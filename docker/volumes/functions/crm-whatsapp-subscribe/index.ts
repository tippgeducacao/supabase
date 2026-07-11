// crm-whatsapp-subscribe
// ----------------------------------------------------------------------------
// Conecta a WABA da conta ao NOSSO app na Meta (POST /{waba_id}/subscribed_apps),
// que é o que faz a Meta ENTREGAR as mensagens recebidas no nosso webhook. Assinar
// os "campos do webhook" (messages, etc.) é nível-APP; isto aqui é a ligação por-WABA,
// separada — sem ela o número manda mas as respostas não entram.
//
// Usa o access_token JÁ salvo na conta (service-role lê direto). Gate: admin/diretor.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const META_GRAPH = "https://graph.facebook.com/v21.0";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "use POST" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  // Gate admin/diretor.
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ error: "não autenticado" }, 401);
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false },
  });
  const { data: isAdmin } = await userClient.rpc("is_admin_ou_diretor_user");
  if (isAdmin !== true) return json({ error: "acesso restrito a admin/diretor" }, 403);

  const body = await req.json().catch(() => ({}));
  const waAccountId = String(body?.wa_account_id ?? "").trim();
  if (!waAccountId) return json({ error: "wa_account_id obrigatório" }, 400);

  // waba_id + token (service-role: bypassa RLS; token nunca volta pro front).
  const { data: acc, error: accErr } = await admin
    .from("crm_whatsapp_accounts")
    .select("waba_id, access_token, phone_number_id")
    .eq("id", waAccountId)
    .maybeSingle();
  if (accErr || !acc?.waba_id || !acc?.access_token) {
    return json({ error: `conta incompleta: ${accErr?.message ?? "sem waba_id/token"}` }, 500);
  }

  const auth = { Authorization: `Bearer ${acc.access_token}` };

  // Estado atual.
  const before = await fetch(`${META_GRAPH}/${acc.waba_id}/subscribed_apps`, { headers: auth })
    .then((r) => r.json()).catch(() => ({}));
  console.log(`[crm-whatsapp-subscribe] waba=${acc.waba_id} apps ANTES:`, JSON.stringify(before));

  // Assina a WABA no app dono do token.
  const r = await fetch(`${META_GRAPH}/${acc.waba_id}/subscribed_apps`, { method: "POST", headers: auth });
  const resp = await r.json().catch(() => ({}));
  console.log(`[crm-whatsapp-subscribe] waba=${acc.waba_id} POST status=${r.status} resp:`, JSON.stringify(resp));
  if (!r.ok || (resp as any)?.error) {
    const e = (resp as any)?.error;
    return json({
      error: e?.error_user_msg || e?.message || `Meta ${r.status}`,
      meta_code: e?.code ?? null,
      before,
      // 422 (nunca 502/504): o Cloudflare engole 502/504 da origem sem headers CORS.
    }, 422);
  }

  // Confirma.
  const after = await fetch(`${META_GRAPH}/${acc.waba_id}/subscribed_apps`, { headers: auth })
    .then((r) => r.json()).catch(() => ({}));
  console.log(`[crm-whatsapp-subscribe] waba=${acc.waba_id} apps DEPOIS:`, JSON.stringify(after));

  return json({ ok: true, success: (resp as any)?.success ?? true, before, after });
});
