import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// O módulo lê `Deno.env` no topo: o shim entra ANTES do import.
let mod: typeof import("./waMediaInbound.ts");
beforeAll(async () => {
  vi.stubGlobal("Deno", { env: { get: () => undefined } });
  mod = await import("./waMediaInbound.ts");
});
afterAll(() => vi.unstubAllGlobals());

const LOOKASIDE = "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1";
const PDF = { tipo: "document", id: "1420446609581100", mime_type: "application/pdf", filename: "Aula.pdf" };

/** Fluxo de `total` bytes em pedaços de 64 KB, gerado sob demanda (nada inteiro na memória). */
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

/** Meta falsa: o Graph devolve `graph`; o lookaside devolve `download`. */
function meta(graph: { status?: number; json: unknown }, download?: () => Response) {
  const chamadas: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    chamadas.push(url);
    if (url.startsWith("https://graph.facebook.com/")) {
      return new Response(JSON.stringify(graph.json), { status: graph.status ?? 200 });
    }
    return download ? download() : new Response("nao esperado", { status: 500 });
  }));
  return chamadas;
}

/** Storage falso que LÊ o corpo como o servidor leria. */
function storage(erro?: string) {
  const uploads: Array<{ path: string; corpo: unknown; opcoes: any; bytes: number }> = [];
  const removidos: string[] = [];
  const admin = {
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, corpo: any, opcoes: any) => {
          let bytes = 0;
          const leitor = (corpo as ReadableStream<Uint8Array>).getReader();
          for (;;) {
            const { done, value } = await leitor.read(); // erro do contador sobe daqui
            if (done) break;
            bytes += value.byteLength;
          }
          uploads.push({ path, corpo, opcoes, bytes });
          return erro ? { data: null, error: { message: erro } } : { data: { path }, error: null };
        },
        remove: async (paths: string[]) => {
          removidos.push(...paths);
          return { data: [], error: null };
        },
        getPublicUrl: (path: string) => ({
          data: { publicUrl: `http://kong:8000/storage/v1/object/public/${bucket}/${path}` },
        }),
      }),
    },
  };
  return { admin, uploads, removidos };
}

beforeEach(() => vi.stubGlobal("Deno", { env: { get: () => undefined } }));

describe("gravarMidiaInbound — arquivo grande do professor (22/10/2026)", () => {
  it("o PDF de 95 MB vai do download direto para o upload, em fluxo", async () => {
    const tamanho = 99804438; // o PDF da Prof. Maria Luiza
    meta({ json: { url: LOOKASIDE, mime_type: "application/pdf", file_size: tamanho } }, () =>
      new Response(fluxo(tamanho), { headers: { "content-length": String(tamanho) } }));
    const { admin, uploads } = storage();

    const r = await mod.gravarMidiaInbound(admin, PDF, "tok", { pasta: "crm/" });

    expect(r.bytes).toBe(tamanho);
    expect(r.path).toMatch(/^crm\/\d{4}-\d{2}-\d{2}\/inbound-[0-9a-f-]+\.pdf$/);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].corpo).toBeInstanceOf(ReadableStream); // não um Uint8Array inteiro
    expect(uploads[0].opcoes).toMatchObject({ contentType: "application/pdf", upsert: false, duplex: "half" });
    expect(uploads[0].bytes).toBe(tamanho);
  });

  it("acima do teto nem começa a baixar: o Graph já informa o tamanho", async () => {
    const chamadas = meta({ json: { url: LOOKASIDE, mime_type: "application/pdf", file_size: 150 * 1024 * 1024 } });
    const { admin, uploads } = storage();

    await expect(mod.gravarMidiaInbound(admin, PDF, "tok")).rejects.toBeInstanceOf(mod.FalhaDefinitivaMidia);
    expect(chamadas).toHaveLength(1); // só o Graph
    expect(uploads).toHaveLength(0);
  });

  it("o teto é o do bucket: 100 MB", () => {
    expect(mod.LIMITE_MIDIA_INBOUND_BYTES).toBe(104857600);
  });

  it("sem tamanho informado em lugar nenhum, o contador corta o que passa do teto", async () => {
    meta({ json: { url: LOOKASIDE, mime_type: "application/pdf" } }, () => new Response(fluxo(3000)));
    const { admin, uploads } = storage();

    await expect(mod.gravarMidiaInbound(admin, PDF, "tok", { limiteBytes: 1000 }))
      .rejects.toBeInstanceOf(mod.FalhaDefinitivaMidia);
    expect(uploads).toHaveLength(0);
  });
});

