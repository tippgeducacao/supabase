import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// `iniciar` cria a sessão e o contato do chat. O contato do anúncio precisa nascer com a
// UTM da URL da LP (diagnóstico de 03/10/2026: 36 contatos do TikTok em SEM UTM › Webchat).
// Nenhuma rede, banco ou modelo real participa: o cliente Supabase é simulado.
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  inserts: [] as Array<Record<string, unknown>>,
}));
vi.mock("https://esm.sh/@supabase/supabase-js@2.49.4", () => ({
  createClient: () => ({
    rpc: mocks.rpc,
    from: () => {
      const consulta: Record<string, unknown> = {};
      Object.assign(consulta, {
        select: () => consulta,
        eq: () => consulta,
        gte: async () => ({ count: 0, error: null }),
        insert: (valor: Record<string, unknown>) => { mocks.inserts.push(valor); return consulta; },
        single: async () => ({ data: { id: "00000000-0000-4000-8000-000000000009" }, error: null }),
        update: () => ({ eq: async () => ({ error: null }) }),
      });
      return consulta;
    },
  }),
}));
vi.mock("./agente.ts", () => ({
  responderWebchat: vi.fn(), aberturaWebchat: vi.fn(),
  WEBCHAT_TEMPLATE_CONTINUIDADE: "template_teste", WEBCHAT_WA_ACCOUNT_ID: "conta-teste",
  WHATSAPP_REENVIO_COOLDOWN_MIN: 10,
}));
vi.mock("./rodada.ts", () => ({ processarRodadaWebchat: vi.fn() }));
vi.mock("./continuidade.ts", () => ({ semearHistoricoWhatsApp: vi.fn() }));
vi.mock("../_shared/webchatPush.ts", () => ({ pushParaSessao: vi.fn() }));

let handler: (req: Request) => Promise<Response>;
beforeAll(async () => {
  vi.stubGlobal("Deno", {
    env: { get: (nome: string) => nome === "SUPABASE_URL" ? "https://supabase.invalid" : undefined },
    serve: (callback: typeof handler) => { handler = callback; },
  });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Teste não permite rede externa"); }));
  await import("./index");
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.inserts.length = 0;
});

const ttclid = "E_C_P_" + "x".repeat(330);
const origemUrl = "https://www.ppgvet.com.br/pos-clinica-e-cirurgia?utm_source=tiktok&utm_medium=paid"
  + "&utm_campaign=LP_LEAD_POS-CLINICACIRURGIA-COMERCIAL-mensal&utm_id=1876416498425186&ttclid=" + ttclid;

function iniciar(extra: Record<string, unknown> = {}) {
  return handler(new Request("https://supabase.invalid/functions/v1/crm-webchat", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ acao: "iniciar", nome: "Visitante Teste", telefone: "11987650231", pagina: "www.ppgvet.com.br", ...extra }),
  }));
}
const chamadasUpsert = () => mocks.rpc.mock.calls.filter(([nome]) => nome === "webchat_lead_upsert").map(([, args]) => args);

describe("iniciar: o contato do chat nasce com a UTM do anúncio", () => {
  it("passa a atribuição da URL ao webchat_lead_upsert e guarda a URL sem cortar o ttclid", async () => {
    mocks.rpc.mockResolvedValue({ data: "lead-1", error: null });
    expect((await iniciar({ origem_url: origemUrl })).status).toBe(200);
    expect(mocks.inserts[0].origem_url).toBe(origemUrl);
    expect(chamadasUpsert()).toEqual([expect.objectContaining({
      p_telefone: "11987650231",
      p_rastreamento: {
        utm_source: "tiktok", utm_medium: "paid", utm_campaign: "LP_LEAD_POS-CLINICACIRURGIA-COMERCIAL-mensal",
        utm_id: "1876416498425186", ttclid,
      },
    })]);
  });

  it("sem UTM na URL o rastreamento vai nulo", async () => {
    mocks.rpc.mockResolvedValue({ data: "lead-1", error: null });
    await iniciar({ origem_url: "https://www.ppgvet.com.br/" });
    expect(chamadasUpsert()).toEqual([expect.objectContaining({ p_rastreamento: null })]);
  });

  it("banco ainda sem o parâmetro novo: cria o contato pela assinatura antiga", async () => {
    mocks.rpc.mockImplementation(async (nome: string, args: Record<string, unknown>) =>
      nome === "webchat_lead_upsert" && "p_rastreamento" in args
        ? { data: null, error: { message: "Could not find the function public.webchat_lead_upsert" } }
        : { data: "lead-1", error: null });
    expect((await iniciar({ origem_url: origemUrl })).status).toBe(200);
    const chamadas = chamadasUpsert();
    expect(chamadas).toHaveLength(2);
    expect(chamadas[1]).not.toHaveProperty("p_rastreamento");
    expect(chamadas[1]).toMatchObject({ p_nome: "Visitante Teste", p_telefone: "11987650231" });
  });
});
