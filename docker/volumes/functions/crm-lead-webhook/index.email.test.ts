import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const cliente = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("https://esm.sh/@supabase/supabase-js@2.49.4", () => ({ createClient: () => cliente }));
const INTEGRACAO = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const TEMPLATE = "33333333-3333-4333-8333-333333333333";
const REMETENTE = "44444444-4444-4444-8444-444444444444";
const LOG = "55555555-5555-4555-8555-555555555555";
type Registro = Record<string, unknown>;
let atender: (req: Request) => Promise<Response>;
let integracao: Registro;
let contato: Registro | null;
let gravacoes: Record<string, Registro[]>;
let reservas: Map<string, Registro>;
let saidas: Registro[];
let respostaEnvio: Registro;
let falhaEnvio: boolean;

beforeAll(async () => {
  vi.stubGlobal("Deno", { env: { get: (nome: string) => nome === "SUPABASE_URL" ? "https://backend.invalid" : "segredo-sintetico" }, serve: (handler: typeof atender) => { atender = handler; } });
  await import("./index.ts");
});
afterAll(() => vi.unstubAllGlobals());

const email = () => ({ id: "acao-email", tipo: "enviar_email", params: { template_id: TEMPLATE, remetente_id: REMETENTE, variaveis: {} } });
const atualizar = (campo: string, valor: string) => ({ id: "acao-editar", tipo: "atualizar_lead", params: { campos: [{ campo, valor }] } });

beforeEach(() => {
  vi.clearAllMocks();
  contato = null;
  gravacoes = {};
  reservas = new Map();
  saidas = [];
  respostaEnvio = { ok: true, log_id: LOG };
  falhaEnvio = false;
  integracao = { id: INTEGRACAO, slug: "teste", nome: "Integração sintética", secret: "segredo-sintetico", ativa: true,
    field_mapping: { nome: "lead.nome", email: "lead.email" }, config: { acoes: { itens: [email()] } } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe("https://backend.invalid/functions/v1/email-send");
    saidas.push(JSON.parse(String(init.body)));
    if (falhaEnvio) throw new Error("timeout sintético, sem rede");
    return Response.json(respostaEnvio);
  }));
  cliente.rpc.mockImplementation(async (nome: string) => { throw new Error(`RPC não esperada: ${nome}`); });
  cliente.from.mockImplementation((tabela: string) => {
    if (!["crm_webhook_integrations", "crm_webhook_escutas", "leads", "lead_oportunidades", "crm_whatsapp_accounts", "crm_webhook_logs", "crm_lead_atividades", "email_templates", "email_remetentes", "crm_webhook_email_envios"].includes(tabela)) throw new Error(`Tabela não esperada: ${tabela}`);
    let operacao = "select";
    let error: { code: string } | null = null;
    let valorEscrito: Registro = {};
    const resultado = (unico = false) => {
      if (error) return { data: null, error };
      if (tabela === "crm_webhook_integrations") return { data: integracao, error: null };
      if (tabela === "leads") return { data: unico ? contato : contato ? [contato] : [], error: null };
      if (tabela === "email_templates") return { data: { id: TEMPLATE, ativo: true, assunto: "Olá {{primeiro_nome}}", corpo_html: "<p>Olá {{nome}}, sua inscrição chegou.</p>", corpo_texto: null, uso: "marketing" }, error: null };
      if (tabela === "email_remetentes") return { data: { id: REMETENTE, ativo: true, provider: "resend", dominio_verificado: true }, error: null };
      if (tabela === "crm_webhook_email_envios") return { data: valorEscrito, error: null };
      return { data: operacao === "insert" ? { id: LEAD } : unico ? null : [], error: null };
    };
    const consulta = {
      select: () => consulta, eq: () => consulta, gt: () => consulta, order: () => consulta, in: () => consulta, limit: () => consulta,
      insert: (valor: Registro) => {
        operacao = "insert";
        valorEscrito = valor;
        (gravacoes[tabela] ??= []).push(valor);
        if (tabela === "leads") contato = { id: LEAD, ...valor };
        if (tabela === "crm_webhook_email_envios") {
          const chave = String(valor.chave);
          if (reservas.has(chave)) error = { code: "23505" };
          else reservas.set(chave, valor);
        }
        return consulta;
      },
      update: (valor: Registro) => {
        operacao = "update";
        valorEscrito = valor;
        (gravacoes[`${tabela}:update`] ??= []).push(valor);
        if (tabela === "leads") contato = { ...contato, ...valor };
        return consulta;
      },
      single: async () => resultado(true), maybeSingle: async () => resultado(true),
      then: (resolver: (v: unknown) => unknown) => Promise.resolve(resultado()).then(resolver),
    };
    return consulta;
  });
});

