// facebook-leads-webhook — Formulário instantâneo do Meta → CRM, direto (sem planilha, sem n8n).
//
// Desde 2026-10-14 (a VPS do n8n foi excluída). Antes: Meta → Google Sheets → n8n → crm-lead-webhook.
// Agora esta edge busca o lead na Graph API e posta no MESMO `crm-lead-webhook?int=form-meta-*`,
// no MESMO formato que o n8n mandava (a linha da planilha em `dados_completos`, com os ids
// prefixados l:/ag:/as:/c:/f:). Nada muda do lado do CRM: mapeamento de entrada, rodízio,
// segmento, card, trava de reenvio (passo 3.6, por `dados_completos.id`) e métrica por página.
//
// Três portas:
//   GET  ?hub.mode=subscribe…      verificação do webhook da Meta (verify_token do banco ou env)
//   POST (assinado pela Meta)      evento `leadgen` em tempo real → entrega o lead na hora
//   POST ?acao=varrer              pg_cron de 1 min (header x-meta-leads-cron) → varre cada
//                                  formulário desde o cursor; cobre webhook perdido e o buraco
//                                  de quando o sistema estava fora. Também descobre formulário
//                                  novo da página (a cada 15 min) e o registra SEM rota.
//   POST ?acao=diagnostico         mesmo header; testa o token e lista os formulários da página.
//
// Tabelas (RLS sem policy, só service_role): meta_leadgen_config, meta_leadgen_paginas,
// meta_leadgen_formularios (form → integração), meta_leadgen_entregas (idempotência/auditoria).
// Mapa: docs/CRM — Webhooks.md, seção "Formulário do Meta direto na Graph API".

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.50.3";

const GRAPH = "https://graph.facebook.com/v21.0";
const CAMPOS_LEAD =
  "id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,is_organic,platform,field_data";
const CAMPOS_LEAD_MINIMO = "id,created_time,ad_id,form_id,is_organic,platform,field_data";
// Janela de sobreposição da varredura: relê este tanto antes do cursor (lead que a Meta
// publica com atraso). Quem já foi entregue é pulado pela meta_leadgen_entregas.
const SOBREPOSICAO_MS = 2 * 60 * 60 * 1000;
const MAX_TENTATIVAS = 5;
const PROCESSANDO_EXPIRA_MS = 3 * 60 * 1000;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type Json = Record<string, unknown>;

interface Pagina {
  page_id: string;
  nome: string | null;
  access_token: string | null;
  formularios_descobertos_em: string | null;
}

interface Formulario {
  form_id: string;
  page_id: string;
  form_name: string | null;
  integracao_slug: string | null;
  curso_interesse: string | null;
  cursor_created_time: string | null;
}

