import { describe, expect, it, vi } from "vitest";
import { autenticarDispatcher } from "./autenticacao.ts";
describe("autenticação do cron de campanhas", () => {
  it("requisição pública e JWT anon não consultam nem processam campanhas", async () => {
    const cliente = { rpc: vi.fn() };
    for (const headers of [{}, { Authorization: "Bearer anon-publico" }, { "x-email-cron-secret": "curto" }]) {
      expect(await autenticarDispatcher(new Request("https://example.invalid", { headers }), cliente, "servico-privado")).toBe(false);
    }
    expect(cliente.rpc).not.toHaveBeenCalled();
  });
  it("service_role interno pode executar sem segredo de cron", async () => {
    const cliente = { rpc: vi.fn() };
    expect(await autenticarDispatcher(new Request("https://example.invalid", { headers: { Authorization: "Bearer servico-privado" } }), cliente, "servico-privado")).toBe(true);
    expect(cliente.rpc).not.toHaveBeenCalled();
  });
  it("segredo precisa ser confirmado pela RPC privada", async () => {
    const req = new Request("https://example.invalid", { headers: { "x-email-cron-secret": "a".repeat(64) } });
    expect(await autenticarDispatcher(req, { rpc: vi.fn(async () => ({ data: true, error: null })) }, "servico")).toBe(true);
    expect(await autenticarDispatcher(req, { rpc: vi.fn(async () => ({ data: false, error: null })) }, "servico")).toBe(false);
    expect(await autenticarDispatcher(req, { rpc: vi.fn(async () => ({ data: true, error: { message: "offline" } })) }, "servico")).toBe(false);
    expect(await autenticarDispatcher(req, { rpc: vi.fn(async () => { throw new Error("offline"); }) }, "servico")).toBe(false);
  });
});