async function captar() {
  const resposta = await atender(new Request("https://backend.invalid/crm-lead-webhook?int=teste", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Webhook-Secret": "segredo-sintetico" },
    body: JSON.stringify({ nome: "Maria Silva", email: "recebido@example.com" }),
  }));
  expect(resposta.status).toBe(200);
  return await resposta.json();
}

describe("envio de e-mail no entrypoint do webhook", () => {
  it("envia ao endereço persistido após a edição anterior e preserva modelo/remetente no log", async () => {
    integracao.config = { acoes: { itens: [atualizar("lead.email", "corrigido@example.com"), email()] } };
    const corpo = await captar();
    expect(corpo).toMatchObject({ ok: true, lead_id: LEAD, acoes_aplicadas: ["atualizar_lead", "enviar_email"],
      acoes_email_resultados: [{ acao_id: "acao-email", status: "enviado", log_id: LOG }] });
    expect(saidas).toHaveLength(1);
    expect(saidas[0]).toMatchObject({ destinatario_email: "corrigido@example.com", template_id: TEMPLATE, remetente_id: REMETENTE, contexto_tipo: "webhook" });
    expect(gravacoes.crm_webhook_logs.at(-1)?.resultado).toMatchObject({ acoes_email_resultados: corpo.acoes_email_resultados });
  });

  it("respeita a ordem: uma edição posterior não altera o destinatário do envio anterior", async () => {
    integracao.config = { acoes: { itens: [email(), atualizar("lead.email", "posterior@example.com")] } };
    await captar();
    expect(saidas[0].destinatario_email).toBe("recebido@example.com");
    expect(contato?.email).toBe("posterior@example.com");
  });

  it("supressão registra resultado e continua as outras ações sem declarar envio", async () => {
    respostaEnvio = { ok: false, suprimido: true };
    integracao.config = { acoes: { itens: [email(), atualizar("lead.nome", "Nome corrigido")] } };
    const corpo = await captar();
    expect(corpo.acoes_aplicadas).toEqual(["atualizar_lead"]);
    expect(corpo.acoes_email_resultados).toEqual([{ acao_id: "acao-email", status: "suprimido", motivo: "destinatario_suprimido" }]);
    expect(contato?.nome).toBe("Nome corrigido");
    expect(gravacoes.crm_lead_atividades.filter(a => a.titulo === "E-mail da integração enviado")).toHaveLength(0);
  });

  it("timeout preserva a captação, executa a próxima ação e bloqueia repetição", async () => {
    falhaEnvio = true;
    integracao.config = { acoes: { itens: [email(), atualizar("lead.nome", "Nome corrigido")] } };
    const corpo = await captar();
    expect(corpo).toMatchObject({ ok: true, lead_id: LEAD, acoes_aplicadas: ["atualizar_lead"] });
    expect(corpo.acoes_email_resultados[0]).toMatchObject({ status: "erro", motivo: "resultado_desconhecido" });
    expect(contato?.nome).toBe("Nome corrigido");
    expect((await captar()).acoes_email_resultados[0].status).toBe("duplicado");
    expect(saidas).toHaveLength(1);
  });

  it("webhook legado sem ação não consulta modelos/reservas nem altera seu retorno", async () => {
    integracao.config = {};
    const corpo = await captar();
    expect(corpo).not.toHaveProperty("acoes_email_resultados");
    expect(saidas).toHaveLength(0);
    expect(cliente.from.mock.calls.some(([t]) => ["email_templates", "email_remetentes", "crm_webhook_email_envios"].includes(t))).toBe(false);
  });
});
