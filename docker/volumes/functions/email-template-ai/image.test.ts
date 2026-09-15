import { describe, expect, it, vi } from "vitest";
import { gerarImagemEmailIA, MODELO_IMAGEM_EMAIL_IA, validarImagemGeradaEmailIA, validarPromptImagemEmailIA } from "./image.ts";

// PNG real de 1×1 para verificar o contrato binário sem chamar qualquer API.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKeUAAAAASUVORK5CYII=";
const respostaImagem = (inlineData: unknown = { mimeType: "image/png", data: PNG }) => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData }] } }] });

describe("validação da imagem criada antes de oferecer ao editor", () => {
  it("devolve raster privado sem URL, sem publicar automaticamente", () => {
    expect(validarImagemGeradaEmailIA({ mimeType: "image/png", data: PNG })).toEqual({ nome: "Imagem criada com IA.png", mime: "image/png", base64: PNG, uso: "referencia" });
  });
  it.each([
    { mimeType: "image/svg+xml", data: btoa('<svg onload="alert(1)"/>') },
    { mimeType: "image/jpeg", data: PNG },
    { mimeType: "image/png", data: btoa("\x89PNG\r\n\x1a\nassinatura-sem-imagem") },
    { mimeType: "image/png", data: `data:image/png;base64,${PNG}` },
    { mimeType: "image/png", data: "isto-não-é-base64" },
    { mimeType: "image/png", data: PNG.slice(0, -4) },
  ])("recusa formato disfarçado, inválido ou incompleto", valor => {
    expect(() => validarImagemGeradaEmailIA(valor)).toThrow();
  });
  it("limita dimensões antes do navegador decodificar o bitmap", () => {
    const bytes = Uint8Array.from(atob(PNG), c => c.charCodeAt(0));
    new DataView(bytes.buffer).setUint32(16, 100000);
    expect(() => validarImagemGeradaEmailIA({ mimeType: "image/png", data: btoa(String.fromCharCode(...bytes)) })).toThrow();
  });
  it("limita os bytes reais a 8 MB", () => {
    expect(() => validarImagemGeradaEmailIA({ mimeType: "image/png", data: "A".repeat(12 * 1024 * 1024) })).toThrow(/grande demais/);
  });
  it.each(["", "  ", "a".repeat(2001), "a\u0000b", {}, null])("limita o pedido visual antes do consumo", prompt => {
    expect(() => validarPromptImagemEmailIA(prompt)).toThrow();
  });
});

describe("geração direta pelo Google sem ferramentas", () => {
  it("usa modelo fixo e chave em header, com resposta privada", async () => {
    const buscar = vi.fn(async () => Response.json(respostaImagem()));
    const imagem = await gerarImagemEmailIA({ prompt: "Ilustração veterinária", chave: "CHAVE_PRIVADA", buscar });
    expect(imagem.uso).toBe("referencia");
    expect(imagem).not.toHaveProperty("url");
    expect(buscar).toHaveBeenCalledTimes(1);
    const [url, init] = buscar.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${MODELO_IMAGEM_EMAIL_IA}:generateContent`);
    expect(url).not.toContain("CHAVE_PRIVADA");
    expect(init.headers).toMatchObject({ "x-goog-api-key": "CHAVE_PRIVADA" });
    const body = JSON.parse(String(init.body));
    expect(body.generationConfig).toEqual({ responseModalities: ["TEXT", "IMAGE"] });
    expect(body.tools).toBeUndefined();
    expect(body.contents[0].parts[0].text).toContain("Ilustração veterinária");
  });
  it.each([
    {},
    { candidates: [{ finishReason: "SAFETY", content: { parts: [] } }] },
    { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [] } }] },
    { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Não criei imagem" }] } }] },
    respostaImagem({ mimeType: "text/html", data: btoa("<script>alert(1)</script>") }),
  ])("recusa texto, bloqueio e resposta malformada sem repetir a geração", async resultado => {
    const buscar = vi.fn(async () => Response.json(resultado));
    await expect(gerarImagemEmailIA({ prompt: "Imagem", chave: "CHAVE", buscar })).rejects.toMatchObject({ status: 422, code: "INVALID_IMAGE_OUTPUT" });
    expect(buscar).toHaveBeenCalledTimes(1);
  });
  it("não devolve erros internos do provedor e informa Retry-After", async () => {
    const buscar = vi.fn(async () => new Response("DETALHE_PRIVADO", { status: 429, headers: { "Retry-After": "23" } }));
    await expect(gerarImagemEmailIA({ prompt: "Imagem", chave: "CHAVE", buscar })).rejects.toMatchObject({ status: 429, retryAfter: 23, code: "PROVIDER_RATE_LIMIT" });
  });
  it("limita a leitura real da resposta, sem depender de Content-Length", async () => {
    const buscar = vi.fn(async () => new Response("x".repeat(12 * 1024 * 1024 + 1)));
    await expect(gerarImagemEmailIA({ prompt: "Imagem", chave: "CHAVE", buscar })).rejects.toMatchObject({ code: "IMAGE_OUTPUT_TOO_LARGE" });
  });
  it("aborta em 150 segundos sem repetir a chamada", async () => {
    vi.useFakeTimers();
    try {
      const buscar = vi.fn((_url: string | URL | Request, init?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Cancelado", "AbortError")));
      }));
      const pendente = gerarImagemEmailIA({ prompt: "Imagem", chave: "CHAVE", buscar });
      const verificar = expect(pendente).rejects.toMatchObject({ status: 503, code: "IMAGE_PROVIDER_UNAVAILABLE" });
      await vi.advanceTimersByTimeAsync(150000);
      await verificar;
      expect(buscar).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
