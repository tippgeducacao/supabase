import { describe, expect, it } from "vitest";
import {
  buscarUsuario,
  corpoDoPost,
  criarPost,
  ESCOPOS,
  leitorEmPartes,
  LINKEDIN_VERSION,
  subirImagem,
  subirVideo,
  trocarCodigoPorToken,
  urlDeAutorizacao,
} from "./linkedinApi";

type Chamada = { url: string; init?: RequestInit };

/** fetch falso: responde em ordem e guarda o que foi pedido. */
function fetchFalso(respostas: Array<() => Response>) {
  const chamadas: Chamada[] = [];
  let i = 0;
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    chamadas.push({ url: String(url), init });
    const r = respostas[i++];
    if (!r) throw new Error(`chamada inesperada: ${String(url)}`);
    return r();
  }) as typeof fetch;
  return { f, chamadas };
}

const json = (status: number, corpo: unknown, headers: Record<string, string> = {}) =>
  () => new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json", ...headers } });

describe("OAuth e quem autorizou", () => {
  it("monta a autorização com os escopos de publicar e de identificar", () => {
    const u = new URL(urlDeAutorizacao("CID", "https://api.ppgeducacao.site/functions/v1/linkedin-oauth-callback", "st"));
    expect(u.origin + u.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(u.searchParams.get("scope")).toBe(ESCOPOS);
    expect(ESCOPOS.split(" ")).toEqual(expect.arrayContaining(["openid", "profile", "w_member_social"]));
    expect(u.searchParams.get("state")).toBe("st");
  });

  it("troca o código em form-urlencoded e assume 60 dias quando não vem expires_in", async () => {
    const { f, chamadas } = fetchFalso([json(200, { access_token: "AT", scope: "openid,profile,w_member_social" })]);
    const t = await trocarCodigoPorToken("CID", "SEG", "COD", "https://cb", f);
    expect(t).toEqual({ access_token: "AT", expires_in: 5184000, scope: "openid,profile,w_member_social" });
    const corpo = String(chamadas[0].init?.body);
    expect(corpo).toContain("grant_type=authorization_code");
    expect(corpo).toContain("code=COD");
    expect((chamadas[0].init?.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  it("código recusado vira erro com a mensagem do LinkedIn", async () => {
    const { f } = fetchFalso([json(400, { error: "invalid_request", error_description: "authorization code expired" })]);
    await expect(trocarCodigoPorToken("C", "S", "X", "https://cb", f)).rejects.toThrow(/authorization code expired/);
  });

  it("userinfo devolve sub, nome e foto", async () => {
    const { f } = fetchFalso([json(200, { sub: "abc", name: "Rafael Costa", picture: "https://foto" })]);
    expect(await buscarUsuario("AT", f)).toEqual({ sub: "abc", nome: "Rafael Costa", foto: "https://foto" });
  });
});

describe("envio de mídia", () => {
  it("imagem: inicializa como a pessoa e sobe com Bearer", async () => {
    const { f, chamadas } = fetchFalso([
      json(200, { value: { uploadUrl: "https://up/img", image: "urn:li:image:1" } }),
      () => new Response(null, { status: 201 }),
    ]);
    const urn = await subirImagem("AT", "urn:li:person:abc", new Uint8Array([1, 2, 3]), "image/jpeg", f);
    expect(urn).toBe("urn:li:image:1");
    const h = chamadas[0].init?.headers as Record<string, string>;
    expect(h["LinkedIn-Version"]).toBe(LINKEDIN_VERSION);
    expect(h["X-Restli-Protocol-Version"]).toBe("2.0.0");
    expect(JSON.parse(String(chamadas[0].init?.body))).toEqual({ initializeUploadRequest: { owner: "urn:li:person:abc" } });
    expect(chamadas[1].init?.method).toBe("PUT");
    expect((chamadas[1].init?.headers as Record<string, string>).Authorization).toBe("Bearer AT");
  });

  it("vídeo: parte em blocos na ordem das instruções e finaliza com os ETags", async () => {
    const total = 10;
    const fluxo = new ReadableStream<Uint8Array>({
      start(c) {
        // a rede entrega em pedaços que NÃO casam com as partes (3 + 3 + 4)
        c.enqueue(new Uint8Array([0, 1, 2]));
        c.enqueue(new Uint8Array([3, 4, 5]));
        c.enqueue(new Uint8Array([6, 7, 8, 9]));
        c.close();
      },
    });
    const { f, chamadas } = fetchFalso([
      json(200, {
        value: {
          video: "urn:li:video:9", uploadToken: "tok",
          uploadInstructions: [
            { firstByte: 0, lastByte: 3, uploadUrl: "https://up/1" },
            { firstByte: 4, lastByte: 9, uploadUrl: "https://up/2" },
          ],
        },
      }),
      () => new Response(null, { status: 200, headers: { etag: "e1" } }),
      () => new Response(null, { status: 200, headers: { etag: "e2" } }),
      () => new Response(null, { status: 200 }),
    ]);
    const urn = await subirVideo("AT", "urn:li:person:abc", total, fluxo, f);
    expect(urn).toBe("urn:li:video:9");
    expect([...(chamadas[1].init?.body as Uint8Array)]).toEqual([0, 1, 2, 3]);
    expect([...(chamadas[2].init?.body as Uint8Array)]).toEqual([4, 5, 6, 7, 8, 9]);
    expect(JSON.parse(String(chamadas[3].init?.body))).toEqual({
      finalizeUploadRequest: { video: "urn:li:video:9", uploadToken: "tok", uploadedPartIds: ["e1", "e2"] },
    });
  });

  it("vídeo: instrução que não cobre o arquivo cancela ANTES de mandar byte", async () => {
    const { f, chamadas } = fetchFalso([
      json(200, { value: { video: "urn:li:video:9", uploadInstructions: [{ firstByte: 0, lastByte: 3, uploadUrl: "https://up/1" }] } }),
    ]);
    const vazio = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
    await expect(subirVideo("AT", "urn:li:person:abc", 10, vazio, f)).rejects.toThrow(/cobrem 4 bytes/);
    expect(chamadas).toHaveLength(1);
  });

  it("leitorEmPartes avisa quando o arquivo acaba antes", async () => {
    const fluxo = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.close(); } });
    const ler = leitorEmPartes(fluxo.getReader());
    await expect(ler(5)).rejects.toThrow(/acabou antes/);
  });
});

describe("o post", () => {
  it("corpo de multi-imagem e de vídeo", () => {
    const multi = corpoDoPost("urn:li:person:a", "t", { tipo: "multi_imagem", urns: ["urn:li:image:1", "urn:li:image:2"] });
    expect(multi.content).toEqual({ multiImage: { images: [{ id: "urn:li:image:1" }, { id: "urn:li:image:2" }] } });
    expect(multi.visibility).toBe("PUBLIC");
    expect(multi.lifecycleState).toBe("PUBLISHED");
    const video = corpoDoPost("urn:li:person:a", "t", { tipo: "video", urns: ["urn:li:video:1"] });
    expect(video.content).toEqual({ media: { id: "urn:li:video:1" } });
    expect(corpoDoPost("urn:li:person:a", "t", { tipo: "texto" })).not.toHaveProperty("content");
  });

  it("criarPost lê a URN do x-restli-id e não lança em erro de rede", async () => {
    const ok = fetchFalso([json(201, {}, { "x-restli-id": "urn:li:share:42" })]);
    expect(await criarPost("AT", {}, ok.f)).toMatchObject({ status: 201, urn: "urn:li:share:42" });
    const caiu = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    expect(await criarPost("AT", {}, caiu)).toEqual({ status: null, urn: null, corpo: "ECONNRESET" });
  });
});
