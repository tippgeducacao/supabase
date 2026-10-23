import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getWaProvider, type WaInboundMessage } from "../_shared/waProviders.ts";

// `midia.ts` puxa o `_shared/waMediaInbound.ts`, que lê `Deno.env` no topo: shim ANTES do import.
let mod: typeof import("./midia.ts");
beforeAll(async () => {
  vi.stubGlobal("Deno", { env: { get: () => undefined } });
  mod = await import("./midia.ts");
});
afterAll(() => vi.unstubAllGlobals());

const SERVIDOR = "https://ppgvet.uazapi.com";
const ARQUIVO = `${SERVIDOR}/files/3EB0ABC.mp4`;
const MB = 1024 * 1024;

function msg(extra: Partial<WaInboundMessage> = {}): WaInboundMessage {
  return {
    externalId: "3EB0ABC",
    fromDigits: "5546999990000",
    fromMe: true,
    isGroup: false,
    tipo: "video",
    conteudo: "[vídeo]",
    caption: "",
    mediaUrl: null,
    mediaBase64: null,
    mediaMime: "video/mp4",
    mediaFilename: "andreia.mp4",
    mediaBytes: 3000,
    timestamp: 1792700000,
    ...extra,
  };
}

/** Fluxo de `total` bytes em pedaços de 64 KB, gerado sob demanda. */
function fluxo(total: number): ReadableStream<Uint8Array> {
  let enviado = 0;
  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (enviado >= total) return ctrl.close();
      const n = Math.min(65536, total - enviado);
      enviado += n;
      ctrl.enqueue(new Uint8Array(n));
    },
  });
}

/** Provider de verdade, com o /message/download trocado por um falso. */
function provedor(download: Partial<{ url: string | null; mime: string | null; base64: string | null }> | Error) {
  const downloadMedia = vi.fn(async () => {
    if (download instanceof Error) throw download;
    return { url: null, mime: null, base64: null, ...download };
  });
  return { provider: { ...getWaProvider("uazapi"), downloadMedia }, downloadMedia };
}

/** Banco + Storage falsos; o upload LÊ o corpo como o servidor leria. */
function admin(jaGravadas: string[] = []) {
  const uploads: Array<{ path: string; corpo: unknown; opcoes: any; bytes: number }> = [];
  const cliente = {
    from: (_t: string) => ({
      select: () => ({
        eq: (_c: string, v: string) => ({
          limit: async () => ({ data: jaGravadas.includes(v) ? [{ id: "x" }] : [], error: null }),
        }),
      }),
    }),
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, corpo: any, opcoes: any) => {
          let bytes = 0;
          const leitor = (corpo as ReadableStream<Uint8Array>).getReader();
          for (;;) {
            const { done, value } = await leitor.read();
            if (done) break;
            bytes += value.byteLength;
          }
          uploads.push({ path, corpo, opcoes, bytes });
          return { data: { path }, error: null };
        },
        remove: async () => ({ data: [], error: null }),
        getPublicUrl: (path: string) => ({
          data: { publicUrl: `http://kong:8000/storage/v1/object/public/${bucket}/${path}` },
        }),
      }),
    },
  };
  return { cliente, uploads };
}

const token = async () => "tok";
let baixados: string[];
beforeEach(() => {
  vi.stubGlobal("Deno", { env: { get: () => undefined } });
  baixados = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    baixados.push(url);
    if (url === ARQUIVO) return new Response(fluxo(3000), { headers: { "content-length": "3000" } });
    return new Response("não achei", { status: 404 });
  }));
});

