// crm-lead-webhook
// Webhook multi-tenant de captacao de leads para o CRM Comercial B2C.
// URL: POST https://api.ppgeducacao.site/functions/v1/crm-lead-webhook?int=<slug>
// Auth: header X-Webhook-Secret (constant-time compare com integration.secret)
// Body: JSON arbitrario; mapeado em campos do lead via integration.field_mapping
//
// Fluxo:
//   (1) busca integracao por slug + valida ativa
//   (2) valida secret
//   (3) aplica field_mapping no payload
//   (4) find-or-create lead (dedup OR email/whatsapp)
//   (5) insere lead_oportunidades (registro de origem; bridge legado foi cortado)
//   (6) atribui segmento default da integracao (idempotente)
//   (7) cria crm_oportunidades em crm_pipeline_settings.intake_funil_id
//       (MVP — Fase 2 substitui por engine de automacao com gatilho 'ao_atribuir_segmento')
//   (8) loga em crm_webhook_logs
//
// Retorno OK 200:
//   { ok:true, lead_id, segmento_aplicado, lead_oportunidade_id, oportunidade_id }

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

// Procura no payload o primeiro valor cujo target no mapping = wantedTarget.
function pickByMapping(payload: any, mapping: Record<string, string>, wantedTarget: string): unknown {
  for (const [k, t] of Object.entries(mapping)) {
    if (t === wantedTarget && payload[k] !== undefined && payload[k] !== null && payload[k] !== "") {
      return payload[k];
    }
  }
  return undefined;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = new URL(req.url);
  const slug = url.searchParams.get("int");
  const ipOrigem = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  if (!slug) return json({ error: "missing_integration" }, 400);

  // (1) integracao
  const { data: integration } = await admin
    .from("crm_webhook_integrations")
    .select("id, slug, nome, secret, segmento_id, area_interesse, pagina_nome, field_mapping, ativa")
    .eq("slug", slug)
    .maybeSingle();

  if (!integration) return json({ error: "integration_not_found" }, 404);

  if (!integration.ativa) {
    await admin.from("crm_webhook_logs").insert({
      integration_id: integration.id, slug, status: "integracao_inativa", ip_origem: ipOrigem,
    });
    return json({ error: "integration_inactive" }, 403);
  }

  // (2) secret
  const receivedSecret = req.headers.get("x-webhook-secret") ?? "";
  if (!constantTimeEqual(receivedSecret, integration.secret)) {
    await admin.from("crm_webhook_logs").insert({
      integration_id: integration.id, slug, status: "secret_invalido", ip_origem: ipOrigem,
    });
    return json({ error: "invalid_secret" }, 401);
  }

  // (3) body
  let payload: any = null;
  try { payload = await req.json(); } catch { payload = null; }
  if (!payload || typeof payload !== "object") {
    await admin.from("crm_webhook_logs").insert({
      integration_id: integration.id, slug, status: "erro",
      erro: "payload nao eh JSON", ip_origem: ipOrigem,
    });
    return json({ error: "invalid_body" }, 400);
  }

  const mapping = (integration.field_mapping ?? {}) as Record<string, string>;

  // (4) extrai campos do lead via mapping
  const nome     = asString(pickByMapping(payload, mapping, "lead.nome"), 200);
  const email    = normalizeEmail(pickByMapping(payload, mapping, "lead.email"));
  const whatsapp = normalizeWhatsapp(pickByMapping(payload, mapping, "lead.whatsapp"));

  if (!email && !whatsapp) {
    await admin.from("crm_webhook_logs").insert({
      integration_id: integration.id, slug, payload, status: "sem_identificador",
      erro: "Nem email nem whatsapp encontrados via field_mapping", ip_origem: ipOrigem,
    });
    return json({ error: "no_identifier" }, 422);
  }

  // (5) find-or-create lead — dedup OR email/whatsapp (com variantes de prefixo 55)
  let leadId: string | null = null;
  let duplicado = false;
  try {
    let existing: any = null;

    if (email) {
      const { data } = await admin
        .from("leads")
        .select("id, nome, email, whatsapp")
        .eq("email", email)
        .limit(1);
      existing = data?.[0] ?? null;
    }
    if (!existing && whatsapp) {
      const variants = [whatsapp, whatsapp.startsWith("55") ? whatsapp.slice(2) : `55${whatsapp}`];
      const { data } = await admin
        .from("leads")
        .select("id, nome, email, whatsapp")
        .in("whatsapp", variants)
        .limit(1);
      existing = data?.[0] ?? null;
    }

    if (existing) {
      duplicado = true;
      leadId = existing.id;
      // Preenche campos vazios sem sobrescrever os existentes
      const patch: Record<string, string> = {};
      if (!existing.nome && nome)         patch.nome = nome;
      if (!existing.email && email)       patch.email = email;
      if (!existing.whatsapp && whatsapp) patch.whatsapp = whatsapp;
      if (Object.keys(patch).length) {
        await admin.from("leads").update(patch).eq("id", existing.id);
      }
    } else {
      const { data: novo, error: leadErr } = await admin
        .from("leads")
        .insert({ nome: nome ?? "Sem nome", email, whatsapp })
        .select("id")
        .single();
      if (leadErr || !novo) throw leadErr ?? new Error("lead insert sem retorno");
      leadId = novo.id;
    }
  } catch (e: any) {
    await admin.from("crm_webhook_logs").insert({
      integration_id: integration.id, slug, payload, status: "erro",
      erro: `lead persist: ${e?.message ?? e}`, ip_origem: ipOrigem,
    });
    return json({ error: "lead_persist_failed" }, 500);
  }

  // (6) extras p/ lead_oportunidades
  const utm_source   = asString(pickByMapping(payload, mapping, "lead_op.utm_source"), 200);
  const utm_medium   = asString(pickByMapping(payload, mapping, "lead_op.utm_medium"), 200);
  const utm_campaign = asString(pickByMapping(payload, mapping, "lead_op.utm_campaign"), 200);
  const fonte        = asString(pickByMapping(payload, mapping, "lead_op.fonte"), 200);
  const profissao    = asString(pickByMapping(payload, mapping, "lead_op.profissao"), 200);

  // (7) insere lead_oportunidades — registro de origem (bridge legado foi removido)
  let leadOportunidadeId: string | null = null;
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
    // segue: card pode ser criado sem o link
  }

  // (8) atribui segmento (idempotente)
  let segmentoAplicado: string | null = null;
  if (integration.segmento_id && leadId) {
    const { error: segErr } = await admin
      .from("crm_lead_segmentos")
      .upsert(
        { lead_id: leadId, segmento_id: integration.segmento_id, origem: "auto" },
        { onConflict: "lead_id,segmento_id", ignoreDuplicates: true },
      );
    if (!segErr) segmentoAplicado = integration.segmento_id;
  }

  // (9) cria oportunidade no funil de intake (default ate Fase 2)
  let oportunidadeId: string | null = null;
  try {
    const { data: cfg } = await admin
      .from("crm_pipeline_settings")
      .select("intake_funil_id, intake_ativo")
      .eq("id", 1)
      .maybeSingle();

    if (cfg?.intake_ativo && cfg.intake_funil_id) {
      const { data: etapa } = await admin
        .from("crm_funis_etapas")
        .select("id")
        .eq("funil_id", cfg.intake_funil_id)
        .order("ordem", { ascending: true })
        .limit(1)
        .maybeSingle();

      const { data: waAcc } = await admin
        .from("crm_whatsapp_accounts")
        .select("id")
        .eq("ativo", true)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (etapa?.id) {
        const titulo = integration.area_interesse ?? integration.pagina_nome ?? integration.nome ?? "Lead";
        const nowIso = new Date().toISOString();
        const { data: op, error: opErr } = await admin
          .from("crm_oportunidades")
          .insert({
            lead_id: leadId,
            lead_oportunidade_id: leadOportunidadeId,
            funil_id: cfg.intake_funil_id,
            etapa_id: etapa.id,
            titulo,
            origem: fonte ?? null,
            origem_campanha: utm_campaign ?? null,
            wa_account_id: waAcc?.id ?? null,
            status: "aberta",
            entrou_na_etapa_em: nowIso,
            ultima_atividade_em: nowIso,
          })
          .select("id")
          .single();
        if (opErr) throw opErr;
        oportunidadeId = op?.id ?? null;
      }
    }
  } catch (e: any) {
    console.error("[crm-lead-webhook] crm_oportunidades falhou:", e?.message);
    await admin.from("crm_webhook_logs").insert({
      integration_id: integration.id, slug, payload,
      resultado: {
        lead_id: leadId, segmento_aplicado: segmentoAplicado,
        lead_oportunidade_id: leadOportunidadeId, duplicado,
      },
      status: "erro", erro: `oportunidade: ${e?.message ?? e}`, ip_origem: ipOrigem,
    });
    return json({
      ok: true, partial: true,
      lead_id: leadId, segmento_aplicado: segmentoAplicado,
      lead_oportunidade_id: leadOportunidadeId, oportunidade_id: null,
      warning: "oportunidade_falhou",
    }, 200);
  }

  // (10) log de sucesso
  await admin.from("crm_webhook_logs").insert({
    integration_id: integration.id, slug, payload,
    resultado: {
      lead_id: leadId, segmento_aplicado: segmentoAplicado,
      lead_oportunidade_id: leadOportunidadeId, oportunidade_id: oportunidadeId, duplicado,
    },
    status: duplicado && !oportunidadeId ? "duplicado" : "ok",
    ip_origem: ipOrigem,
  });

  return json({
    ok: true,
    lead_id: leadId,
    segmento_aplicado: segmentoAplicado,
    lead_oportunidade_id: leadOportunidadeId,
    oportunidade_id: oportunidadeId,
    duplicado,
  }, 200);
});
