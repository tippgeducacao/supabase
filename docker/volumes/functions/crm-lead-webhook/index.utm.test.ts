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
  return resposta.json();
}

describe("webhook integrado: captura UTM no entrypoint real", () => {
  const BRUNO = "00000000-0000-4000-8000-0000000b2b01";
  const configEmpresa = (comAcao = true) => ({
    criacaoAutomaticaEmpresa: { habilitada: true, campos: [
      { id: "c1", campo: "nome", valor: "{webhook=Empresa}" },
      { id: "c2", campo: "dominio", valor: "{webhook=Site}" },
      { id: "c3", campo: "cidade", valor: "{webhook=Cidade_da_empresa}" },
    ] },
    acoes: { itens: comAcao ? [{ id: "acao-empresa", tipo: "criar_oportunidade", params: {
      entidade: "empresa", titulo: "", funilId: "funil-empresa", etapaId: "lead-geral",
      responsavel: { estrategia: "usuario", usuarioId: BRUNO },
    } }] : [] },
  });
  const rpcEmpresa = (vincular: unknown, card: unknown = { data: { empresa_id: "empresa-1", oportunidade_id: "card-b2b", oportunidade_criada: false }, error: null }) =>
    cliente.rpc.mockImplementation(async (nome: string) => {
      if (nome === "crm_webhook_empresa_vincular") { if (vincular instanceof Error) throw vincular; return vincular; }
      if (nome === "crm_webhook_empresa_oportunidade") return card;
      throw new Error(`RPC não esperada: ${nome}`);
    });
  async function enviarCru(dados: Record<string, unknown>) {
    return atender(new Request("https://edge.invalid/crm-lead-webhook?int=teste", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Webhook-Secret": "segredo-sintetico" },
      body: JSON.stringify({ nome: "Participante", email: "sintetico@example.invalid", ...dados }),
    }));
  }

  it("cria/localiza a empresa pela aba, abre o card B2B e devolve os dois no recibo", async () => {
    integracao.config = configEmpresa();
    rpcEmpresa({ data: { empresa_id: "empresa-1", empresa_criada: true, via: "criada", campos_preenchidos: ["dominio"], campos_invalidos: [] }, error: null });
    const r = await enviar({ Empresa: "Cooperativa sintética", Site: "cooperativa.example", Cidade_da_empresa: "", dados_completos: { id: "evento-1" } });
    expect(r).toMatchObject({ ok: true, empresa_id: "empresa-1", oportunidade_id: "card-b2b" });
    expect(cliente.rpc).toHaveBeenCalledWith("crm_webhook_empresa_vincular", expect.objectContaining({
      p_lead_id: "lead-1", p_nome_empresa: "Cooperativa sintética", p_campos: { dominio: "cooperativa.example" },
      p_funil_id: "funil-empresa", p_evento_id: "evento-1", p_responsavel_id: BRUNO, p_integration_id: "integracao-1",
    }));
    expect(cliente.rpc).toHaveBeenCalledWith("crm_webhook_empresa_oportunidade", expect.objectContaining({
      p_lead_id: "lead-1", p_empresa_id: "empresa-1", p_funil_id: "funil-empresa", p_etapa_id: "lead-geral",
      p_acao_id: "acao-empresa", p_empresa_criada: true, p_responsavel_id: BRUNO,
    }));
    // O card do contato (crm_oportunidades) não é tocado: o negócio é da empresa.
    expect(gravacoes.crm_oportunidades).toBeUndefined();
    expect(gravacoes.crm_webhook_logs.at(-1)).toMatchObject({ status: "ok", resultado: {
      empresa_id: "empresa-1", oportunidade_id: "card-b2b", oportunidade_empresa_id: "card-b2b",
      acoes_aplicadas: expect.arrayContaining(["criacao_empresa", "criar_oportunidade_empresa"]),
    } });
  });

  it("confirmação sem o campo Empresa manda nome vazio e deixa o banco reencontrar o vínculo", async () => {
    integracao.config = configEmpresa();
    rpcEmpresa({ data: { empresa_id: "empresa-1", empresa_criada: false, via: "vinculo" }, error: null });
    const r = await enviar({});
    expect(r).toMatchObject({ ok: true, empresa_id: "empresa-1" });
    expect(cliente.rpc).toHaveBeenCalledWith("crm_webhook_empresa_vincular", expect.objectContaining({ p_nome_empresa: null, p_campos: {} }));
    expect(cliente.rpc).toHaveBeenCalledWith("crm_webhook_empresa_oportunidade", expect.objectContaining({ p_empresa_criada: false }));
  });

  it("sem empresa identificável não devolve sucesso falso e o log fica como erro", async () => {
    integracao.config = configEmpresa();
    rpcEmpresa({ data: null, error: { message: "EMPRESA_NAO_INFORMADA" } });
    const resposta = await enviarCru({});
    expect(resposta.status).toBe(422);
    expect(await resposta.json()).toMatchObject({ ok: false, codigo: "EMPRESA_NAO_INFORMADA", lead_id: "lead-1", empresa_pendente: true });
    expect(gravacoes.crm_webhook_logs.at(-1)).toMatchObject({ status: "erro", resultado: { lead_id: "lead-1", empresa: { pendente: true, codigo: "EMPRESA_NAO_INFORMADA" } } });
    expect(cliente.rpc).not.toHaveBeenCalledWith("crm_webhook_empresa_oportunidade", expect.anything());
  });

  it("empresa homônima pede revisão (409) em vez de escolher uma", async () => {
    integracao.config = configEmpresa();
    rpcEmpresa({ data: null, error: { message: "EMPRESA_AMBIGUA", details: "id-a,id-b" } });
    const resposta = await enviarCru({ Empresa: "Cooperativa" });
    expect(resposta.status).toBe(409);
    expect(gravacoes.crm_webhook_logs.at(-1)).toMatchObject({ status: "erro", resultado: { empresa: { codigo: "EMPRESA_AMBIGUA", detalhe: "id-a,id-b" } } });
  });

  it("pessoa já ligada à empresa A informa B desconhecida: 409 sem card e sem revelar A", async () => {
    integracao.config = configEmpresa();
    rpcEmpresa({ data: null, error: { message: "EMPRESA_DIVERGENTE", details: "empresa-a" } });
    const resposta = await enviarCru({ Empresa: "Empresa B sintética" });
    expect(resposta.status).toBe(409);
    const corpo = await resposta.json();
    expect(corpo).toMatchObject({ ok: false, codigo: "EMPRESA_DIVERGENTE", lead_id: "lead-1", empresa_pendente: true });
    expect(JSON.stringify(corpo)).not.toContain("empresa-a");
    expect(cliente.rpc).not.toHaveBeenCalledWith("crm_webhook_empresa_oportunidade", expect.anything());
    // O time revisa pelo log: código, empresa já vinculada e o nome que veio no envio.
    expect(gravacoes.crm_webhook_logs.at(-1)).toMatchObject({
      status: "erro", resultado: { empresa: { pendente: true, codigo: "EMPRESA_DIVERGENTE", detalhe: "empresa-a" } },
      payload: expect.objectContaining({ Empresa: "Empresa B sintética" }),
    });
  });

  it("só a aba com empresa divergente segue como enriquecimento (200, pendente no log)", async () => {
    integracao.config = configEmpresa(false);
    rpcEmpresa({ data: null, error: { message: "EMPRESA_DIVERGENTE", details: "empresa-a" } });
    const r = await enviar({ Empresa: "Empresa B sintética" });
    expect(r).toMatchObject({ ok: true, lead_id: "lead-1" });
    expect(JSON.stringify(r)).not.toContain("empresa-a");
    expect(gravacoes.crm_webhook_logs.at(-1)).toMatchObject({ status: "ok", resultado: { empresa: { pendente: true, codigo: "EMPRESA_DIVERGENTE" } } });
  });

  it("falha passageira (rede) responde 503 para o retry concluir", async () => {
    integracao.config = configEmpresa();
    rpcEmpresa(new Error("Rede indisponível"));
    const resposta = await enviarCru({ Empresa: "Empresa sintética" });
    expect(resposta.status).toBe(503);
    expect(await resposta.json()).toMatchObject({ ok: false, codigo: "EMPRESA_INDISPONIVEL" });
  });

  it("card falhou depois de vincular a empresa: também não é sucesso", async () => {
    integracao.config = configEmpresa();
    rpcEmpresa({ data: { empresa_id: "empresa-1", empresa_criada: false }, error: null }, { data: null, error: { message: "EMPRESA_ARQUIVADA" } });
    const resposta = await enviarCru({ Empresa: "Empresa sintética" });
    expect(resposta.status).toBe(409);
    expect(gravacoes.crm_webhook_logs.at(-1)).toMatchObject({ status: "erro" });
  });

  it("só a aba (sem card de empresa) é enriquecimento: falha não derruba o contato", async () => {
    integracao.config = configEmpresa(false);
    rpcEmpresa({ data: null, error: { message: "EMPRESA_NAO_INFORMADA" } });
    const r = await enviar({});
    expect(r).toMatchObject({ ok: true, lead_id: "lead-1" });
    expect(r.empresa_id).toBeUndefined();
    expect(gravacoes.crm_webhook_logs.at(-1)).toMatchObject({ status: "ok", resultado: { empresa: { pendente: true } } });
  });

  it("integração de contato (sem aba nem ação de empresa) não chama nada de empresa", async () => {
    integracao.config = { criacaoAutomaticaEmpresa: { habilitada: false, campos: [{ id: "c1", campo: "nome", valor: "{webhook=Empresa}" }] } };
    const r = await enviar({ Empresa: "Qualquer" });
    expect(r).toMatchObject({ ok: true });
    expect(cliente.rpc).not.toHaveBeenCalled();
  });

  it("reenvio do Fórum devolve o recibo original sem executar o intake outra vez", async () => {
    integracao.config = { retornarReciboReenvio: true };
    logAnterior = { id: "log-original", resultado: { lead_id: "contato-original", oportunidade_id: "card-original", empresa_id: "empresa-original" } };
    const resultado = await enviar({ dados_completos: { id: "envio-original" } });
    expect(resultado).toMatchObject({ ok: true, reenvio_ignorado: true, lead_id: "contato-original", oportunidade_id: "card-original", empresa_id: "empresa-original" });
    expect(gravacoes.leads).toBeUndefined();
    expect(gravacoes.lead_oportunidades).toBeUndefined();
  });
  it("marca o Fórum sem substituir o nome já cadastrado e sem duplicar no retorno", async () => {
    contato = { id: "lead-antigo", nome: "Maria Souza", email: "sintetico@example.com" };
    integracao.config = { prefixoNome: "FÓRUM" };
    await enviar({ nome: "Maria" });
    expect(contato?.nome).toBe("FÓRUM Maria Souza");
    gravacoes = {};
    await enviar({ nome: "FÓRUM Maria" });
    expect(gravacoes["leads:update"]).toBeUndefined();
  });

  it("cria o contato do Fórum com o prefixo exigido pela direção", async () => {
    integracao.config = { prefixoNome: "FÓRUM" };
    await enviar({ nome: "Maria Souza" });
    expect(contato?.nome).toBe("FÓRUM Maria Souza");
  });
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

  it("captação do chat da LP lê a UTM de origem_url sem trocar a página do contato", async () => {
    const origem = "https://www.ppgvet.com.br/pos-clinica-e-cirurgia?utm_source=tiktok&utm_medium=paid&utm_campaign=LP_LEAD_POS-CLINICACIRURGIA-COMERCIAL-mensal&utm_id=1876&ttclid=clique-chat";
    await enviar({ telefone: "11999998888", curso: "Clínica Médica", fonte: "Webchat", pagina: "www.ppgvet.com.br", origem_url: origem });
    expect(gravacoes.leads[0]).toMatchObject({ utm_source: "tiktok", utm_medium: "paid", utm_id: "1876", ttclid: "clique-chat", pagina_nome: "www.ppgvet.com.br" });
    expect(gravacoes.lead_oportunidades[0]).toMatchObject({ utm_source: "tiktok", utm_campaign: "LP_LEAD_POS-CLINICACIRURGIA-COMERCIAL-mensal" });
    expect(gravacoes.crm_webhook_logs[0].resultado).toMatchObject({ rastreamento: { utm_source: "tiktok", ttclid: "clique-chat" } });
  });

  it("formulário da LP completa o contato que o chat criou sem UTM", async () => {
    contato = { id: "lead-chat", nome: "Contato sintético", email: "sintetico@example.com", fonte: "Webchat LP", origem_criacao: "webchat" };
    await enviar({ URL: "https://www.ppgvet.com.br/pos-clinica-e-cirurgia?utm_source=tiktok&utm_medium=paid&utm_campaign=clinica&ttclid=clique-form" });
    expect(gravacoes["leads:update"]?.[0]).toMatchObject({ utm_source: "tiktok", utm_medium: "paid", utm_campaign: "clinica", ttclid: "clique-form" });
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

  /**
   * UTM perdida entre páginas (26/10/2026): o GreatPages envia os campos utm_* VAZIOS
   * quando o formulário está numa página diferente da que recebeu a UTM, e manda a
   * página anterior em Referral_Source. Forma real do payload (pós 3 em 1, 25/10).
   */
  const envioSemUtm = (referral: string, extra: Record<string, unknown> = {}) => ({
    URL: "https://www.ppgvet.com.br/poa", utm_source: "", utm_medium: "", utm_campaign: "", utm_content: "",
    utm_term: "", gclid: "", fbclid: "", Referral_Source: referral, ...extra,
  });

  it("UTM perdida entre páginas: a página anterior NOSSA devolve a UTM ao contato e à chegada", async () => {
    await enviar(envioSemUtm("https://www.ppgvet.com.br/links?utm_source=ig&utm_medium=social&utm_content=link_in_bio&fbclid=clique-bio"));
    expect(gravacoes.leads[0]).toMatchObject({ utm_source: "ig", utm_medium: "social", utm_content: "link_in_bio", fbclid: "clique-bio" });
    // a página de captação continua sendo a do formulário, e a origem NÃO é presumida
    expect(gravacoes.leads[0]).toMatchObject({ pagina_nome: "https://www.ppgvet.com.br/poa" });
    expect(gravacoes.leads[0]).not.toHaveProperty("fonte_referencia");
    expect(gravacoes.crm_webhook_logs[0].resultado).toMatchObject({ rastreamento: { utm_source: "ig", utm_content: "link_in_bio" } });
  });

  it("página anterior de site PARCEIRO não vira a nossa UTM", async () => {
    await enviar(envioSemUtm("https://www.produtivaassessoriavet.com.br/?utm_source=parceiro&utm_content=banner"));
    expect(gravacoes.leads[0]).not.toHaveProperty("utm_source");
    expect(gravacoes.leads[0]).not.toHaveProperty("utm_content");
  });

  it("UTM do próprio envio vence: a página anterior não completa outro toque", async () => {
    await enviar(envioSemUtm("https://www.ppgvet.com.br/links?utm_source=ig&utm_content=link_in_bio", { utm_source: "tiktok" }));
    expect(gravacoes.leads[0]).toMatchObject({ utm_source: "tiktok" });
    expect(gravacoes.leads[0]).not.toHaveProperty("utm_content");
  });

  it("formulário instantâneo com anúncio mapeado não herda a UTM da página anterior", async () => {
    integracao.field_mapping = { nome: "lead.nome", email: "lead.email", anuncio: "lead.meta_ad_name" };
    await enviar(envioSemUtm("https://www.ppgvet.com.br/links?utm_source=ig&utm_content=link_in_bio", { anuncio: "ad00612_SA_v01_c01_e05_ATMP" }));
    expect(gravacoes.leads[0]).toMatchObject({ meta_ad_name: "ad00612_SA_v01_c01_e05_ATMP", utm_content: "ad00612_SA_v01_c01_e05_ATMP" });
    expect(gravacoes.leads[0]).not.toHaveProperty("utm_source");
  });

  it("página anterior sem UTM (home do site) não inventa origem", async () => {
    await enviar(envioSemUtm("https://ppgvet.com.br/"));
    expect(gravacoes.leads[0]).not.toHaveProperty("utm_source");
    expect(gravacoes.leads[0]).not.toHaveProperty("fonte_referencia");
  });

  it("reenvio de log legado sem snapshot não inventa atribuição com o config atual", async () => {
    logAnterior = { id: "log-legado", criado_em: "2026-09-09T12:00:00Z", resultado: {} };
    integracao.config = { acoes: { itens: [{ tipo: "salvar_utm", params: { utm_source: "tiktok" } }] } };
    await enviar({ dados_completos: { id: "submissao-legada" } });
    expect(gravacoes.crm_webhook_logs[0].resultado).not.toHaveProperty("rastreamento");
    expect(cliente.from.mock.calls.map(([tabela]) => tabela)).toEqual(["crm_webhook_integrations", "crm_webhook_escutas", "crm_webhook_logs", "crm_webhook_logs"]);
  });
});