interface LeadMeta {
  id: string;
  created_time?: string;
  ad_id?: string;
  ad_name?: string;
  adset_id?: string;
  adset_name?: string;
  campaign_id?: string;
  campaign_name?: string;
  form_id?: string;
  is_organic?: boolean;
  platform?: string;
  field_data?: Array<{ name: string; values?: string[] }>;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function semPrefixo(id: string | null | undefined): string {
  return String(id ?? "").replace(/^[a-z]+:/i, "");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function assinaturaValida(body: string, header: string, appSecret: string): Promise<boolean> {
  const [alg, hash] = header.split("=");
  if (alg !== "sha256" || !hash) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return constantTimeEqual(hex, hash);
}

async function graph(path: string, token: string): Promise<{ ok: boolean; data: any }> {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`${GRAPH}/${path}${sep}access_token=${encodeURIComponent(token)}`, {
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok && !data?.error, data };
}

// Token salvo pode ser do usuário do sistema; a leitura de lead pede o da página quando dá.
const cacheTokenPagina = new Map<string, string>();
async function tokenDaPagina(p: Pagina): Promise<string | null> {
  if (!p.access_token) return null;
  const emCache = cacheTokenPagina.get(p.page_id);
  if (emCache) return emCache;
  const r = await graph(`${p.page_id}?fields=access_token`, p.access_token);
  const tk = r.ok && typeof r.data?.access_token === "string" ? r.data.access_token : p.access_token;
  cacheTokenPagina.set(p.page_id, tk);
  return tk;
}

async function registrarErroPagina(admin: SupabaseClient, pageId: string, erro: string) {
  await admin.from("meta_leadgen_paginas")
    .update({ ultimo_erro: erro.slice(0, 1000), ultimo_erro_em: new Date().toISOString() })
    .eq("page_id", pageId);
}

// A linha que a planilha da Meta gerava — chaves e prefixos idênticos (ver docstring).
export function montarDadosCompletos(lead: LeadMeta, form: Formulario): Json {
  const pref = (p: string, v?: string) => (v ? `${p}:${v}` : "");
  const d: Json = {
    id: `l:${lead.id}`,
    created_time: lead.created_time ?? "",
    ad_id: pref("ag", lead.ad_id),
    ad_name: lead.ad_name ?? "",
    adset_id: pref("as", lead.adset_id),
    adset_name: lead.adset_name ?? "",
    campaign_id: pref("c", lead.campaign_id),
    campaign_name: lead.campaign_name ?? "",
    form_id: `f:${form.form_id}`,
    form_name: form.form_name ?? "",
    is_organic: String(lead.is_organic ?? false),
    platform: lead.platform ?? "",
    lead_status: "CREATED",
  };
  for (const f of lead.field_data ?? []) {
    if (f?.name) d[f.name] = (f.values ?? []).join(", ");
  }
  // O mapeamento das form-meta-* identifica pelo whatsapp_number; formulário com a pergunta
  // padrão de telefone manda phone_number.
  if (!d.whatsapp_number && d.phone_number) d.whatsapp_number = d.phone_number;
  return d;
}

// Reserva o lead (idempotência entre webhook e varredura concorrentes). true = pode processar.
async function reservar(
  admin: SupabaseClient, leadgenId: string, form: Formulario | null, pageId: string | null,
  createdTime: string | null, origem: string,
): Promise<boolean> {
  const { data: novo } = await admin.from("meta_leadgen_entregas").upsert({
    leadgen_id: leadgenId, form_id: form?.form_id ?? null, page_id: pageId,
    integracao_slug: form?.integracao_slug ?? null, created_time: createdTime,
    origem, status: "processando",
  }, { onConflict: "leadgen_id", ignoreDuplicates: true }).select("leadgen_id");
  if (novo && novo.length > 0) return true;

  const { data: atual } = await admin.from("meta_leadgen_entregas")
    .select("status, tentativas, atualizado_em").eq("leadgen_id", leadgenId).maybeSingle();
  if (!atual) return false;
  if (atual.status === "ok") return false;
  if (atual.status === "sem_rota" && !form?.integracao_slug) return false;
  if (atual.status === "erro" && atual.tentativas >= MAX_TENTATIVAS) return false;
  if (atual.status === "processando" &&
      Date.now() - new Date(atual.atualizado_em).getTime() < PROCESSANDO_EXPIRA_MS) return false;

  const { data: pego } = await admin.from("meta_leadgen_entregas")
    .update({
      status: "processando", tentativas: (atual.tentativas ?? 0) + 1, origem,
      integracao_slug: form?.integracao_slug ?? null, atualizado_em: new Date().toISOString(),
    })
    .eq("leadgen_id", leadgenId).eq("atualizado_em", atual.atualizado_em).select("leadgen_id");
  return !!pego && pego.length > 0;
}

async function concluir(admin: SupabaseClient, leadgenId: string, patch: Json) {
  await admin.from("meta_leadgen_entregas")
    .update({ ...patch, atualizado_em: new Date().toISOString() })
    .eq("leadgen_id", leadgenId);
}

const cacheSecret = new Map<string, string | null>();
async function secretDaIntegracao(admin: SupabaseClient, slug: string): Promise<string | null> {
  if (cacheSecret.has(slug)) return cacheSecret.get(slug)!;
  const { data } = await admin.from("crm_webhook_integrations").select("secret").eq("slug", slug).maybeSingle();
  const s = (data?.secret as string | undefined) ?? null;
  cacheSecret.set(slug, s);
  return s;
}

// Entrega UM lead já lido da Graph API. Devolve o status final.
async function entregar(
  admin: SupabaseClient, lead: LeadMeta, form: Formulario | null, pageId: string | null, origem: string,
): Promise<string> {
  const leadgenId = String(lead.id);
  if (!(await reservar(admin, leadgenId, form, pageId, lead.created_time ?? null, origem))) return "pulado";

  if (!form?.integracao_slug) {
    const dados = form ? montarDadosCompletos(lead, form) : { id: `l:${leadgenId}`, field_data: lead.field_data ?? [] };
    await concluir(admin, leadgenId, { status: "sem_rota", dados_completos: dados });
    console.warn(`[facebook-leads-webhook] lead ${leadgenId} do formulário ${lead.form_id ?? "?"} sem rota`);
    return "sem_rota";
  }

  const dados = montarDadosCompletos(lead, form);
  const secret = await secretDaIntegracao(admin, form.integracao_slug);
  if (!secret) {
    await concluir(admin, leadgenId, { status: "erro", dados_completos: dados, resposta: { erro: "integracao_inexistente" } });
    return "erro";
  }

  const qs = new URLSearchParams({
    int: form.integracao_slug,
    fonte: "Formulário Direto",
    pagina: form.form_name ?? "",
    utm_source: "Formulário Direto",
    utm_medium: "form",
  });
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/crm-lead-webhook?${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Webhook-Secret": secret },
      body: JSON.stringify({
        tipo_lead: "formulario_campanha_direta_meta",
        dados_completos: dados,
        curso_de_Interesse: form.curso_interesse ?? "",
      }),
      signal: AbortSignal.timeout(30000),
    });
    const resposta = await r.json().catch(() => ({}));
    const status = r.ok ? "ok" : "erro";
    await concluir(admin, leadgenId, { status, http_status: r.status, resposta, dados_completos: dados });
    if (!r.ok) console.error(`[facebook-leads-webhook] ${form.integracao_slug} HTTP ${r.status}: ${JSON.stringify(resposta).slice(0, 300)}`);
    return status;
  } catch (e) {
    await concluir(admin, leadgenId, {
      status: "erro", dados_completos: dados, resposta: { erro: (e as Error).message },
    });
    return "erro";
  }
}