describe("gravarMidiaInbound — o que repete e o que não repete", () => {
  it("Storage recusando pelo tamanho é definitiva (repetir baixaria tudo de novo)", async () => {
    meta({ json: { url: LOOKASIDE, mime_type: "application/pdf", file_size: 10 } }, () => new Response(fluxo(10)));
    const { admin } = storage("The object exceeded the maximum allowed size");

    const erro = await mod.gravarMidiaInbound(admin, PDF, "tok").catch((e) => e);
    expect(erro).toBeInstanceOf(mod.FalhaDefinitivaMidia);
    expect(erro.message).toBe("storage upload: The object exceeded the maximum allowed size");
  });

  it("outro erro do Storage é transitório", async () => {
    meta({ json: { url: LOOKASIDE, mime_type: "application/pdf", file_size: 10 } }, () => new Response(fluxo(10)));
    const { admin } = storage("Internal Server Error");

    const erro = await mod.gravarMidiaInbound(admin, PDF, "tok").catch((e) => e);
    expect(erro).toBeInstanceOf(Error);
    expect(erro).not.toBeInstanceOf(mod.FalhaDefinitivaMidia);
  });

  it("Graph 4xx é definitiva; Graph 5xx e 429 são transitórias", async () => {
    const { admin } = storage();
    meta({ status: 404, json: { error: { message: "Unsupported get request" } } });
    await expect(mod.gravarMidiaInbound(admin, PDF, "tok")).rejects.toBeInstanceOf(mod.FalhaDefinitivaMidia);

    for (const status of [500, 429]) {
      meta({ status, json: {} });
      const erro = await mod.gravarMidiaInbound(admin, PDF, "tok").catch((e) => e);
      expect(erro).not.toBeInstanceOf(mod.FalhaDefinitivaMidia);
      expect(erro.message).toContain(`HTTP ${status}`);
    }
  });

  it("URL fora da Meta não é baixada (anti-SSRF)", async () => {
    const chamadas = meta({ json: { url: "http://kong:8000/rest/v1/", mime_type: "application/pdf" } });
    const { admin } = storage();

    const erro = await mod.gravarMidiaInbound(admin, PDF, "tok").catch((e) => e);
    expect(erro).toBeInstanceOf(mod.FalhaDefinitivaMidia);
    expect(erro.message).toBe("host_nao_permitido: kong");
    expect(chamadas).toHaveLength(1);
  });

  it("download com erro HTTP não sobe o corpo de erro da Meta", async () => {
    meta({ json: { url: LOOKASIDE, mime_type: "audio/ogg" } }, () => new Response("{\"error\":1}", { status: 403 }));
    const { admin, uploads } = storage();

    await expect(mod.gravarMidiaInbound(admin, PDF, "tok")).rejects.toThrow("download HTTP 403");
    expect(uploads).toHaveLength(0);
  });

  it("download vazio sem content-length: tira o objeto de 0 bytes e tenta de novo", async () => {
    meta({ json: { url: LOOKASIDE, mime_type: "audio/ogg" } }, () => new Response(fluxo(0)));
    const { admin, uploads, removidos } = storage();

    const erro = await mod.gravarMidiaInbound(admin, PDF, "tok").catch((e) => e);
    expect(erro.message).toBe("download vazio");
    expect(erro).not.toBeInstanceOf(mod.FalhaDefinitivaMidia);
    expect(removidos).toEqual([uploads[0].path]);
  });
});

describe("baixarAnexoInbound (pipeline do pedagógico e do podcast)", () => {
  it("devolve o anexo com a URL pública e o nome original", async () => {
    meta({ json: { url: LOOKASIDE, mime_type: "application/pdf", file_size: 10 } }, () => new Response(fluxo(10)));
    const { admin, uploads } = storage();

    const [ax] = await mod.baixarAnexoInbound(admin, PDF, "tok", "teste");

    expect(ax).toEqual({
      tipo: "document",
      mime_type: "application/pdf",
      meta_media_id: PDF.id,
      url: `https://api.ppgeducacao.site/storage/v1/object/public/whatsapp-anexos/${uploads[0].path}`,
      url_storage: `https://api.ppgeducacao.site/storage/v1/object/public/whatsapp-anexos/${uploads[0].path}`,
      filename: "Aula.pdf",
    });
    expect(uploads[0].path).not.toMatch(/^crm\//);
  });

  it("qualquer falha vira [] — a mensagem segue sem o arquivo", async () => {
    meta({ json: { url: LOOKASIDE, mime_type: "application/pdf", file_size: 150 * 1024 * 1024 } });
    const { admin } = storage();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await mod.baixarAnexoInbound(admin, PDF, "tok", "teste")).toEqual([]);
    expect(await mod.baixarAnexoInbound(admin, PDF, null, "teste")).toEqual([]);
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });
});
