// whatsapp-send-message
// Envia mensagem WhatsApp (texto, template, image, video, document, audio) via Meta Cloud API,
// persiste em ped_conversas_mensagens e atualiza ped_conversas_avulsas.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const META_GRAPH = "https://graph.facebook.com/v21.0";

function formatPhone(raw: string): string | null {
  const trimmed = String(raw ?? "").trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  // Número internacional já com DDI (veio com '+', ex.: +1 dos EUA): NÃO force o 55.
  if (trimmed.startsWith("+")) return digits;
  // Já vem com o DDI do Brasil (55 + 10/11 dígitos).
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) return digits;
  // Número brasileiro sem DDI (DDD + 8/9 dígitos).
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  // Não reconhecido: devolve os dígitos como estão (não corrompe internacional sem '+').
  return digits;
}

const MEDIA_TIPOS = new Set(["image", "video", "document", "audio"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userClient = createClient(SUPABASE_URL, ANON, {
      global: { headers: { Authorization: authHeader } },
    });
    let userId: string | null = null;
    try {
      const { data: userData, error: userErr } = await userClient.auth.getUser();
      if (!userErr && userData?.user?.id) userId = userData.user.id;
    } catch (_) {}
    if (!userId) {
      return new Response(
        JSON.stringify({ error: "Não autenticado. Faça login novamente." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const body = await req.json().catch(() => ({}));
    const {
      conversa_id,
      telefone,
      tipo,
      conteudo,
      template_name,
      template_lang,
      template_components,
      media_url,
      media_filename,
      caption,
      reply_to_wa_message_id,
    } = body ?? {};

    if (!conversa_id || !telefone || !tipo) {
      return new Response(
        JSON.stringify({ error: "conversa_id, telefone e tipo são obrigatórios" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const tipoOk = tipo === "text" || tipo === "template" || MEDIA_TIPOS.has(tipo);
    if (!tipoOk) {
      return new Response(JSON.stringify({ error: "tipo inválido" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (tipo === "text" && !String(conteudo ?? "").trim()) {
      return new Response(JSON.stringify({ error: "conteudo vazio" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (tipo === "template" && !template_name) {
      return new Response(JSON.stringify({ error: "template_name obrigatório" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (MEDIA_TIPOS.has(tipo) && !media_url) {
      return new Response(JSON.stringify({ error: "media_url obrigatório" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const to = formatPhone(telefone);
    if (!to) {
      return new Response(JSON.stringify({ error: "telefone inválido" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    const { data: waRow, error: waErr } = await admin.rpc("get_wa_account_pedagogico");
    if (waErr || !waRow) {
      return new Response(JSON.stringify({ error: `WA account: ${waErr?.message ?? "vazio"}` }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const wa = Array.isArray(waRow) ? waRow[0] : waRow;
    const phoneNumberId = wa?.phone_number_id;
    const accessToken = wa?.access_token;
    if (!phoneNumberId || !accessToken) {
      return new Response(JSON.stringify({ error: "WA account incompleto" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let waPayload: Record<string, unknown>;
    if (tipo === "text") {
      waPayload = {
        messaging_product: "whatsapp", to, type: "text",
        text: { body: String(conteudo).slice(0, 4096), preview_url: true },
      };
    } else if (tipo === "template") {
      waPayload = {
        messaging_product: "whatsapp", to, type: "template",
        template: {
          name: template_name,
          language: { code: template_lang || "pt_BR" },
          components: Array.isArray(template_components) ? template_components : [],
        },
      };
    } else {
      // Media: image, video, document, audio
      const mediaObj: Record<string, unknown> = { link: media_url };
      if (tipo === "document" && media_filename) mediaObj.filename = media_filename;
      if ((tipo === "image" || tipo === "video" || tipo === "document") && caption) {
        mediaObj.caption = String(caption).slice(0, 1024);
      }
      waPayload = {
        messaging_product: "whatsapp", to, type: tipo,
        [tipo]: mediaObj,
      };
    }

    if (reply_to_wa_message_id) {
      (waPayload as Record<string, unknown>).context = { message_id: String(reply_to_wa_message_id) };
    }

    if (tipo === "audio") {
      try {
        const head = await fetch(media_url, { method: "HEAD" });
        console.log("[whatsapp-send-message] audio HEAD:", media_url, "status:", head.status, "content-type:", head.headers.get("content-type"), "content-length:", head.headers.get("content-length"));
      } catch (e) {
        console.log("[whatsapp-send-message] audio HEAD failed:", String(e));
      }
    }

    console.log("[whatsapp-send-message] -> Meta payload:", JSON.stringify(waPayload));
    const r = await fetch(`${META_GRAPH}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(waPayload),
    });
    const waResp = await r.json().catch(() => ({}));
    console.log("[whatsapp-send-message] <- Meta status:", r.status, "resp:", JSON.stringify(waResp));
    if (!r.ok) {
      const errMsg = waResp?.error?.message || waResp?.error?.error_user_msg || `Meta API ${r.status}`;
      // Persiste erro detalhado em ped_conversas_mensagens.classificacao_ia
      try {
        await admin.from("ped_conversas_mensagens").insert({
          conversa_id,
          direcao: "outbound",
          conteudo: `[falha ao enviar ${tipo}] ${errMsg}`,
          enviada_em: new Date().toISOString(),
          anexos: tipo !== "text" && tipo !== "template" ? [{ tipo, url: media_url, filename: media_filename ?? null }] : [],
          classificacao_ia: { erro_envio: true, status: r.status, meta_response: waResp, payload_enviado: waPayload },
        });
      } catch (logErr) {
        console.log("[whatsapp-send-message] não foi possível salvar mensagem de erro:", (logErr as Error).message);
      }
      return new Response(JSON.stringify({ error: errMsg, status: r.status, detalhes: waResp }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const waMsgId = waResp?.messages?.[0]?.id ?? null;
    const nowIso = new Date().toISOString();

    // Conteúdo legível persistido
    let conteudoPersist: string;
    let anexos: any[] = [];
    if (tipo === "text") {
      conteudoPersist = String(conteudo);
    } else if (tipo === "template") {
      conteudoPersist = `[template] ${template_name}`;
    } else {
      conteudoPersist = caption ? String(caption) : `[${tipo}]`;
      anexos = [{ tipo, url: media_url, filename: media_filename ?? null }];
    }

    const { error: msgErr } = await admin.from("ped_conversas_mensagens").insert({
      conversa_id,
      direcao: "outbound",
      conteudo: conteudoPersist,
      template_name: tipo === "template" ? template_name : null,
      wa_message_id: waMsgId,
      enviada_em: nowIso,
      anexos,
      reply_to_wa_message_id: reply_to_wa_message_id || null,
    });
    if (msgErr) console.log("[whatsapp-send-message] insert msg erro:", msgErr.message);

    await admin
      .from("ped_conversas_avulsas")
      .update({ ultima_atividade_em: nowIso, status: "em_conversa" })
      .eq("id", conversa_id);

    return new Response(
      JSON.stringify({ success: true, wa_message_id: waMsgId, sent_at: nowIso }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[whatsapp-send-message] fatal:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