async function lerLead(leadgenId: string, token: string): Promise<{ lead: LeadMeta | null; erro?: string }> {
  let r = await graph(`${leadgenId}?fields=${CAMPOS_LEAD}`, token);
  if (!r.ok) r = await graph(`${leadgenId}?fields=${CAMPOS_LEAD_MINIMO}`, token);
  if (!r.ok) return { lead: null, erro: JSON.stringify(r.data?.error ?? r.data).slice(0, 500) };
  return { lead: r.data as LeadMeta };
}

// ── Varredura ────────────────────────────────────────────────────────────────

async function descobrirFormularios(admin: SupabaseClient, p: Pagina, token: string) {
  const ultima = p.formularios_descobertos_em ? new Date(p.formularios_descobertos_em).getTime() : 0;
  if (Date.now() - ultima < 15 * 60 * 1000) return;
  const r = await graph(`${p.page_id}/leadgen_forms?fields=id,name,status&limit=200`, token);
  if (!r.ok) {
    await registrarErroPagina(admin, p.page_id, `leadgen_forms: ${JSON.stringify(r.data?.error ?? r.data)}`);
    return;
  }
  const ativos = (r.data?.data ?? []).filter((f: any) => f?.status === "ACTIVE");
  if (ativos.length > 0) {
    // Formulário novo entra SEM rota e com cursor = agora: nada de histórico antigo,
    // e o lead dele fica em meta_leadgen_entregas 'sem_rota' até alguém ligar a integração.
    await admin.from("meta_leadgen_formularios").upsert(
      ativos.map((f: any) => ({
        form_id: String(f.id), page_id: p.page_id, form_name: f.name ?? null,
        cursor_created_time: new Date().toISOString(),
      })),
      { onConflict: "form_id", ignoreDuplicates: true },
    );
  }
  await admin.from("meta_leadgen_paginas")
    .update({ formularios_descobertos_em: new Date().toISOString() }).eq("page_id", p.page_id);
}

