// crm-whatsapp-calling-settings
// ----------------------------------------------------------------------------
// Liga/desliga a Calling API por NÚMERO (POST /{phone_number_id}/settings) e espelha
// o estado nas colunas `calling_*` de crm_whatsapp_accounts.
//
// POR QUÊ o espelho: a verdade mora na Meta, mas a tela de contas lista ~29 números e
// não vai bater na Graph API 29 vezes só pra desenhar um selo.
//
// ⚠️ `call_icon_visibility` é o botão que o CLIENTE vê no perfil do número. Ligar o
// calling com o ícone em DEFAULT antes de existir alguém pra atender é pior que não
// ter ícone nenhum: o lead liga e chama no vazio. A ordem certa é ENABLED +
// DISABLE_ALL agora, DEFAULT quando o softphone estiver no ar.
//
// Gate: admin/diretor (mexe em número de produção e é visível pro cliente).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
// v23.0 é a primeira versão em que /settings responde o objeto `calling` (validado
// contra os números da BM 02 em 02/09/2026).
const META_GRAPH = "https://graph.facebook.com/v23.0";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Erro da Meta em formato legível — o error_user_msg vem em PT e é o melhor pra tela. */
function erroMeta(resp: any, status: number) {
  const e = resp?.error;
  return {
    error: e?.error_user_msg || e?.message || `Meta ${status}`,
    meta_code: e?.code ?? null,
    meta_subcode: e?.error_subcode ?? null,
  };
}

async function lerSettings(phoneNumberId: string, token: string) {
  const r = await fetch(`${META_GRAPH}/${phoneNumberId}/settings`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && !j?.error, status: r.status, body: j };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "use POST" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  // ── Gate admin/diretor ────────────────────────────────────────────────────
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ error: "não autenticado" }, 401);
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  });
  const { data: isAdmin } = await userClient.rpc("is_admin_ou_diretor_user");
  if (isAdmin !== true) return json({ error: "acesso restrito a admin/diretor" }, 403);

  const body = await req.json().catch(() => ({}));
  const acao = String(body?.acao ?? "ler");
  const waAccountId = String(body?.wa_account_id ?? "").trim();

  // ── sincronizar_todas: refaz o espelho de todas as contas ativas ──────────
  if (acao === "sincronizar_todas") {
    const { data: contas } = await admin
      .from("crm_whatsapp_accounts")
      .select("id, nome, phone_number_id, access_token")
      .eq("ativo", true);

    const resultado: any[] = [];
    for (const c of contas ?? []) {
      const s = await lerSettings(c.phone_number_id, c.access_token);
      const calling = s.body?.calling ?? {};
      await admin.from("crm_whatsapp_accounts").update({
        calling_status: calling.status ?? null,
        calling_icon_visibility: calling.call_icon_visibility ?? null,
        calling_callback_permission: calling.callback_permission_status ?? null,
        calling_sincronizado_em: new Date().toISOString(),
      }).eq("id", c.id);
      resultado.push({ id: c.id, nome: c.nome, calling: calling.status ?? null });
    }
    return json({ ok: true, contas: resultado });
  }

  if (!waAccountId) return json({ error: "wa_account_id obrigatório" }, 400);

  const { data: acc, error: accErr } = await admin
    .from("crm_whatsapp_accounts")
    .select("id, nome, phone_number_id, access_token")
    .eq("id", waAccountId)
    .maybeSingle();
  if (accErr || !acc?.phone_number_id || !acc?.access_token) {
    return json({ error: `conta incompleta: ${accErr?.message ?? "sem phone_number_id/token"}` }, 500);
  }

  // ── ler ───────────────────────────────────────────────────────────────────
  if (acao === "ler") {
    const s = await lerSettings(acc.phone_number_id, acc.access_token);
    if (!s.ok) return json(erroMeta(s.body, s.status), 422);
    const calling = s.body?.calling ?? {};
    await admin.from("crm_whatsapp_accounts").update({
      calling_status: calling.status ?? null,
      calling_icon_visibility: calling.call_icon_visibility ?? null,
      calling_callback_permission: calling.callback_permission_status ?? null,
      calling_sincronizado_em: new Date().toISOString(),
    }).eq("id", acc.id);
    return json({ ok: true, calling });
  }

  // ── salvar ────────────────────────────────────────────────────────────────
  if (acao === "salvar") {
    const status = String(body?.status ?? "").toUpperCase();
    if (!["ENABLED", "DISABLED"].includes(status)) {
      return json({ error: "status deve ser ENABLED ou DISABLED" }, 400);
    }
    const iconVisibility = String(body?.call_icon_visibility ?? "DISABLE_ALL").toUpperCase();
    if (!["DEFAULT", "DISABLE_ALL"].includes(iconVisibility)) {
      return json({ error: "call_icon_visibility deve ser DEFAULT ou DISABLE_ALL" }, 400);
    }
    const callback = String(body?.callback_permission_status ?? "ENABLED").toUpperCase();

    const calling: Record<string, unknown> = {
      status,
      call_icon_visibility: iconVisibility,
      callback_permission_status: callback,
    };
    // call_hours é opcional. Quando vem, tem que vir completo (timezone + semana),
    // senão a Meta recusa o objeto inteiro.
    if (body?.call_hours) calling.call_hours = body.call_hours;

    const r = await fetch(`${META_GRAPH}/${acc.phone_number_id}/settings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${acc.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ calling }),
    });
    const resp = await r.json().catch(() => ({}));
    console.log(`[calling-settings] ${acc.nome} status=${r.status} resp:`, JSON.stringify(resp));
    if (!r.ok || resp?.error) return json(erroMeta(resp, r.status), 422);

    // Relê da Meta em vez de confiar no que mandamos — ela normaliza valores.
    const depois = await lerSettings(acc.phone_number_id, acc.access_token);
    const callingDepois = depois.body?.calling ?? {};
    await admin.from("crm_whatsapp_accounts").update({
      calling_status: callingDepois.status ?? null,
      calling_icon_visibility: callingDepois.call_icon_visibility ?? null,
      calling_callback_permission: callingDepois.callback_permission_status ?? null,
      calling_sincronizado_em: new Date().toISOString(),
    }).eq("id", acc.id);

    return json({ ok: true, calling: callingDepois });
  }

  return json({ error: `ação desconhecida: ${acao}` }, 400);
});
