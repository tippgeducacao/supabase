// crm-whatsapp-webhook
// Recebe eventos do Meta WhatsApp Cloud API para o CRM Comercial.
// Processa: mensagens inbound, status de entrega, leitura.
// Cada conta CRM tem seu próprio webhook_verify_token.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// App Secret do Meta App comercial. Quando definido, a assinatura X-Hub-Signature-256
// é validada e payloads não assinados são rejeitados. Setar no Dokploy.
const META_APP_SECRET = Deno.env.get("CRM_META_APP_SECRET") ?? "";
// Relay do inbound pro agente SDR. CRM_N8N_INBOUND_URL funciona como liga/desliga
// (vazio = relay off), mas a CHAMADA usa o kong INTERNO (SUPABASE_URL=http://kong:8000),
// não a URL pública: o container do edge-runtime não alcança o próprio domínio
// público (api.ppgeducacao.site) por hairpin NAT — só o pg_net da reconciliação
// (no container do banco) chega lá. Com a URL pública, TODO inbound caía na
// reconciliação de ~5min. O kong interno é o mesmo caminho usado p/ crm-whatsapp-send.
const RELAY_BASE = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
const N8N_INBOUND_URL = ((Deno.env.get("CRM_N8N_INBOUND_URL") ?? "") !== "" && RELAY_BASE)
  ? `${RELAY_BASE}/functions/v1/crm-agente-sdr`
  : "";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Valida o HMAC-SHA256 que a Meta envia em X-Hub-Signature-256 (formato "sha256=<hex>").
async function validMetaSignature(raw: string, header: string | null, appSecret: string): Promise<boolean> {
  if (!header) return false;
  const [algo, sigHex] = header.split("=");
  if (algo !== "sha256" || !sigHex) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const expected = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
  // comparação em tempo constante
  if (expected.length !== sigHex.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sigHex.charCodeAt(i);
  return diff === 0;
}

// Só baixa mídia de hosts da Meta (anti-SSRF): a URL vem do JSON da Meta e é buscada com o token.
function isMetaMediaHost(u: string): boolean {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h === "lookaside.fbsbx.com"
      || h === "graph.facebook.com"
      || h.endsWith(".fbcdn.net")
      || h.endsWith(".facebook.com");
  } catch {
    return false;
  }
}

// Canoniza dígitos BR pro formato COM 9º dígito. O Meta dropa o 9 no inbound
// (manda 554688166051), mas o lead é salvo COM o 9 (5546988166051, pela
// crm-lead-webhook). Sem canonizar, o relay manda o remotejid sem o 9, o agente
// não acha o lead (buscarLead) e a msg só é recuperada pela reconciliação (~5min).
function canonicalBrDigits(raw: string): string {
  let d = (raw ?? "").replace(/\D/g, "");
  if (d.startsWith("55")) d = d.slice(2);
  if (d.length === 10 && ["6", "7", "8", "9"].includes(d[2])) {
    d = d.slice(0, 2) + "9" + d.slice(2);
  }
  return `55${d}`;
}

