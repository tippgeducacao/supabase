import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ambiente = vi.hoisted(() => ({ atender: undefined as undefined | ((req: Request) => Promise<Response>), from: vi.fn(), rpc: vi.fn() }));
vi.mock("https://deno.land/std@0.168.0/http/server.ts", () => ({ serve: (handler: typeof ambiente.atender) => { ambiente.atender = handler; } }));
vi.mock("https://esm.sh/@supabase/supabase-js@2", () => ({ createClient: () => ambiente }));

let gravacoes: Record<string, Array<Record<string, unknown>>>;
let existente: Record<string, unknown> | null;

beforeAll(async () => {
  vi.stubGlobal("Deno", { env: { get: () => "valor-sintetico" } });
  await import("./index.ts");
});
beforeEach(() => {
  vi.clearAllMocks();
  existente = null;
  gravacoes = {};
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Teste sem rede externa"); }));
  ambiente.rpc.mockImplementation(async () => ({ data: existente?.id ?? null, error: null }));
  ambiente.from.mockImplementation((tabela: string) => {
    let operacao = "select";
    const resposta = () => ({ data: operacao === "select" ? (tabela === "leads" ? existente : []) : { id: `${tabela}-1` }, error: null });
    const consulta = {
      select: () => consulta, eq: () => consulta,
      insert: (valor: Record<string, unknown> | Array<Record<string, unknown>>) => {
        operacao = "insert";
        (gravacoes[tabela] ??= []).push(...(Array.isArray(valor) ? valor : [valor]));
        return consulta;
      },
      update: (valor: Record<string, unknown>) => { operacao = "update"; (gravacoes[`${tabela}:update`] ??= []).push(valor); return consulta; },
      single: async () => resposta(), limit: async () => resposta(),
      then: (resolver: (valor: unknown) => unknown) => Promise.resolve(resposta()).then(resolver),
    };
    return consulta;
  });
});
afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function enviar(dados: Record<string, unknown>, query = "") {
  const resposta = await ambiente.atender!(new Request(`https://edge.invalid/webhook-leads${query}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nome: "Contato sintético", whatsapp: "46999999999", ...dados }),
  }));
  expect(resposta.status).toBe(200);
  expect(fetch).not.toHaveBeenCalled();
}

describe("webhook do sistema: rastreamento no entrypoint real", () => {
  it.each(["tiktok_aviario", "linkedin_ppgvet", "whatsapp_aves", "ig_petfood"])("URL-only %s não vira Google/organic e fica na captação", async fonte => {
    await enviar({ URL: `https://sanidade.ppgvet.com.br/?utm_source=${fonte}&utm_medium=bio&utm_campaign=sanidade&utm_content=video_1` });
    expect(gravacoes.leads[0]).toMatchObject({ utm_source: fonte, utm_medium: "bio", utm_campaign: "sanidade", utm_content: "video_1", fonte_referencia: fonte });
    expect(gravacoes.lead_oportunidades[0]).toMatchObject({ utm_source: fonte, utm_campaign: "sanidade" });
    expect(gravacoes.lead_webhook_logs[0]).toMatchObject({ utm_source: fonte });
  });

  it("ttclid isolado na query da requisição impede fallback orgânico e não é truncado", async () => {
    const ttclid = "x".repeat(700);
    await enviar({ URL: "https://sanidade.ppgvet.com.br/" }, `?ttclid=${ttclid}&utm_id=campanha`);
    expect(gravacoes.leads[0]).toMatchObject({ ttclid, utm_id: "campanha", utm_source: null, utm_medium: null });
    expect(gravacoes.leads[0].fonte_referencia).not.toBe("Google");
  });

  it("fallback GreatPages no corpo não esconde TikTok que chegou na URL", async () => {
    await enviar({ utm_source: " GreatPages ", URL: "https://sanidade.ppgvet.com.br/?utm_source=tiktok_aviario&utm_campaign=sanidade" });
    expect(gravacoes.leads[0]).toMatchObject({ utm_source: "tiktok_aviario", utm_campaign: "sanidade", fonte_referencia: "tiktok_aviario" });
    expect(gravacoes.lead_webhook_logs[0]).toMatchObject({ utm_source: "tiktok_aviario" });
    expect(gravacoes.lead_oportunidades[0]).toMatchObject({ utm_source: "tiktok_aviario" });
  });

  it("reentrada TikTok preserva Meta do contato e registra TikTok na nova oportunidade", async () => {
    existente = { id: "lead-antigo", fonte: "METAADS", utm_source: "facebook", utm_campaign: "campanha-antiga" };
    await enviar({ URL: "https://sanidade.ppgvet.com.br/?utm_source=tiktok&utm_campaign=nova&utm_content=video" });
    expect(gravacoes.leads).toBeUndefined();
    expect(gravacoes["leads:update"]).toBeUndefined();
    expect(gravacoes.lead_oportunidades[0]).toMatchObject({ lead_id: "lead-antigo", utm_source: "tiktok", utm_campaign: "nova" });
  });

  it("completa campos compatíveis do contato que já tinha a mesma campanha", async () => {
    existente = { id: "lead-antigo", utm_source: "tiktok", utm_campaign: "sanidade" };
    await enviar({ utm_source: "tiktok", utm_campaign: "sanidade", utm_content: "video", ttclid: "clique" });
    expect(gravacoes["leads:update"][0]).toMatchObject({ utm_content: "video", ttclid: "clique" });
    expect(gravacoes["leads:update"][0]).not.toHaveProperty("utm_source");
  });
});
