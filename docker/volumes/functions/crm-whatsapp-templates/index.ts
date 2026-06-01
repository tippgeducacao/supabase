// crm-whatsapp-templates
// Lista os templates de mensagem da Meta WhatsApp Cloud API para o CRM Comercial.
// Reusa o mesmo padrão do crm-whatsapp-send (conta crm_whatsapp_accounts, auth Bearer, Graph v21.0).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_GRAPH = "https://graph.facebook.com/v21.0";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const { wa_account_id } = body ?? {};

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false },
    });

    // Busca conta WA ativa do CRM (por id, senão a primeira ativa) — igual ao crm-whatsapp-send
    const { data: waRow, error: waErr } = await admin.rpc("get_crm_wa_account", {
      p_account_id: wa_account_id ?? null,
    });
    if (waErr || !waRow || (Array.isArray(waRow) && waRow.length === 0)) {
      return json({ error: `Conta WhatsApp CRM não encontrada: ${waErr?.message ?? "nenhuma ativa"}` }, 500);
    }
    const wa = Array.isArray(waRow) ? waRow[0] : waRow;
    const { waba_id: wabaId, access_token: accessToken } = wa;
    if (!wabaId || !accessToken) {
      return json({ error: "Conta WA incompleta (falta waba_id ou access_token)" }, 500);
    }

    // Lista templates da Meta (mesmo auth Bearer do send)
    const r = await fetch(`${META_GRAPH}/${wabaId}/message_templates?limit=200`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });
    const metaResp = await r.json().catch(() => ({}));
    console.log("[crm-whatsapp-templates] <- Meta status:", r.status);

    if (!r.ok) {
      const errMsg =
        metaResp?.error?.message ||
        metaResp?.error?.error_user_msg ||
        `Meta API ${r.status}`;
      return json({ error: errMsg }, 500);
    }

    const data = Array.isArray(metaResp?.data) ? metaResp.data : [];
    const templates = data.map((t: any) => {
      const components = Array.isArray(t?.components) ? t.components : [];
      const bodyComp = components.find(
        (c: any) => String(c?.type ?? "").toUpperCase() === "BODY",
      );
      const bodyText = String(bodyComp?.text ?? "");
      return {
        name: String(t?.name ?? ""),
        language: String(t?.language ?? ""),
        status: String(t?.status ?? ""),
        category: String(t?.category ?? ""),
        has_body_param: bodyText.includes("{{"),
        body_text: bodyText,
      };
    });

    return json({ templates });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[crm-whatsapp-templates] fatal:", msg);
    return json({ error: "erro interno ao listar templates" }, 500);
  }
});
