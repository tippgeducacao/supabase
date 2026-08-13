// wa-uazapi-webhook
// ----------------------------------------------------------------------------
// Recebe os eventos do provider (Uazapi) para UMA conexão, identificada pela
// query ?conexao=<id> (que o wa-uazapi-admin grava na URL ao configurar o
// webhook) — assim NUNCA dependemos de adivinhar a instância pelo payload.
//
// LOG-FIRST: todo payload é gravado cru em wa_webhook_log antes de qualquer
// parsing. O parser (provider.parseWebhook) é tolerante; o que ele não entender
// fica no log pra refinar sobre dados reais, sem perder mensagem.
//
// Mensagens inbound (e as que o SDR mandar do próprio celular, fromMe=true) são
// inseridas em crm_whatsapp_messages -> o trigger crm_mirror_to_sac espelha pro
// SAC/Omnichat automaticamente. Eventos connection atualizam wa_conexoes.
// ----------------------------------------------------------------------------
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { getWaProvider } from "../_shared/waProviders.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PROVIDER = "uazapi";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function extFromMime(mime: string): string {
  const m = (mime ?? "").toLowerCase();
  if (m.includes("ogg")) return "ogg";
  if (m.includes("audio") && m.includes("mpeg")) return "mp3";
  if (m.includes("audio") && m.includes("mp4")) return "m4a";
  if (m === "video/mp4") return "mp4";
  if (m === "image/jpeg") return "jpg";
  if (m === "image/png") return "png";
  if (m === "image/webp") return "webp";
  if (m === "application/pdf") return "pdf";
  return "bin";
}

