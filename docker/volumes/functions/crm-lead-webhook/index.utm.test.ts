import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const cliente = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("https://esm.sh/@supabase/supabase-js@2.49.4", () => ({ createClient: () => cliente }));
let atender: (req: Request) => Promise<Response>;
let gravacoes: Record<string, Array<Record<string, unknown>>>;
let contato: Record<string, unknown> | null;
let integracao: Record<string, unknown>;
let logAnterior: Record<string, unknown> | null;

beforeAll(async () => {
  vi.stubGlobal("Deno", {
    env: { get: () => "valor-sintetico" },
    serve: (handler: typeof atender) => { atender = handler; },
  });
  await import("./index.ts");
});

beforeEach(() => {
  vi.clearAllMocks();
  contato = null;
  gravacoes = {};
  logAnterior = null;
  integracao = {
    id: "integracao-1", slug: "teste", nome: "Integração sintética", secret: "segredo-sintetico", ativa: true,
    config: {}, field_mapping: { nome: "lead.nome", email: "lead.email" },
  };
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Teste não permite rede externa"); }));
  cliente.rpc.mockImplementation(async (nome: string) => { throw new Error(`RPC não esperada: ${nome}`); });
  cliente.from.mockImplementation((tabela: string) => {
    if (!["crm_webhook_integrations", "crm_webhook_escutas", "leads", "lead_oportunidades", "crm_whatsapp_accounts", "crm_webhook_logs", "crm_lead_atividades"].includes(tabela)) throw new Error(`Tabela não esperada: ${tabela}`);
    let operacao = "select";
    const resultado = (unico = false) => {
      if (tabela === "crm_webhook_integrations") return { data: integracao, error: null };
      if (tabela === "leads") return { data: unico ? contato : contato ? [contato] : [], error: null };
      if (tabela === "crm_webhook_logs" && operacao === "select") return { data: logAnterior, error: null };
      return { data: operacao === "insert" ? { id: `${tabela}-1` } : unico ? null : [], error: null };
    };
    const consulta = {
      select: () => consulta, eq: () => consulta, gt: () => consulta, order: () => consulta, in: () => consulta,
      insert: (valor: Record<string, unknown>) => {
        operacao = "insert";
        (gravacoes[tabela] ??= []).push(valor);
        if (tabela === "leads") contato = { id: "lead-1", ...valor };
        return consulta;
      },
      update: (valor: Record<string, unknown>) => {
        operacao = "update";
        (gravacoes[`${tabela}:update`] ??= []).push(valor);
        if (tabela === "leads") contato = { ...contato, ...valor };
        return consulta;
      },
      single: async () => resultado(true), maybeSingle: async () => resultado(true), limit: () => consulta,
      then: (resolver: (valor: unknown) => unknown) => Promise.resolve(resultado()).then(resolver),
    };
    return consulta;
  });
});
afterAll(() => vi.unstubAllGlobals());

