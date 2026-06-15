// whatsapp-send-media
// Envia mídia (audio, video, image, document) via Meta WhatsApp Cloud API com upload direto
// (multipart -> /media -> /messages com media_id), persiste em ped_conversas_mensagens
// e atualiza ped_conversas_avulsas.ultima_atividade_em.
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
const BUCKET = "whatsapp-anexos";
const PUBLIC_SUPABASE_URL = Deno.env.get("PUBLIC_SUPABASE_URL") || "https://api.ppgeducacao.site";

function toPublicUrl(internalUrl: string): string {
  return internalUrl.replace(/^https?:\/\/kong:8000/i, PUBLIC_SUPABASE_URL);
}

const ALLOWED_TIPOS = new Set(["audio", "video", "image", "document", "sticker"]);

function formatPhone(raw: string): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (!digits) return null;
  return digits.startsWith("55") ? digits : `55${digits}`;
}

function extFromMime(mime: string, fallback = "bin"): string {
  const m = mime.toLowerCase();
  if (m.includes("ogg")) return "ogg";
  if (m.includes("mp4") && m.includes("audio")) return "m4a";
  if (m.includes("aac")) return "aac";
  if (m.includes("mpeg") && m.includes("audio")) return "mp3";
  if (m === "audio/amr") return "amr";
  if (m === "video/mp4") return "mp4";
  if (m === "video/3gpp") return "3gp";
  if (m === "image/jpeg") return "jpg";
  if (m === "image/png") return "png";
  if (m === "image/webp") return "webp";
  if (m === "application/pdf") return "pdf";
  return fallback;
}

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // 1) Auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return jsonResp({ error: "Unauthorized" }, 401);
    }
    const userClient = createClient(SUPABASE_URL, ANON, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user?.id) {
      return jsonResp({ error: "Não autenticado. Faça login novamente." }, 401);
    }

    // 2) Parse multipart
    const ct = req.headers.get("content-type") ?? "";
    if (!ct.toLowerCase().includes("multipart/form-data")) {
      return jsonResp({ error: "Esperado multipart/form-data" }, 400);
    }
    const form = await req.formData();
    const conversa_id = String(form.get("conversa_id") ?? "");
    const telefoneRaw = String(form.get("telefone") ?? "");
    const tipo = String(form.get("tipo") ?? "");
    const mime_type = String(form.get("mime_type") ?? "");
    const caption = form.get("caption") ? String(form.get("caption")) : "";
    const filename = form.get("filename") ? String(form.get("filename")) : "";
    const reply_to_wa_message_id = form.get("reply_to_wa_message_id")
      ? String(form.get("reply_to_wa_message_id"))
      : "";
    const fileEntry = form.get("file");

    if (!conversa_id || !telefoneRaw || !tipo || !mime_type) {
      return jsonResp({ error: "conversa_id, telefone, tipo e mime_type são obrigatórios" }, 400);
    }
    if (!ALLOWED_TIPOS.has(tipo)) {
      return jsonResp({ error: `tipo inválido: ${tipo}` }, 400);
    }
    if (!(fileEntry instanceof File) && !(fileEntry instanceof Blob)) {
      return jsonResp({ error: "campo 'file' ausente ou inválido" }, 400);
    }
    const fileBlob = fileEntry as Blob;
    const fileName =
      filename ||
      (fileEntry instanceof File && fileEntry.name) ||
      `arquivo.${extFromMime(mime_type)}`;

    const to = formatPhone(telefoneRaw);
    if (!to) return jsonResp({ error: "telefone inválido" }, 400);

    // 3) WA account
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false },
    });
    const { data: waRow, error: waErr } = await admin.rpc("get_wa_account_pedagogico");
    if (waErr || !waRow) {
      return jsonResp({ error: `WA account: ${waErr?.message ?? "vazio"}` }, 500);
    }
    const wa = Array.isArray(waRow) ? waRow[0] : waRow;
    const phoneNumberId = wa?.phone_number_id;
    const accessToken = wa?.access_token;
    if (!phoneNumberId || !accessToken) {
      return jsonResp({ error: "WA account incompleto" }, 500);
    }

    // 4) Upload pro Meta /media
    const uploadForm = new FormData();
    // Garante que o blob tenha o mime correto
    const blobForUpload = new Blob([await fileBlob.arrayBuffer()], { type: mime_type });
    uploadForm.append("file", blobForUpload, fileName);
    uploadForm.append("type", mime_type);
    uploadForm.append("messaging_product", "whatsapp");

    console.log("[whatsapp-send-media] upload ->", {
      phoneNumberId,
      tipo,
      mime_type,
      size: blobForUpload.size,
      fileName,
    });

    const upRes = await fetch(`${META_GRAPH}/${phoneNumberId}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: uploadForm,
    });
    const upJson = await upRes.json().catch(() => ({}));
    console.log("[whatsapp-send-media] upload <-", upRes.status, JSON.stringify(upJson));
    if (!upRes.ok || !upJson?.id) {
      return jsonResp({
        error: upJson?.error?.message || `Falha no upload Meta (${upRes.status})`,
        status: upRes.status,
        detalhes: upJson,
      }, 502);
    }
    const mediaId: string = upJson.id;

    // 5) (Opcional) salva no Storage para histórico
    let urlStorage: string | null = null;
    try {
      const ext = extFromMime(mime_type);
      const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${ext}`;
      const { error: stErr } = await admin.storage.from(BUCKET).upload(path, blobForUpload, {
        contentType: mime_type,
        upsert: false,
      });
      if (stErr) {
        console.log("[whatsapp-send-media] storage upload fail:", stErr.message);
      } else {
        urlStorage = toPublicUrl(admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl);
      }
    } catch (e) {
      console.log("[whatsapp-send-media] storage exception:", (e as Error).message);
    }

    // 6) Envia mensagem usando media_id
    const mediaObj: Record<string, unknown> = { id: mediaId };
    if ((tipo === "image" || tipo === "video" || tipo === "document") && caption) {
      mediaObj.caption = caption.slice(0, 1024);
    }
    if (tipo === "document" && fileName) mediaObj.filename = fileName;

    const sendPayload: Record<string, unknown> = {
      messaging_product: "whatsapp",
      to,
      type: tipo,
      [tipo]: mediaObj,
    };
    if (reply_to_wa_message_id) {
      sendPayload.context = { message_id: reply_to_wa_message_id };
    }

    console.log("[whatsapp-send-media] send ->", JSON.stringify(sendPayload));
    const sendRes = await fetch(`${META_GRAPH}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(sendPayload),
    });
    const sendJson = await sendRes.json().catch(() => ({}));
    console.log("[whatsapp-send-media] send <-", sendRes.status, JSON.stringify(sendJson));

    if (!sendRes.ok) {
      const errMsg =
        sendJson?.error?.message ||
        sendJson?.error?.error_user_msg ||
        `Meta API ${sendRes.status}`;
      try {
        await admin.from("ped_conversas_mensagens").insert({
          conversa_id,
          direcao: "outbound",
          conteudo: `[falha ao enviar ${tipo}] ${errMsg}`,
          enviada_em: new Date().toISOString(),
          anexos: [
            { tipo, mime_type, meta_media_id: mediaId, url_storage: urlStorage },
          ],
          classificacao_ia: {
            erro_envio: true,
            status: sendRes.status,
            meta_response: sendJson,
            payload_enviado: sendPayload,
          },
        });
      } catch (logErr) {
        console.log("[whatsapp-send-media] não foi possível salvar erro:", (logErr as Error).message);
      }
      return jsonResp(
        { error: errMsg, status: sendRes.status, detalhes: sendJson },
        502,
      );
    }

    const waMsgId: string | null = sendJson?.messages?.[0]?.id ?? null;
    const nowIso = new Date().toISOString();

    const conteudoPersist = caption ? caption : `[${tipo}]`;
    const anexos = [
      { tipo, mime_type, meta_media_id: mediaId, url: urlStorage, url_storage: urlStorage, filename: fileName },
    ];

    const { error: msgErr } = await admin.from("ped_conversas_mensagens").insert({
      conversa_id,
      direcao: "outbound",
      conteudo: conteudoPersist,
      wa_message_id: waMsgId,
      enviada_em: nowIso,
      anexos,
      reply_to_wa_message_id: reply_to_wa_message_id || null,
    });
    if (msgErr) console.log("[whatsapp-send-media] insert msg erro:", msgErr.message);

    await admin
      .from("ped_conversas_avulsas")
      .update({ ultima_atividade_em: nowIso, status: "em_conversa" })
      .eq("id", conversa_id);

    return jsonResp({ ok: true, wa_message_id: waMsgId, meta_media_id: mediaId, sent_at: nowIso });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[whatsapp-send-media] fatal:", msg);
    return jsonResp({ error: msg }, 500);
  }
});