async function varrerFormulario(admin: SupabaseClient, form: Formulario, token: string) {
  const cursorMs = form.cursor_created_time ? new Date(form.cursor_created_time).getTime() : Date.now() - 86400000;
  const desde = Math.floor((cursorMs - SOBREPOSICAO_MS) / 1000);
  const filtro = encodeURIComponent(JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: desde }]));
  let caminho: string | null = `${form.form_id}/leads?fields=${CAMPOS_LEAD}&filtering=${filtro}&limit=100`;
  const cont: Record<string, number> = {};
  let maiorOk = cursorMs;
  let erro: string | null = null;

  for (let pagina = 0; caminho && pagina < 10; pagina++) {
    const r = await graph(caminho, token);
    if (!r.ok) { erro = JSON.stringify(r.data?.error ?? r.data).slice(0, 500); break; }
    const leads: LeadMeta[] = r.data?.data ?? [];
    // Mais antigo primeiro: o card nasce na ordem de chegada.
    leads.sort((a, b) => String(a.created_time).localeCompare(String(b.created_time)));
    for (const lead of leads) {
      const st = await entregar(admin, lead, form, form.page_id, "varredura");
      cont[st] = (cont[st] ?? 0) + 1;
      const t = lead.created_time ? new Date(lead.created_time).getTime() : 0;
      if ((st === "ok" || st === "pulado" || st === "sem_rota") && t > maiorOk) maiorOk = t;
    }
    const next: string | undefined = r.data?.paging?.next;
    caminho = next ? next.replace(`${GRAPH}/`, "").replace(/([?&])access_token=[^&]*&?/, "$1") : null;
  }

  await admin.from("meta_leadgen_formularios").update({
    ultima_varredura_em: new Date().toISOString(),
    cursor_created_time: new Date(maiorOk).toISOString(),
  }).eq("form_id", form.form_id);
  return { form_id: form.form_id, slug: form.integracao_slug, ...cont, ...(erro ? { erro } : {}) };
}

async function varrer(admin: SupabaseClient) {
  const { data: paginas } = await admin.from("meta_leadgen_paginas")
    .select("page_id, nome, access_token, formularios_descobertos_em")
    .eq("ativo", true).not("access_token", "is", null);
  if (!paginas || paginas.length === 0) return { ok: true, aviso: "nenhuma página com token" };

  const resultado: Json[] = [];
  for (const p of paginas as Pagina[]) {
    const token = await tokenDaPagina(p);
    if (!token) continue;
    await descobrirFormularios(admin, p, token);
    const { data: forms } = await admin.from("meta_leadgen_formularios")
      .select("form_id, page_id, form_name, integracao_slug, curso_interesse, cursor_created_time")
      .eq("page_id", p.page_id).eq("ativo", true);
    let algumErro: string | null = null;
    for (const f of (forms ?? []) as Formulario[]) {
      const r = await varrerFormulario(admin, f, token);
      if ((r as Json).erro) algumErro = String((r as Json).erro);
      resultado.push(r);
    }
    if (algumErro) await registrarErroPagina(admin, p.page_id, algumErro);
    else await admin.from("meta_leadgen_paginas").update({ ultimo_ok_em: new Date().toISOString() }).eq("page_id", p.page_id);
  }
  return { ok: true, formularios: resultado };
}

