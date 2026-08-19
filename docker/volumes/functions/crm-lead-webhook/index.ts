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
//   (3.5) MODO MAPEAMENTO: se a integracao tem escuta ativa (crm_webhook_escutas), a chamada
//       e' SO LOGADA (status='escuta') e NADA e' processado — ver secao "escuta" no CLAUDE.md
//   (3.6) TRAVA DE REENVIO (idempotencia): payload com `dados_completos.id` (lead id da
//       Meta) que JA virou lead NESTA integracao e' logado como duplicado e devolvido ok,
//       SEM processar nada — contra o re-push da planilha pelo n8n. `?force=1` pula.
//   (4) find-or-create lead (dedup OR email/whatsapp)
//   (5) ANTI-RAJADA da saudacao por (telefone, curso, lote, INTEGRACAO) via
//       crm_saudacao_guard: gateia a CRIACAO da captacao/card dentro de uma JANELA
//       (CRM_SAUDACAO_GUARD_TTL_MIN, default 60 min). Fora da janela a chave e renovada
//       e o card volta a ser decidido pelo naoCriarRepetidas da acao (passo 9b).
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
import { telefoneEnviavel } from "../_shared/telefone.ts";
import { aplicarFiltrosToken, parseTokenWebhook } from "./tokenFiltros.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/**
 * Tag "[Sistema] Telefone inválido" (`crm_tags`), criada com UUID FIXO pela
 * migration `20260817200000_tag_telefone_invalido.sql` — marca o contato cujo número
 * é estruturalmente impossível. Desde 2026-08-18 o número É gravado (a tag existe
 * justamente para sinalizar isso, não para explicar uma ausência). Ver o bloco (10.9).
 */
const TAG_TELEFONE_INVALIDO = "00000000-0000-4000-8000-00000000ca11";

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

// Lê uma chave de `dados` aceitando CAMINHO ANINHADO com "." (ex.: "dados_completos.email" —
// n8n/Meta que manda o formulário inteiro dentro de um objeto). Regras (2026-07-17):
// - 1º tenta a chave EXATA no primeiro nível: chave com ponto LITERAL (ex.: "eu_sou...")
//   continua funcionando como sempre — zero regressão pros mapeamentos flat existentes.
// - Só então desce o caminho segmento a segmento. Segmento que cai numa STRING que parece
//   JSON-objeto é parseado (LP form-urlencoded manda o objeto aninhado como string).
function valorDoPayload(dados: any, chave: string): unknown {
  if (!dados || typeof dados !== "object") return undefined;
  const direto = (dados as Record<string, unknown>)[chave];
  if (direto !== undefined) return direto;
  if (!chave.includes(".")) return undefined;
  return resolveSegmentos(dados, chave.split("."));
}

// Resolve os segmentos do caminho com casamento GULOSO (junção mais longa primeiro) —
// cobre chave com ponto LITERAL também DENTRO do objeto aninhado (ex.: a chave real
// "eu_sou..." sob dados_completos: o caminho "dados_completos.eu_sou..." casa a junção
// "eu_sou..." inteira antes de tentar descer por "eu_sou").
function resolveSegmentos(atual: unknown, segs: string[]): unknown {
  if (segs.length === 0) return atual;
  if (typeof atual === "string") {
    const s = atual.trim();
    if (!s.startsWith("{")) return undefined;
    try { atual = JSON.parse(s); } catch { return undefined; }
  }
  if (!atual || typeof atual !== "object" || Array.isArray(atual)) return undefined;
  const obj = atual as Record<string, unknown>;
  for (let i = segs.length; i >= 1; i--) {
    const v = obj[segs.slice(0, i).join(".")];
    if (v === undefined) continue;
    const r = resolveSegmentos(v, segs.slice(i));
    if (r !== undefined) return r;
  }
  return undefined;
}

