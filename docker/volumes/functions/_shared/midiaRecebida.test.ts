import { describe, expect, it, vi } from "vitest";
import { assinarObjeto, caminhoRecebido, expiracaoDoLink, objetoPrivado, paraHostPublico, precisaRenovar, urlBaixavel, urlParaTerceiros } from "./midiaRecebida";

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "");
const assinado = (caminho: string, exp: number) =>
  `https://api.ppgeducacao.site/storage/v1/object/sign/whatsapp-recebidos/${caminho}?token=${b64({ alg: "HS256" })}.${b64({ url: caminho, exp })}.sig`;

describe("mídia recebida em bucket privado (29/10/2026)", () => {
  it("reconhece só links do bucket privado", () => {
    expect(caminhoRecebido(assinado("crm/2026-10-29/inbound-a.jpg", 1))).toBe("crm/2026-10-29/inbound-a.jpg");
    expect(caminhoRecebido("https://api.ppgeducacao.site/storage/v1/object/public/whatsapp-anexos/crm/x.jpg")).toBeNull();
    expect(caminhoRecebido("https://scontent.cdninstagram.com/x.jpg")).toBeNull();
    expect(caminhoRecebido(null)).toBeNull();
  });

  it("lê a expiração do token e decide se renova", () => {
    const agora = 1_800_000_000_000;
    const valeUmDia = assinado("a/b.ogg", agora / 1000 + 86_400);
    const venceJa = assinado("a/b.ogg", agora / 1000 + 60);
    expect(expiracaoDoLink(valeUmDia)).toBe(agora / 1000 + 86_400);
    expect(precisaRenovar(valeUmDia, agora)).toBe(false);
    expect(precisaRenovar(venceJa, agora)).toBe(true);
    expect(precisaRenovar("https://x/storage/v1/object/public/whatsapp-anexos/a.ogg", agora)).toBe(false);
  });

  it("link de bucket público ou de fora volta igual, sem pedir nada ao storage", async () => {
    const fetchImpl = vi.fn();
    const pub = "https://api.ppgeducacao.site/storage/v1/object/public/professor-photos/a.jpg";
    expect(await urlBaixavel(pub, { base: "http://kong:8000", chave: "k", fetchImpl })).toBe(pub);
    expect(await urlBaixavel("https://lookaside.fbsbx.com/x.ogg", { base: "http://kong:8000", chave: "k", fetchImpl })).toBe("https://lookaside.fbsbx.com/x.ogg");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("link PÚBLICO gravado de bucket que virou privado (whatsapp-anexos, 30/10) ganha link assinado", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ signedURL: "/object/sign/whatsapp-anexos/outbound/x.pdf?token=novo" })));
    const pub = "https://api.ppgeducacao.site/storage/v1/object/public/whatsapp-anexos/outbound/x.pdf";
    const novo = await urlBaixavel(pub, { base: "http://kong:8000", chave: "k", fetchImpl });
    expect(novo).toBe("http://kong:8000/storage/v1/object/sign/whatsapp-anexos/outbound/x.pdf?token=novo");
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe("http://kong:8000/storage/v1/object/sign/whatsapp-anexos/outbound/x.pdf");
    // `caminhoRecebido` continua sendo só do bucket de mídia recebida.
    expect(caminhoRecebido(pub)).toBeNull();
  });

  it("link para TERCEIROS sai assinado E com o host público (a Uazapi não alcança kong:8000)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ signedURL: "/object/sign/whatsapp-anexos/stickers/a.webp?token=novo" })));
    const pub = "https://api.ppgeducacao.site/storage/v1/object/public/whatsapp-anexos/stickers/a.webp";
    const terceiros = await urlParaTerceiros(pub, { base: "http://kong:8000", chave: "k", fetchImpl });
    expect(terceiros).toBe("https://api.ppgeducacao.site/storage/v1/object/sign/whatsapp-anexos/stickers/a.webp?token=novo");
    expect(paraHostPublico("http://supabase-kong:8000/storage/v1/x", "https://api.exemplo")).toBe("https://api.exemplo/storage/v1/x");
    expect(paraHostPublico("https://cdn.meta.com/x", "https://api.exemplo")).toBe("https://cdn.meta.com/x");
  });

  it("link vencido do bucket privado ganha um novo pela service role", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ signedURL: "/object/sign/whatsapp-recebidos/a/b.ogg?token=novo" })));
    const novo = await urlBaixavel(assinado("a/b.ogg", 1), { base: "http://kong:8000/", chave: "k", fetchImpl });
    expect(novo).toBe("http://kong:8000/storage/v1/object/sign/whatsapp-recebidos/a/b.ogg?token=novo");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://kong:8000/storage/v1/object/sign/whatsapp-recebidos/a/b.ogg");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
  });

  it("falha ao assinar interrompe o envio sem tentar o link original", async () => {
    const fetchImpl = vi.fn(async () => new Response("x", { status: 500 }));
    const velho = assinado("a/b.ogg", 1);
    await expect(urlBaixavel(velho, { base: "http://kong:8000", chave: "k", fetchImpl })).rejects.toThrow("HTTP 500");
  });

  it.each(["../rh-admissional/x.pdf", "%2e%2e/rh-admissional/x.pdf", "%252e%252e%252frh-admissional/x.pdf", "crm/%2e%2e/../x.pdf", "crm\\..\\x.pdf"])("recusa travessia antes de pedir assinatura: %s", async (caminho) => {
    const fetchImpl = vi.fn();
    const url = `https://api.ppgeducacao.site/storage/v1/object/public/whatsapp-recebidos/${caminho}`;
    await expect(urlBaixavel(url, { base: "http://kong:8000", chave: "k", fetchImpl })).rejects.toThrow("não permitido");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a assinatura direta também confina bucket e caminho", async () => {
    const fetchImpl = vi.fn();
    const deps = { base: "http://kong:8000", chave: "k", fetchImpl };
    await expect(assinarObjeto("rh-admissional", "x.pdf", 600, deps)).rejects.toThrow();
    await expect(assinarObjeto("whatsapp-recebidos", "../rh-admissional/x.pdf", 600, deps)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("não transforma Storage de outro host numa assinatura nossa", async () => {
    const fetchImpl = vi.fn();
    const url = "https://externo.example/storage/v1/object/public/whatsapp-recebidos/a.pdf";
    expect(objetoPrivado(url)).toBeNull();
    expect(await urlBaixavel(url, { base: "http://kong:8000", chave: "k", fetchImpl })).toBe(url);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