describe("mídia da linha Web — arquivo grande (23/10/2026)", () => {
  it("o tamanho vem no próprio webhook (content.fileLength)", () => {
    const parsed = getWaProvider("uazapi").parseWebhook({
      event: "messages",
      message: {
        messageid: "3EB0ABC",
        chatid: "5546999990000@s.whatsapp.net",
        fromMe: true,
        messageType: "DocumentMessage",
        content: { fileLength: 158463016, fileName: "samara.pdf", mimetype: "application/pdf" },
      },
    });
    expect(parsed.messages[0].mediaBytes).toBe(158463016);
  });

  it("acima de 100 MB nem pede o arquivo à Uazapi: a mensagem vai sem anexo, com o motivo", async () => {
    const { provider, downloadMedia } = provedor({ url: ARQUIVO });
    const { cliente, uploads } = admin();

    const r = await mod.baixarMidiaUazapi(cliente, provider, SERVIDOR, token, msg({ mediaBytes: 158463016 }));

    expect(r.anexos).toEqual([]);
    expect(r.pendente).toMatchObject({ id: "3EB0ABC", tipo: "video", motivo: "arquivo_grande: 158463016 bytes" });
    expect(downloadMedia).not.toHaveBeenCalled();
    expect(uploads).toHaveLength(0);
  });

  it("dentro do teto, o arquivo vai do servidor da Uazapi para o bucket em fluxo", async () => {
    const { provider } = provedor({ url: ARQUIVO, mime: "video/mp4" });
    const { cliente, uploads } = admin();

    const r = await mod.baixarMidiaUazapi(cliente, provider, SERVIDOR, token, msg());

    expect(r.pendente).toBeNull();
    expect(uploads[0].corpo).toBeInstanceOf(ReadableStream);
    expect(uploads[0].opcoes).toMatchObject({ contentType: "video/mp4", duplex: "half" });
    expect(uploads[0].path).toMatch(/^crm\/\d{4}-\d{2}-\d{2}\/uazapi-[0-9a-f-]+\.mp4$/);
    expect(r.anexos).toEqual([{
      tipo: "video",
      mime_type: "video/mp4",
      url: `http://kong:8000/storage/v1/object/public/whatsapp-anexos/${uploads[0].path}`,
      url_storage: `http://kong:8000/storage/v1/object/public/whatsapp-anexos/${uploads[0].path}`,
      filename: "andreia.mp4",
    }]);
  });

  it("arquivo grande ganha mais tempo para a Uazapi decifrar; o pequeno fica nos 20 s de sempre", async () => {
    const { provider, downloadMedia } = provedor({ url: ARQUIVO });
    const { cliente } = admin();

    await mod.baixarMidiaUazapi(cliente, provider, SERVIDOR, token, msg({ mediaBytes: 80 * MB }));
    await mod.baixarMidiaUazapi(cliente, provider, SERVIDOR, token, msg({ mediaBytes: 2 * MB }));

    expect(downloadMedia.mock.calls[0][3]).toEqual({ audioMp3: false, timeoutMs: 60_000 });
    expect(downloadMedia.mock.calls[1][3]).toEqual({ audioMp3: false });
  });

  it("áudio continua pedindo o mp3", async () => {
    const { provider, downloadMedia } = provedor({ url: ARQUIVO });
    await mod.baixarMidiaUazapi(admin().cliente, provider, SERVIDOR, token, msg({ tipo: "audio", mediaBytes: 9000 }));
    expect(downloadMedia.mock.calls[0][3]).toEqual({ audioMp3: true });
  });
});

describe("mídia da linha Web — o que falha vira motivo, nunca exceção", () => {
  it("URL fora do servidor da Uazapi não é baixada (anti-SSRF)", async () => {
    const { provider } = provedor({ url: "http://kong:8000/rest/v1/" });
    const r = await mod.baixarMidiaUazapi(admin().cliente, provider, SERVIDOR, token, msg());
    expect(r.pendente?.motivo).toBe("host_nao_permitido: kong");
    expect(baixados).toHaveLength(0);
  });

  it("/message/download caindo", async () => {
    const { provider } = provedor(new Error("The signal has been aborted"));
    const r = await mod.baixarMidiaUazapi(admin().cliente, provider, SERVIDOR, token, msg());
    expect(r.pendente?.motivo).toBe("downloadMedia: The signal has been aborted");
  });

  it("sem token da linha", async () => {
    const { provider, downloadMedia } = provedor({ url: ARQUIVO });
    const r = await mod.baixarMidiaUazapi(admin().cliente, provider, SERVIDOR, async () => null, msg());
    expect(r.pendente?.motivo).toBe("sem_token");
    expect(downloadMedia).not.toHaveBeenCalled();
  });

  it("download com erro HTTP não sobe o corpo de erro", async () => {
    const { provider } = provedor({ url: `${SERVIDOR}/files/sumiu.mp4` });
    const { cliente, uploads } = admin();
    const r = await mod.baixarMidiaUazapi(cliente, provider, SERVIDOR, token, msg());
    expect(r.pendente?.motivo).toBe("download HTTP 404");
    expect(uploads).toHaveLength(0);
  });

  it("base64 pequeno (fallback) ainda é gravado", async () => {
    const { provider } = provedor({ base64: btoa("arquivo pequeno") });
    const { cliente, uploads } = admin();
    const r = await mod.baixarMidiaUazapi(cliente, provider, SERVIDOR, token, msg({ mediaBytes: null }));
    expect(r.pendente).toBeNull();
    expect(uploads[0].bytes).toBe("arquivo pequeno".length);
  });

  it("base64 grande não é decodificado (custaria ~3x o arquivo na memória)", async () => {
    const { provider } = provedor({ base64: "A".repeat(28 * MB) });
    const { cliente, uploads } = admin();
    const r = await mod.baixarMidiaUazapi(cliente, provider, SERVIDOR, token, msg({ mediaBytes: null }));
    expect(r.pendente?.motivo).toMatch(/^base64_grande: ~\d+ bytes/);
    expect(uploads).toHaveLength(0);
  });

  it("texto não é mídia", async () => {
    const { provider, downloadMedia } = provedor({ url: ARQUIVO });
    const r = await mod.baixarMidiaUazapi(admin().cliente, provider, SERVIDOR, token, msg({ tipo: "text" }));
    expect(r).toEqual({ anexos: [], pendente: null });
    expect(downloadMedia).not.toHaveBeenCalled();
  });
});

describe("mensagemJaGravada", () => {
  it("reentrega (ou o eco de um envio nosso) não baixa o arquivo de novo", async () => {
    const { cliente } = admin(["3EB0ABC"]);
    expect(await mod.mensagemJaGravada(cliente, "3EB0ABC")).toBe(true);
    expect(await mod.mensagemJaGravada(cliente, "3EB0XYZ")).toBe(false);
    expect(await mod.mensagemJaGravada(cliente, null)).toBe(false);
  });
});
