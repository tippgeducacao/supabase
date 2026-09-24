// ig-webhook
// ----------------------------------------------------------------------------
// Webhook do Instagram (Instagram API with Instagram Login) — 1 app, 1 webhook,
// N contas. Cada evento traz entry.id = ig_user_id da conta (roteamento).
//
// GET  : verificação do webhook (hub.mode/hub.verify_token/hub.challenge) contra
//        IG_WEBHOOK_VERIFY_TOKEN (env). Responde hub.challenge cru.
// POST : eventos. Valida X-Hub-Signature-256 (HMAC do app secret) se
//        IG_META_APP_SECRET estiver setado. LOG-FIRST: grava o payload cru em
//        ig_webhook_log ANTES de processar. DMs -> ig_mensagens; comentários ->
//        ig_comentarios. Sempre responde 200 (não deixar a Meta suspender).
//
// Padrões espelhados de crm-whatsapp-webhook (HMAC + protocolo Meta) e
// wa-uazapi-webhook (log-first). Deploy por git push (deploy-edges.yml);
// NUNCA usar o "Deploy" do Dokploy (apaga functions).
//
// IA do direct (TESTE, 24/09/2026): depois de gravar a DM, aciona a edge ig-agente
// só para quem passa no gate (_shared/igAgenteGate.ts) — ver acionarAgenteIg().
// ----------------------------------------------------------------------------
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { avaliarGateIg } from "../_shared/igAgenteGate.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VERIFY_TOKEN = Deno.env.get("IG_WEBHOOK_VERIFY_TOKEN") ?? "";
// App Secrets (Meta). A assinatura X-Hub-Signature-256 é testada contra TODOS
// os secrets configurados (o app tem DUAS chaves: a "Chave secreta do app do
// Instagram" e a do app principal — a Meta pode assinar com qualquer uma
// dependendo do fluxo). Nenhum setado = validação desligada (com warning).
const APP_SECRETS = [
  Deno.env.get("IG_META_APP_SECRET") ?? "",
  Deno.env.get("IG_META_APP_SECRET_ALT") ?? "",
].filter(Boolean);

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Valida o HMAC-SHA256 que a Meta envia em X-Hub-Signature-256 ("sha256=<hex>").
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
  if (expected.length !== sigHex.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sigHex.charCodeAt(i);
  return diff === 0;
}

// ── Perfil do contato (foto + @) — cache em ig_perfis ────────────────────────
// User Profile API: GET graph.instagram.com/<IGSID>?fields=name,username,profile_pic
// (exige o access token da conta em ig_contas_secrets; só funciona p/ quem já
// mandou DM). BEST-EFFORT: erro nunca derruba o webhook. A profile_pic expira,
// então refresh quando o cache passa de 7 dias.
const PERFIL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function enriquecerPerfis(admin: any, contaId: string | null, igsids: Set<string>) {
  if (!contaId || igsids.size === 0) return;
  try {
    const ids = [...igsids];
    const { data: existentes } = await admin
      .from("ig_perfis").select("igsid, updated_at").in("igsid", ids);
    const frescos = new Set(
      (existentes ?? [])
        .filter((p: any) => Date.now() - new Date(p.updated_at).getTime() < PERFIL_TTL_MS)
        .map((p: any) => p.igsid),
    );
    const pendentes = ids.filter((id) => !frescos.has(id));
    if (!pendentes.length) return;

    const { data: secret } = await admin
      .from("ig_contas_secrets").select("access_token").eq("conta_id", contaId).maybeSingle();
    const token = secret?.access_token;
    if (!token) return; // sem token guardado -> segue sem foto (degrada)

    for (const igsid of pendentes.slice(0, 10)) {
      try {
        const resp = await fetch(
          `https://graph.instagram.com/v23.0/${igsid}?fields=name,username,profile_pic&access_token=${encodeURIComponent(token)}`,
        );
        if (!resp.ok) {
          console.warn("[ig-webhook] perfil falhou", igsid, resp.status, (await resp.text()).slice(0, 200));
          continue;
        }
        const p = await resp.json();
        await admin.from("ig_perfis").upsert({
          igsid,
          conta_id: contaId,
          username: p?.username ?? null,
          nome: p?.name ?? null,
          foto_url: p?.profile_pic ?? null,
          updated_at: new Date().toISOString(),
        }, { onConflict: "igsid" });
      } catch (e) {
        console.warn("[ig-webhook] perfil erro", igsid, e instanceof Error ? e.message : String(e));
      }
    }
  } catch (e) {
    console.warn("[ig-webhook] enriquecerPerfis:", e instanceof Error ? e.message : String(e));
  }
}

// Mapeia os attachments do IG p/ o nosso formato + resolve o tipo da mensagem.
function mapAttachments(atts: any[]): { tipo: string; anexos: any[] } {
  const anexos = (atts ?? []).map((a: any) => ({
    tipo: a?.type ?? "file",
    url: a?.payload?.url ?? null,
    ...(a?.payload?.title ? { title: a.payload.title } : {}),
  }));
  const tipo = anexos[0]?.tipo ?? "file";
  return { tipo, anexos };
}

