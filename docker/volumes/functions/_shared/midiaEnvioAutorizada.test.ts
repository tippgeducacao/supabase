import { describe, expect, it, vi } from "vitest";
import { criarMidiaEnvio, type ReferenciaMidia } from "./midiaEnvioAutorizada";

const usuario = { tipo: "usuario" as const, usuarioId: "usuario", token: "jwt-do-usuario" };
const url = (bucket: string, caminho = "pasta/arquivo.pdf") => `https://api.ppgeducacao.site/storage/v1/object/public/${bucket}/${caminho}`;
const resposta = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const origem = { tabela: "crm_whatsapp_messages", id: "11111111-1111-4111-8111-111111111111" };
function preparar(fetchImpl: typeof fetch, referencia?: ReferenciaMidia, servico = false) {
  const conferirExterna = vi.fn(async (_url: string) => {});
  const midia = criarMidiaEnvio(servico ? { tipo: "servico" } : usuario, {
    base: "http://kong:8000", publico: "https://api.ppgeducacao.site", chaveAnon: "anon",
    chaveServico: "servico", fetchImpl, conferirExterna,
  }, referencia);
  return { midia, conferirExterna };
}

describe("arquivo do envio precisa ser autorizado para o solicitante", () => {
  it("nega Storage sem acesso e nunca tenta baixar o arquivo", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => resposta({}, 403));
    const { midia } = preparar(fetchImpl);
    await expect(midia.baixar(url("gt-doc-assets"))).rejects.toMatchObject({ status: 403 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer jwt-do-usuario" });
  });

  it("assina upload autorizado com JWT, e entrega host público para a Meta", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => resposta({ signedURL: "/object/sign/whatsapp-anexos/pasta/arquivo.pdf?token=teste" }));
    const { midia } = preparar(fetchImpl);
    expect(await midia.paraTerceiros(url("whatsapp-anexos"))).toBe("https://api.ppgeducacao.site/storage/v1/object/sign/whatsapp-anexos/pasta/arquivo.pdf?token=teste");
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer jwt-do-usuario" });
  });

  it("não aceita mídia recebida sem mensagem de origem, nem token de URL como autorização", async () => {
    const fetchImpl = vi.fn();
    const { midia } = preparar(fetchImpl);
    await expect(midia.conferir(url("whatsapp-recebidos") + "?token=forjado")).rejects.toMatchObject({ status: 403 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([{ rows: [] }, { rows: [{ anexos: [{ url: url("whatsapp-recebidos", "outro.pdf") }] }] }])("não assina quando RLS oculta mensagem ou caminho difere", async ({ rows }) => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => resposta(rows));
    const { midia } = preparar(fetchImpl, origem);
    await expect(midia.conferir(url("whatsapp-recebidos"))).rejects.toMatchObject({ status: 403 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer jwt-do-usuario" });
  });

  it("recebido: confere mensagem como usuário antes de assinar o caminho exato como serviço", async () => {
    const fetchImpl = vi.fn(async (alvo: RequestInfo | URL, _init?: RequestInit) => String(alvo).includes("/rest/v1/")
      ? resposta([{ anexos: [{ url: url("whatsapp-recebidos") }] }])
      : resposta({ signedURL: "/object/sign/whatsapp-recebidos/pasta/arquivo.pdf?token=teste" }));
    const { midia } = preparar(fetchImpl, origem);
    await midia.paraTerceiros(url("whatsapp-recebidos"));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer jwt-do-usuario" });
    expect(fetchImpl.mock.calls[1][1]?.headers).toMatchObject({ Authorization: "Bearer servico" });
  });

  it("automação com credencial interna continua assinando sem sessão humana", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => resposta({ signedURL: "/object/sign/whatsapp-anexos/pasta/arquivo.pdf?token=teste" }));
    const { midia } = preparar(fetchImpl, undefined, true);
    await midia.conferir(url("whatsapp-anexos"));
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer servico" });
  });

  it("recusa travessia sem qualquer pedido de rede", async () => {
    const fetchImpl = vi.fn();
    const { midia } = preparar(fetchImpl);
    await expect(midia.conferir(url("whatsapp-recebidos", "%252e%252e%252frh-admissional/x.pdf"))).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("confere mídia em componente aninhado de template e preserva o original", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => resposta({ signedURL: "/object/sign/whatsapp-anexos/pasta/arquivo.pdf?token=teste" }));
    const { midia } = preparar(fetchImpl);
    const componentes = [{ type: "header", parameters: [{ document: { link: url("whatsapp-anexos") } }] }];
    const saida = await midia.componentes(componentes);
    expect(JSON.stringify(saida)).toContain("/object/sign/");
    expect(JSON.stringify(componentes)).toContain("/object/public/");
  });

  it("media_id no pedido humano não contorna a autorização por URL", async () => {
    const fetchImpl = vi.fn();
    const { midia } = preparar(fetchImpl);
    const componentes = [{ type: "header", parameters: [{ image: { id: "id-copiado-do-cache" } }] }];
    await expect(midia.componentes(componentes)).rejects.toMatchObject({ status: 403 });
    expect(fetchImpl).not.toHaveBeenCalled();
    // O handler só libera IDs na montagem final, depois de conferir o pedido original.
    expect(await midia.componentes(componentes, true)).toEqual(componentes);
  });

  it("redirect externo não herda permissão do primeiro endereço", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "http://localhost/segredo" } }));
    const { midia, conferirExterna } = preparar(fetchImpl);
    conferirExterna.mockImplementation(async (alvo) => { if (String(alvo).includes("localhost")) throw new Error("rede interna"); });
    await expect(midia.baixar("https://cdn.example/x.pdf")).rejects.toThrow("rede interna");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
