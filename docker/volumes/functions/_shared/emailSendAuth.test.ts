import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { autorizarEnvioEmail, conferirContaEnvioEmail } from "./emailSendAuth";

function banco(opcoes: { invalido?: boolean; anonimo?: boolean; ativo?: boolean; cargo?: string; falhaPermissao?: boolean } = {}) {
  const getUser = vi.fn().mockResolvedValue({ data: { user: opcoes.invalido ? null : { id: "usuario", is_anonymous: !!opcoes.anonimo } }, error: opcoes.invalido ? { message: "jwt privado" } : null });
  const consultas: string[] = [];
  const rpc = vi.fn().mockImplementation((_nome, args) => Promise.resolve({ data: args.role_name === (opcoes.cargo ?? "admin"), error: opcoes.falhaPermissao ? { message: "interno" } : null }));
  const cliente = { auth: { getUser }, rpc, from(tabela: string) { consultas.push(tabela); const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { ativo: opcoes.ativo !== false }, error: null }) }; return q; } } as unknown as SupabaseClient;
  return { cliente, getUser, consultas, rpc };
}
describe("autorização própria do envio sem depender do gateway", () => {
  it.each([null, "", "Basic token", "Bearer ", "Bearer duas palavras"])("recusa Authorization ausente ou malformado (%s) antes de consultar dados", async authorization => {
    const b = banco(); await expect(autorizarEnvioEmail(b.cliente, authorization)).rejects.toMatchObject({ status: 401 });
    expect(b.getUser).not.toHaveBeenCalled(); expect(b.consultas).toEqual([]);
  });
  it.each([{ invalido: true }, { anonimo: true }])("recusa sessão inválida ou anônima %j", async opcoes => {
    const b = banco(opcoes); await expect(autorizarEnvioEmail(b.cliente, "Bearer token")).rejects.toMatchObject({ status: 401 });
    expect(b.consultas).toEqual([]);
  });
  it.each([{ ativo: false }, { cargo: "vendedor" }])("recusa perfil inativo ou sem papel permitido %j", async opcoes => {
    await expect(autorizarEnvioEmail(banco(opcoes).cliente, "Bearer token")).rejects.toMatchObject({ status: 403 });
  });
  it.each(["admin", "diretor"])("preserva envio direto da sessão %s ativa", async cargo => {
    expect(await autorizarEnvioEmail(banco({ cargo }).cliente, "Bearer token")).toEqual({ usuarioId: "usuario", interno: false, authorization: "Bearer token" });
  });
  it("uma falha de permissão bloqueia sem vazar detalhes", async () => {
    await expect(autorizarEnvioEmail(banco({ falhaPermissao: true }).cliente, "Bearer token")).rejects.toMatchObject({ status: 503, code: "ACCESS_UNAVAILABLE" });
  });
  it("preserva somente a chave interna exata explicitamente autorizada", async () => {
    const b = banco({ invalido: true });
    expect(await autorizarEnvioEmail(b.cliente, "Bearer segredo-teste", { permitirInterno: true, chaveServico: "segredo-teste" })).toMatchObject({ usuarioId: null, interno: true });
    expect(b.getUser).not.toHaveBeenCalled(); expect(b.rpc).not.toHaveBeenCalled();
    await expect(autorizarEnvioEmail(b.cliente, "Bearer segredo-teste", { chaveServico: "segredo-teste" })).rejects.toMatchObject({ status: 401 });
    await expect(autorizarEnvioEmail(b.cliente, "Bearer segredo-teste-falso", { permitirInterno: true, chaveServico: "segredo-teste" })).rejects.toMatchObject({ status: 401 });
  });
  it("conta esperada impede resposta de outra sessão e preserva callers internos antigos", () => {
    expect(() => conferirContaEnvioEmail("outra", "usuario")).toThrow("conta mudou");
    expect(() => conferirContaEnvioEmail(undefined, null)).not.toThrow();
    expect(() => conferirContaEnvioEmail("usuario", "usuario")).not.toThrow();
  });
});