// Procura no payload o primeiro valor cujo target no mapping = wantedTarget.
function pickByMapping(payload: any, mapping: Record<string, string>, wantedTarget: string): unknown {
  for (const [k, t] of Object.entries(mapping)) {
    if (t !== wantedTarget) continue;
    const v = valorDoPayload(payload, k);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

// Página de captação = URL da LP. Toda LP manda a URL (GreatPages = chave "URL"); pegamos
// AUTOMÁTICO, sem depender de mapeamento. Escaneia as chaves comuns (case-insensitive) e
// devolve o 1º valor não-vazio. Origem/UTM não são capturadas aqui (decisão diretor
// 2026-07-16: só a Página é automática; fonte/fonte_referencia ficam vazias).
const URL_KEYS = ["url", "page_url", "pageurl", "page_uri", "pagina", "page", "landing_page", "lp"];
function pickUrlAuto(dados: Record<string, unknown>): string | undefined {
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(dados)) lower[k.toLowerCase()] = v;
  for (const key of URL_KEYS) {
    const v = lower[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

// ── Builder (config JSONB): execução ADITIVA das abas avançadas ──────────────
// IMPORTANTE: tudo aqui é opt-in. Config vazio (webhooks antigos) => comportamento
// idêntico ao anterior. Cada bloco é defensivo (try/catch) e nunca derruba o core.

/**
 * Destinos aceitos SÓ na Criação Automática (fill-if-empty), nunca no LEAD_COL global.
 * São os campos que antes só existiam como destino do Mapeamento de Entrada e por isso
 * prendiam a coluna "Campo do contato" na aba 1.
 *
 * ⚠️ Fora do LEAD_COL de propósito: lá eles virariam alvo do "Atualizar campo do contato",
 * que SOBRESCREVE — e reescrever `fonte` dispara apply_fonte_segmento → segmento → fluxo
 * publicado (WhatsApp). Aqui o uso é sempre fill-if-empty, como já era pelo Mapeamento.
 *
 * Os `meta_*` alimentam o filtro "por formulário" da Gestão de Leads (useMetaFormNames) e
 * o bloco de campanha/criativo do Contato 360 — sem eles aqui, as integrações do
 * formulário instantâneo do Meta não poderiam sair do Mapeamento.
 */
const LEAD_COL_SO_CRIACAO: Record<string, string> = {
  "lead.fonte": "fonte",
  "lead.pagina_nome": "pagina_nome",
  "lead.meta_campaign_id": "meta_campaign_id",
  "lead.meta_campaign_name": "meta_campaign_name",
  "lead.meta_adset_id": "meta_adset_id",
  "lead.meta_adset_name": "meta_adset_name",
  "lead.meta_ad_id": "meta_ad_id",
  "lead.meta_ad_name": "meta_ad_name",
  "lead.meta_form_id": "meta_form_id",
  "lead.meta_form_name": "meta_form_name",
  "lead.meta_platform": "meta_platform",
};

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
      const v = c?.campo ? valorDoPayload(payload, String(c.campo)) : undefined;
      return v !== undefined && v !== null && String(v).trim() !== "";
    }
    case "campo_igual": {
      const v = c?.campo ? valorDoPayload(payload, String(c.campo)) : undefined;
      return v !== undefined && String(v).trim() === String(c?.valor ?? "").trim();
    }
    // tem_tag / tem_segmento e tipos desconhecidos: não aplicados no edge v1 → não bloqueiam
    default: return true;
  }
}

/** Substitui {webhook=Chave} pelo valor do payload (Criação Automática). Aceita caminho
 *  aninhado com "." (valorDoPayload) — ex.: {webhook=dados_completos.full_name} — e
 *  FILTROS depois de "|" (tokenFiltros.ts) — ex.:
 *  {webhook=dados_completos.full_name|primeiro_nome|capitalizar} = "Maria" a partir de
 *  "MARIA APARECIDA DA SILVA". É por aqui que a ação "Enviar template WhatsApp" manda só o
 *  1º nome, já que a variável vem do PAYLOAD e não de um campo do lead. */
function resolveWebhookVar(template: unknown, payload: any): string {
  return String(template ?? "").replace(/\{webhook=([^}]+)\}/g, (_m, k) => {
    const { chave, filtros } = parseTokenWebhook(String(k));
    const v = valorDoPayload(payload, chave);
    const bruto = v === undefined || v === null ? "" : String(v);
    return filtros.length ? aplicarFiltrosToken(bruto, filtros) : bruto;
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
  definir_responsavel_contato: "Definir responsável do contato",
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

  // (3.5) MODO MAPEAMENTO ("escuta" do builder) — DRY-RUN.
  // Se ESTA integração está com uma escuta ATIVA (linha não expirada em crm_webhook_escutas),
  // o que chega aqui é payload PARA MAPEAR CAMPOS, não um lead: apenas REGISTRAMOS a chamada
  // (status='escuta', com corpo/query/headers) e devolvemos 200 SEM processar NADA — sem
  // contato, sem captação, sem oportunidade, sem segmento, sem template/ações. É o modal do
  // builder que lê esse log e detecta os campos.
  // Escopo = a integração (o link daquela webhook). Integração sem escuta ativa segue normal;
  // a escuta expira sozinha (expira_em), então o webhook nunca fica "mudo" por esquecimento.
  try {
    const { data: escuta } = await admin
      .from("crm_webhook_escutas")
      .select("token, expira_em")
      .eq("integration_id", integration.id)
      .gt("expira_em", new Date().toISOString())
      .maybeSingle();
    if (escuta) {
      await admin.from("crm_webhook_logs").insert({
        integration_id: integration.id, slug, payload, status: "escuta",
        erro: null, ip_origem: ipOrigem, ...reqMeta,
        resultado: { modo: "mapeamento", processado: false, escuta_token: escuta.token },
      });
      return json({ ok: true, modo: "mapeamento", processado: false }, 200);
    }
  } catch (e: any) {
    // Falha ao checar a escuta NÃO pode derrubar o intake: segue o fluxo normal de produção.
    console.error("[crm-lead-webhook] escuta check erro:", e?.message);
  }

  const mapping = (integration.field_mapping ?? {}) as Record<string, string>;
  const config = (integration.config ?? {}) as any; // builder: abas avançadas (opt-in)

  // (3.6) TRAVA DE REENVIO por IDENTIFICADOR EXTERNO (idempotência) — 2026-08-18.
  // Contexto: o n8n do Formulário INSTANTÂNEO do Meta relê a planilha de 5 em 5 min e
  // reposta a MESMA linha enquanto a marca `enviado_crm` não gruda nela. Oito linhas presas
  // geraram 13.223 reprocessos em 7 dias (85% de TODO o tráfego de webhook do sistema),
  // 3.092 captações e 6.188 atividades para UMA pessoa e 3.086 "recadastros" falsos num
  // único card. A causa raiz é do lado do n8n (a marcação casava por TELEFONE; passou a
  // casar pelo `id` da Meta), mas o intake não pode ser cúmplice: se a MESMA submissão
  // externa já virou lead NESTA integração, respondemos ok — para o remetente conseguir
  // marcar a linha — e não processamos NADA de novo.
  // Mesma família do descarte "lead arquivado recente" (passo 8b): desfecho deliberado,
  // resposta HONRA o config.retorno (é o {"sucesso":"true"} que o IF do n8n valida).
  // Escopo deliberadamente estreito: só vale quando o payload traz `dados_completos.id` —
  // o lead id da Meta, único por submissão. Payload sem esse campo => fluxo antigo intacto.
  // Escape hatch: `?force=1` na URL pula a trava (reprocesso manual depois de arrumar
  // mapeamento). Uma nova submissão da MESMA pessoa tem id novo e passa normalmente.
  const idExterno = asString((payload as Record<string, any>)?.dados_completos?.id, 200);
  if (idExterno && String(queryParams.force ?? "") !== "1") {
    try {
      const { data: jaProcessado } = await admin
        .from("crm_webhook_logs")
        .select("id, criado_em")
        .eq("integration_id", integration.id)
        .eq("payload->dados_completos->>id", idExterno)
        .in("status", ["ok", "duplicado"])
        .limit(1)
        .maybeSingle();
      if (jaProcessado) {
        await admin.from("crm_webhook_logs").insert({
          integration_id: integration.id, slug, payload, status: "duplicado",
          erro: null, ip_origem: ipOrigem, ...reqMeta,
          resultado: {
            reenvio_ignorado: true, processado: false, duplicado: true,
            id_externo: idExterno,
            chegada_anterior_em: jaProcessado.criado_em,
            chegada_anterior_log_id: jaProcessado.id,
          },
        });
        const retornoReenvio = Array.isArray(config?.retorno) ? config.retorno : [];
        if (retornoReenvio.length > 0) {
          const ctxReenvio: Record<string, unknown> = {
            "lead.id": null, "oportunidade.id": null, "lead_oportunidade.id": null,
            "segmento": null, "duplicado": true, "duplicado_lote": false,
          };
          const outReenvio: Record<string, string> = {};
          for (const r of retornoReenvio) {
            if (r?.chave) outReenvio[String(r.chave)] = resolveRetornoVal(r?.valor, ctxReenvio);
          }
          return json(outReenvio, Number(integration.codigo_status) || 200);
        }
        return json(
          { ok: true, reenvio_ignorado: true, processado: false, duplicado: true, id_externo: idExterno },
          Number(integration.codigo_status) || 200,
        );
      }
    } catch (e: any) {
      // Checagem falhou NÃO derruba o intake: segue o fluxo normal de produção.
      console.error("[crm-lead-webhook] trava de reenvio erro:", e?.message);
    }
  }

  // Fonte unificada de dados p/ mapeamento/tokens/validação: Corpo + Query + Headers.
  // O Mapeamento de Entrada tem 3 seções (Query/Corpo/Headers); o field_mapping casa a
  // CHAVE contra qualquer uma. Body tem prioridade em caso de chave repetida. O log segue
  // gravando o `payload` (corpo) cru; query/headers já vão no log via ...reqMeta.
  const dados: Record<string, unknown> = { ...queryParams, ...headersObj, ...(payload as Record<string, unknown>) };

  // Grafias LEGADAS de UTM (typos herdados do GreatPages/prompt antigo do Pages):
  // "utm_campaing"→"utm_campaign" e "utm_contet"→"utm_content", fill-if-missing nos DOIS
  // sentidos, SÓ na resolução (`dados`) — o log segue gravando o corpo cru. É o que permite
  // padronizar todo config em {webhook=utm_campaign}/{webhook=utm_content} sem tocar as LPs
  // antigas, que seguem enviando o typo (2026-08-05). ⚠️ Espelho: webhookSample.ts
  // (valorAmostra) aplica o MESMO alias na prévia "o que veio" do builder.
  for (const [certo, typo] of [["utm_campaign", "utm_campaing"], ["utm_content", "utm_contet"]]) {
    if (dados[certo] === undefined && dados[typo] !== undefined) dados[certo] = dados[typo];
    else if (dados[typo] === undefined && dados[certo] !== undefined) dados[typo] = dados[certo];
  }

  // (4) extrai campos do lead via mapping
  const nome     = asString(pickByMapping(dados, mapping, "lead.nome"), 200);
  const email    = normalizeEmail(pickByMapping(dados, mapping, "lead.email"));
  const whatsapp = normalizeWhatsapp(pickByMapping(dados, mapping, "lead.whatsapp"));

  // ⚠️ Guarda de formato — MARCA, não descarta (2026-08-18). Até aqui o número
  // estruturalmente impossível era jogado fora ANTES de gravar. O motivo era certo (a
  // Meta queima o template e só depois devolve 131026), mas o remédio ficava no lugar
  // errado: o contato nascia sem telefone nenhum e o SDR nem sabia que a pessoa tinha
  // digitado alguma coisa. Agora o número é GRAVADO como veio, quem julga o que pode
  // SAIR é o envio (`crm-whatsapp-send`, régua compartilhada em `_shared/telefone.ts`)
  // e o contato fica sinalizado — ver `whatsappImpossivel` logo abaixo do `whatsappLead`.

  // campos adicionais do lead (gravados em public.leads) + lote (controle de dedup)
  const cursoInteresse = asString(pickByMapping(dados, mapping, "lead.curso_interesse"), 200);
  const formacaoLead   = asString(pickByMapping(dados, mapping, "lead.profissao"), 200);      // "formação" / área de atuação
  const areaLead       = asString(pickByMapping(dados, mapping, "lead.area_interesse"), 200);
  const tempoFormacao  = asString(pickByMapping(dados, mapping, "lead.tempo_formacao"), 200);
  const lote           = asString(pickByMapping(dados, mapping, "control.lote"), 200);

  // ⚠️ NÃO há gate de identificador aqui (2026-08-12). O identificador (aba Entrada,
  // coluna "Identificador Para") serve pra ENCONTRAR o contato na base — é a chave de
  // DEDUP, não o cadastro. Quem cadastra é a Criação Automática. Até 2026-08-12 a falta
  // dele derrubava a chamada inteira em 422 `sem_identificador`, o que (a) impedia
  // integração deliberadamente sem identificador (todo POST vira contato novo) e (b)
  // descartava o formulário inteiro quando SÓ o identificador vinha torto — ex.: LP de
  // processo seletivo com WhatsApp como identificador e telefone digitado errado perdia
  // nome, e-mail, currículo e todas as respostas. Agora o intake segue: sem identificador
  // = sem dedup (cria direto). O descarte por "nada pra cadastrar" ficou logo antes do
  // passo (5), depois que a Criação Automática já foi resolvida.

  // ⚠️ A VALIDAÇÃO DE ENTRADA (config.validacao) NÃO roda mais aqui — desceu pro passo
  // (4.6), depois da Criação Automática. `tem_email`/`tem_whatsapp` perguntam se O CONTATO
  // tem o dado, e o dado pode vir só da Criação Automática; rodando antes dela, a condição
  // só enxergava o identificador e descartava envio legítimo. Nada entre um ponto e outro
  // escreve no banco, então o descarte continua acontecendo antes de qualquer gravação.

  // ── Campos do contato (catálogo crm_campos) mapeados como `campo:<alias>` ──────
  // O builder agora oferece TODOS os campos de contato (sistema + customizados, ex.:
  // Estado). Resolvemos cada alias: coluna física de `leads` (lead_coluna whitelisted)
  // OU valor customizado (EAV crm_campo_valores). Tudo defensivo — nunca derruba o intake.
  // ⚠️ Espelha LEAD_COLUNAS_PERMITIDAS (useCrmCamposCustomizados) — mudou lá, reflita aqui.
  const LEAD_COLS_WL = new Set([
    "nome", "profissao", "area_interesse", "curso_interesse", "tempo_formacao", "regiao",
    "linkedin", "cargo", // espelhos do decisor B2B / contatos da empresa (2026-07-17)
  ]);
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
    const val = asString(valorDoPayload(dados, chave), 500);
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
  // Página = URL da LP (auto). Mapeamento explícito lead.pagina_nome tem prioridade;
  // senão a URL do payload (pickUrlAuto). Preenchida fill-if-empty no lead novo E existente.
  const inPagina = asString(pickByMapping(dados, mapping, "lead.pagina_nome") ?? pickUrlAuto(dados), 500);
  // Fonte (leads.fonte) — opt-in via mapeamento `lead.fonte` (tipicamente um valor fixo na
  // query string da URL, ex.: formulário instantâneo do Meta que chega pelo n8n e precisa
  // continuar contando como "Formulário Direto" na Gestão de Leads). Sem mapeamento fica
  // NULL e o trigger compute_lead_fonte decide como sempre (ele PRESERVA fonte já
  // preenchida quando fonte_referencia vem vazia). Fill-if-empty no lead existente.
  const inFonte = asString(pickByMapping(dados, mapping, "lead.fonte"), 100);
  // Metadados do anúncio (campanha/conjunto/criativo/formulário). O formulário INSTANTÂNEO
  // do Meta não passa por LP, entao não traz UTM na URL — a atribuição vem destes campos,
  // que alimentam o filtro "por formulário" da Gestão de Leads (useMetaFormNames) e o bloco
  // de campanha/criativo do Contato 360. Opt-in: só grava o que estiver mapeado.
  const META_COLS = [
    "meta_campaign_id", "meta_campaign_name", "meta_adset_id", "meta_adset_name",
    "meta_ad_id", "meta_ad_name", "meta_form_id", "meta_form_name", "meta_platform",
  ] as const;
  const inMeta: Record<string, string> = {};
  for (const c of META_COLS) {
    const v = asString(pickByMapping(dados, mapping, `lead.${c}`), 255);
    if (v) inMeta[c] = v;
  }
  // UTMs em leads.utm_* — mapeáveis (lead.utm_*). No lead de LP elas são extraídas da URL
  // pelo trigger compute_lead_fonte; o formulário instantâneo do Meta não tem URL, então
  // aplicamos o MESMO proxy do webhook-leads: campanha/conjunto/anúncio viram
  // utm_campaign/utm_term/utm_content (é o que liga esses leads ao Melhores Criativos).
  // O proxy só age quando há meta_* mapeado ⇒ integração que não mapeia nada segue igual.
  // gclid/fbclid entram no MESMO balde das UTMs (2026-07-31): as LPs Lovable passaram
  // a persistir os dois em sessionStorage e mandá-los na query. São opt-in por
  // mapeamento (lead.gclid / lead.fbclid) — integração que não mapeia segue idêntica.
  const inUtm: Record<string, string> = {};
  for (const c of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "gclid", "fbclid"]) {
    const v = asString(pickByMapping(dados, mapping, `lead.${c}`), 255);
    if (v) inUtm[c] = v;
  }
  if (!inUtm.utm_campaign && inMeta.meta_campaign_name) inUtm.utm_campaign = inMeta.meta_campaign_name;
  if (!inUtm.utm_content  && inMeta.meta_ad_name)       inUtm.utm_content  = inMeta.meta_ad_name;
  if (!inUtm.utm_term     && inMeta.meta_adset_name)    inUtm.utm_term     = inMeta.meta_adset_name;

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
        // `fonte` e `pagina_nome` não são campos do catálogo (não têm `campo:<alias>`) e
        // só existiam como destino do Mapeamento de Entrada. Aceitá-los aqui é o que
        // permite a aba 1 ficar só com o Identificador. NÃO entram no LEAD_COL global de
        // propósito: lá eles virariam alvo do "Atualizar campo do contato", que
        // SOBRESCREVE — e reescrever `fonte` dispara apply_fonte_segmento → segmento →
        // fluxo publicado (WhatsApp). Aqui o uso é fill-if-empty, como já era com o
        // Mapeamento.
        if (!col && typeof c?.campo === "string" && LEAD_COL_SO_CRIACAO[c.campo]) {
          col = LEAD_COL_SO_CRIACAO[c.campo];
        }
        if (!col) continue;
        const val = resolveWebhookVar(c?.valor, dados).trim();
        if (!val) continue;
        if (col === "email") { const e = normalizeEmail(val); if (e) criacaoDefaults.email = e; }
        else if (col === "whatsapp") {
          // Grava igual ao identificador — inclusive o impossível. O bloqueio de envio
          // é downstream; aqui só interessa não perder o que a pessoa digitou.
          const w = normalizeWhatsapp(val);
          if (w) criacaoDefaults.whatsapp = w;
        }
        else criacaoDefaults[col] = val;
      }
    }
  } catch (e: any) {
    console.error("[crm-lead-webhook] criacaoAutomatica defaults erro:", e?.message);
  }

  // Os meta_* que vieram da Criação Automática entram no MESMO balde do Mapeamento
  // (fill-if-empty) — assim todo ponto que já lê `inMeta` funciona sem mudança: INSERT do
  // lead, patch do existente e o forward. O Mapeamento continua tendo prioridade.
  for (const col of Object.values(LEAD_COL_SO_CRIACAO)) {
    if (col.startsWith("meta_") && !inMeta[col] && criacaoDefaults[col]) inMeta[col] = criacaoDefaults[col];
  }
  // Reaplica o proxy campanha/conjunto/anúncio → utm_campaign/term/content agora que os
  // meta_* podem ter chegado pela Criação Automática (é idempotente: só age se vazio).
  if (!inUtm.utm_campaign && inMeta.meta_campaign_name) inUtm.utm_campaign = inMeta.meta_campaign_name;
  if (!inUtm.utm_content  && inMeta.meta_ad_name)       inUtm.utm_content  = inMeta.meta_ad_name;
  if (!inUtm.utm_term     && inMeta.meta_adset_name)    inUtm.utm_term     = inMeta.meta_adset_name;

  // ── Contato EFETIVO vs IDENTIFICADOR (2026-08-12) ────────────────────────────
  // `email`/`whatsapp` = IDENTIFICADOR (aba Entrada) e servem SÓ pra dedup no passo (5).
  // `emailLead`/`whatsappLead` = o que o contato realmente tem depois de somar a Criação
  // Automática — é isso que grava em `leads`, alimenta o guard anti-rajada, o template, o
  // seed da IA e o forward. Antes esses pontos liam o identificador direto, então
  // integração que punha o WhatsApp só na Criação Automática criava o contato COM número
  // e mesmo assim não mandava template nem ligava a IA (meio-comportamento silencioso).
  const emailLead    = email ?? criacaoDefaults.email ?? null;
  const whatsappLead = whatsapp ?? criacaoDefaults.whatsapp ?? null;

  // Número que NÃO pode existir (LP truncou, DDI duplicado, nome no campo telefone).
  // Vale para as duas portas — identificador e Criação Automática —, por isso mora
  // aqui, depois do `whatsappLead`. Não impede a gravação: só liga o alarme (tag +
  // timeline no passo 10.9) e segura o seed do agente no passo (10).
  const whatsappImpossivel = whatsappLead && !telefoneEnviavel(whatsappLead) ? whatsappLead : null;

  // Descarte por "não há NADA pra cadastrar" — substitui o antigo gate de identificador.
  // Não é sobre dedup: é sobre webhook que chegou sem nenhum dado de contato aproveitável
  // (mapeamento vazio / payload que não casa com nada). Sem isso, integração mal
  // configurada viraria fábrica de contato "Sem nome" vazio.
  //
  // Só conta valor da Criação Automática que VEIO DO PAYLOAD (token {webhook=...}
  // resolvido). Valor literal fixo (ex.: fonte = "Formulário PS") não conta: ele existe em
  // TODA chamada, então sozinho transformaria um POST vazio (probe, bot, teste) em contato.
  const criacaoVeioDoPayload = (() => {
    try {
      const criacao = config?.criacaoAutomatica;
      if (!criacao?.habilitada || !Array.isArray(criacao.campos)) return false;
      return criacao.campos.some((c: any) =>
        String(c?.valor ?? "").includes("{webhook=") && resolveWebhookVar(c?.valor, dados).trim() !== "");
    } catch { return false; }
  })();
  const temDadosDeContato = Boolean(
    emailLead || whatsappLead || inNome || criacaoDefaults.nome ||
    campoEav.length > 0 || Object.keys(campoFisico).length > 0 || criacaoVeioDoPayload,
  );
  if (!temDadosDeContato) {
    // Nota: telefone impossível NÃO cai mais aqui (desde 2026-08-18 ele é gravado e
    // conta como dado de contato). Este descarte é só pro payload que não casou com nada.
    const motivo = "Sem dados de contato: nenhum campo do Mapeamento de Entrada nem da Criação Automática casou com o payload";
    await admin.from("crm_webhook_logs").insert({
      integration_id: integration.id, slug, payload, status: "sem_identificador",
      erro: motivo, ip_origem: ipOrigem, ...reqMeta,
    });
    return json({ error: "no_contact_data" }, 422);
  }

  // (4.6) VALIDAÇÃO DE ENTRADA (config.validacao) — opt-in. Se alguma condição não
  // for atendida, descarta a chamada (não cria lead/oportunidade). Só roda se houver
  // condições configuradas; condições baseadas no contato (tag/segmento) não bloqueiam aqui.
  // `tem_email`/`tem_whatsapp` leem o contato EFETIVO (identificador + Criação Automática).
  const validacao = Array.isArray(config?.validacao) ? config.validacao : [];
  if (validacao.length > 0) {
    const reprovou = validacao.find((c: any) => !condicaoPassa(c, dados, emailLead, whatsappLead));
    if (reprovou) {
      await admin.from("crm_webhook_logs").insert({
        integration_id: integration.id, slug, payload, status: "erro",
        erro: `Validação de entrada não atendida: ${reprovou?.tipo ?? "?"}`, ip_origem: ipOrigem, ...reqMeta,
      });
      return json({ ok: false, discarded: true, reason: "validacao", condicao: reprovou?.tipo ?? null }, 200);
    }
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
        .select("id, nome, email, whatsapp, curso_interesse, profissao, area_interesse, tempo_formacao, regiao, pagina_nome, fonte, meta_campaign_id, meta_campaign_name, meta_adset_id, meta_adset_name, meta_ad_id, meta_ad_name, meta_form_id, meta_form_name, meta_platform, utm_source, utm_medium, utm_campaign, utm_content, utm_term, gclid, fbclid, arquivado, arquivado_em")
        .eq("email", email)
        .limit(1);
      existing = data?.[0] ?? null;
    }
    if (!existing && whatsapp) {
      // Dedup por PESSOA via canon (DDD + 8 últimos dígitos): tolera 9º dígito / DDI /
      // formatação. Antes casava só por variante ±55 → criava lead duplicado quando o
      // 9º dígito diferia (raiz da "caralhada de contato"). Defensivo: se o RPC falhar,
      // `existing` fica null e o fluxo cai no insert normal (não quebra a captação).
      const { data: canonId } = await admin.rpc("crm_lead_find_by_canon", { p_telefone: whatsapp });
      if (canonId) {
        const { data } = await admin
          .from("leads")
          .select("id, nome, email, whatsapp, curso_interesse, profissao, area_interesse, tempo_formacao, regiao, pagina_nome, fonte, meta_campaign_id, meta_campaign_name, meta_adset_id, meta_adset_name, meta_ad_id, meta_ad_name, meta_form_id, meta_form_name, meta_platform, utm_source, utm_medium, utm_campaign, utm_content, utm_term, gclid, fbclid, arquivado, arquivado_em")
          .eq("id", canonId as string)
          .maybeSingle();
        existing = data ?? null;
      }
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
      if (!existing.email && emailLead)                                           patch.email = emailLead;
      if (!existing.whatsapp && whatsappLead)                                     patch.whatsapp = whatsappLead;
      if (!existing.curso_interesse && (inCurso ?? criacaoDefaults.curso_interesse))   patch.curso_interesse = (inCurso ?? criacaoDefaults.curso_interesse)!;
      if (!existing.profissao && (inProf ?? criacaoDefaults.profissao))          patch.profissao = (inProf ?? criacaoDefaults.profissao)!;
      if (!existing.area_interesse && (inArea ?? criacaoDefaults.area_interesse))     patch.area_interesse = (inArea ?? criacaoDefaults.area_interesse)!;
      if (!existing.tempo_formacao && (inTempo ?? criacaoDefaults.tempo_formacao))    patch.tempo_formacao = (inTempo ?? criacaoDefaults.tempo_formacao)!;
      if (!existing.regiao && (inRegiao ?? criacaoDefaults.regiao))               patch.regiao = (inRegiao ?? criacaoDefaults.regiao)!;
      if (!existing.pagina_nome && (inPagina ?? criacaoDefaults.pagina_nome))     patch.pagina_nome = (inPagina ?? criacaoDefaults.pagina_nome)!;
      if (!existing.fonte && (inFonte ?? criacaoDefaults.fonte))                  patch.fonte = (inFonte ?? criacaoDefaults.fonte)!;
      for (const [c, v] of Object.entries(inMeta)) if (!existing[c])              patch[c] = v;
      for (const [c, v] of Object.entries(inUtm))  if (!existing[c])              patch[c] = v;
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
          email: emailLead,
          whatsapp: whatsappLead,
          curso_interesse: inCurso ?? criacaoDefaults.curso_interesse ?? null,
          profissao: inProf ?? criacaoDefaults.profissao ?? null,
          area_interesse: inArea ?? criacaoDefaults.area_interesse ?? null,
          tempo_formacao: inTempo ?? criacaoDefaults.tempo_formacao ?? null,
          regiao: inRegiao ?? criacaoDefaults.regiao ?? null,
          // Página = URL da LP (auto). Fonte/fonte_referencia ficam VAZIAS de propósito
          // (default 'GreatPages' removido + trigger não força 'Orgânico' sem sinal).
          pagina_nome: inPagina ?? criacaoDefaults.pagina_nome ?? null,
          // Fonte só quando mapeada explicitamente (Mapeamento `lead.fonte` OU valor de
          // criação); senão NULL, como antes — o trigger compute_lead_fonte decide.
          ...(inFonte ?? criacaoDefaults.fonte ? { fonte: (inFonte ?? criacaoDefaults.fonte) } : {}),
          ...inMeta,
          ...inUtm,
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
    // ⚠️ A resposta HONRA o config.retorno mesmo neste descarte: manter arquivado é um
    // desfecho DELIBERADO da integração, não um erro. O shape antigo ({ok, discarded})
    // não trazia o {"sucesso":"true"} que o IF do n8n valida antes de marcar a linha da
    // planilha como enviada → a MESMA linha re-entrava a cada 5 min por até 14 dias
    // (loop medido em 2026-08-11: ~100 logs/dia por lead arquivado, inflando o
    // "Por chegada" da Gestão de Leads).
    const retornoArq = Array.isArray(config?.retorno) ? config.retorno : [];
    if (retornoArq.length > 0) {
      const ctxArq: Record<string, unknown> = {
        "lead.id": leadId, "oportunidade.id": null, "lead_oportunidade.id": null,
        "segmento": null, "duplicado": true, "duplicado_lote": false,
      };
      const outArq: Record<string, string> = {};
      for (const r of retornoArq) {
        if (r?.chave) outArq[String(r.chave)] = resolveRetornoVal(r?.valor, ctxArq);
      }
      return json(outArq, Number(integration.codigo_status) || 200);
    }
    return json({ ok: true, discarded: true, reason: "lead_arquivado_recente", lead_id: leadId }, 200);
  }

  // (6) extras p/ lead_oportunidades
  const utm_source   = asString(pickByMapping(dados, mapping, "lead_op.utm_source"), 200);
  const utm_medium   = asString(pickByMapping(dados, mapping, "lead_op.utm_medium"), 200);
  const utm_campaign = asString(pickByMapping(dados, mapping, "lead_op.utm_campaign"), 200);
  const fonte        = asString(pickByMapping(dados, mapping, "lead_op.fonte"), 200);
  const profissao    = asString(pickByMapping(dados, mapping, "lead_op.profissao"), 200);

  // (7) ANTI-RAJADA da saudacao por (telefone, curso, lote, INTEGRACAO) — guard ANTES
  // de criar a oportunidade. A saudacao e enviada pela ENGINE DE AUTOMACAO quando o
  // card entra na etapa de entrada (NAO por este webhook). Entao o guard gateia a
  // CRIACAO da oportunidade: submissao repetida na MESMA LP dentro da janela -> nao
  // cria 2o card -> a engine nao re-dispara o template. Lead sem whatsapp cria normal
  // (nao ha WhatsApp pra saudar, nao da pra deduplicar por telefone).
  //
  // ⚠️ A INTEGRACAO faz parte da chave (2026-08-05). Sem ela a chave COLAPSAVA em so
  // telefone quando o curso vem vazio (as LPs do GreatPages nao mandam curso), e quem
  // preenchia duas LPs seguidas so ganhava o card da primeira. Quem decide "cria outro
  // card ou nao" e o naoCriarRepetidas/origem_acao_id da acao (passo 9b), nao este guard.
  //
  // ⚠️ O TTL vive AQUI, na leitura, nao na chave: linha fora da janela e RENOVADA por um
  // UPDATE CONDICIONAL (compare-and-swap em enviada_em). Isso preserva a atomicidade que
  // o ON CONFLICT dava — dois POSTs simultaneos disputam o mesmo UPDATE e so um afeta a
  // linha, entao nao ha janela de corrida em que os dois criem card.
  let duplicadoLote = false;
  let criarOportunidade = true;
  let telCanon: string | null = null;
  if (whatsappLead) {
    telCanon = canonicalBrPhone(whatsappLead);
    const guardKey = {
      telefone: telCanon,
      curso_interesse: cursoInteresse ?? "",
      lote: lote ?? "",
      integration_id: integration.id,
    };
    const { data: guardRows, error: guardErr } = await admin
      .from("crm_saudacao_guard")
      .upsert(
        { ...guardKey, lead_id: leadId },
        { onConflict: "telefone,curso_interesse,lote,integration_id", ignoreDuplicates: true },
      )
      .select("id");
    if (guardErr) console.error("[crm-lead-webhook] guard erro:", guardErr.message);

    const inseriu = !guardErr && Array.isArray(guardRows) && guardRows.length > 0;
    let renovou = false;

    // ja existia: so bloqueia se a chave e RECENTE. Fora da janela, renova (CAS) e libera.
    if (!guardErr && !inseriu) {
      const ttlMin = Number(Deno.env.get("CRM_SAUDACAO_GUARD_TTL_MIN") ?? "60");
      const limite = new Date(
        Date.now() - Math.max(1, Number.isFinite(ttlMin) ? ttlMin : 60) * 60_000,
      ).toISOString();
      const { data: renovadas, error: renovaErr } = await admin
        .from("crm_saudacao_guard")
        .update({ enviada_em: new Date().toISOString(), lead_id: leadId })
        .match(guardKey)
        .lt("enviada_em", limite)
        .select("id");
      if (renovaErr) console.error("[crm-lead-webhook] guard renovacao erro:", renovaErr.message);
      renovou = !renovaErr && Array.isArray(renovadas) && renovadas.length > 0;
    }

    criarOportunidade = !guardErr && (inseriu || renovou);
    duplicadoLote = !guardErr && !inseriu && !renovou;
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

        const tituloResolved =
          resolveWebhookVar(p.titulo, dados).trim() || cursoInteresse || integration.nome || "Oportunidade";
        const nowIso = new Date().toISOString();
        const acaoId = typeof a.id === "string" && a.id ? a.id : null;

        // "Nao criar repetidas" = por WEBHOOK, NAO por funil. Toda webhook de pos aponta pro
        // MESMO funil (1.0 SDR), entao o dedup por funil fazia um card de Producao de Suinos
        // BLOQUEAR o card de Sanidade Avicola: o 2o interesse sumia sem deixar rastro. Agora
        // casa a ACAO que criou o card (fallback: a integracao, p/ cards backfillados sem
        // acao). Regras: card ABERTO desta webhook -> nao cria outro, marca RECADASTRO
        // (moldura dourada no kanban + o novo interesse no tooltip) e sobe a atividade;
        // card desta webhook ja FECHADO (ganha/perdida) -> cria de novo; cadastro em OUTRA
        // webhook -> card novo, mesmo no mesmo funil.
        if (p.naoCriarRepetidas === true) {
          const orFilter = acaoId
            ? `origem_acao_id.eq.${acaoId},and(origem_acao_id.is.null,origem_integracao_id.eq.${integration.id})`
            : `origem_integracao_id.eq.${integration.id}`;
          const { data: existe } = await admin
            .from("crm_oportunidades")
            .select("id, recadastros")
            .eq("lead_id", leadId)
            .eq("status", "aberta")
            .or(orFilter)
            .order("criada_em", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (existe?.id) {
            await admin
              .from("crm_oportunidades")
              .update({
                recadastro_em: nowIso,
                recadastro_titulo: tituloResolved,
                recadastros: (existe.recadastros ?? 0) + 1,
                ultima_atividade_em: nowIso,
              })
              .eq("id", existe.id);
            if (!oportunidadeId) oportunidadeId = existe.id;
            continue;
          }
        }

        const rawValor = resolveWebhookVar(p.valor, dados).replace(",", ".").replace(/[^0-9.\-]/g, "").trim();
        const valorNum = rawValor !== "" && Number.isFinite(Number(rawValor)) ? Number(rawValor) : null;
        const statusOp = (p.status === "ganha" || p.status === "perdida") ? p.status : "aberta";
        const { id: responsavelId, logId } = await resolverResponsavel(a.id, p.responsavel);

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
            // De qual webhook/acao o card nasceu — e o escopo do "nao criar repetidas".
            origem_integracao_id: integration.id,
            origem_acao_id: acaoId,
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
    if (whatsappLead && telCanon && oportunidadeId) {
      await admin.from("crm_saudacao_guard")
        .update({ oportunidade_id: oportunidadeId })
        .eq("telefone", telCanon).eq("curso_interesse", cursoInteresse ?? "").eq("lote", lote ?? "")
        // ⚠️ escopo da integracao: sem isso o carimbo cai na linha de OUTRA LP do mesmo telefone
        .eq("integration_id", integration.id);
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
  // Insere os segmentos (upsert idempotente). O evento "Adicionado ao segmento <nome>"
  // na timeline NÃO é mais logado aqui: quem loga é o gatilho de banco
  // trg_crm_lead_segmento_atividade (AFTER INSERT em crm_lead_segmentos), que grava o
  // SELO DE ORIGEM (Integração/Automático/Manual/Importação) para TODO caminho de
  // atribuição — logar aqui também duplicaria a linha.
  async function logSegmentosAdicionados(ids: string[]) {
    if (!ids.length || !leadId) return;
    await admin.from("crm_lead_segmentos").upsert(
      ids.map((segmento_id) => ({ lead_id: leadId, segmento_id, origem: "auto" })),
      { onConflict: "lead_id,segmento_id", ignoreDuplicates: true },
    );
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
      } else if (a?.tipo === "definir_responsavel_contato" && leadId) {
        // "Definir responsável do contato" → grava `leads.vendedor_atribuido`.
        // ⚠️ TODA a régua (identificar a pós → escolher o vendedor → equalizar a semana
        // comercial com o piso de qualificados) vive na RPC, NUNCA aqui: ela é a FONTE
        // ÚNICA e precisa dar o mesmo resultado se for chamada por outro caminho.
        // ⚠️ Roda DEPOIS de criar_oportunidade (9b) de propósito: o título do card já
        // existe e é o 3º sinal de identificação da pós.
        const { data: respOut, error: respErr } = await admin.rpc(
          "crm_webhook_definir_responsavel_contato",
          { p_lead_id: leadId, p_params: a?.params ?? {}, p_integration_id: integration.id },
        );
        if (respErr) throw respErr;
        if ((respOut as any)?.ok) {
          acoesAplicadas.push("definir_responsavel_contato");
          await logAtividade(leadId, "acao_webhook", "Ação de Webhook Integrado executada", acaoChip("definir_responsavel_contato"));
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
      } else if (a?.tipo === "salvar_utm" && leadId) {
        // "Salvar tags UTM" — ESTE é o lugar das UTMs no modelo do builder (espelha o
        // SprintHub: campos do contato na Criação Automática, UTM nas Ações Extras, e o
        // Mapeamento de Entrada só lê o payload + marca o Identificador). Cada um dos 5
        // campos aceita `{webhook=Campo}` ou um valor FIXO (ex.: utm_medium = "form").
        // Token inexistente resolve para "" (resolveWebhookVar) ⇒ typo no config não grava
        // lixo, só não preenche.
        //
        // ⚠️ FILL-IF-EMPTY, sempre: só escreve em coluna VAZIA. A primeira atribuição do
        // lead é a que vale — recadastro por outra campanha NÃO reescreve a origem já
        // registrada (mesma régua do `inUtm` no find-or-create). Nenhum lead existente com
        // UTM é tocado, e não há backfill: vale só para quem chegar daqui pra frente.
        //
        // A ação existia na UI (AcaoUtmModal) e no rótulo desde o builder, mas nunca foi
        // executada aqui — 106 integrações ativas a tinham configurada sem efeito.
        // gclid/fbclid entram aqui (mesma natureza: rastreio de campanha) — é o que
        // permite o Mapeamento de Entrada ficar só com o Identificador.
        const UTM_ACAO_COLS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "gclid", "fbclid"] as const;
        const desejado: Record<string, string> = {};
        for (const c of UTM_ACAO_COLS) {
          const v = asString(resolveWebhookVar((a?.params as any)?.[c], dados), 255);
          if (v) desejado[c] = v;
        }
        if (Object.keys(desejado).length) {
          const { data: atual } = await admin
            .from("leads")
            .select("utm_source, utm_medium, utm_campaign, utm_content, utm_term, gclid, fbclid")
            .eq("id", leadId)
            .maybeSingle();
          const patch: Record<string, string> = {};
          for (const [c, v] of Object.entries(desejado)) {
            if (!(atual as any)?.[c]) patch[c] = v; // não sobrescreve o que já existe
          }
          if (Object.keys(patch).length) {
            await admin.from("leads").update(patch).eq("id", leadId);
            acoesAplicadas.push("salvar_utm");
            await logAtividade(leadId, "acao_webhook", "Ação de Webhook Integrado executada", acaoChip("salvar_utm"));
          }
        }
      } else if (a?.tipo === "enviar_mensagem_whatsapp") {
        // "Enviar template WhatsApp": dispara um template aprovado já com as variáveis
        // mapeadas dos campos do webhook ({webhook=Campo}, na ordem {{1}},{{2}}…). Encurta o
        // fluxo (webhook recebe → manda o template) sem depender de automação separada.
        // params (builder) OU config (legado SQL). ativar_ia liga o agente João p/ o lead.
        const pc: any = a?.params ?? (a as any)?.config ?? {};
        const templateName = String(pc.template_id ?? pc.template_name ?? "").trim();
        if (templateName && telCanon && whatsappLead) {
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
                telefone: whatsappLead,
                tipo: "template",
                template_name: templateName,
                template_lang: pc.template_lang || "pt_BR",
                template_components: components,
                // Imagem/mídia do CABEÇALHO escolhida nesta ação (opcional). Vazio = a
                // mídia FIXA do template (crm_whatsapp_template_media). É PARÂMETRO do
                // envio — não altera o template na Meta (sem re-aprovação).
                ...(typeof pc.header_media_url === "string" && pc.header_media_url.trim()
                  ? {
                      header_media_url: pc.header_media_url.trim(),
                      header_media_format: String(pc.header_media_format ?? "").trim() || undefined,
                    }
                  : {}),
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
  // `!whatsappImpossivel`: número que não pode existir não semeia o agente nem fura o
  // n8n — o JID seria de um telefone inexistente e o follow-up nasceria condenado.
  // A guarda de `crm-whatsapp-send` já barraria o envio; aqui evita-se o lixo antes.
  if (abrirCards && whatsappLead && telCanon && !whatsappImpossivel) {
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
          nome: inNome ?? criacaoDefaults.nome ?? null,
          numero_formatado: whatsappLead,
          email: emailLead,
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

      // Âncora da esteira de template p/ lead que NUNCA responder (migration
      // 20260704120000): AQUI o 1º template (ação 'enviar_mensagem_whatsapp') sai ANTES
      // deste seed existir, então o trigger de carimbo em crm_whatsapp_messages não acha
      // a linha — carimba em update SEPARADO, only-if-null, best-effort (se a migration
      // ainda não foi aplicada, só loga e o seed segue intacto).
      if (acoesAplicadas.includes("enviar_mensagem_whatsapp")) {
        const { error: tplErr } = await admin
          .from("cliente_ppg_leads_sdr")
          .update({ template_inicial_em: new Date().toISOString() })
          .eq("remotejid", remoteJid)
          .is("template_inicial_em", null);
        if (tplErr) console.error("[crm-lead-webhook] carimbo template_inicial_em:", tplErr.message);
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
            nome: inNome ?? criacaoDefaults.nome ?? null,
            telefone: whatsappLead,
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

  // (10.9) TELEFONE IMPOSSÍVEL — grava, mas acende o alarme ────────────────────
  //
  // O número fica em `leads.whatsapp` como chegou (o SDR precisa ver o que a pessoa
  // digitou para decidir se dá para adivinhar ou se pede por e-mail). O que impede o
  // estrago é a guarda de ENVIO em `crm-whatsapp-send` — nada sai daqui para a Meta.
  //
  // Medido em 2026-08-17 (14 dias): 171 casos, 153 no MESMO padrão `5555` + DDD + 7
  // dígitos — a pessoa digita o "55" no campo que já tem +55 selecionado e a máscara
  // de 11 dígitos da LP come os dois últimos dígitos do celular. Os dígitos perdidos
  // nunca saíram do navegador: é irrecuperável no servidor, a correção de raiz é na
  // landing page (projeto externo).
  //
  // Relê `leads.whatsapp` em vez de confiar em `whatsappImpossivel`: contato
  // duplicado que já tinha número BOM não pode virar alarme só porque a submissão
  // nova veio torta (o patch de duplicado não sobrescreve número existente).
  // Best-effort — nunca derruba o intake.
  if (whatsappImpossivel && leadId) {
    try {
      const { data: leadAtual } = await admin
        .from("leads").select("whatsapp").eq("id", leadId).maybeSingle();
      if (!telefoneEnviavel(leadAtual?.whatsapp)) {
        await admin.from("crm_lead_tags").upsert(
          [{ lead_id: leadId, tag_id: TAG_TELEFONE_INVALIDO, origem: "auto" }],
          { onConflict: "lead_id,tag_id", ignoreDuplicates: true },
        );
        // ⚠️ `detalhe` vira o `subtitulo` da timeline, que é renderizado com
        // `truncate` (uma linha só, em `ContatoVisaoGeral.tsx`). Texto longo some
        // no "…" — por isso o número cru vem PRIMEIRO, que é o que o SDR precisa
        // ler para decidir se pede o contato de novo.
        await logAtividade(
          leadId, "acao_webhook",
          "Telefone não pode existir: nenhum disparo vai sair",
          "Telefone inválido",
          `Chegou "${whatsappImpossivel}" (${slug}) — gravado como veio; peça o número por e-mail.`,
        );
      }
    } catch (e: any) {
      console.error("[crm-lead-webhook] marcar telefone inválido erro:", e?.message);
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
      // Telefone estruturalmente impossível (régua em `_shared/telefone.ts`). Desde
      // 2026-08-18 ele É gravado em leads.whatsapp — esta chave virou observabilidade
      // (quantos chegam, de qual LP) e o marcador que a tag/timeline usam.
      telefone_invalido: whatsappImpossivel ?? undefined,
      // Nenhum identificador resolvido: o contato foi criado SEM passar por dedup (ou a
      // integração não define identificador, ou o valor dele não veio/veio inválido).
      sem_dedup: (!email && !whatsapp) || undefined,
    },
    status: duplicado ? "duplicado" : "ok",
    ip_origem: ipOrigem,
  });

  // (11.9) HISTÓRICO DO ENVIO CRU (lead_entries) — opt-in via config.registrarEntrada.
  // Alimenta o Histórico do Contato 360 (get_contato_timeline) e a busca de histórico da
  // Gestão de Leads (search_lead_entries) — é o que o webhook-leads registrava para o
  // formulário instantâneo do Meta. Best-effort: nunca derruba o intake.
  if (config?.registrarEntrada === true && leadId) {
    try {
      await admin.from("lead_entries").insert({
        lead_id: leadId,
        raw_payload: payload as any,
        // Mesmo fallback do lead: página/fonte podem vir do Mapeamento OU da Criação
        // Automática — senão o Histórico do Contato 360 perderia a origem do envio.
        pagina_nome: inPagina ?? criacaoDefaults.pagina_nome ?? integration.pagina_nome ?? null,
        fonte: inFonte ?? criacaoDefaults.fonte ?? null,
        criou_oportunidade: !!oportunidadeId,
        motivo: oportunidadeId ? "nova_oportunidade" : (duplicado ? "duplicado" : "sem_oportunidade"),
        criado_por: integration.nome ?? `Webhook ${slug}`,
      });
    } catch (e: any) {
      console.error("[crm-lead-webhook] lead_entries falhou:", e?.message);
    }
  }

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