async function processarMensagens(admin: any, contaId: string | null, igUserId: string, messaging: any[]) {
  for (const ev of messaging ?? []) {
    try {
      const msg = ev?.message;
      const reaction = ev?.reaction;
      // Reação a uma mensagem
      if (reaction) {
        const contato = ev?.sender?.id === igUserId ? ev?.recipient?.id : ev?.sender?.id;
        await admin.from("ig_mensagens").upsert({
          conta_id: contaId, ig_user_id: igUserId,
          contato_igsid: contato, direcao: "inbound", tipo: "reaction",
          conteudo: reaction?.emoji ?? reaction?.reaction ?? null,
          // chave sintética p/ dedup (reação não tem mid próprio distinto do alvo)
          mid: reaction?.mid ? `${reaction.mid}:react:${ev?.sender?.id}` : null,
          metadata: { reaction, timestamp: ev?.timestamp },
        }, { onConflict: "mid", ignoreDuplicates: true });
        continue;
      }
      if (!msg) continue;
      // Echo = mensagem enviada por NÓS/humano (sender = a conta). Senão, inbound.
      const isEcho = !!msg?.is_echo;
      const direcao = isEcho ? "outbound" : "inbound";
      const contato = isEcho ? ev?.recipient?.id : ev?.sender?.id;
      let tipo = "text";
      let anexos: any[] = [];
      if (Array.isArray(msg.attachments) && msg.attachments.length) {
        const m = mapAttachments(msg.attachments);
        tipo = m.tipo; anexos = m.anexos;
      } else if (msg.reply_to?.story) {
        tipo = "story_reply";
      }
      await admin.from("ig_mensagens").upsert({
        conta_id: contaId, ig_user_id: igUserId,
        contato_igsid: contato, direcao, tipo,
        conteudo: msg.text ?? null,
        mid: msg.mid ?? null,
        anexos,
        metadata: {
          is_echo: isEcho,
          origem: isEcho ? "humano" : "lead",
          timestamp: ev?.timestamp,
          ...(msg.reply_to ? { reply_to: msg.reply_to } : {}),
        },
      }, { onConflict: "mid", ignoreDuplicates: true });
    } catch (e) {
      console.error("[ig-webhook] erro msg:", e instanceof Error ? e.message : String(e));
    }
  }
}

// ── IA do direct (teste) ─────────────────────────────────────────────────────
// Roda DEPOIS de gravar a DM e buscar o @ de quem mandou (o gate do teste é pelo @).
//   DM recebida  → só chama o ig-agente se passar no gate. DM de fora do teste nem
//                  chega na edge.
//   eco (nosso)  → só interessa se a IA já está nessa conversa: lá o ig-agente confere
//                  se foi ela ou alguém do time pelo app (humano assumiu = IA pausa).
// BEST-EFFORT: erro aqui nunca derruba o webhook.
async function acionarAgenteIg(admin: any, contaId: string | null, igUserId: string, messaging: any[]) {
  if (!contaId) return;
  const eventos = (messaging ?? []).filter((ev: any) =>
    ev?.message?.mid && !ev.message.is_deleted && !ev.message.is_unsupported
  );
  if (!eventos.length) return;
  try {
    const { data: cfg } = await admin.from("ig_agente_config")
      .select("modo, usernames_teste").eq("id", 1).maybeSingle();
    if (!cfg || cfg.modo === "desligado") return;
    const { data: conta } = await admin.from("ig_contas")
      .select("ativo, agente_ia_ativo").eq("id", contaId).maybeSingle();
    const contaIaAtiva = conta?.ativo === true && conta?.agente_ia_ativo === true;
    if (!contaIaAtiva) return;

    for (const ev of eventos) {
      const eco = !!ev.message.is_echo;
      const igsid = String((eco ? ev?.recipient?.id : ev?.sender?.id) ?? "");
      if (!igsid || igsid === igUserId) continue;
      if (eco) {
        const { data: conversa } = await admin.from("ig_conversa_ia")
          .select("pausada").eq("conta_id", contaId).eq("igsid", igsid).maybeSingle();
        if (!conversa || conversa.pausada) continue;
      } else {
        const { data: perfil } = await admin.from("ig_perfis")
          .select("username").eq("igsid", igsid).maybeSingle();
        const gate = avaliarGateIg({
          modo: cfg.modo,
          usernamesTeste: cfg.usernames_teste,
          contaIaAtiva,
          username: perfil?.username,
        });
        if (!gate.liberado) continue;
      }
      await dispararAgenteIg({ evento: eco ? "echo" : "inbound", conta_id: contaId, igsid, mid: String(ev.message.mid) });
    }
  } catch (e) {
    console.warn("[ig-webhook] acionarAgenteIg:", e instanceof Error ? e.message : String(e));
  }
}

// O ig-agente responde na hora e trabalha em background — esperar a resposta não segura
// o webhook.
async function dispararAgenteIg(corpo: Record<string, string>) {
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/ig-agente`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_ROLE}`, "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) console.warn("[ig-webhook] ig-agente respondeu", r.status, (await r.text()).slice(0, 200));
  } catch (e) {
    console.warn("[ig-webhook] ig-agente inacessível:", e instanceof Error ? e.message : String(e));
  }
}