// Repassa a mensagem inbound normalizada pro n8n (buffer + roteador do agente SDR).
// Awaited com timeout; em qualquer erro só loga — nunca derruba o webhook (Meta espera 200).
async function relayToN8n(payload: Record<string, unknown>): Promise<void> {
  if (!N8N_INBOUND_URL) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(N8N_INBOUND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) console.log(`[crm-whatsapp-webhook] relay n8n respondeu ${res.status}`);
  } catch (e) {
    console.log("[crm-whatsapp-webhook] relay n8n falhou:", e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  // ── GET: Verificação do webhook pelo Meta ──────────────────────────────────
  if (req.method === "GET") {
    const url = new URL(req.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode !== "subscribe" || !token || !challenge) {
      return json({ error: "Parâmetros de verificação inválidos" }, 400);
    }

    // Busca todas as contas CRM ativas e verifica se algum token bate
    const { data: accounts } = await admin
      .from("crm_whatsapp_accounts")
      .select("id, webhook_verify_token")
      .eq("ativo", true);

    const matched = (accounts ?? []).find((a: any) => a.webhook_verify_token === token);
    if (!matched) {
      console.warn("[crm-whatsapp-webhook] verify_token não reconhecido:", token);
      return json({ error: "Token de verificação inválido" }, 403);
    }

    console.log("[crm-whatsapp-webhook] Webhook verificado para conta:", matched.id);
    return new Response(challenge, { status: 200 });
  }

  // ── POST: Eventos do Meta ──────────────────────────────────────────────────
  if (req.method !== "POST") {
    return json({ error: "Método não suportado" }, 405);
  }

  // Corpo cru: necessário para validar a assinatura HMAC sobre os bytes exatos.
  const rawBody = await req.text();
  const signature = req.headers.get("x-hub-signature-256");
  if (META_APP_SECRET) {
    const valid = await validMetaSignature(rawBody, signature, META_APP_SECRET);
    if (!valid) {
      console.warn("[crm-whatsapp-webhook] assinatura X-Hub-Signature-256 inválida — rejeitado");
      return json({ error: "assinatura inválida" }, 401);
    }
  } else {
    console.warn("[crm-whatsapp-webhook] CRM_META_APP_SECRET ausente — validação de assinatura DESATIVADA (configurar no Dokploy)");
  }

  try {
    let payload: any = null;
    try { payload = JSON.parse(rawBody); } catch { payload = null; }
    if (!payload) return json({ ok: true, skipped: "payload vazio/invalido" }, 200);

    console.log("[crm-whatsapp-webhook] payload recebido:", JSON.stringify(payload).slice(0, 500));

    const entries = payload?.entry ?? [];
    let processedMessages = 0;
    let processedStatuses = 0;

    for (const entry of entries) {
      const changes = entry?.changes ?? [];

      for (const change of changes) {
        if (change?.field !== "messages") continue;
        const value = change?.value;
        if (!value) continue;

        const phoneNumberId = value?.metadata?.phone_number_id;
        if (!phoneNumberId) continue;

        // Encontra a conta CRM pelo phone_number_id
        const { data: accountRows } = await admin
          .from("crm_whatsapp_accounts")
          .select("id")
          .eq("phone_number_id", phoneNumberId)
          .eq("ativo", true)
          .limit(1);

        const accountId = accountRows?.[0]?.id;
        if (!accountId) {
          console.warn("[crm-whatsapp-webhook] phone_number_id não encontrado no CRM:", phoneNumberId);
          continue;
        }

        // Resolve access_token da conta CRM (1x por conta) para baixar mídia inbound da Meta.
        // Em qualquer falha, segue sem token: as mensagens são inseridas sem anexos.
        let accountAccessToken: string | undefined;
        try {
          const { data: waRow, error: waErr } = await admin.rpc("get_crm_wa_account", {
            p_account_id: accountId,
          });
          if (waErr) {
            console.log("[crm-whatsapp-webhook] get_crm_wa_account erro:", waErr.message);
          } else {
            const wa = Array.isArray(waRow) ? waRow[0] : waRow;
            accountAccessToken = wa?.access_token;
          }
        } catch (tokErr: any) {
          console.log("[crm-whatsapp-webhook] erro ao resolver access_token:", tokErr?.message);
        }

        // ── Mensagens inbound ────────────────────────────────────────────
        const messages = value?.messages ?? [];
        for (const msg of messages) {
          const from = msg?.from;
          const msgType = msg?.type ?? "text";
          const msgId = msg?.id;
          const profileName = value?.contacts?.[0]?.profile?.name ?? null;

          let conteudo = "";
          let caption = ""; // legenda real da mídia (vazio se não houver) — separada do placeholder de conteudo
          // Mídia inbound a baixar da Meta (image/audio/video/document/sticker)
          let mediaInbound: { tipo: string; id?: string; mime_type?: string; filename?: string } | null = null;
          // Resposta a uma mensagem interativa (clique em botão/lista) — guarda id+título p/ roteamento.
          let interactiveReply: { tipo: string; id: string | null; title: string | null; description: string | null } | null = null;
          if (msgType === "text") {
            conteudo = msg?.text?.body ?? "";
          } else if (msgType === "interactive") {
            const br = msg?.interactive?.button_reply;
            const lr = msg?.interactive?.list_reply;
            conteudo = br?.title ?? lr?.title ?? "[interativo]";
            interactiveReply = {
              tipo: br ? "button_reply" : lr ? "list_reply" : "interactive",
              id: br?.id ?? lr?.id ?? null,
              title: br?.title ?? lr?.title ?? null,
              description: lr?.description ?? null,
            };
          } else if (msgType === "image") {
            conteudo = msg?.image?.caption ?? "[imagem]";
            caption = msg?.image?.caption ?? "";
            mediaInbound = { tipo: "image", id: msg?.image?.id, mime_type: msg?.image?.mime_type };
          } else if (msgType === "audio") {
            conteudo = "[áudio]";
            mediaInbound = { tipo: "audio", id: msg?.audio?.id, mime_type: msg?.audio?.mime_type };
          } else if (msgType === "video") {
            conteudo = msg?.video?.caption ?? "[vídeo]";
            caption = msg?.video?.caption ?? "";
            mediaInbound = { tipo: "video", id: msg?.video?.id, mime_type: msg?.video?.mime_type };
          } else if (msgType === "document") {
            conteudo = msg?.document?.filename ?? "[documento]";
            caption = msg?.document?.caption ?? "";
            mediaInbound = { tipo: "document", id: msg?.document?.id, mime_type: msg?.document?.mime_type, filename: msg?.document?.filename };
          } else if (msgType === "sticker") {
            conteudo = "[sticker]";
            mediaInbound = { tipo: "sticker", id: msg?.sticker?.id, mime_type: msg?.sticker?.mime_type ?? "image/webp" };
          } else if (msgType === "location") {
            conteudo = `[localização: ${msg?.location?.latitude}, ${msg?.location?.longitude}]`;
          } else if (msgType === "reaction") {
            // Marcador [reacao]<emoji> — mesmo formato do outbound; o chat renderiza
            // como reação (emoji destacado) e o preview do card vira "Reagiu <emoji>".
            conteudo = `[reacao]${msg?.reaction?.emoji ?? ""}`;
          } else {
            conteudo = `[${msgType}]`;
          }

          // ── Baixa mídia inbound da Meta e grava no Storage ──────────────
          // Em QUALQUER erro: console.log + segue, inserindo a mensagem sem anexos.
          let anexos: any[] = [];
          if (mediaInbound?.id && accountAccessToken) {
            try {
              // a) get media URL
              const metaUrlRes = await fetch(`https://graph.facebook.com/v21.0/${mediaInbound.id}`, {
                headers: { Authorization: `Bearer ${accountAccessToken}` },
              });
              const metaUrlJson: any = await metaUrlRes.json().catch(() => ({}));
              const mediaUrl: string | undefined = metaUrlJson?.url;
              const mime: string = metaUrlJson?.mime_type || mediaInbound.mime_type || "application/octet-stream";
              if (mediaUrl && !isMetaMediaHost(mediaUrl)) {
                console.warn("[crm-whatsapp-webhook] mediaUrl com host não permitido, ignorando (anti-SSRF):", mediaUrl);
              } else if (mediaUrl) {
                // b) download bytes (com token)
                const binRes = await fetch(mediaUrl, {
                  headers: { Authorization: `Bearer ${accountAccessToken}` },
                });
                const bin = new Uint8Array(await binRes.arrayBuffer());
                // c) upload to storage
                const ext = (mime.includes("ogg") ? "ogg" :
                  mime.includes("mpeg") && mime.includes("audio") ? "mp3" :
                  mime.includes("mp4") && mime.includes("audio") ? "m4a" :
                  mime === "video/mp4" ? "mp4" :
                  mime === "image/jpeg" ? "jpg" :
                  mime === "image/png" ? "png" :
                  mime === "image/webp" ? "webp" :
                  mime === "application/pdf" ? "pdf" : "bin");
                const path = `crm/${new Date().toISOString().slice(0, 10)}/inbound-${crypto.randomUUID()}.${ext}`;
                const { error: stErr } = await admin.storage.from("whatsapp-anexos").upload(path, bin, {
                  contentType: mime, upsert: false,
                });
                if (stErr) {
                  console.log("[crm-whatsapp-webhook] storage upload inbound fail:", stErr.message);
                } else {
                  const pub = admin.storage.from("whatsapp-anexos").getPublicUrl(path).data.publicUrl;
                  anexos = [{
                    tipo: mediaInbound.tipo,
                    mime_type: mime,
                    meta_media_id: mediaInbound.id,
                    url: pub,
                    url_storage: pub,
                    filename: mediaInbound.filename || `${mediaInbound.tipo}.${ext}`,
                  }];
                }
              } else {
                console.log("[crm-whatsapp-webhook] inbound media sem URL:", JSON.stringify(metaUrlJson));
              }
            } catch (mediaErr: any) {
              console.log("[crm-whatsapp-webhook] erro download mídia inbound:", mediaErr?.message);
            }
          } else if (mediaInbound?.id && !accountAccessToken) {
            console.log("[crm-whatsapp-webhook] mídia inbound sem access_token, inserindo sem anexos:", mediaInbound.id);
          }

          // Busca lead pelo telefone normalizado
          const phoneDigits = (from ?? "").replace(/\D/g, "");
          const phoneVariants = [
            phoneDigits,
            phoneDigits.startsWith("55") ? phoneDigits.slice(2) : `55${phoneDigits}`,
          ];

          const { data: leadRows } = await admin
            .from("leads")
            .select("id")
            .or(phoneVariants.map((p) => `whatsapp.eq.${p}`).join(","))
            .limit(1);

          const leadId = leadRows?.[0]?.id ?? null;

          // Busca oportunidade ativa do lead (se existir)
          let oportunidadeId: string | null = null;
          if (leadId) {
            const { data: opRows } = await admin
              .from("lead_oportunidades")
              .select("id")
              .eq("lead_id", leadId)
              .eq("status", "ativo")
              .order("created_at", { ascending: false })
              .limit(1);
            oportunidadeId = opRows?.[0]?.id ?? null;
          }

          const { error: insertErr } = await admin.from("crm_whatsapp_messages").insert({
            wa_account_id: accountId,
            lead_id: leadId,
            oportunidade_id: oportunidadeId,
            telefone: phoneDigits,
            direcao: "inbound",
            tipo: msgType,
            conteudo,
            anexos,
            wa_message_id: msgId,
            status_entrega: "delivered",
            metadata: {
              profile_name: profileName,
              original_type: msgType,
              timestamp: msg?.timestamp,
              ...(interactiveReply ? { interactive_reply: interactiveReply } : {}),
            },
          });

          if (insertErr) {
            // 23505 = unique_violation: retry da Meta com o mesmo wamid. Benigno: não relaya de novo.
            if ((insertErr as { code?: string }).code === "23505") {
              console.log("[crm-whatsapp-webhook] msg duplicada (retry meta), ignorada:", msgId);
            } else {
              console.error("[crm-whatsapp-webhook] insert msg erro:", insertErr.message);
            }
          } else {
            processedMessages++;
            console.log(
              `[crm-whatsapp-webhook] msg inbound de ${from} (lead=${leadId ?? "?"}, op=${oportunidadeId ?? "?"}, anexos=${anexos.length}): ${conteudo.slice(0, 80)}`,
            );
            // Relay pro n8n (somente após insert NOVO -> at-most-once garantido pelo índice único em wa_message_id).
            await relayToN8n({
              remotejid: `${canonicalBrDigits(phoneDigits)}@s.whatsapp.net`,
              id: msgId,
              timestamp: Number(msg?.timestamp) || Math.floor(Date.now() / 1000),
              direcao: "inbound", // relay só dispara p/ inbound; nunca p/ as próprias saídas
              from_me: false,     // Meta Cloud API não ecoa mensagens do negócio -> sempre false
              tipo: msgType,
              conteudo,
              caption,
              mime_type: anexos[0]?.mime_type ?? mediaInbound?.mime_type ?? null,
              anexos,
              // Clique em botão/lista: o agente (n8n) roteia pelo id/título escolhido.
              interactive_reply: interactiveReply,
              profile_name: profileName,
              telefone: phoneDigits,
              wa_account_id: accountId,
              lead_id: leadId,
              oportunidade_id: oportunidadeId,
            });
          }
        }

        // ── Status updates (delivered, read, failed) ─────────────────────
        const statuses = value?.statuses ?? [];
        for (const st of statuses) {
          const waMsgId = st?.id;
          const statusName = st?.status;
          if (!waMsgId || !statusName) continue;

          const statusMap: Record<string, string> = {
            sent: "sent",
            delivered: "delivered",
            read: "read",
            failed: "failed",
          };
          const mapped = statusMap[statusName];
          if (!mapped) continue;

          const updateData: Record<string, unknown> = { status_entrega: mapped };
          if (statusName === "failed" && st?.errors?.length) {
            updateData.erro = { errors: st.errors };
          }

          const { error: updErr } = await admin
            .from("crm_whatsapp_messages")
            .update(updateData)
            .eq("wa_message_id", waMsgId);

          if (updErr) {
            console.error("[crm-whatsapp-webhook] update status erro:", updErr.message);
          } else {
            processedStatuses++;
          }
        }
      }
    }

    console.log(
      `[crm-whatsapp-webhook] processado: ${processedMessages} msgs, ${processedStatuses} statuses`,
    );
    return json({ ok: true, messages: processedMessages, statuses: processedStatuses });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[crm-whatsapp-webhook] erro de processamento:", msg);
    // 200 mesmo em erro: evita retry/suspensão do webhook pela Meta. Detalhe fica no log.
    return json({ ok: true, processed: false }, 200);
  }
});
