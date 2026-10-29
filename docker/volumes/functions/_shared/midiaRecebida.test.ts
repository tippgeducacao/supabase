import { describe, expect, it, vi } from "vitest";
import { caminhoRecebido, expiracaoDoLink, precisaRenovar, urlBaixavel } from "./midiaRecebida";

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

  it("link público volta igual, sem pedir nada ao storage", async () => {
    const fetchImpl = vi.fn();
    const pub = "https://api.ppgeducacao.site/storage/v1/object/public/whatsapp-anexos/crm/a.ogg";
    expect(await urlBaixavel(pub, { base: "http://kong:8000", chave: "k", fetchImpl })).toBe(pub);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("link vencido do bucket privado ganha um novo pela service role", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ signedURL: "/object/sign/whatsapp-recebidos/a/b.ogg?token=novo" })));
    const novo = await urlBaixavel(assinado("a/b.ogg", 1), { base: "http://kong:8000/", chave: "k", fetchImpl });
    expect(novo).toBe("http://kong:8000/storage/v1/object/sign/whatsapp-recebidos/a/b.ogg?token=novo");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://kong:8000/storage/v1/object/sign/whatsapp-recebidos/a/b.ogg");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
  });

  it("falha ao assinar devolve o link original", async () => {
    const fetchImpl = vi.fn(async () => new Response("x", { status: 500 }));
    const velho = assinado("a/b.ogg", 1);
    expect(await urlBaixavel(velho, { base: "http://kong:8000", chave: "k", fetchImpl })).toBe(velho);
  });
});