async function processarComentario(admin: any, contaId: string | null, igUserId: string, value: any) {
  try {
    if (!value?.id) return;
    await admin.from("ig_comentarios").upsert({
      conta_id: contaId, ig_user_id: igUserId,
      comment_id: String(value.id),
      media_id: value?.media?.id ?? null,
      parent_comment_id: value?.parent_id ?? null,
      autor_igsid: value?.from?.id ?? null,
      autor_username: value?.from?.username ?? null,
      texto: value?.text ?? null,
      metadata: { media: value?.media ?? null },
    }, { onConflict: "comment_id", ignoreDuplicates: true });
  } catch (e) {
    console.error("[ig-webhook] erro comentario:", e instanceof Error ? e.message : String(e));
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // ── GET: verificação do webhook pela Meta ──────────────────────────────────
  if (req.method === "GET") {
    const url = new URL(req.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token && VERIFY_TOKEN && token === VERIFY_TOKEN) {
      console.log("[ig-webhook] webhook verificado");
      return new Response(challenge ?? "", { status: 200 });
    }
    console.warn("[ig-webhook] verify token inválido ou IG_WEBHOOK_VERIFY_TOKEN ausente");
    return json({ error: "verify token inválido" }, 403);
  }

  if (req.method !== "POST") return json({ error: "método não suportado" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  // Corpo cru: necessário p/ validar a assinatura HMAC sobre os bytes exatos.
  const rawBody = await req.text();
  const signature = req.headers.get("x-hub-signature-256");
  if (APP_SECRETS.length) {
    let ok = false;
    for (const s of APP_SECRETS) {
      if (await validMetaSignature(rawBody, signature, s)) { ok = true; break; }
    }
    if (!ok) {
      console.warn("[ig-webhook] assinatura X-Hub-Signature-256 inválida — rejeitado (testados", APP_SECRETS.length, "secrets)");
      return json({ error: "assinatura inválida" }, 401);
    }
  } else {
    console.warn("[ig-webhook] IG_META_APP_SECRET ausente — validação de assinatura DESATIVADA (setar no Dokploy)");
  }

  let payload: any = null;
  try { payload = JSON.parse(rawBody); } catch { payload = null; }
  if (!payload) return json({ ok: true, skipped: "payload vazio" });

  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  for (const entry of entries) {
    const igUserId = String(entry?.id ?? "");
    let evento = "desconhecido";
    if (Array.isArray(entry?.messaging)) evento = "messages";
    else if (Array.isArray(entry?.changes)) evento = entry.changes[0]?.field ?? "changes";

    // ── LOG-FIRST: grava o cru (por entry) antes de qualquer parsing ──────────
    try {
      await admin.from("ig_webhook_log").insert({ ig_user_id: igUserId || null, evento, payload: entry });
    } catch (e) {
      console.error("[ig-webhook] falha ao logar payload:", e instanceof Error ? e.message : String(e));
    }

    // Resolve a conta pelo ig_user_id (entry.id)
    let contaId: string | null = null;
    if (igUserId) {
      const { data: conta } = await admin.from("ig_contas").select("id").eq("ig_user_id", igUserId).maybeSingle();
      contaId = conta?.id ?? null;
      if (!contaId) console.warn("[ig-webhook] conta não cadastrada em ig_contas:", igUserId);
    }

    try {
      // DMs (Instagram Messaging entrega em entry.messaging[])
      if (Array.isArray(entry?.messaging)) {
        await processarMensagens(admin, contaId, igUserId, entry.messaging);
        // foto + @ do contato: só INBOUND (a API de perfil vale p/ quem mandou DM)
        const inboundIds = new Set<string>(
          entry.messaging
            .filter((ev: any) => ev?.message && !ev.message.is_echo && ev?.sender?.id && ev.sender.id !== igUserId)
            .map((ev: any) => String(ev.sender.id)),
        );
        await enriquecerPerfis(admin, contaId, inboundIds);
        await acionarAgenteIg(admin, contaId, igUserId, entry.messaging);
      }
      // Comentários / menções (entry.changes[])
      if (Array.isArray(entry?.changes)) {
        for (const ch of entry.changes) {
          if (ch?.field === "comments") {
            await processarComentario(admin, contaId, igUserId, ch.value);
          } else if (ch?.field === "messages" && Array.isArray(ch?.value?.messaging)) {
            // fallback: alguns setups entregam DM sob changes.field='messages'
            await processarMensagens(admin, contaId, igUserId, ch.value.messaging);
          }
          // mentions/live_comments/outros: ficam no log-first p/ refinar sobre dados reais
        }
      }
    } catch (e) {
      console.error("[ig-webhook] erro processando entry:", e instanceof Error ? e.message : String(e));
    }
  }

  // 200 sempre: evita a Meta suspender o webhook por erro nosso (detalhe no log).
  return json({ ok: true });
});
