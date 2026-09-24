import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  ErroAcessoResultados,
  exigirAcessoResultados,
  respostaAcessoRecusado,
  type CriarClienteSupabase,
} from "./acessoResultadosAvaliacoes";

const AMBIENTE = { url: "https://api.exemplo", chavePublica: "chave-publica" };

function banco(opcoes: {
  sessaoInvalida?: boolean;
  anonimo?: boolean;
  getUserExplode?: boolean;
  pode?: unknown;
  rpcErro?: boolean;
} = {}) {
  const getUser = vi.fn().mockImplementation(async () => {
    if (opcoes.getUserExplode) throw new Error("rede");
    return {
      data: { user: opcoes.sessaoInvalida ? null : { id: "usuario", is_anonymous: !!opcoes.anonimo } },
      error: opcoes.sessaoInvalida ? { message: "jwt inválido" } : null,
    };
  });
  // `"pode" in opcoes`, e não `opcoes.pode ?? true`: o caso `pode: null` precisa chegar como null.
  const rpc = vi.fn().mockResolvedValue({
    data: opcoes.rpcErro ? null : ("pode" in opcoes ? opcoes.pode : true),
    error: opcoes.rpcErro ? { message: "permission denied for function" } : null,
  });
  const cliente = { auth: { getUser }, rpc } as unknown as SupabaseClient;
  const criarCliente = vi.fn(() => cliente) as unknown as CriarClienteSupabase & ReturnType<typeof vi.fn>;
  return { criarCliente, getUser, rpc };
}

describe("exigirAcessoResultados — resultados só para o Setor do Amanhã", () => {
  it.each([null, "", "Basic abc", "Bearer ", "Bearer duas palavras"])(
    "recusa com 401 sem token válido (%s), sem nem criar cliente",
    async (authorization) => {
      const b = banco();
      await expect(exigirAcessoResultados(authorization, b.criarCliente, AMBIENTE)).rejects.toMatchObject({ status: 401 });
      expect(b.criarCliente).not.toHaveBeenCalled();
    },
  );

  it("consulta COMO o usuário: chave pública + o token dele no Authorization", async () => {
    const b = banco();
    await exigirAcessoResultados("Bearer token-da-pessoa", b.criarCliente, AMBIENTE);
    expect(b.criarCliente).toHaveBeenCalledWith(
      "https://api.exemplo",
      "chave-publica",
      expect.objectContaining({ global: { headers: { Authorization: "Bearer token-da-pessoa" } } }),
    );
    expect(b.getUser).toHaveBeenCalledWith("token-da-pessoa");
    expect(b.rpc).toHaveBeenCalledWith("pode_ver_resultados_avaliacoes");
  });

  it.each([{ sessaoInvalida: true }, { anonimo: true }])("recusa com 401 sessão inválida ou anônima %j", async (opcoes) => {
    const b = banco(opcoes);
    await expect(exigirAcessoResultados("Bearer t", b.criarCliente, AMBIENTE)).rejects.toMatchObject({ status: 401 });
    expect(b.rpc).not.toHaveBeenCalled();
  });

  // Chave pública usada como token: o EXECUTE da função é só de `authenticated`.
  it("recusa (503) quando o banco nega a própria consulta — ex.: chamada com a chave pública", async () => {
    const b = banco({ rpcErro: true });
    await expect(exigirAcessoResultados("Bearer t", b.criarCliente, AMBIENTE)).rejects.toMatchObject({ status: 503 });
  });

  it("recusa (503) se não der para verificar a sessão", async () => {
    const b = banco({ getUserExplode: true });
    await expect(exigirAcessoResultados("Bearer t", b.criarCliente, AMBIENTE)).rejects.toMatchObject({ status: 503 });
  });

  it.each([false, null, "true", 1])("recusa com 403 quem não é membro do espaço (resposta %j)", async (pode) => {
    const b = banco({ pode });
    await expect(exigirAcessoResultados("Bearer t", b.criarCliente, AMBIENTE)).rejects.toMatchObject({ status: 403 });
  });

  it("libera só com true explícito", async () => {
    const b = banco({ pode: true });
    await expect(exigirAcessoResultados("Bearer t", b.criarCliente, AMBIENTE)).resolves.toBeUndefined();
  });
});

describe("respostaAcessoRecusado", () => {
  it("devolve o status do erro, a mensagem e os cabeçalhos de CORS", async () => {
    const r = respostaAcessoRecusado(new ErroAcessoResultados(403, "restrito"), { "Access-Control-Allow-Origin": "*" });
    expect(r.status).toBe(403);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await r.json()).toEqual({ error: "restrito" });
  });
});