function b64ToBytes(b64: string): Uint8Array {
  const clean = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64;
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  // Alguns provedores validam o webhook com um GET; respondemos 200.
  if (req.method === "GET") return new Response("ok", { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "método não suportado" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
  const url = new URL(req.url);
  const conexaoId = url.searchParams.get("conexao");

  let payload: any = null;
  try { payload = await req.json(); } catch { payload = null; }

  // ── LOG-FIRST: grava o cru antes de tudo ────────────────────────────────────
  let evento = "desconhecido";
  try {
    const provider = getWaProvider(PROVIDER);
    const parsedPeek = payload ? provider.parseWebhook(payload) : null;
    evento = parsedPeek?.evento ?? "desconhecido";
  } catch { /* ignore */ }
  try {
    await admin.from("wa_webhook_log").insert({
      provider: PROVIDER,
      conexao_id: conexaoId ?? null,
      evento,
      payload: payload ?? {},
    });
  } catch (e) {
    console.error("[wa-uazapi-webhook] falha ao logar payload:", e instanceof Error ? e.message : String(e));
  }

  if (!payload) return json({ ok: true, skipped: "payload vazio" });
  if (!conexaoId) {
    console.warn("[wa-uazapi-webhook] sem ?conexao= na URL; só logado");
    return json({ ok: true, skipped: "sem conexao" });
  }

  // Resolve a conexão (server_url p/ baixar mídia + secret token).
  const { data: conex } = await admin
    .from("wa_conexoes")
    .select("id, server_url, provider")
    .eq("id", conexaoId)
    .maybeSingle();
  if (!conex) {
    console.warn("[wa-uazapi-webhook] conexao não encontrada:", conexaoId);
    return json({ ok: true, skipped: "conexao inexistente" });
  }

  const provider = getWaProvider(conex.provider ?? PROVIDER);
  const parsed = provider.parseWebhook(payload);

  try {
    // ── connection: atualiza o status da linha ────────────────────────────────
    if (parsed.connection) {
      const patch: Record<string, unknown> = {
        status_conexao: parsed.connection.status,
        ultimo_status_em: new Date().toISOString(),
      };
      if (parsed.connection.numero) patch.numero = parsed.connection.numero;
      if (parsed.connection.status === "conectado") { patch.qrcode = null; patch.paircode = null; }
      await admin.from("wa_conexoes").update(patch).eq("id", conexaoId);
      console.log(`[wa-uazapi-webhook] conexao ${conexaoId} -> ${parsed.connection.status}`);
      return json({ ok: true, connection: parsed.connection.status });
    }

    // ── messages ──────────────────────────────────────────────────────────────
    let processed = 0;
    // resolve token 1x (só se precisar baixar mídia)
    let instToken: string | null = null;
    const getToken = async (): Promise<string | null> => {
      if (instToken) return instToken;
      const { data: sec } = await admin.from("wa_conexoes_secrets").select("token").eq("conexao_id", conexaoId).maybeSingle();
      instToken = sec?.token ?? null;
      return instToken;
    };

    // Foto de perfil do CONTATO: a Uazapi a envia em `chat.imagePreview` (96x96) /
    // `chat.image` (URL pps.whatsapp.net). A Meta NÃO fornece isso — por isso só a
    // linha Web popula a foto. A URL expira; cada mensagem traz uma nova e o front
    // cai nas iniciais quando vence. Gravamos em metadata.contato_foto_url; o trigger
    // `crm_mirror_to_sac` a escreve em sac_contatos.foto_url (lido pelas RPCs Omnichat).
    const chatFoto: string | null = (() => {
      const ch = (payload as { chat?: { imagePreview?: unknown; image?: unknown } })?.chat;
      const u = ch?.imagePreview || ch?.image || null;
      return typeof u === "string" && u.startsWith("http") ? u : null;
    })();

    for (const m of parsed.messages) {
      if (m.isGroup) continue; // grupos fora do escopo
      const telefone = m.fromDigits;
      if (!telefone) continue;

      // baixa mídia -> storage. Uazapi manda a mídia criptografada (sem URL no webhook):
      // resolvemos a URL pública real via /message/download (provider.downloadMedia) e
      // baixamos pro NOSSO storage (a deles expira em ~2 dias).
      let anexos: any[] = [];
      const ehMidia = ["image", "audio", "video", "document", "sticker"].includes(m.tipo);
      let mediaUrl = m.mediaUrl ?? null;
      let mediaMime = m.mediaMime ?? null;
      let mediaB64 = m.mediaBase64 ?? null;
      if (ehMidia && !mediaUrl && !mediaB64 && m.externalId) {
        try {
          const tok = await getToken();
          if (tok) {
            const dl = await provider.downloadMedia(conex.server_url, tok, m.externalId, { audioMp3: m.tipo === "audio" });
            mediaUrl = dl.url ?? null;
            mediaMime = mediaMime ?? dl.mime ?? null;
            mediaB64 = dl.base64 ?? null;
          }
        } catch (e) {
          console.log("[wa-uazapi-webhook] downloadMedia falhou:", e instanceof Error ? e.message : String(e));
        }
      }
      if (mediaUrl || mediaB64) {
        try {
          const mime = mediaMime || "application/octet-stream";
          let bytes: Uint8Array | null = null;
          if (mediaUrl && provider.isAllowedMediaHost(mediaUrl, conex.server_url)) {
            const binRes = await fetch(mediaUrl);
            if (binRes.ok) bytes = new Uint8Array(await binRes.arrayBuffer());
          } else if (mediaUrl) {
            console.warn("[wa-uazapi-webhook] mediaUrl host não permitido (anti-SSRF):", mediaUrl);
          }
          if (!bytes && mediaB64) bytes = b64ToBytes(mediaB64);
          if (bytes) {
            const ext = extFromMime(mime);
            const path = `crm/${new Date().toISOString().slice(0, 10)}/uazapi-${crypto.randomUUID()}.${ext}`;
            const { error: stErr } = await admin.storage.from("whatsapp-anexos").upload(path, bytes, { contentType: mime, upsert: false });
            if (stErr) {
              console.log("[wa-uazapi-webhook] storage upload fail:", stErr.message);
            } else {
              const pub = admin.storage.from("whatsapp-anexos").getPublicUrl(path).data.publicUrl;
              anexos = [{
                tipo: m.tipo, mime_type: mime, url: pub, url_storage: pub,
                filename: m.mediaFilename || `${m.tipo}.${ext}`,
              }];
            }
          }
        } catch (e) {
          console.log("[wa-uazapi-webhook] erro mídia inbound:", e instanceof Error ? e.message : String(e));
        }
      }

      // Mesma fonte única do webhook Meta: DDI, pontuação e ±9º dígito precisam
      // resolver para a mesma pessoa. A comparação exata antiga criava mensagens
      // órfãs quando o provedor devolvia o telefone em outra representação válida.
      const { data: leadIdResolvido, error: leadResolveErr } = await admin.rpc(
        "crm_lead_find_by_canon",
        { p_telefone: telefone },
      );
      if (leadResolveErr) {
        console.error("[wa-uazapi-webhook] resolver lead por telefone:", leadResolveErr.message);
      }
      const leadId = typeof leadIdResolvido === "string" ? leadIdResolvido : null;
      let oportunidadeId: string | null = null;
      if (leadId) {
        const { data: opRows } = await admin
          .from("lead_oportunidades").select("id")
          .eq("lead_id", leadId).eq("status", "ativo")
          .order("created_at", { ascending: false }).limit(1);
        oportunidadeId = opRows?.[0]?.id ?? null;
      }

      const direcao = m.fromMe ? "outbound" : "inbound";
      const { error: insErr } = await admin.from("crm_whatsapp_messages").insert({
        provider: PROVIDER,
        wa_conexao_id: conexaoId,
        wa_account_id: null, // Uazapi não tem conta Meta
        lead_id: leadId,
        oportunidade_id: oportunidadeId,
        telefone,
        direcao,
        tipo: m.tipo,
        conteudo: m.conteudo,
        anexos,
        wa_message_id: m.externalId,
        status_entrega: direcao === "inbound" ? "delivered" : "sent",
        metadata: {
          provider: PROVIDER,
          profile_name: m.senderName ?? null,
          original_type: m.tipo,
          timestamp: m.timestamp,
          // Foto de perfil do contato (chat.imagePreview) -> sac_contatos.foto_url no trigger.
          ...(chatFoto ? { contato_foto_url: chatFoto } : {}),
          // fromMe = SDR respondeu pelo próprio celular -> conta como 'humano' no espelho
          ...(m.fromMe ? { origem: "humano" } : {}),
        },
      });
      if (insErr) {
        if ((insErr as { code?: string }).code === "23505") {
          console.log("[wa-uazapi-webhook] msg duplicada, ignorada:", m.externalId);
        } else {
          console.error("[wa-uazapi-webhook] insert msg erro:", insErr.message);
        }
      } else {
        processed++;
      }
    }

    // marca o log como processado
    return json({ ok: true, messages: processed });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[wa-uazapi-webhook] erro:", msg);
    // 200 sempre: não queremos que o provider suspenda o webhook por erro nosso.
    return json({ ok: true, processed: false });
  }
});
