// crm-whatsapp-templates
// Gerencia os templates (modelos) de mensagem da Meta WhatsApp Cloud API para o
// CRM Comercial. Reusa o mesmo padrão do crm-whatsapp-send (conta
// crm_whatsapp_accounts, auth Bearer, Graph v21.0).
//
// Ações (campo `action` no body, default "list"):
//   - "list"   → lista os templates da conta (GET  /{waba_id}/message_templates)
//   - "create" → cria um template novo p/ análise da Meta
//                (POST /{waba_id}/message_templates)
//   - "edit"   → edita o conteúdo de um template existente p/ reanálise da Meta
//                (POST /{template_id}; nome/idioma NÃO podem mudar)
//   - "delete" → remove um template pelo nome
//                (DELETE /{waba_id}/message_templates?name=...)
//
// A conta WA é resolvida por `wa_account_id` (ou a 1ª ativa) via RPC
// get_crm_wa_account (service_role). Cada conta = 1 número de API cadastrado.
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

/** Mensagem de erro mais legível a partir da resposta da Meta. */
function metaErro(metaResp: any, fallbackStatus: number): string {
  return (
    metaResp?.error?.error_user_msg ||
    metaResp?.error?.message ||
    `Meta API ${fallbackStatus}`
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const { wa_account_id, action = "list" } = body ?? {};

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

    const authHeaders = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };

    // ── CREATE ────────────────────────────────────────────────────────────────
    if (action === "create") {
      const { name, language, category, components } = body ?? {};
      if (!name || !language || !category || !Array.isArray(components)) {
        return json({ error: "name, language, category e components são obrigatórios" }, 400);
      }
      const r = await fetch(`${META_GRAPH}/${wabaId}/message_templates`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ name, language, category, components }),
      });
      const metaResp = await r.json().catch(() => ({}));
      console.log("[crm-whatsapp-templates] create <- Meta status:", r.status);
      if (!r.ok) return json({ error: metaErro(metaResp, r.status), meta: metaResp?.error ?? null }, 400);
      return json({ ok: true, id: metaResp?.id ?? null, status: metaResp?.status ?? null, category: metaResp?.category ?? null });
    }

    // ── EDIT ──────────────────────────────────────────────────────────────────
    // Edita o conteúdo (components) e, opcionalmente, a categoria de um template
    // existente. A Meta NÃO permite alterar nome nem idioma — só os componentes.
    // O template volta a ficar PENDING (reanálise). Endpoint: POST /{template_id}.
    if (action === "edit") {
      const { template_id, category, components } = body ?? {};
      if (!template_id || !Array.isArray(components)) {
        return json({ error: "template_id e components são obrigatórios" }, 400);
      }
      const payload: Record<string, unknown> = { components };
      if (category) payload.category = category;
      const r = await fetch(`${META_GRAPH}/${template_id}`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(payload),
      });
      const metaResp = await r.json().catch(() => ({}));
      console.log("[crm-whatsapp-templates] edit <- Meta status:", r.status);
      if (!r.ok) return json({ error: metaErro(metaResp, r.status), meta: metaResp?.error ?? null }, 400);
      return json({ ok: true });
    }

    // ── DELETE ────────────────────────────────────────────────────────────────
    if (action === "delete") {
      const { name } = body ?? {};
      if (!name) return json({ error: "name é obrigatório para excluir" }, 400);
      const r = await fetch(
        `${META_GRAPH}/${wabaId}/message_templates?name=${encodeURIComponent(name)}`,
        { method: "DELETE", headers: authHeaders },
      );
      const metaResp = await r.json().catch(() => ({}));
      console.log("[crm-whatsapp-templates] delete <- Meta status:", r.status);
      if (!r.ok) return json({ error: metaErro(metaResp, r.status) }, 400);
      return json({ ok: true });
    }

    // ── UPLOAD HEADER MEDIA ─────────────────────────────────────────────────────
    // Sobe um arquivo de EXEMPLO (imagem/vídeo/documento) p/ o cabeçalho de mídia de
    // um template e devolve o `header_handle` que a Meta exige no `example` ao criar.
    // Usa a Resumable Upload API: POST /{APP_ID}/uploads (inicia sessão) → POST
    // /{SESSION_ID} com os bytes (Authorization: OAuth). O APP_ID é descoberto a partir
    // do próprio token (debug_token) — não depende de env extra.
    if (action === "upload_header_media") {
      const { file_base64, mime, filename } = body ?? {};
      if (!file_base64 || !mime) {
        return json({ error: "file_base64 e mime são obrigatórios" }, 400);
      }
      // bytes do arquivo
      let bytes: Uint8Array;
      try {
        const raw = String(file_base64).includes(",") ? String(file_base64).split(",").pop()! : String(file_base64);
        const bin = atob(raw);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } catch {
        return json({ error: "file_base64 inválido" }, 400);
      }

      // app_id a partir do token (debug_token)
      const dbg = await fetch(
        `${META_GRAPH}/debug_token?input_token=${encodeURIComponent(accessToken)}&access_token=${encodeURIComponent(accessToken)}`,
      );
      const dbgResp = await dbg.json().catch(() => ({}));
      const appId = dbgResp?.data?.app_id ? String(dbgResp.data.app_id) : null;
      if (!appId) return json({ error: `Não foi possível resolver o app_id da conta: ${metaErro(dbgResp, dbg.status)}` }, 400);

      // 1) inicia a sessão de upload
      const startUrl =
        `${META_GRAPH}/${appId}/uploads?file_name=${encodeURIComponent(filename || "sample")}` +
        `&file_length=${bytes.length}&file_type=${encodeURIComponent(mime)}`;
      const startR = await fetch(startUrl, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } });
      const startResp = await startR.json().catch(() => ({}));
      const sessionId = startResp?.id ? String(startResp.id) : null;
      if (!startR.ok || !sessionId) return json({ error: metaErro(startResp, startR.status) }, 400);

      // 2) envia os bytes → devolve o handle `h`
      const upR = await fetch(`${META_GRAPH}/${sessionId}`, {
        method: "POST",
        headers: { Authorization: `OAuth ${accessToken}`, file_offset: "0", "Content-Type": "application/octet-stream" },
        body: bytes,
      });
      const upResp = await upR.json().catch(() => ({}));
      const handle = upResp?.h ? String(upResp.h) : null;
      console.log("[crm-whatsapp-templates] upload_header_media <- Meta status:", upR.status, handle ? "ok" : "sem handle");
      if (!upR.ok || !handle) return json({ error: metaErro(upResp, upR.status) }, 400);
      return json({ ok: true, handle });
    }

    // ── LIST (default) ─────────────────────────────────────────────────────────
    // `fields` explícito garante que `components` venha com os `example` (exigidos
    // ao reeditar variáveis na tela de edição).
    const r = await fetch(
      `${META_GRAPH}/${wabaId}/message_templates?limit=200&fields=name,language,status,category,id,components`,
      { method: "GET", headers: authHeaders },
    );
    const metaResp = await r.json().catch(() => ({}));
    console.log("[crm-whatsapp-templates] list <- Meta status:", r.status);

    if (!r.ok) return json({ error: metaErro(metaResp, r.status) }, 500);

    const data = Array.isArray(metaResp?.data) ? metaResp.data : [];
    const templates = data.map((t: any) => {
      const components = Array.isArray(t?.components) ? t.components : [];
      const up = (c: any) => String(c?.type ?? "").toUpperCase();
      const bodyComp = components.find((c: any) => up(c) === "BODY");
      const headerComp = components.find((c: any) => up(c) === "HEADER");
      const footerComp = components.find((c: any) => up(c) === "FOOTER");
      const buttonsComp = components.find((c: any) => up(c) === "BUTTONS");
      const bodyText = String(bodyComp?.text ?? "");
      const buttons = Array.isArray(buttonsComp?.buttons)
        ? buttonsComp.buttons.map((b: any) => ({
            type: String(b?.type ?? ""),
            text: String(b?.text ?? ""),
            url: b?.url ? String(b.url) : null,
            phone_number: b?.phone_number ? String(b.phone_number) : null,
          }))
        : [];
      return {
        id: String(t?.id ?? ""),
        name: String(t?.name ?? ""),
        language: String(t?.language ?? ""),
        status: String(t?.status ?? ""),
        category: String(t?.category ?? ""),
        has_body_param: bodyText.includes("{{"),
        body_text: bodyText,
        header_format: headerComp ? String(headerComp?.format ?? "TEXT") : null,
        header_text: headerComp?.text ? String(headerComp.text) : null,
        footer_text: footerComp?.text ? String(footerComp.text) : null,
        buttons,
        // Componentes crus (com `example`) — usados pela tela de edição para
        // reconstruir cabeçalho/corpo/rodapé/botões com fidelidade.
        components,
      };
    });

    return json({ templates });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[crm-whatsapp-templates] fatal:", msg);
    return json({ error: "erro interno ao processar templates" }, 500);
  }
});
