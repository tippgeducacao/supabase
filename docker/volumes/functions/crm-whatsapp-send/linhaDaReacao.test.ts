import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { linhaDaMensagemReagida } from "./linhaDaReacao.ts";

const transporte = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), fetch: vi.fn() }));
vi.mock("https://esm.sh/@supabase/supabase-js@2.49.4", () => ({
  createClient: () => ({ from: transporte.from, rpc: transporte.rpc, auth: { getUser: vi.fn() } }),
}));

/** Consulta encadeável do supabase-js: todo filtro devolve a própria consulta, que resolve `resultado`. */
function consulta(resultado: { data: unknown; error?: unknown }) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "not", "order", "limit", "insert", "upsert", "update"]) q[m] = vi.fn(() => q);
  q.maybeSingle = vi.fn(async () => resultado);
  q.then = (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) => Promise.resolve(resultado).then(ok, erro);
  return q;
}

function banco(tabelas: Record<string, { data: unknown; error?: unknown }>) {
  return {
    from: vi.fn((tabela: string) => {
      if (!(tabela in tabelas)) throw new Error(`Tabela inesperada: ${tabela}`);
      return consulta(tabelas[tabela]);
    }),
  };
}

describe("número da reação = número da conversa da mensagem reagida", () => {
  it("conversa do número oficial: reage pela conta dela", async () => {
    const db = banco({
      sac_mensagens: { data: [{ conversa_id: "conv-podcast" }] },
      sac_conversas: { data: { wa_account_id: "conta-podcast", wa_conexao_id: null } },
    });
    expect(await linhaDaMensagemReagida(db, "wamid.ALVO")).toEqual({ waAccountId: "conta-podcast", waConexaoId: null });
  });

  it("conversa da linha Web: reage pela linha dela", async () => {
    const db = banco({
      sac_mensagens: { data: [{ conversa_id: "conv-web" }] },
      sac_conversas: { data: { wa_account_id: null, wa_conexao_id: "linha-web" } },
    });
    expect(await linhaDaMensagemReagida(db, "3EB0ALVO")).toEqual({ waAccountId: null, waConexaoId: "linha-web" });
  });

  it("fora do SAC: usa a linha gravada na própria mensagem do CRM", async () => {
    const db = banco({
      sac_mensagens: { data: [] },
      crm_whatsapp_messages: { data: { wa_account_id: "conta-crm", wa_conexao_id: null } },
    });
    expect(await linhaDaMensagemReagida(db, "wamid.ALVO")).toEqual({ waAccountId: "conta-crm", waConexaoId: null });
  });

  it.each([
    ["mensagem desconhecida", { sac_mensagens: { data: [] }, crm_whatsapp_messages: { data: null } }],
    ["consulta quebrada", {}],
  ])("%s: devolve null e o envio segue a rota de antes", async (_caso, tabelas) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await linhaDaMensagemReagida(banco(tabelas), "wamid.ALVO")).toBeNull();
  });

  it("sem wamid nem consulta o banco", async () => {
    const db = banco({});
    expect(await linhaDaMensagemReagida(db, "  ")).toBeNull();
    expect(db.from).not.toHaveBeenCalled();
  });
});

describe("handler real: reação do SAC sai pelo número da conversa, não pela conta mais antiga", () => {
  let handler: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    vi.stubGlobal("Deno", {
      env: { get: (nome: string) => ({ SUPABASE_URL: "https://supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "servico-teste" })[nome] },
      serve: (callback: typeof handler) => { handler = callback; },
    });
    vi.stubGlobal("fetch", transporte.fetch);
    await import("./index");
  });
  afterAll(() => vi.unstubAllGlobals());
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    transporte.fetch.mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.REACAO" }] }), { status: 200 }));
    transporte.rpc.mockImplementation(async (nome: string, p: { p_account_id?: string | null }) =>
      nome === "get_crm_wa_account"
        ? { data: [{ id: p.p_account_id ?? "conta-ia-sdr", phone_number_id: `pnid-${p.p_account_id ?? "conta-ia-sdr"}`, access_token: "token" }], error: null }
        : { data: null, error: null });
    const tabelas: Record<string, { data: unknown }> = {
      crm_agente_sdr_config: { data: null },
      sac_mensagens: { data: [{ conversa_id: "conv-podcast" }] },
      sac_conversas: { data: { wa_account_id: "conta-podcast", wa_conexao_id: null } },
      crm_whatsapp_messages: { data: null },
      cliente_ppg_mensagens_sdr: { data: null },
    };
    transporte.from.mockImplementation((tabela: string) => consulta(tabelas[tabela] ?? { data: null }));
  });

  it("pede a conta da conversa e posta no phone_number_id dela", async () => {
    const resposta = await handler(new Request("https://supabase.invalid/functions/v1/crm-whatsapp-send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer servico-teste" },
      body: JSON.stringify({ telefone: "5517996444507", tipo: "reaction", conteudo: "❤️", reaction_message_id: "wamid.ALVO" }),
    }));
    expect(resposta.status).toBe(200);
    expect(transporte.rpc).toHaveBeenCalledWith("get_crm_wa_account", { p_account_id: "conta-podcast" });
    const [url, init] = transporte.fetch.mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v21.0/pnid-conta-podcast/messages");
    expect(JSON.parse(init.body)).toMatchObject({ type: "reaction", reaction: { message_id: "wamid.ALVO", emoji: "❤️" } });
  });
});
