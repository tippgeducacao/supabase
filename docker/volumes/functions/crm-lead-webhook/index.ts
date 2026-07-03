// crm-lead-webhook
// Webhook multi-tenant de captacao de leads para o CRM Comercial B2C.
// URL: POST https://api.ppgeducacao.site/functions/v1/crm-lead-webhook?int=<slug>
// Auth: header X-Webhook-Secret (constant-time compare com integration.secret)
// Body: JSON arbitrario; mapeado em campos do lead via integration.field_mapping
//
// Fluxo:
//   (1) busca integracao por slug + valida ativa
//   (2) valida secret
//   (3) aplica field_mapping na CHAVE recebida (Corpo + Query + Headers — body tem
//       prioridade); resolve lead.* e campo:<alias> (coluna física ou EAV)
//   (4) find-or-create lead (dedup OR email/whatsapp)
//   (5) DEDUP por (telefone, curso, lote) via crm_saudacao_guard (ON CONFLICT DO NOTHING):
//       gateia a CRIACAO da captacao/card. Lote repetido -> nao recria.
//   (6) atribui segmento default da integracao (idempotente, sempre)
//   (7) SE passou o dedup: lead_oportunidades (captacao). O CARD do pipeline
//       (crm_oportunidades) NAO e mais criado automaticamente — so nasce via a ACAO
//       'criar_oportunidade' (passo 9b). A saudacao dispara quando esse card entra numa
//       etapa com automacao. Este webhook NAO envia msg.
//   (8) SE passou o dedup: fura 'novo_lead' pro n8n (so contexto p/ semear o agente).
//   (9) loga em crm_webhook_logs
//
// BUILDER (config JSONB) — execução ADITIVA e opt-in das abas avançadas. Config vazio
// (webhooks antigos) => lead + captacao, SEM card (card era criado pelo intake global,
// agora removido). Cada bloco é defensivo (try/catch):
//   (4.5) Validação de Entrada: descarta se condição (tem_email/tem_whatsapp/campo_existe/
//         campo_igual) não for atendida. tag/segmento ainda não aplicadas no edge.
//   Criação Automática: preenche campos faltantes (fill-if-empty) ao criar OU atualizar
//         lead (habilitada), INCLUSIVE email/whatsapp (valor de criação). Marcar o campo
//         como IDENTIFICADOR (dedup) é separado e fica só na aba Entrada.
//   (9b) Ação criar_oportunidade: cria o card (funil/etapa/titulo+tokens/valor/status/
//        responsavel com distribuicao + "nao criar repetidas"). Opt-in. Abre card
//        INCLUSIVE p/ o lead IDENTIFICADO (que so ganha card por esta acao).
//   (9.5) Ações Extras: modificar_segmentos / definir_responsavel / atualizar_lead
//         (SOBRESCREVE lead.* e campo:<alias> físico/EAV; resolve {webhook=Campo}).
//   (12) Mapeamento de Retorno: shape custom da resposta + codigo_status.
//   Permissões: NÃO afetam o intake (é controle de acesso de UI).
//   NÃO suportados ainda no edge: add_tag/remove_tag (legado),
//   executarUmaVezPorEntidade, método != POST.
//
// Retorno OK 200:
//   { ok:true, lead_id, segmento_aplicado, lead_oportunidade_id, oportunidade_id, duplicado_lote }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-webhook-secret, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function asString(v: unknown, max = 500): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.includes("@") ? trimmed : null;
}

function normalizeWhatsapp(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const digits = String(raw).replace(/\D/g, "");
  if (!digits || digits.length < 8) return null;
  return digits.startsWith("55") ? digits : `55${digits}`;
}

// Canonicaliza celular BR para 13 dígitos (55 + DDD + 9 + 8), espelhando a normalização
// de JID do agente. Usado SÓ na chave do guard e no remotejid do novo_lead, pra que o mesmo
// número em formatos diferentes (com/sem 9º dígito) não escape do dedup e gere 2 saudações.
function canonicalBrPhone(whats55: string): string {
  let d = whats55.replace(/\D/g, "");
  if (d.startsWith("55")) d = d.slice(2);
  if (d.length === 10 && ["6", "7", "8", "9"].includes(d[2])) {
    d = d.slice(0, 2) + "9" + d.slice(2); // insere o 9º dígito (só celular)
  }
  return `55${d}`;
}

// Procura no payload o primeiro valor cujo target no mapping = wantedTarget.
function pickByMapping(payload: any, mapping: Record<string, string>, wantedTarget: string): unknown {
  for (const [k, t] of Object.entries(mapping)) {
    if (t === wantedTarget && payload[k] !== undefined && payload[k] !== null && payload[k] !== "") {
      return payload[k];
    }
  }
  return undefined;
}

// ── Builder (config JSONB): execução ADITIVA das abas avançadas ──────────────
// IMPORTANTE: tudo aqui é opt-in. Config vazio (webhooks antigos) => comportamento
// idêntico ao anterior. Cada bloco é defensivo (try/catch) e nunca derruba o core.

const LEAD_COL: Record<string, string> = {
  "lead.nome": "nome",
  "lead.email": "email",
  "lead.whatsapp": "whatsapp",
  "lead.curso_interesse": "curso_interesse",
  "lead.profissao": "profissao",
  "lead.area_interesse": "area_interesse",
  "lead.tempo_formacao": "tempo_formacao",
};

/** Validação de Entrada: true = condição atendida. Só condições derivadas do payload
 *  são aplicadas no edge (tem_email/tem_whatsapp/campo_existe/campo_igual). As baseadas
 *  no contato (tem_tag/tem_segmento) NÃO são aplicadas aqui (default: não bloqueiam). */
function condicaoPassa(c: any, payload: any, email: string | null, whatsapp: string | null): boolean {
  switch (c?.tipo) {
    case "tem_email":    return !!email;
    case "tem_whatsapp": return !!whatsapp;
    case "campo_existe": {
      const v = c?.campo ? payload?.[c.campo] : undefined;
      return v !== undefined && v !== null && String(v).trim() !== "";
    }
    case "campo_igual": {
      const v = c?.campo ? payload?.[c.campo] : undefined;
      return v !== undefined && String(v).trim() === String(c?.valor ?? "").trim();
    }
    // tem_tag / tem_segmento e tipos desconhecidos: não aplicados no edge v1 → não bloqueiam
    default: return true;
  }
}

/** Substitui {webhook=Chave} pelo valor do payload (Criação Automática). */
function resolveWebhookVar(template: unknown, payload: any): string {
  return String(template ?? "").replace(/\{webhook=([^}]+)\}/g, (_m, k) => {
    const v = payload?.[String(k).trim()];
    return v === undefined || v === null ? "" : String(v);
  });
}

/** Resolve variáveis {chave} do Mapeamento de Retorno a partir de um contexto. */
function resolveRetornoVal(template: unknown, ctx: Record<string, unknown>): string {
  return String(template ?? "").replace(/\{([^}]+)\}/g, (_m, k) => {
    const v = ctx[String(k).trim()];
    return v === undefined || v === null ? "" : String(v);
  });
}

