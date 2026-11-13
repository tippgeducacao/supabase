import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Falha do banco ao ler a integração não pode virar 404 "não existe": o site só repete em 503.
const cliente = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("https://esm.sh/@supabase/supabase-js@2.49.4", () => ({ createClient: () => cliente }));
let atender: (req: Request) => Promise<Response>;

beforeAll(async () => {
  vi.stubGlobal("Deno", {
    env: { get: () => "valor-sintetico" },
    serve: (handler: typeof atender) => { atender = handler; },
  });
  await import("./index.ts");
});
afterAll(() => vi.unstubAllGlobals());

function leituraDaIntegracao(resultado: { data: unknown; error: unknown }) {
  cliente.from.mockImplementation((tabela: string) => {
    if (tabela !== "crm_webhook_integrations") throw new Error(`Tabela não esperada: ${tabela}`);
    const consulta = { select: () => consulta, eq: () => consulta, maybeSingle: async () => resultado };
    return consulta;
  });
}

const enviar = () => atender(new Request("https://edge.invalid/crm-lead-webhook?int=teste", {
  method: "POST", headers: { "Content-Type": "application/json", "X-Webhook-Secret": "segredo-sintetico" },
  body: JSON.stringify({ nome: "Contato sintético", email: "sintetico@example.com" }),
}));

describe("leitura da integração", () => {
  it("banco falhou: 503, para o remetente tentar de novo", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    leituraDaIntegracao({ data: null, error: { message: "canceling statement due to statement timeout" } });
    const resposta = await enviar();
    expect(resposta.status).toBe(503);
    expect(await resposta.json()).toEqual({ error: "temporarily_unavailable" });
  });

  it("integração que não existe segue 404", async () => {
    leituraDaIntegracao({ data: null, error: null });
    const resposta = await enviar();
    expect(resposta.status).toBe(404);
    expect(await resposta.json()).toEqual({ error: "integration_not_found" });
  });
});
