import { describe, expect, it, vi } from "vitest";
import { criarHandlerControleCampanha } from "./handler";
import { respostaOpcoesCampanhas } from "../_shared/emailCampanhasCapacidades";

const USUARIO = "11111111-1111-4111-8111-111111111111";
function cenario(opcoes: { usuario?: boolean; ativo?: boolean; erroPerfil?: boolean } = {}) {
  const rpc = vi.fn(async () => ({ data: null, error: null }));
  const from = vi.fn(() => ({ select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: async () => ({ data: { ativo: opcoes.ativo ?? true }, error: opcoes.erroPerfil ? { message: "privado" } : null }) })) })) }));
  const criarCliente = vi.fn(() => ({ auth: { getUser: async () => ({ data: { user: opcoes.usuario === false ? null : { id: USUARIO } }, error: null }) }, rpc, from }));
  const buscar = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => respostaOpcoesCampanhas({}));
  const handler = criarHandlerControleCampanha({ criarCliente: criarCliente as unknown as Parameters<typeof criarHandlerControleCampanha>[0]["criarCliente"], url: "https://interno.test", apikey: "publica", buscar });
  const chamar = (body: unknown = { action: "consultar_capacidades", usuario_esperado: USUARIO }, auth = true, method = "POST") => handler(new Request("https://edge.test/control", {
    method, headers: { ...(auth ? { Authorization: "Bearer sessao" } : {}), "Content-Type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  }));
  return { chamar, rpc, from, buscar, criarCliente };
}
describe("controle autenticado e consulta de compatibilidade", () => {
  it("não chama RPC, fila ou provedor na consulta de capacidades", async () => {
    const c = cenario(); const resposta = await c.chamar();
    expect(resposta.status).toBe(200); expect(await resposta.json()).toEqual({ versao: 1, campanhas_ab: true });
    expect(c.from.mock.calls).toEqual([["profiles"]]); expect(c.rpc).not.toHaveBeenCalled();
    expect(c.buscar).toHaveBeenCalledTimes(2);
    for (const [, init] of c.buscar.mock.calls) expect(init?.method).toBe("OPTIONS");
  });
  it.each(["sem-sessao", "invalida", "inativa", "outra-conta", "conta-ausente", "perfil-indisponivel"])("recusa %s antes de sondar os workers", async tipo => {
    const c = cenario({ usuario: tipo !== "invalida", ativo: tipo !== "inativa", erroPerfil: tipo === "perfil-indisponivel" });
    const resposta = await c.chamar({ action: "consultar_capacidades", ...(tipo === "conta-ausente" ? {} : { usuario_esperado: tipo === "outra-conta" ? "outra" : USUARIO }) }, tipo !== "sem-sessao");
    expect(resposta.status).toBeGreaterThanOrEqual(400); expect(c.buscar).not.toHaveBeenCalled(); expect(c.rpc).not.toHaveBeenCalled();
  });
  it("capacidade incompatível retorna false sem tentar acionar o dispatcher", async () => {
    const c = cenario(); c.buscar.mockImplementation(async () => new Response("ok"));
    expect(await (await c.chamar()).json()).toEqual({ versao: 1, campanhas_ab: false });
    expect(c.rpc).not.toHaveBeenCalled();
  });
  it.each(["pausar", "retomar", "cancelar"])("preserva RPC de %s sem sondagem automática", async action => {
    const c = cenario(); expect((await c.chamar({ action, campanha_id: "campanha", usuario_esperado: USUARIO })).status).toBe(200);
    expect(c.rpc).toHaveBeenCalledWith("email_campanha_controlar", { p_usuario_esperado: USUARIO, p_campanha: "campanha", p_acao: action });
    expect(c.buscar).not.toHaveBeenCalled();
  });
  it("OPTIONS e métodos inválidos não consultam sessão nem banco", async () => {
    const c = cenario(); expect((await c.chamar({}, false, "OPTIONS")).status).toBe(200); expect((await c.chamar({}, false, "GET")).status).toBe(405);
    expect(c.criarCliente).not.toHaveBeenCalled(); expect(c.buscar).not.toHaveBeenCalled();
  });
});
