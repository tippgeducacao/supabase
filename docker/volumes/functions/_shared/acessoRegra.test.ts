import { describe, expect, it } from "vitest";
import { AcessoNegado, decidirAcesso, iguaisEmTempoConstante, type DependenciasAcesso } from "./acessoRegra";

const SERVICO = "chave-de-servico";
const ANON = "chave-anon-publica";

function cab(auth?: string, extra: Record<string, string> = {}) {
  return { authorization: auth ?? null, get: (n: string) => extra[n.toLowerCase()] ?? null };
}

function deps(over: Partial<DependenciasAcesso> = {}): DependenciasAcesso {
  return {
    chaveServico: SERVICO,
    chaveAnon: ANON,
    usuarioDoToken: async (t) => (t === "token-da-maria" ? { id: "maria", anonimo: false } : null),
    rpcComoUsuario: async () => true,
    ...over,
  };
}

async function status(p: Promise<unknown>): Promise<number | string> {
  try {
    const r = (await p) as { tipo: string };
    return r.tipo;
  } catch (e) {
    return e instanceof AcessoNegado ? e.status : "outro";
  }
}

describe("conferência de acesso das edges (29/10/2026)", () => {
  it("sem credencial: 401", async () => {
    expect(await status(decidirAcesso(cab(), { usuario: true, servico: true }, deps()))).toBe(401);
  });

  it("chave pública (anon) NUNCA vale como login", async () => {
    expect(await status(decidirAcesso(cab(`Bearer ${ANON}`), { usuario: true }, deps()))).toBe(401);
    expect(await status(decidirAcesso(cab(`Bearer ${ANON}`), { servico: true }, deps()))).toBe(401);
  });

  it("'Bearer qualquer-coisa' não passa", async () => {
    expect(await status(decidirAcesso(cab("Bearer x"), { usuario: true, servico: true }, deps()))).toBe(401);
  });

  it("chave de serviço exata passa só quando servico=true", async () => {
    expect(await status(decidirAcesso(cab(`Bearer ${SERVICO}`), { servico: true }, deps()))).toBe("servico");
    expect(await status(decidirAcesso(cab(`Bearer ${SERVICO}x`), { servico: true }, deps()))).toBe(401);
  });

  it("usuário logado passa só quando usuario=true", async () => {
    expect(await status(decidirAcesso(cab("Bearer token-da-maria"), { usuario: true }, deps()))).toBe("usuario");
    expect(await status(decidirAcesso(cab("Bearer token-da-maria"), { servico: true }, deps()))).toBe(401);
  });

  it("usuário anônimo do GoTrue não passa", async () => {
    const d = deps({ usuarioDoToken: async () => ({ id: "x", anonimo: true }) });
    expect(await status(decidirAcesso(cab("Bearer t"), { usuario: true }, d))).toBe(401);
  });

  it("permissão por RPC: 403 quando false, 503 quando não deu para conferir", async () => {
    const nega = deps({ rpcComoUsuario: async () => false });
    expect(await status(decidirAcesso(cab("Bearer token-da-maria"), { usuario: true, rpcPermissao: "is_financial_user" }, nega))).toBe(403);
    const falha = deps({ rpcComoUsuario: async () => null });
    expect(await status(decidirAcesso(cab("Bearer token-da-maria"), { usuario: true, rpcPermissao: "is_financial_user" }, falha))).toBe(503);
  });

  it("falha ao conferir a sessão vira 503, não acesso liberado", async () => {
    const d = deps({ usuarioDoToken: async () => { throw new Error("rede"); } });
    expect(await status(decidirAcesso(cab("Bearer t"), { usuario: true }, d))).toBe(503);
  });

  it("segredo de cabeçalho passa só com o valor certo e configurado", async () => {
    const op = { segredo: { cabecalho: "x-chave-cron", valor: "s3gr3do" } };
    expect(await status(decidirAcesso(cab(undefined, { "x-chave-cron": "s3gr3do" }), op, deps()))).toBe("segredo");
    expect(await status(decidirAcesso(cab(undefined, { "x-chave-cron": "errado" }), op, deps()))).toBe(401);
    const semValor = { segredo: { cabecalho: "x-chave-cron", valor: "" } };
    expect(await status(decidirAcesso(cab(undefined, { "x-chave-cron": "" }), semValor, deps()))).toBe(401);
  });

  it("cabeçalho de cron sem segredo não vale nada", async () => {
    expect(await status(decidirAcesso(cab(undefined, { "x-trigger": "cron" }), { usuario: true, servico: true }, deps()))).toBe(401);
  });

  it("comparação em tempo constante", () => {
    expect(iguaisEmTempoConstante("abc", "abc")).toBe(true);
    expect(iguaisEmTempoConstante("abc", "abd")).toBe(false);
    expect(iguaisEmTempoConstante("abc", "abcd")).toBe(false);
    expect(iguaisEmTempoConstante("", "")).toBe(false);
  });
});
