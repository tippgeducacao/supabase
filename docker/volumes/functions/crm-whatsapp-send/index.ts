// crm-whatsapp-send
// Envia mensagem WhatsApp (texto ou template) via Meta Cloud API para o CRM Comercial.
// Diferente do whatsapp-send-message (pedagógico) — usa crm_whatsapp_accounts e crm_whatsapp_messages.
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

function formatPhone(raw: string): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (!digits) return null;
  return digits.startsWith("55") ? digits : `55${digits}`;
}

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
    const {
      wa_account_id,
      telefone,
      tipo = "text",
      conteudo,
      template_name,
      template_lang,
      template_components,
      lead_id,
      oportunidade_id,
    } = body ?? {};

    if (!telefone || !tipo) {
      return json({ error: "telefone e tipo são obrigatórios" }, 400);
    }
    if (tipo === "text" && !String(conteudo ?? "").trim()) {
      return json({ error: "conteudo vazio para tipo text" }, 400);
    }
    if (tipo === "template" && !template_name) {
      return json({ error: "template_name obrigatório para tipo template" }, 400);
    }

    const to = formatPhone(telefone);
    if (!to) return json({ error: "telefone inválido" }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false },
    });

    // Busca conta WA ativa do CRM
    const { data: waRow, error: waErr } = await admin.rpc("get_crm_wa_account", {
      p_account_id: wa_account_id ?? null,
    });
    if (waErr || !waRow || (Array.isArray(waRow) && waRow.length === 0)) {
      return json({ error: `Conta WhatsApp CRM não encontrada: ${waErr?.message ?? "nenhuma ativa"}` }, 500);
    }
    const wa = Array.isArray(waRow) ? waRow[0] : waRow;
    const { phone_number_id: phoneNumberId, access_token: accessToken, id: accountId } = wa;
    if (!phoneNumberId || !accessToken) {
      return json({ error: "Conta WA incompleta (falta phone_number_id ou access_token)" }, 500);
    }

    // Monta payload Meta
    let waPayload: Record<string, unknown>;
    if (tipo === "text") {
      waPayload = {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: String(conteudo).slice(0, 4096), preview_url: true },
      };
    } else if (tipo === "template") {
      waPayload = {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: template_name,
          language: { code: template_lang || "pt_BR" },
          components: Array.isArray(template_components) ? template_components : [],
        },
      };
    } else {
      return json({ error: `tipo '${tipo}' não suportado (use text ou template)` }, 400);
    }

    console.log("[crm-whatsapp-send] -> Meta:", JSON.stringify(waPayload));

    const r = await fetch(`${META_GRAPH}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(waPayload),
    });
    const waResp = await r.json().catch(() => ({}));
    console.log("[crm-whatsapp-send] <- Meta status:", r.status);

    const waMsgId = waResp?.messages?.[0]?.id ?? null;
    const nowIso = new Date().toISOString();

    // Conteúdo persistido
    const conteudoPersist =
      tipo === "text" ? String(conteudo) : `[template] ${template_name}`;

    // Persiste mensagem no CRM
    const { error: msgErr } = await admin.from("crm_whatsapp_messages").insert({
      wa_account_id: accountId,
      lead_id: lead_id ?? null,
      oportunidade_id: oportunidade_id ?? null,
      telefone: to,
      direcao: "outbound",
      tipo,
      conteudo: conteudoPersist,
      template_name: tipo === "template" ? template_name : null,
      wa_message_id: waMsgId,
      status_entrega: r.ok ? "sent" : "failed",
      erro: r.ok ? null : { status: r.status, meta_response: waResp },
      metadata: { payload_enviado: waPayload },
    });
    if (msgErr) console.error("[crm-whatsapp-send] insert erro:", msgErr.message);

    if (!r.ok) {
      const errMsg =
        waResp?.error?.message ||
        waResp?.error?.error_user_msg ||
        `Meta API ${r.status}`;
      console.error("[crm-whatsapp-send] Meta erro:", r.status, JSON.stringify(waResp));
      return json({ error: errMsg, status: r.status }, 502);
    }

    return json({
      success: true,
      wa_message_id: waMsgId,
      sent_at: nowIso,
      wa_account_id: accountId,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[crm-whatsapp-send] fatal:", msg);
    return json({ error: "erro interno ao enviar mensagem" }, 500);
  }
});
