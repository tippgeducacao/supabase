import { describe, expect, it, vi } from "vitest";
import { criarHandlerImportarMaterialEmailIA } from "./handler";
const usuario = "11111111-1111-4111-8111-111111111111";
function fixture(opcoes: { ativo?: boolean; autorizado?: boolean; anonimo?: boolean } = {}) {
  const cliente = { auth: { getUser: vi.fn(async () => ({ data: { user: { id: usuario, is_anonymous: opcoes.anonimo } }, error: null })) },
    from: vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { ativo: opcoes.ativo !== false }, error: null }) }) }) })),
    rpc: vi.fn(async (_nome: string, _argumentos: unknown) => ({ data: opcoes.autorizado !== false, error: null })) };
  const rede = { resolver: vi.fn(async () => ["8.8.8.8"]), baixar: vi.fn(async () => ({ status: 200, headers: new Headers({ "content-type": "text/plain" }), corpo: new TextEncoder().encode("Material do curso para revisão humana.") })) };
  return { cliente, rede, handler: criarHandlerImportarMaterialEmailIA(cliente as unknown as Parameters<typeof criarHandlerImportarMaterialEmailIA>[0], rede) };
}
function req(corpo: unknown = { url: "https://curso.com/", usuario_esperado: usuario }, token = "teste") { return new Request("https://local/", { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {}, body: JSON.stringify(corpo) }); }
describe("acesso e limites da importação de material", () => {
  it("autentica e exige admin/diretor ativo antes de consultar DNS", async () => {
    for (const opcoes of [{ ativo: false }, { autorizado: false }, { anonimo: true }]) { const f = fixture(opcoes); expect((await f.handler(req())).status).toBe(opcoes.anonimo ? 401 : 403); expect(f.rede.resolver).not.toHaveBeenCalled(); }
    const f = fixture(); expect((await f.handler(req(undefined, ""))).status).toBe(401); expect(f.cliente.auth.getUser).not.toHaveBeenCalled();
  });
  it("recusa troca de conta ou usuário esperado ausente antes de baixar", async () => {
    for (const usuario_esperado of [undefined, "outra-conta"]) { const f = fixture(); expect((await f.handler(req({ url: "https://curso.com", usuario_esperado }))).status).toBe(409); expect(f.rede.resolver).not.toHaveBeenCalled(); }
  });
  it("retorna só material revisável, sem consumo da cota de IA", async () => {
    const f = fixture(); const res = await f.handler(req()); expect(res.status).toBe(200); expect(await res.json()).toMatchObject({ material: { tipo: "url", truncado: false } });
    expect(f.cliente.rpc.mock.calls.every(c => c[0] === "has_role")).toBe(true);
  });
  it("limita5 tentativas por minuto e recusa6 antes da rede", async () => {
    const f = fixture(); for (let i = 0; i < 5; i++) expect((await f.handler(req())).status).toBe(200);
    const res = await f.handler(req()); expect(res.status).toBe(429); expect(res.headers.get("Retry-After")).toBe("60"); expect(f.rede.baixar).toHaveBeenCalledTimes(5);
  });
  it("limita o corpo mesmo sem Content-Length", async () => {
    const f = fixture(); expect((await f.handler(req({ url: "x".repeat(5000), usuario_esperado: usuario }))).status).toBe(413); expect(f.rede.resolver).not.toHaveBeenCalled();
  });
  it("teto global mantém no máximo4 importações simultâneas por worker", async () => {
    const f = fixture(); let liberar!: () => void; const espera = new Promise<void>(r => { liberar = r; });
    f.rede.baixar = vi.fn(async () => { await espera; return { status: 200, headers: new Headers({ "content-type": "text/plain" }), corpo: new TextEncoder().encode("Texto público do material importado.") }; });
    const pendentes = Array.from({ length: 4 }, () => f.handler(req()));
    await vi.waitFor(() => expect(f.rede.baixar).toHaveBeenCalledTimes(4)); expect((await f.handler(req())).status).toBe(429); liberar(); await Promise.all(pendentes);
  });
});