// Rótulos legíveis das ações (espelha ACAO_OPTIONS do builder). Usados no chip do
// evento "Ação de Webhook Integrado executada" da timeline do Contato 360.
const ACAO_LABELS: Record<string, string> = {
  modificar_segmentos: "Modificar os segmentos do contato",
  modificar_tags:      "Modificar tags do contato",
  salvar_utm:          "Salvar tags UTM",
  atualizar_lead:      "Atualizar campo do contato",
  definir_responsavel: "Mudar permissões de acesso ao contato",
  criar_oportunidade:  "Criar oportunidade",
  enviar_mensagem_whatsapp: "Enviar template WhatsApp",
  add_segmento:        "Adicionar a um segmento",
  remove_segmento:     "Remover de um segmento",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = new URL(req.url);
  const slug = url.searchParams.get("int");
  const ipOrigem = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  // ── Histórico de Atividades (Contato 360) ──────────────────────────────────
  // Grava eventos na timeline (crm_lead_atividades). O evento "Criado por" é gerado
  // pelo TRIGGER trg_crm_log_lead_criacao (lê leads.origem_criacao); aqui logamos os
  // eventos derivados: segmento aplicado e ações do builder executadas. Best-effort —
  // nunca derruba o intake.
  async function logAtividade(
    leadId: string | null,
    tipo: "segmento_add" | "acao_webhook",
    titulo: string,
    chip: string | null,            // vira o badge da timeline (user_nome)
    detalhe: string | null = null,
  ): Promise<void> {
    if (!leadId) return;
    try {
      await admin.from("crm_lead_atividades").insert({
        lead_id: leadId, user_id: null, user_nome: chip, tipo, titulo, detalhe,
      });
    } catch (e: any) {
      console.error("[crm-lead-webhook] logAtividade erro:", e?.message);
    }
  }
  const segNomeCache = new Map<string, string>();
  async function nomeSegmento(id: string): Promise<string> {
    if (segNomeCache.has(id)) return segNomeCache.get(id)!;
    let nome = "segmento";
    try {
      const { data } = await admin.from("crm_segmentos").select("nome").eq("id", id).maybeSingle();
      nome = (data as any)?.nome ?? "segmento";
    } catch { /* mantém fallback */ }
    segNomeCache.set(id, nome);
    return nome;
  }

  // Captura query params (exceto int/segredo) e headers customizados (exceto auth/proxy/ruído).
  // Alimentam o "Mapeamento automático" (escuta) do builder, que detecta os campos das 3
  // seções (Query / Corpo / Headers). Tudo defensivo; gravado em TODO log via ...reqMeta.
  const SECRET_QUERY_KEYS = new Set(["secret", "token", "access_token", "api_token", "auth_token", "api_key", "key", "hash"]);
  const queryParams: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) {
    if (k === "int" || SECRET_QUERY_KEYS.has(k.toLowerCase())) continue;
    queryParams[k] = String(v).slice(0, 500);
  }
  const HEADER_DENYLIST = new Set([
    "host", "content-length", "content-type", "user-agent", "accept", "accept-encoding", "accept-language",
    "connection", "cache-control", "pragma", "dnt", "te", "upgrade-insecure-requests", "priority", "via",
    "forwarded", "referer", "origin", "cookie",
    // auth (não são dado de lead)
    "authorization", "apikey", "x-webhook-secret", "x-auth-token", "x-token", "token", "x-api-key", "api-key",
  ]);
  const headersObj: Record<string, string> = {};
  for (const [k, v] of req.headers.entries()) {
    const lk = k.toLowerCase();
    if (HEADER_DENYLIST.has(lk) || lk.startsWith("x-forwarded") || lk.startsWith("sec-") || lk.startsWith("cf-")) continue;
    headersObj[k] = String(v).slice(0, 500);
  }
  const reqMeta = { query_params: queryParams, headers: headersObj };

  if (!slug) return json({ error: "missing_integration" }, 400);

  // (1) integracao
  const { data: integration } = await admin
    .from("crm_webhook_integrations")
    .select("id, slug, nome, secret, area_interesse, pagina_nome, field_mapping, ativa, config, codigo_status")
    .eq("slug", slug)
    .maybeSingle();

  if (!integration) return json({ error: "integration_not_found" }, 404);

  if (!integration.ativa) {
    await admin.from("crm_webhook_logs").insert({
      integration_id: integration.id, slug, status: "integracao_inativa", ip_origem: ipOrigem, ...reqMeta,
    });
    return json({ error: "integration_inactive" }, 403);
  }

  // (2) secret — aceita em muitas convencoes pra compatibilizar com diferentes LPs/CRMs.
  // Coleta todos os candidatos possiveis e checa cada um em constant-time.
  const authHeader = req.headers.get("authorization") ?? "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const tokenSchemeMatch = authHeader.match(/^Token\s+(.+)$/i);
  const candidates: (string | null)[] = [
    req.headers.get("x-webhook-secret"),
    req.headers.get("x-auth-token"),
    req.headers.get("x-token"),
    req.headers.get("token"),
    req.headers.get("x-api-key"),
    req.headers.get("api-key"),
    bearerMatch ? bearerMatch[1] : null,
    tokenSchemeMatch ? tokenSchemeMatch[1] : null,
    // Authorization sem prefixo conhecido (alguns sistemas mandam o token cru)
    authHeader && !bearerMatch && !tokenSchemeMatch && !authHeader.toLowerCase().startsWith("basic ")
      ? authHeader : null,
    url.searchParams.get("secret"),
    url.searchParams.get("token"),
    url.searchParams.get("access_token"),
    url.searchParams.get("api_token"),
    url.searchParams.get("auth_token"),
    url.searchParams.get("api_key"),
    url.searchParams.get("key"),
    url.searchParams.get("hash"),
  ];
  const secretOk = candidates.some((c) => c && constantTimeEqual(c, integration.secret));
  if (!secretOk) {
    // Debug seguro: nomes dos headers (sem valores) + nomes dos query params,
    // pra identificar onde o sistema externo (SprintHub etc) esta passando o token.
    const HIDE = new Set(["host", "content-length", "user-agent", "accept", "content-type", "accept-encoding", "connection", "cache-control"]);
    const headerNames = Array.from(req.headers.keys())
      .filter((k) => !HIDE.has(k.toLowerCase()))
      .slice(0, 30)
      .join(",");
    const queryNames = Array.from(url.searchParams.keys()).filter((k) => k !== "int").join(",");
    const debug = `headers=[${headerNames}] query=[${queryNames}]`.slice(0, 800);
    await admin.from("crm_webhook_logs").insert({
      integration_id: integration.id, slug, status: "secret_invalido",
      erro: debug, ip_origem: ipOrigem, ...reqMeta,
    });
    return json({ error: "invalid_secret" }, 401);
  }

  // (3) body — aceita JSON, x-www-form-urlencoded e multipart/form-data. Várias LPs
  // (ex.: GreatPages) enviam o formulário como form-urlencoded ou multipart, NÃO JSON;
  // parsear só como JSON perdia o corpo inteiro (a "escuta" do builder só via os headers).
  // O stream é lido UMA única vez por content-type.
  let payload: any = null;
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  try {
    if (contentType.includes("multipart/form-data")) {
      const fd = await req.formData();
      const obj: Record<string, string> = {};
      for (const [k, v] of fd.entries()) obj[k] = typeof v === "string" ? v : (v as File).name;
      payload = obj;
    } else {
      // JSON, form-urlencoded ou content-type ausente/desconhecido: lê o texto uma vez
      // e tenta JSON; se não for JSON, parseia como querystring (form-urlencoded).
      const txt = await req.text();
      if (txt) {
        try {
          payload = JSON.parse(txt);
        } catch {
          const obj = Object.fromEntries(new URLSearchParams(txt).entries());
          payload = Object.keys(obj).length > 0 ? obj : null;
        }
      }
    }
  } catch {
    payload = null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    await admin.from("crm_webhook_logs").insert({
      integration_id: integration.id, slug, status: "erro",
      erro: "corpo nao reconhecido (esperado JSON, form-urlencoded ou multipart)", ip_origem: ipOrigem, ...reqMeta,
    });
    return json({ error: "invalid_body" }, 400);
  }

  const mapping = (integration.field_mapping ?? {}) as Record<string, string>;
  const config = (integration.config ?? {}) as any; // builder: abas avançadas (opt-in)

  // Fonte unificada de dados p/ mapeamento/tokens/validação: Corpo + Query + Headers.
  // O Mapeamento de Entrada tem 3 seções (Query/Corpo/Headers); o field_mapping casa a
  // CHAVE contra qualquer uma. Body tem prioridade em caso de chave repetida. O log segue
  // gravando o `payload` (corpo) cru; query/headers já vão no log via ...reqMeta.
  const dados: Record<string, unknown> = { ...queryParams, ...headersObj, ...(payload as Record<string, unknown>) };

  // (4) extrai campos do lead via mapping
  const nome     = asString(pickByMapping(dados, mapping, "lead.nome"), 200);
  const email    = normalizeEmail(pickByMapping(dados, mapping, "lead.email"));
  const whatsapp = normalizeWhatsapp(pickByMapping(dados, mapping, "lead.whatsapp"));

  // campos adicionais do lead (gravados em public.leads) + lote (controle de dedup)
  const cursoInteresse = asString(pickByMapping(dados, mapping, "lead.curso_interesse"), 200);
  const formacaoLead   = asString(pickByMapping(dados, mapping, "lead.profissao"), 200);      // "formação" / área de atuação
  const areaLead       = asString(pickByMapping(dados, mapping, "lead.area_interesse"), 200);
  const tempoFormacao  = asString(pickByMapping(dados, mapping, "lead.tempo_formacao"), 200);
  const lote           = asString(pickByMapping(dados, mapping, "control.lote"), 200);

  if (!email && !whatsapp) {
    await admin.from("crm_webhook_logs").insert({
      integration_id: integration.id, slug, payload, status: "sem_identificador",
      erro: "Nem email nem whatsapp encontrados via field_mapping", ip_origem: ipOrigem, ...reqMeta,
    });
    return json({ error: "no_identifier" }, 422);
  }

  // (4.5) VALIDAÇÃO DE ENTRADA (config.validacao) — opt-in. Se alguma condição não
  // for atendida, descarta a chamada (não cria lead/oportunidade). Só roda se houver
  // condições configuradas; condições baseadas no contato (tag/segmento) não bloqueiam aqui.
  const validacao = Array.isArray(config?.validacao) ? config.validacao : [];
  if (validacao.length > 0) {
    const reprovou = validacao.find((c: any) => !condicaoPassa(c, dados, email, whatsapp));
    if (reprovou) {
      await admin.from("crm_webhook_logs").insert({
        integration_id: integration.id, slug, payload, status: "erro",
        erro: `Validação de entrada não atendida: ${reprovou?.tipo ?? "?"}`, ip_origem: ipOrigem, ...reqMeta,
      });
      return json({ ok: false, discarded: true, reason: "validacao", condicao: reprovou?.tipo ?? null }, 200);
    }
  }

  // ── Campos do contato (catálogo crm_campos) mapeados como `campo:<alias>` ──────
  // O builder agora oferece TODOS os campos de contato (sistema + customizados, ex.:
  // Estado). Resolvemos cada alias: coluna física de `leads` (lead_coluna whitelisted)
  // OU valor customizado (EAV crm_campo_valores). Tudo defensivo — nunca derruba o intake.
  const LEAD_COLS_WL = new Set(["nome", "profissao", "area_interesse", "curso_interesse", "tempo_formacao", "regiao"]);
  function eavCols(tipo: string, valor: string): Record<string, unknown> {
    if (tipo === "numero" || tipo === "inteiro") {
      const n = Number(valor);
      return Number.isFinite(n) ? { value_number: n } : { value_text: valor };
    }
    if (tipo === "data") return { value_date: valor };
    if (tipo === "seletor_multiplo") return { value_json: [valor] };
    return { value_text: valor };
  }

  // alias -> chave do payload (vindo do Mapeamento de Entrada)
  const aliasFromMapping: Record<string, string> = {};
  for (const [chave, dest] of Object.entries(mapping)) {
    if (typeof dest === "string" && dest.startsWith("campo:")) aliasFromMapping[dest.slice(6)] = chave;
  }
  // campo:<alias> usados na Criação Automática (valores default p/ lead novo)
  const criacaoCampoAlias: Array<{ alias: string; valor: string }> = [];
  try {
    const criacao = config?.criacaoAutomatica;
    if (criacao?.habilitada && Array.isArray(criacao.campos)) {
      for (const c of criacao.campos) {
        if (typeof c?.campo === "string" && c.campo.startsWith("campo:")) {
          criacaoCampoAlias.push({ alias: c.campo.slice(6), valor: String(c?.valor ?? "") });
        }
      }
    }
  } catch { /* defensivo */ }

  // campo:<alias> usados na Ação Extra "Atualizar campo do contato" (sobrescreve o valor).
  const atualizarCampoAlias: string[] = [];
  try {
    const itensCfg = Array.isArray(config?.acoes?.itens) ? config.acoes.itens : [];
    for (const a of itensCfg) {
      if (a?.tipo !== "atualizar_lead") continue;
      const campos = Array.isArray(a?.params?.campos) ? a.params.campos : [];
      for (const c of campos) {
        if (typeof c?.campo === "string" && c.campo.startsWith("campo:")) atualizarCampoAlias.push(c.campo.slice(6));
      }
    }
  } catch { /* defensivo */ }

  // Busca o catálogo dos aliases referenciados (id/tipo/lead_coluna).
  const camposCatalogo = new Map<string, { id: string; tipo: string; lead_coluna: string | null }>();
  const aliasesRef = new Set<string>([
    ...Object.keys(aliasFromMapping),
    ...criacaoCampoAlias.map((c) => c.alias),
    ...atualizarCampoAlias,
  ]);
  if (aliasesRef.size > 0) {
    try {
      const { data: catRows } = await admin
        .from("crm_campos")
        .select("id, alias, tipo, lead_coluna, ativo")
        .in("alias", [...aliasesRef]);
      for (const r of (catRows ?? []) as any[]) {
        if (r.ativo !== false) camposCatalogo.set(r.alias, { id: r.id, tipo: r.tipo, lead_coluna: r.lead_coluna });
      }
    } catch (e: any) {
      console.error("[crm-lead-webhook] crm_campos catalog erro:", e?.message);
    }
  }

  // Resolve o Mapeamento de Entrada: físico (coluna de leads) vs EAV (crm_campo_valores).
  const campoFisico: Record<string, string> = {};
  const campoEav: Array<{ campo_id: string; tipo: string; valor: string }> = [];
  for (const [alias, chave] of Object.entries(aliasFromMapping)) {
    const meta = camposCatalogo.get(alias);
    if (!meta) continue;
    const val = asString(dados[chave], 500);
    if (val === null) continue;
    if (meta.lead_coluna && LEAD_COLS_WL.has(meta.lead_coluna)) {
      campoFisico[meta.lead_coluna] = val;
    } else if (!meta.lead_coluna) {
      campoEav.push({ campo_id: meta.id, tipo: meta.tipo, valor: val });
    }
    // lead_coluna fora do whitelist (ex.: email/whatsapp/status) → ignorado de propósito.
  }

  // Valores "de entrada" mesclando target fixo (lead.*) + campo:<alias> físico.
  const inNome  = nome ?? campoFisico.nome ?? null;
  const inCurso = cursoInteresse ?? campoFisico.curso_interesse ?? null;
  const inProf  = formacaoLead ?? campoFisico.profissao ?? null;
  const inArea  = areaLead ?? campoFisico.area_interesse ?? null;
  const inTempo = tempoFormacao ?? campoFisico.tempo_formacao ?? null;
  // Estado (campo:state → leads.regiao). Não há target fixo lead.regiao; só chega
  // via campo:state no Mapeamento de Entrada (campoFisico.regiao) ou na Criação Automática.
  const inRegiao = campoFisico.regiao ?? null;

  // Normaliza o título do SprintHub → nome canônico do curso (só pós/MBA; cascata
  // exato → normalizado → alias → fuzzy no banco). Curso livre e título desconhecido
  // seguem com o texto original (resolver devolve id=null). O CONTEXTO DO AGENTE
  // (cliente_ppg_leads_sdr + forward n8n) recebe o canônico — é o nome que a sdr-api
  // aceita no /disponibilidade e /agendamentos. O cru permanece em leads.curso_interesse,
  // na chave de dedup e no payload do log (auditoria). Nunca derruba o intake.
  let cursoCanonico: string | null = null;
  if (inCurso) {
    try {
      const { data: rc } = await admin.rpc("fn_sdr_api_resolver_pos_graduacao", { p_valor: inCurso });
      if (rc && (rc as any).id) cursoCanonico = String((rc as any).nome);
    } catch (e: any) {
      console.error("[crm-lead-webhook] resolver curso falhou:", e?.message);
    }
  }
  const cursoParaAgente = cursoCanonico ?? inCurso;

  // Criação Automática (config.criacaoAutomatica) — valores default p/ NOVO lead.
  // Opt-in (habilitada). NÃO altera a regra de criar/não-criar: só preenche campos
  // faltantes ao inserir um lead novo (e fill-if-empty no existente). Suporta targets
  // fixos (LEAD_COL) e `campo:<alias>` físicos; os campo:<alias> EAV viram default mais
  // abaixo. INCLUI email/whatsapp como VALOR DE CRIAÇÃO — porém identificar o contato
  // (dedup) é só pela aba Entrada ("Identificador Para"); um email/whatsapp posto só aqui
  // preenche o lead mas NÃO vira chave de dedup.
  const criacaoDefaults: Record<string, string> = {};
  try {
    const criacao = config?.criacaoAutomatica;
    if (criacao?.habilitada && Array.isArray(criacao.campos)) {
      for (const c of criacao.campos) {
        let col = LEAD_COL[c?.campo];
        if (!col && typeof c?.campo === "string" && c.campo.startsWith("campo:")) {
          const meta = camposCatalogo.get(c.campo.slice(6));
          // email/whatsapp são colunas físicas mesmo fora do whitelist de texto.
          if (meta?.lead_coluna && (LEAD_COLS_WL.has(meta.lead_coluna) || meta.lead_coluna === "email" || meta.lead_coluna === "whatsapp")) {
            col = meta.lead_coluna;
          }
        }
        if (!col) continue;
        const val = resolveWebhookVar(c?.valor, dados).trim();
        if (!val) continue;
        if (col === "email") { const e = normalizeEmail(val); if (e) criacaoDefaults.email = e; }
        else if (col === "whatsapp") { const w = normalizeWhatsapp(val); if (w) criacaoDefaults.whatsapp = w; }
        else criacaoDefaults[col] = val;
      }
    }
  } catch (e: any) {
    console.error("[crm-lead-webhook] criacaoAutomatica defaults erro:", e?.message);
  }

  // (5) find-or-create lead — dedup OR email/whatsapp (com variantes de prefixo 55)
  let leadId: string | null = null;
  let duplicado = false;
  let leadArquivadoReativado = false;
  // Arquivamento HUMANO recente (<14d): o "recadastro" NÃO reativa nem dispara nada —
  // o SprintHub re-empurra base existente como lead novo (94% duplicados no lote 18,
  // 2026-07-03, caso Ana Limeira: arquivada 09:32, template às 14:32) e isso atropelava
  // a decisão do SDR. Arquivado antigo (>=14d ou sem data) segue reativando (recadastro
  // legítimo de lead que voltou).
  let leadPermaneceArquivado = false;
  const CARENCIA_ARQUIVADO_MS = 14 * 24 * 3600_000;
  try {
    let existing: any = null;

    if (email) {
      const { data } = await admin
        .from("leads")
        .select("id, nome, email, whatsapp, curso_interesse, profissao, area_interesse, tempo_formacao, regiao, arquivado, arquivado_em")
        .eq("email", email)
        .limit(1);
      existing = data?.[0] ?? null;
    }
    if (!existing && whatsapp) {
      const variants = [whatsapp, whatsapp.startsWith("55") ? whatsapp.slice(2) : `55${whatsapp}`];
      const { data } = await admin
        .from("leads")
        .select("id, nome, email, whatsapp, curso_interesse, profissao, area_interesse, tempo_formacao, regiao, arquivado, arquivado_em")
        .in("whatsapp", variants)
        .limit(1);
      existing = data?.[0] ?? null;
    }

    if (existing) {
      duplicado = true;
      leadId = existing.id;
      // Lead estava arquivado → recadastro = reativar, SALVO arquivamento recente (<14d):
      // aí a decisão de arquivar (humana) prevalece — mantém arquivado e o fluxo abaixo
      // vira no-op (sem card, sem template, sem IA).
      if (existing.arquivado === true) {
        const arquivadoEmMs = existing.arquivado_em ? Date.parse(existing.arquivado_em) : NaN;
        if (Number.isFinite(arquivadoEmMs) && Date.now() - arquivadoEmMs < CARENCIA_ARQUIVADO_MS) {
          leadPermaneceArquivado = true;
        } else {
          leadArquivadoReativado = true;
          await admin.from("leads")
            .update({ arquivado: false, arquivado_em: null, arquivado_por: null })
            .eq("id", existing.id);
        }
      }
      // Preenche campos vazios sem sobrescrever os existentes. Inclui os defaults da
      // Criação Automática (espelha o "atualiza e cria" do SprintHub — fill-if-empty
      // também no lead que já existe). Mapeamento de Entrada (in*) tem prioridade.
      const patch: Record<string, string> = {};
      // "Sem nome" é tratado como VAZIO: lead duplicado que ficou com esse literal recebe
      // o nome real que chega depois (antes `!existing.nome` via "Sem nome" como preenchido
      // e nunca sobrescrevia). Só grava um nome REAL (nunca "Sem nome" por cima).
      const nomeVazio = (s: string | null | undefined) =>
        !s || !s.trim() || s.trim().toLowerCase() === "sem nome";
      const nomeNovo = inNome ?? criacaoDefaults.nome;
      if (nomeVazio(existing.nome) && nomeNovo && !nomeVazio(nomeNovo))           patch.nome = nomeNovo;
      if (!existing.email && (email ?? criacaoDefaults.email))                    patch.email = (email ?? criacaoDefaults.email)!;
      if (!existing.whatsapp && (whatsapp ?? criacaoDefaults.whatsapp))           patch.whatsapp = (whatsapp ?? criacaoDefaults.whatsapp)!;
      if (!existing.curso_interesse && (inCurso ?? criacaoDefaults.curso_interesse))   patch.curso_interesse = (inCurso ?? criacaoDefaults.curso_interesse)!;
      if (!existing.profissao && (inProf ?? criacaoDefaults.profissao))          patch.profissao = (inProf ?? criacaoDefaults.profissao)!;
      if (!existing.area_interesse && (inArea ?? criacaoDefaults.area_interesse))     patch.area_interesse = (inArea ?? criacaoDefaults.area_interesse)!;
      if (!existing.tempo_formacao && (inTempo ?? criacaoDefaults.tempo_formacao))    patch.tempo_formacao = (inTempo ?? criacaoDefaults.tempo_formacao)!;
      if (!existing.regiao && (inRegiao ?? criacaoDefaults.regiao))               patch.regiao = (inRegiao ?? criacaoDefaults.regiao)!;
      if (Object.keys(patch).length) {
        await admin.from("leads").update(patch).eq("id", existing.id);
      }
    } else {
      const { data: novo, error: leadErr } = await admin
        .from("leads")
        .insert({
          nome: inNome ?? criacaoDefaults.nome ?? "Sem nome",
          // identificador (Entrada) tem prioridade; senão usa o valor de criação da
          // Criação Automática. dedup já rodou acima — o default aqui só preenche o campo.
          email: email ?? criacaoDefaults.email ?? null,
          whatsapp: whatsapp ?? criacaoDefaults.whatsapp ?? null,
          curso_interesse: inCurso ?? criacaoDefaults.curso_interesse ?? null,
          profissao: inProf ?? criacaoDefaults.profissao ?? null,
          area_interesse: inArea ?? criacaoDefaults.area_interesse ?? null,
          tempo_formacao: inTempo ?? criacaoDefaults.tempo_formacao ?? null,
          regiao: inRegiao ?? criacaoDefaults.regiao ?? null,
          // Origem da criação → evento "Criado por <webhook>" na timeline (via trigger).
          origem_criacao: integration.nome ?? `Webhook ${slug}`,
        })
        .select("id")
        .single();
      if (leadErr || !novo) throw leadErr ?? new Error("lead insert sem retorno");
      leadId = novo.id;
    }
  } catch (e: any) {
    await admin.from("crm_webhook_logs").insert({
      integration_id: integration.id, slug, payload, status: "erro",
      erro: `lead persist: ${e?.message ?? e}`, ip_origem: ipOrigem, ...reqMeta,
    });
    return json({ error: "lead_persist_failed" }, 500);
  }

  // (5.5) Campos customizados (EAV) — Estado e demais campos do contato SEM coluna física.
  // Vêm do Mapeamento de Entrada (campo:<alias>) e dos defaults da Criação Automática
  // (só p/ lead novo). Preenche-se-ausente (ON CONFLICT DO NOTHING) — não sobrescreve um
  // valor já existente, espelhando o "fill if empty" das colunas físicas. Best-effort:
  // nunca derruba o intake.
  if (leadId) {
    const eavParaGravar: Array<{ campo_id: string; tipo: string; valor: string }> = [...campoEav];
    // Defaults EAV da Criação Automática — aplicam em lead NOVO e EXISTENTE (fill-if-empty
    // garantido pelo upsert ignoreDuplicates abaixo), espelhando o "atualiza e cria".
    for (const { alias, valor } of criacaoCampoAlias) {
      const meta = camposCatalogo.get(alias);
      if (!meta || meta.lead_coluna) continue;                       // físico já tratado nos defaults
      if (eavParaGravar.some((e) => e.campo_id === meta.id)) continue; // já veio do mapping
      const val = resolveWebhookVar(valor, dados).trim();
      if (val) eavParaGravar.push({ campo_id: meta.id, tipo: meta.tipo, valor: val });
    }
    for (const e of eavParaGravar) {
      try {
        await admin.from("crm_campo_valores").upsert(
          { lead_id: leadId, campo_id: e.campo_id, ...eavCols(e.tipo, e.valor) },
          { onConflict: "lead_id,campo_id", ignoreDuplicates: true },
        );
      } catch (err: any) {
        console.error("[crm-lead-webhook] eav campo erro:", err?.message);
      }
    }
  }

  // (5.7) Lead ARQUIVADO há menos de 14 dias → recadastro INERTE: dados já atualizados
  // (fill-if-empty acima), mas NADA dispara (sem card, sem template, sem seed de IA, sem
  // forward). A decisão humana de arquivar prevalece sobre o re-push do SprintHub.
  if (leadPermaneceArquivado) {
    await logAtividade(
      leadId, "acao_webhook", "Recadastro recebido com lead ARQUIVADO",
      `${integration.nome ?? slug} — arquivado há menos de 14 dias: mantido arquivado, sem envios`,
    );
    await admin.from("crm_webhook_logs").insert({
      integration_id: integration.id, slug, payload, ...reqMeta,
      resultado: { lead_id: leadId, duplicado: true, lead_arquivado_recente: true, acoes_aplicadas: [] },
      status: "duplicado",
      ip_origem: ipOrigem,
    });
    return json({ ok: true, discarded: true, reason: "lead_arquivado_recente", lead_id: leadId }, 200);
  }

  // (6) extras p/ lead_oportunidades
  const utm_source   = asString(pickByMapping(dados, mapping, "lead_op.utm_source"), 200);
  const utm_medium   = asString(pickByMapping(dados, mapping, "lead_op.utm_medium"), 200);
  const utm_campaign = asString(pickByMapping(dados, mapping, "lead_op.utm_campaign"), 200);
  const fonte        = asString(pickByMapping(dados, mapping, "lead_op.fonte"), 200);
  const profissao    = asString(pickByMapping(dados, mapping, "lead_op.profissao"), 200);

  // (7) DEDUP por (telefone, curso, lote) — guard ANTES de criar a oportunidade.
  // A saudacao e enviada pela ENGINE DE AUTOMACAO quando o card entra na etapa de
  // entrada (NAO por este webhook). Entao o dedup gateia a CRIACAO da oportunidade:
  // lote repetido -> nao cria 2a oportunidade -> a engine nao re-dispara o template.
  // = 1 card + 1 saudacao por (telefone, curso, lote). Lead sem whatsapp cria normal
  // (nao ha WhatsApp pra saudar, nao da pra deduplicar por telefone).
  let duplicadoLote = false;
  let criarOportunidade = true;
  let telCanon: string | null = null;
  if (whatsapp) {
    telCanon = canonicalBrPhone(whatsapp);
    const { data: guardRows, error: guardErr } = await admin
      .from("crm_saudacao_guard")
      .upsert(
        { telefone: telCanon, curso_interesse: cursoInteresse ?? "", lote: lote ?? "", lead_id: leadId },
        { onConflict: "telefone,curso_interesse,lote", ignoreDuplicates: true },
      )
      .select("id");
    if (guardErr) console.error("[crm-lead-webhook] guard erro:", guardErr.message);
    criarOportunidade = !guardErr && Array.isArray(guardRows) && guardRows.length > 0;
    duplicadoLote = !guardErr && Array.isArray(guardRows) && guardRows.length === 0;
  }

  // (8) Segmento NAO e mais atribuido no nivel da integracao. A categorizacao por
  // segmento acontece SOMENTE via a acao extra "Modificar segmentos do contato"
  // (passo 9.5: modificar_segmentos / add_segmento / remove_segmento). Mantemos
  // `segmentoAplicado` no resultado/retorno por compatibilidade (fica null aqui).
  const segmentoAplicado: string | null = null;

  // Ações 'criar_oportunidade' válidas (funil+etapa). São o ÚNICO jeito de abrir card —
  // e abrem card inclusive p/ o lead IDENTIFICADO (já existe na base).
  const acoesItens = Array.isArray(config?.acoes?.itens) ? config.acoes.itens : [];
  const opActions = acoesItens.filter(
    (a: any) => a?.tipo === "criar_oportunidade" && a?.params?.funilId && a?.params?.etapaId,
  );
  // Abrir captação + card quando: passou o dedup de saudação (lead novo/fresco) OU o lead
  // foi IDENTIFICADO e há ação 'criar_oportunidade'. Regra: lead identificado só ganha card
  // via ação extra; re-saudação é permitida. Webhook SEM a ação => comportamento inalterado.
  const abrirCards = criarOportunidade || (duplicado && opActions.length > 0);

  // (9) lead_oportunidades (captacao) — SO quando vamos abrir card. NAO cria card no CRM aqui.
  // A oportunidade do pipeline (crm_oportunidades) so nasce quando ha uma ACAO
  // 'criar_oportunidade' configurada (ver 9b). Webhook sem essa acao => lead + captacao,
  // SEM card. (Antes o card era criado automaticamente pelo intake global — removido.)
  let leadOportunidadeId: string | null = null;
  let oportunidadeId: string | null = null;
  let waAccId: string | null = null;
  if (abrirCards) {
    try {
      const { data: lo, error: loErr } = await admin
        .from("lead_oportunidades")
        .insert({
          lead_id: leadId,
          pagina_nome: integration.pagina_nome ?? null,
          area_interesse: integration.area_interesse ?? null,
          profissao,
          utm_source, utm_medium, utm_campaign,
          fonte,
          status: "ativo",
        })
        .select("id")
        .single();
      if (loErr) throw loErr;
      leadOportunidadeId = lo?.id ?? null;
    } catch (e: any) {
      console.error("[crm-lead-webhook] lead_oportunidades falhou:", e?.message);
    }
  }

  // Conta de WhatsApp — anexada ao card criado pela acao (p/ conversa/saudacao) e usada
  // no envio do template + contexto do agente. Se uma ação 'Enviar template WhatsApp'
  // escolheu um NÚMERO específico (params.wa_account_id, seletor visível no builder),
  // esse número ancora o fluxo INTEIRO; senão, a primeira conta ativa (legado).
  try {
    const acaoComConta = acoesItens.find(
      (a: any) => a?.tipo === "enviar_mensagem_whatsapp" &&
        typeof a?.params?.wa_account_id === "string" && a.params.wa_account_id,
    );
    if (acaoComConta) {
      const { data: waSel } = await admin
        .from("crm_whatsapp_accounts")
        .select("id")
        .eq("id", (acaoComConta as any).params.wa_account_id)
        .eq("ativo", true)
        .maybeSingle();
      waAccId = waSel?.id ?? null;
      if (!waAccId) console.warn("[crm-lead-webhook] wa_account_id da ação não é conta ativa — caindo na conta padrão");
    }
    if (!waAccId) {
      const { data: waAcc } = await admin
        .from("crm_whatsapp_accounts")
        .select("id")
        .eq("ativo", true)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      waAccId = waAcc?.id ?? null;
    }
  } catch { /* sem conta ativa */ }

  // Resolve o responsavel do card conforme a estrategia (espelha "Tipo de Responsavel"):
  //   do_contato → leads.vendedor_atribuido; usuario → fixo; sequencial → rodizio (RPC);
  //   menos_oportunidades → o com menos cards abertos na lista; aleatorio → sorteio;
  //   setor_equipe → rodizio BALANCEADO por carga entre os MEMBROS dos DEPARTAMENTOS DO CRM
  //   escolhidos (RPC distribuir_proximo_responsavel; devolve tambem o logId p/ amarrar
  //   opp/atendimento e a carga contar pelo estado real); nenhum → null.
  // Devolve { id, logId }: logId só vem na estrategia setor_equipe (linha em crm_distribuicao_log).
  async function resolverResponsavel(acaoId: string, resp: any): Promise<{ id: string | null; logId: string | null }> {
    const estrategia = resp?.estrategia ?? "do_contato";
    try {
      if (estrategia === "nenhum") return { id: null, logId: null };
      if (estrategia === "usuario") return { id: (typeof resp?.usuarioId === "string" && resp.usuarioId) ? resp.usuarioId : null, logId: null };
      if (estrategia === "do_contato") {
        const { data } = await admin.from("leads").select("vendedor_atribuido").eq("id", leadId).maybeSingle();
        return { id: (data as any)?.vendedor_atribuido ?? null, logId: null };
      }
      if (estrategia === "setor_equipe") {
        // Pool = MEMBROS ATIVOS dos DEPARTAMENTOS DO CRM (crm_departamento_membros) escolhidos;
        // rodizio balanceado pela carga (so dos leads que ESTA acao distribuiu — recontato nao
        // pesa). p_departamentos = crm_departamentos.id. Sem departamento = sem pool.
        const deptos: string[] = Array.isArray(resp?.departamentos) ? resp.departamentos.map((x: unknown) => String(x)).filter(Boolean) : [];
        const excluir: string[] = Array.isArray(resp?.excluir) ? resp.excluir.map((x: unknown) => String(x)).filter(Boolean) : [];
        if (!deptos.length) return { id: null, logId: null };
        const { data: pick } = await admin.rpc("distribuir_proximo_responsavel", {
          p_acao_id: acaoId,
          p_departamentos: deptos,
          p_excluir: excluir.length ? excluir : null,
        });
        const row: any = Array.isArray(pick) ? pick[0] : pick;
        return { id: row?.usuario_id ?? null, logId: row?.log_id ?? null };
      }
      const lista: string[] = Array.isArray(resp?.usuarios)
        ? resp.usuarios.filter((x: any) => typeof x === "string" && x)
        : [];
      if (lista.length === 0) return { id: null, logId: null };
      if (estrategia === "aleatorio") return { id: lista[Math.floor(Math.random() * lista.length)] ?? null, logId: null };
      if (estrategia === "sequencial") {
        const { data: idx } = await admin.rpc("crm_webhook_acao_next_index", { p_acao_id: acaoId, p_len: lista.length });
        const i = typeof idx === "number" ? idx : 0;
        return { id: lista[i] ?? lista[0] ?? null, logId: null };
      }
      if (estrategia === "menos_oportunidades") {
        const { data: rows } = await admin
          .from("crm_oportunidades")
          .select("responsavel_id")
          .in("responsavel_id", lista)
          .eq("status", "aberta");
        const counts = new Map<string, number>(lista.map((u) => [u, 0]));
        for (const r of (rows ?? [])) {
          const k = (r as any)?.responsavel_id;
          if (k && counts.has(k)) counts.set(k, (counts.get(k) ?? 0) + 1);
        }
        let best = lista[0]; let bestN = Infinity;
        for (const u of lista) { const n = counts.get(u) ?? 0; if (n < bestN) { bestN = n; best = u; } }
        return { id: best ?? null, logId: null };
      }
    } catch (e: any) {
      console.error("[crm-lead-webhook] resolverResponsavel erro:", e?.message);
    }
    return { id: null, logId: null };
  }

  // (9b) ACAO 'criar_oportunidade' — cria card(s) no pipeline SOMENTE quando configurada.
  // Resolve titulo/valor (tokens {webhook=Campo}), aplica funil/etapa/status, distribui o
  // responsavel e respeita "nao criar oportunidades repetidas". O INSERT na etapa escolhida
  // dispara a engine de automacao (saudacao) se a etapa tiver automacao — controle do usuario.
  // Roda tambem p/ lead IDENTIFICADO (abrirCards), nao so quando passou o dedup de saudacao.
  if (abrirCards) {
    let captacaoVinculada = false;
    for (const a of opActions) {
      try {
        const p: any = a.params ?? {};

        // dedup por acao: se ja ha card aberto no funil p/ o lead, pula (e reaproveita o id).
        if (p.naoCriarRepetidas === true) {
          const { data: existe } = await admin
            .from("crm_oportunidades")
            .select("id")
            .eq("lead_id", leadId)
            .eq("funil_id", p.funilId)
            .eq("status", "aberta")
            .limit(1)
            .maybeSingle();
          if (existe?.id) {
            if (!oportunidadeId) oportunidadeId = existe.id;
            continue;
          }
        }

        const tituloResolved =
          resolveWebhookVar(p.titulo, dados).trim() || cursoInteresse || integration.nome || "Oportunidade";
        const rawValor = resolveWebhookVar(p.valor, dados).replace(",", ".").replace(/[^0-9.\-]/g, "").trim();
        const valorNum = rawValor !== "" && Number.isFinite(Number(rawValor)) ? Number(rawValor) : null;
        const statusOp = (p.status === "ganha" || p.status === "perdida") ? p.status : "aberta";
        const { id: responsavelId, logId } = await resolverResponsavel(a.id, p.responsavel);
        const nowIso = new Date().toISOString();

        const { data: op, error: opErr } = await admin
          .from("crm_oportunidades")
          .insert({
            lead_id: leadId,
            // vincula a captacao apenas no PRIMEIRO card (constraint UNIQUE em lead_oportunidade_id)
            lead_oportunidade_id: captacaoVinculada ? null : leadOportunidadeId,
            funil_id: p.funilId,
            etapa_id: p.etapaId,
            titulo: tituloResolved,
            valor_estimado: valorNum,
            origem: fonte ?? null,
            origem_campanha: utm_campaign ?? null,
            wa_account_id: waAccId,
            responsavel_id: responsavelId,
            status: statusOp,
            entrou_na_etapa_em: nowIso,
            ultima_atividade_em: nowIso,
            reativado_de_arquivo: leadArquivadoReativado,
            reativado_em: leadArquivadoReativado ? nowIso : null,
          })
          .select("id")
          .single();
        if (opErr) throw opErr;
        if (op?.id) {
          captacaoVinculada = true;
          if (!oportunidadeId) oportunidadeId = op.id;
          // (9b.1) AÇÃO VISÍVEL "Também abrir atendimento no SAC" (toggle da Criar oportunidade):
          // abre+atribui o atendimento em SAC Comercial ao MESMO responsável da oportunidade
          // (o SDR distribuído). É a AUTOMAÇÃO que atribui o SDR no SAC — NÃO um gatilho
          // escondido. O mirror do template reaproveita esse atendimento (dedup por
          // contato+funil) → não duplica. Sem responsável distribuído → não abre.
          if (p.abrirSac === true && responsavelId && leadId) {
            try {
              const { data: cfg } = await admin
                .from("crm_pipeline_settings").select("sac_funil_comercial_id").eq("id", 1).maybeSingle();
              const sacFunilId = (cfg as any)?.sac_funil_comercial_id ?? null;
              if (sacFunilId) {
                const { data: et } = await admin
                  .from("sac_funis_etapas").select("id").eq("funil_id", sacFunilId)
                  .order("ordem", { ascending: true }).limit(1).maybeSingle();
                const sacEtapaId = (et as any)?.id ?? null;
                if (sacEtapaId) {
                  await admin.rpc("sac_cria_atend", {
                    p_lead_id: leadId, p_funil_id: sacFunilId, p_etapa_id: sacEtapaId,
                    p_responsavel_id: responsavelId, p_origem: "distribuicao",
                  });
                }
              }
            } catch (e: any) { console.error("[crm-lead-webhook] abrirSac falhou:", e?.message); }
          }
          // Estratégia setor_equipe: amarra a oportunidade na linha de crm_distribuicao_log →
          // a carga do rodízio passa a contar pelo estado real (oportunidade aberta).
          if (logId) {
            await admin.from("crm_distribuicao_log")
              .update({ lead_id: leadId, oportunidade_id: op.id })
              .eq("id", logId);
          }
          await logAtividade(
            leadId, "acao_webhook", "Ação de Webhook Integrado executada",
            `${integration.nome ?? slug} - ${ACAO_LABELS.criar_oportunidade}`,
          );
        }
      } catch (e: any) {
        console.error("[crm-lead-webhook] criar_oportunidade falhou:", e?.message);
      }
    }

    // vincula a 1a oportunidade no guard (auditoria) — best-effort
    if (whatsapp && telCanon && oportunidadeId) {
      await admin.from("crm_saudacao_guard")
        .update({ oportunidade_id: oportunidadeId })
        .eq("telefone", telCanon).eq("curso_interesse", cursoInteresse ?? "").eq("lote", lote ?? "");
    }
  }

  // (9.5) AÇÕES EXTRAS (config.acoes.itens) — opt-in. Rodam após lead/oportunidade.
  // Suportadas no edge v1: modificar_segmentos (params.adicionar/params.remover =
  // segmento_id[]), modificar_tags (params.adicionar/params.remover = tag_id[] de
  // crm_tags → grava/remove em crm_lead_tags), add_segmento/remove_segmento (LEGADO;
  // valor = segmento_id(s), 1+ IDs separados por vírgula), definir_responsavel (valor =
  // profiles.id, aplica na oportunidade criada), atualizar_lead (params.campos[]).
  // criar_oportunidade roda no passo (9b) acima.
  const segIds = (v: unknown): string[] =>
    String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const segArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
  const acoesExtras = acoesItens;
  const acoesAplicadas: string[] = [];
  // Ligado por uma ação 'enviar_mensagem_whatsapp' com ativar_ia ≠ false → o seed de
  // cliente_ppg_leads_sdr (10a) marca iniciar_atendimento/followup p/ o agente João responder.
  let acaoAtivarIa = false;
  // Loga "Adicionado ao segmento <nome>" para cada segmento REALMENTE inserido (a upsert
  // com ignoreDuplicates só retorna as linhas novas) → sem ruído quando o lead já tinha.
  async function logSegmentosAdicionados(ids: string[]) {
    if (!ids.length || !leadId) return;
    const { data: inseridos } = await admin.from("crm_lead_segmentos").upsert(
      ids.map((segmento_id) => ({ lead_id: leadId, segmento_id, origem: "auto" })),
      { onConflict: "lead_id,segmento_id", ignoreDuplicates: true },
    ).select("segmento_id");
    for (const row of (inseridos ?? [])) {
      await logAtividade(leadId, "segmento_add", "Adicionado ao segmento", await nomeSegmento((row as any).segmento_id));
    }
  }
  const acaoChip = (tipo: string) => `${integration.nome ?? slug} - ${ACAO_LABELS[tipo] ?? tipo}`;
  for (const a of acoesExtras) {
    try {
      if (a?.tipo === "modificar_segmentos" && leadId) {
        const add = segArr(a?.params?.adicionar);
        const rem = segArr(a?.params?.remover);
        if (add.length) await logSegmentosAdicionados(add);
        if (rem.length) {
          await admin.from("crm_lead_segmentos").delete().eq("lead_id", leadId).in("segmento_id", rem);
        }
        if (add.length || rem.length) {
          acoesAplicadas.push("modificar_segmentos");
          await logAtividade(leadId, "acao_webhook", "Ação de Webhook Integrado executada", acaoChip("modificar_segmentos"));
        }
      } else if (a?.tipo === "modificar_tags" && leadId) {
        // "Modificar tags do contato": adiciona/remove tags (crm_tags) em crm_lead_tags.
        // NÃO confundir com segmentos nem com tags UTM de origem.
        const add = segArr(a?.params?.adicionar);
        const rem = segArr(a?.params?.remover);
        if (add.length) {
          await admin.from("crm_lead_tags").upsert(
            add.map((tag_id) => ({ lead_id: leadId, tag_id, origem: "auto" })),
            { onConflict: "lead_id,tag_id", ignoreDuplicates: true },
          );
        }
        if (rem.length) {
          await admin.from("crm_lead_tags").delete().eq("lead_id", leadId).in("tag_id", rem);
        }
        if (add.length || rem.length) {
          acoesAplicadas.push("modificar_tags");
          await logAtividade(leadId, "acao_webhook", "Ação de Webhook Integrado executada", acaoChip("modificar_tags"));
        }
      } else if (a?.tipo === "add_segmento" && a?.valor && leadId) {
        const ids = segIds(a.valor);
        if (ids.length) {
          await logSegmentosAdicionados(ids);
          acoesAplicadas.push("add_segmento");
          await logAtividade(leadId, "acao_webhook", "Ação de Webhook Integrado executada", acaoChip("add_segmento"));
        }
      } else if (a?.tipo === "remove_segmento" && a?.valor && leadId) {
        const ids = segIds(a.valor);
        if (ids.length) {
          await admin.from("crm_lead_segmentos").delete().eq("lead_id", leadId).in("segmento_id", ids);
          acoesAplicadas.push("remove_segmento");
          await logAtividade(leadId, "acao_webhook", "Ação de Webhook Integrado executada", acaoChip("remove_segmento"));
        }
      } else if (a?.tipo === "definir_responsavel" && a?.valor && oportunidadeId) {
        await admin.from("crm_oportunidades").update({ responsavel_id: a.valor }).eq("id", oportunidadeId);
        acoesAplicadas.push("definir_responsavel");
        await logAtividade(leadId, "acao_webhook", "Ação de Webhook Integrado executada", acaoChip("definir_responsavel"));
      } else if (a?.tipo === "atualizar_lead" && leadId) {
        // "Atualizar campo do contato": grava (SOBRESCREVE) cada campo configurado.
        // Aceita lead.* (coluna física, inclui email/whatsapp normalizados) e
        // campo:<alias> (coluna física whitelisted OU EAV). Valor resolve {webhook=Campo};
        // valor vazio = não mexe no campo (não apaga sem querer).
        const itens = Array.isArray(a?.params?.campos) ? a.params.campos : [];
        const leadPatch: Record<string, string> = {};
        const eavOverwrite: Array<{ campo_id: string; tipo: string; valor: string }> = [];
        for (const it of itens) {
          const target = it?.campo;
          if (typeof target !== "string" || !target) continue;
          const val = resolveWebhookVar(it?.valor, dados).trim();
          if (!val) continue;
          let col: string | null = null;
          let eavMeta: { id: string; tipo: string } | null = null;
          if (target.startsWith("lead.")) {
            col = LEAD_COL[target] ?? null;
          } else if (target.startsWith("campo:")) {
            const meta = camposCatalogo.get(target.slice(6));
            if (meta) {
              if (meta.lead_coluna) col = meta.lead_coluna;
              else eavMeta = { id: meta.id, tipo: meta.tipo };
            }
          }
          if (col === "email") { const e = normalizeEmail(val); if (e) leadPatch.email = e; }
          else if (col === "whatsapp") { const w = normalizeWhatsapp(val); if (w) leadPatch.whatsapp = w; }
          else if (col && LEAD_COLS_WL.has(col)) leadPatch[col] = val;
          else if (eavMeta) eavOverwrite.push({ campo_id: eavMeta.id, tipo: eavMeta.tipo, valor: val });
        }
        let mudou = false;
        if (Object.keys(leadPatch).length) {
          await admin.from("leads").update(leadPatch).eq("id", leadId);
          mudou = true;
        }
        for (const e of eavOverwrite) {
          // SOBRESCREVE (sem ignoreDuplicates): zera as outras colunas typed e grava a do tipo.
          await admin.from("crm_campo_valores").upsert(
            { lead_id: leadId, campo_id: e.campo_id, value_text: null, value_number: null, value_date: null, value_json: null, ...eavCols(e.tipo, e.valor) },
            { onConflict: "lead_id,campo_id" },
          );
          mudou = true;
        }
        if (mudou) {
          acoesAplicadas.push("atualizar_lead");
          await logAtividade(leadId, "acao_webhook", "Ação de Webhook Integrado executada", acaoChip("atualizar_lead"));
        }
      } else if (a?.tipo === "enviar_mensagem_whatsapp") {
        // "Enviar template WhatsApp": dispara um template aprovado já com as variáveis
        // mapeadas dos campos do webhook ({webhook=Campo}, na ordem {{1}},{{2}}…). Encurta o
        // fluxo (webhook recebe → manda o template) sem depender de automação separada.
        // params (builder) OU config (legado SQL). ativar_ia liga o agente João p/ o lead.
        const pc: any = a?.params ?? (a as any)?.config ?? {};
        const templateName = String(pc.template_id ?? pc.template_name ?? "").trim();
        if (templateName && telCanon && whatsapp) {
          const variaveis = Array.isArray(pc.variaveis) ? pc.variaveis : [];
          const parameters = variaveis
            .map((v: unknown) => resolveWebhookVar(v, dados))
            .map((text: string) => ({ type: "text", text }));
          const components = parameters.length ? [{ type: "body", parameters }] : [];
          try {
            const resp = await fetch(`${SUPABASE_URL}/functions/v1/crm-whatsapp-send`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` },
              body: JSON.stringify({
                // Número escolhido na ação (seletor do builder) > conta ancorada no fluxo.
                wa_account_id: (typeof pc.wa_account_id === "string" && pc.wa_account_id) || waAccId,
                telefone: whatsapp,
                tipo: "template",
                template_name: templateName,
                template_lang: pc.template_lang || "pt_BR",
                template_components: components,
              }),
            });
            if (resp.ok) {
              acoesAplicadas.push("enviar_mensagem_whatsapp");
              await logAtividade(leadId, "acao_webhook", "Ação de Webhook Integrado executada", acaoChip("enviar_mensagem_whatsapp"));
            } else {
              console.error("[crm-lead-webhook] enviar_mensagem_whatsapp falhou:", resp.status, await resp.text().catch(() => ""));
            }
          } catch (e: any) {
            console.error("[crm-lead-webhook] enviar_mensagem_whatsapp erro:", e?.message);
          }
        }
        if (pc.ativar_ia !== false) acaoAtivarIa = true;
      }
    } catch (e: any) {
      console.error("[crm-lead-webhook] acao extra falhou:", a?.tipo, e?.message);
    }
  }

  // (10) Fura 'novo_lead' pro n8n com o CONTEXTO (semeia cliente_ppg_leads_sdr no agente).
  // NAO envia mensagem — quem manda o template e a engine de automacao. So dispara quando
  // vamos abrir card (abrirCards — inclui lead IDENTIFICADO com acao) E ha whatsapp.
  let novoLeadDisparado = false;
  if (abrirCards && whatsapp && telCanon) {
    // (10a) Seed cliente_ppg_leads_sdr (CONTEXTO do agente). O n8n só escuta eventos de
    // MENSAGEM (webhook apioficial), NÃO o webhook do SprintHub — então o lead é semeado
    // aqui, server-side. Upsert manual por remotejid (não há unique no remotejid): insere
    // só se ainda não existir; a conversa depois atualiza o estado.
    try {
      const remoteJid = `${telCanon}@s.whatsapp.net`;
      const { data: leadSdr } = await admin
        .from("cliente_ppg_leads_sdr")
        .select("id, nome, curso_interesse_original, formacao_academica")
        .eq("remotejid", remoteJid)
        .maybeSingle();
      const novaForm = formacaoLead ?? tempoFormacao ?? areaLead;
      if (!leadSdr) {
        await admin.from("cliente_ppg_leads_sdr").insert({
          remotejid: remoteJid,
          nome: nome ?? null,
          numero_formatado: whatsapp ?? null,
          email: email ?? null,
          curso_interesse_original: cursoParaAgente ?? null,
          formacao_academica: novaForm ?? null,
          fonte: "sprinthub",
          pausa_ia: false,
          dados_iniciais_coletados: false,
          // Só liga o agente quando a ação 'Enviar template WhatsApp' pediu (ativar_ia).
          iniciar_atendimento: acaoAtivarIa,
          followup_ativado: acaoAtivarIa,
        });
      } else {
        // Lead JÁ EXISTIA: preenche os campos VAZIOS do registro do agente (fill-if-empty,
        // não sobrescreve bom). Antes só mexia em iniciar_atendimento → por isso ~95% ficavam
        // SEM curso/nome no agente e o envia_informacoes dava pos_nao_encontrada.
        const ls = leadSdr as any;
        const vazio = (s: any) => !s || !String(s).trim() || String(s).trim().toLowerCase() === "sem nome";
        const patch: Record<string, unknown> = {};
        if (vazio(ls.curso_interesse_original) && cursoParaAgente) patch.curso_interesse_original = cursoParaAgente;
        if (vazio(ls.nome) && nome) patch.nome = nome;
        if (vazio(ls.formacao_academica) && novaForm) patch.formacao_academica = novaForm;
        if (acaoAtivarIa) patch.iniciar_atendimento = true; // responde quando reagir ao template
        if (Object.keys(patch).length) {
          await admin.from("cliente_ppg_leads_sdr").update(patch).eq("id", ls.id);
        }
      }
    } catch (e: any) {
      console.error("[crm-lead-webhook] seed cliente_ppg_leads_sdr falhou:", e?.message);
    }

    const { data: cfg2 } = await admin
      .from("crm_pipeline_settings")
      .select("n8n_webhook_url, n8n_webhook_secret")
      .eq("id", 1)
      .maybeSingle();
    if (cfg2?.n8n_webhook_url) {
      try {
        await fetch(cfg2.n8n_webhook_url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(cfg2.n8n_webhook_secret ? { "X-Webhook-Secret": cfg2.n8n_webhook_secret } : {}),
          },
          body: JSON.stringify({
            event: "novo_lead",
            lead_id: leadId,
            oportunidade_id: oportunidadeId,
            nome,
            telefone: whatsapp,
            remotejid: `${telCanon}@s.whatsapp.net`,
            curso_interesse: cursoParaAgente,
            formacao: formacaoLead ?? tempoFormacao ?? areaLead,
            lote: lote ?? null,
            origem: "sprinthub",
            wa_account_id: waAccId,
          }),
        });
        novoLeadDisparado = true;
      } catch (e: any) {
        console.error("[crm-lead-webhook] novo_lead forward erro:", e?.message);
      }
    }
  }

  // (11) log
  await admin.from("crm_webhook_logs").insert({
    integration_id: integration.id, slug, payload, ...reqMeta,
    resultado: {
      lead_id: leadId, segmento_aplicado: segmentoAplicado,
      lead_oportunidade_id: leadOportunidadeId, oportunidade_id: oportunidadeId, duplicado,
      duplicado_lote: duplicadoLote, novo_lead_disparado: novoLeadDisparado, lote: lote ?? null,
      acoes_aplicadas: acoesAplicadas,
      // observabilidade da normalização: null = título não resolvido (candidato a alias)
      curso_canonico: cursoCanonico,
      lead_arquivado_reativado: leadArquivadoReativado || undefined,
    },
    status: duplicado ? "duplicado" : "ok",
    ip_origem: ipOrigem,
  });

  // (12) MAPEAMENTO DE RETORNO (config.retorno) — opt-in. Se definido, devolve um objeto
  // custom com variáveis resolvidas; senão, mantém o shape padrão. Código de status vem de
  // integration.codigo_status (default 200 → sem mudança p/ webhooks antigos).
  const statusResp = Number(integration.codigo_status) || 200;
  const retorno = Array.isArray(config?.retorno) ? config.retorno : [];
  if (retorno.length > 0) {
    const ctx: Record<string, unknown> = {
      "lead.id": leadId,
      "oportunidade.id": oportunidadeId,
      "lead_oportunidade.id": leadOportunidadeId,
      "segmento": segmentoAplicado,
      "duplicado": duplicado,
      "duplicado_lote": duplicadoLote,
    };
    const out: Record<string, string> = {};
    for (const r of retorno) {
      if (r?.chave) out[String(r.chave)] = resolveRetornoVal(r?.valor, ctx);
    }
    return json(out, statusResp);
  }

  return json({
    ok: true,
    lead_id: leadId,
    segmento_aplicado: segmentoAplicado,
    lead_oportunidade_id: leadOportunidadeId,
    oportunidade_id: oportunidadeId,
    duplicado,
    duplicado_lote: duplicadoLote,
    novo_lead_disparado: novoLeadDisparado,
    acoes_aplicadas: acoesAplicadas,
  }, statusResp);
});