async function enviar(dados: Record<string, unknown>, query = "") {
  const resposta = await atender(new Request(`https://edge.invalid/crm-lead-webhook?int=teste${query}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Webhook-Secret": "segredo-sintetico" },
    body: JSON.stringify({ nome: "Contato sintético", email: "sintetico@example.com", ...dados }),
  }));
  expect(resposta.status).toBe(200);
  expect(fetch).not.toHaveBeenCalled();
}

describe("webhook integrado: captura UTM no entrypoint real", () => {
  it.each(["tiktok_aviario", "linkedin_ppgvet", "whatsapp_aves", "ig_petfood"])("captura URL-only %s sem exigir configuração de cada UTM", async fonte => {
    await enviar({ URL: `https://sanidade.ppgvet.com.br/?utm_source=${fonte}&utm_medium=bio&utm_campaign=sanidade&utm_content=video` });
    expect(gravacoes.leads[0]).toMatchObject({ utm_source: fonte, utm_medium: "bio", utm_campaign: "sanidade", utm_content: "video" });
    expect(gravacoes.lead_oportunidades[0]).toMatchObject({ utm_source: fonte, utm_medium: "bio", utm_campaign: "sanidade" });
  });

  it.each(["body", "query", "url", "mapeamento", "acao"])("preserva ttclid longo e utm_id enviados por %s", async modo => {
    const ttclid = "t".repeat(700);
    let body: Record<string, unknown> = {};
    let query = "";
    if (modo === "body") body = { ttclid, utm_id: "campanha" };
    if (modo === "query") query = `&ttclid=${ttclid}&utm_id=campanha`;
    if (modo === "url") body = { URL: `https://ppgvet.com.br/?ttclid=${ttclid}&utm_id=campanha` };
    if (modo === "mapeamento") {
      integracao.field_mapping = { nome: "lead.nome", email: "lead.email", "dados.clique": "lead.ttclid", identificador: "lead.utm_id" };
      body = { dados: { clique: ttclid }, identificador: "campanha" };
    }
    if (modo === "acao") {
      integracao.config = { acoes: { itens: [{ tipo: "salvar_utm", params: { ttclid: "{webhook=clique}", utm_id: "{webhook=identificador}" } }] } };
      body = { clique: ttclid, identificador: "campanha" };
    }
    await enviar(body, query);
    expect(gravacoes.leads[0]).toMatchObject({ ttclid, utm_id: "campanha" });
  });

  it("valor de salvar_utm continua com prioridade sobre o fallback da URL sem alterar payload auditado", async () => {
    integracao.config = { acoes: { itens: [{ tipo: "salvar_utm", params: { utm_source: "tiktok_ppgvet", utm_campaign: "{webhook=campanha}" } }] } };
    await enviar({ URL: "https://ppgvet.com.br/?utm_source=tiktok&utm_campaign=legado", campanha: "campanha-correta" });
    expect(gravacoes.leads[0]).toMatchObject({ utm_source: "tiktok_ppgvet", utm_campaign: "campanha-correta" });
    expect((gravacoes.crm_webhook_logs[0].payload as Record<string, unknown>).URL).toContain("utm_source=tiktok&utm_campaign=legado");
    expect(gravacoes.crm_webhook_logs[0].resultado).toMatchObject({ acoes_aplicadas: ["salvar_utm"] });
  });

  it("URL mapeada somente na Criação Automática também preserva UTM e clique", async () => {
    integracao.config = { criacaoAutomatica: { habilitada: true, campos: [{ campo: "lead.pagina_nome", valor: "{webhook=dados.url}" }] } };
    await enviar({ dados: { url: "https://ppgvet.com.br/?utm_source=tiktok&utm_campaign=sanidade&ttclid=clique" } });
    expect(gravacoes.leads[0]).toMatchObject({ utm_source: "tiktok", utm_campaign: "sanidade", ttclid: "clique" });
    expect(gravacoes.lead_oportunidades[0]).toMatchObject({ utm_source: "tiktok", utm_campaign: "sanidade" });
  });

  it("recadastro de Meta por TikTok mantém primeiro contato e atribui nova captação ao TikTok", async () => {
    contato = { id: "lead-antigo", nome: "Contato sintético", email: "sintetico@example.com", fonte: "METAADS", utm_source: "facebook", utm_campaign: "antiga" };
    await enviar({ URL: "https://ppgvet.com.br/?utm_source=tiktok&utm_campaign=nova&utm_content=video", ttclid: "novo-clique" });
    expect(gravacoes.leads).toBeUndefined();
    expect(gravacoes["leads:update"]).toBeUndefined();
    expect(gravacoes.lead_oportunidades[0]).toMatchObject({ lead_id: "lead-antigo", utm_source: "tiktok", utm_campaign: "nova" });
  });

  it("salvar_utm também não injeta conteúdo da nova campanha no primeiro contato", async () => {
    contato = { id: "lead-antigo", nome: "Contato sintético", email: "sintetico@example.com", utm_source: "tiktok", utm_campaign: "antiga" };
    integracao.config = { acoes: { itens: [{ tipo: "salvar_utm", params: { utm_source: "tiktok", utm_campaign: "nova", utm_content: "video-novo" } }] } };
    await enviar({});
    expect(gravacoes["leads:update"]).toBeUndefined();
    expect(contato).not.toHaveProperty("utm_content");
    expect(gravacoes.lead_oportunidades[0]).toMatchObject({ utm_source: "tiktok", utm_campaign: "nova" });
  });

  it.each(["mapeamento", "acao"])("log resolve campos personalizados via %s sem trocar a primeira aquisição Meta", async modo => {
    const primeiraAquisicao = { id: "lead-antigo", nome: "Contato sintético", email: "sintetico@example.com", fonte: "METAADS", utm_source: "facebook", utm_campaign: "campanha-antiga" };
    contato = { ...primeiraAquisicao };
    const campos = {
      utm_source: "canal", utm_medium: "midia", utm_campaign: "campanha",
      utm_content: "conteudo", utm_term: "termo", utm_id: "identificador", ttclid: "clique",
    };
    integracao.field_mapping = {
      nome: "lead.nome", email: "lead.email",
      "captacao.canal": "lead_op.utm_source", "captacao.midia": "lead_op.utm_medium", "captacao.campanha": "lead_op.utm_campaign",
      ...(modo === "mapeamento" ? Object.fromEntries(Object.entries(campos).map(([campo, chave]) => [`dados.${chave}`, `lead.${campo}`])) : {}),
    };
    if (modo === "acao") integracao.config = { acoes: { itens: [{ tipo: "salvar_utm", params: Object.fromEntries(Object.entries(campos).map(([campo, chave]) => [campo, `{webhook=dados.${chave}}`])) }] } };
    const payload = {
      dados: { canal: "tiktok", midia: "social", campanha: "sanidade", conteudo: "video_1", termo: "grupo_aves", identificador: "campanha_123", clique: "clique_novo" },
      captacao: { canal: "tiktok_aviario", midia: "paid_social", campanha: "sanidade_avicola" },
    };
    await enviar(payload);
    expect(contato).toEqual(primeiraAquisicao);
    expect(gravacoes["leads:update"]).toBeUndefined();
    expect(gravacoes.lead_oportunidades[0]).toMatchObject({ utm_source: "tiktok_aviario", utm_medium: "paid_social", utm_campaign: "sanidade_avicola" });
    expect(gravacoes.crm_webhook_logs[0].resultado).toMatchObject({
      rastreamento: { utm_source: "tiktok_aviario", utm_medium: "paid_social", utm_campaign: "sanidade_avicola", utm_content: "video_1", utm_term: "grupo_aves", utm_id: "campanha_123", ttclid: "clique_novo" },
    });
    expect(gravacoes.crm_webhook_logs[0].payload).toEqual({ nome: "Contato sintético", email: "sintetico@example.com", ...payload });
  });

  it("reenvio antecipado copia rastreamento da entrega original sem executar novamente o mapeamento ou consultar contato", async () => {
    const rastreamento = { utm_source: "tiktok_aviario", utm_campaign: "primeira_entrega", utm_content: "video_1", ttclid: "clique-original" };
    logAnterior = { id: "log-original", criado_em: "2026-09-10T12:00:00Z", resultado: { rastreamento } };
    integracao.config = { acoes: { itens: [{ tipo: "salvar_utm", params: { utm_source: "linkedin", utm_campaign: "config_alterada" } }] } };
    await enviar({ dados_completos: { id: "submissao-original" } });
    expect(gravacoes.crm_webhook_logs[0].resultado).toMatchObject({ reenvio_ignorado: true, processado: false, chegada_anterior_log_id: "log-original", rastreamento });
    expect(gravacoes.leads).toBeUndefined();
    expect(cliente.from.mock.calls.map(([tabela]) => tabela)).toEqual(["crm_webhook_integrations", "crm_webhook_escutas", "crm_webhook_logs", "crm_webhook_logs"]);
  });

  it("reenvio de log legado sem snapshot não inventa atribuição com o config atual", async () => {
    logAnterior = { id: "log-legado", criado_em: "2026-09-09T12:00:00Z", resultado: {} };
    integracao.config = { acoes: { itens: [{ tipo: "salvar_utm", params: { utm_source: "tiktok" } }] } };
    await enviar({ dados_completos: { id: "submissao-legada" } });
    expect(gravacoes.crm_webhook_logs[0].resultado).not.toHaveProperty("rastreamento");
    expect(cliente.from.mock.calls.map(([tabela]) => tabela)).toEqual(["crm_webhook_integrations", "crm_webhook_escutas", "crm_webhook_logs", "crm_webhook_logs"]);
  });
});