async function diagnostico(admin: SupabaseClient) {
  const { data: paginas } = await admin.from("meta_leadgen_paginas").select("page_id, nome, access_token, formularios_descobertos_em");
  const out: Json[] = [];
  for (const p of (paginas ?? []) as Pagina[]) {
    if (!p.access_token) { out.push({ page_id: p.page_id, erro: "sem token" }); continue; }
    const dbg = await graph(`debug_token?input_token=${encodeURIComponent(p.access_token)}`, p.access_token);
    const token = await tokenDaPagina(p);
    const forms = await graph(`${p.page_id}/leadgen_forms?fields=id,name,status,leads_count&limit=200`, token!);
    out.push({
      page_id: p.page_id,
      token: dbg.ok ? { app: dbg.data?.data?.application, tipo: dbg.data?.data?.type, escopos: dbg.data?.data?.scopes } : dbg.data,
      token_de_pagina: token !== p.access_token,
      formularios: forms.ok ? forms.data?.data : forms.data,
    });
  }
  return { ok: true, paginas: out };
}

// ── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: cfg } = await admin.from("meta_leadgen_config")
    .select("cron_secret, verify_token, app_secret").eq("id", 1).maybeSingle();

  try {
    // Verificação do webhook pela Meta
    if (req.method === "GET") {
      const tokens = [cfg?.verify_token, Deno.env.get("FACEBOOK_VERIFY_TOKEN")].filter(Boolean) as string[];
      const recebido = url.searchParams.get("hub.verify_token") ?? "";
      if (url.searchParams.get("hub.mode") === "subscribe" && tokens.some((t) => constantTimeEqual(t, recebido))) {
        return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200, headers: { "Content-Type": "text/plain" } });
      }
      return new Response("Forbidden", { status: 403 });
    }
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const acao = url.searchParams.get("acao");
    if (acao === "varrer" || acao === "diagnostico") {
      const h = req.headers.get("x-meta-leads-cron") ?? "";
      if (!cfg?.cron_secret || !constantTimeEqual(h, cfg.cron_secret)) return json({ error: "forbidden" }, 403);
      return json(acao === "varrer" ? await varrer(admin) : await diagnostico(admin));
    }

    // Webhook `leadgen` da Meta (assinado)
    const corpo = await req.text();
    const appSecret = cfg?.app_secret || Deno.env.get("FACEBOOK_APP_SECRET") || "";
    if (!appSecret || !(await assinaturaValida(corpo, req.headers.get("x-hub-signature-256") ?? "", appSecret))) {
      return new Response("Forbidden", { status: 403 });
    }
    const payload = JSON.parse(corpo);
    if (payload?.object !== "page") return json({ ok: true, ignorado: payload?.object ?? null });

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change?.field !== "leadgen") continue;
        const v = change.value ?? {};
        const leadgenId = String(v.leadgen_id ?? "");
        const pageId = String(v.page_id ?? entry.id ?? "");
        if (!leadgenId) continue;

        const { data: p } = await admin.from("meta_leadgen_paginas")
          .select("page_id, nome, access_token, formularios_descobertos_em").eq("page_id", pageId).maybeSingle();
        const token = p ? await tokenDaPagina(p as Pagina) : null;
        if (!token) {
          // Sem token não dá para ler o lead agora: fica registrado e a varredura não o
          // alcança (página sem token também não é varrida) — erro visível em entregas.
          await admin.from("meta_leadgen_entregas").upsert({
            leadgen_id: leadgenId, form_id: semPrefixo(v.form_id), page_id: pageId, origem: "webhook",
            status: "erro", resposta: { erro: "pagina_sem_token" },
          }, { onConflict: "leadgen_id", ignoreDuplicates: true });
          continue;
        }
        const { lead, erro } = await lerLead(leadgenId, token);
        if (!lead) {
          await registrarErroPagina(admin, pageId, `lead ${leadgenId}: ${erro}`);
          continue; // a varredura de 1 min tenta de novo pelo formulário
        }
        const formId = semPrefixo(lead.form_id ?? v.form_id);
        const { data: form } = await admin.from("meta_leadgen_formularios")
          .select("form_id, page_id, form_name, integracao_slug, curso_interesse, cursor_created_time")
          .eq("form_id", formId).maybeSingle();
        await entregar(admin, lead, (form as Formulario | null) ?? null, pageId, "webhook");
      }
    }
    return json({ ok: true });
  } catch (e) {
    console.error("[facebook-leads-webhook] erro:", (e as Error).message);
    return json({ error: "internal" }, 500);
  }
});
