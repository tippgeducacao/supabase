// crm-whatsapp-webhook
// Recebe eventos do Meta WhatsApp Cloud API para o CRM Comercial.
// Processa: mensagens inbound, status de entrega, leitura.
// Verificação (GET): aceita o verify token GLOBAL (crm_whatsapp_config) — o que se cola em
// App/BM novo — e, por compat, o token por conta (crm_whatsapp_accounts).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { extrairReferral } from "../_shared/waProviders.ts";
import { carimboInbound } from "./carimbo.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// App Secret(s) do(s) Meta App(s). Quando há pelo menos um, a assinatura
// X-Hub-Signature-256 é validada e payload não assinado é rejeitado. Setar no Dokploy.
//
// ⚠️ ACEITA VÁRIOS, separados por vírgula — a assinatura é feita pelo APP QUE ENVIA, e
// cada app tem o SEU secret. Com um secret só, a WABA que estiver assinada em outro app
// (BM diferente) tem TODOS os eventos rejeitados com 401 — e o modo de falha é MUDO: a
// mensagem sai normalmente, mas não chega status nem inbound, nenhum card nasce no SAC e
// as respostas do lead se perdem (caso 2026-08-07: conta "PPGVET Educação (Escola)" no app
// "CRM API OFICIAL BM 01", 265 enviadas / 0 inbound / 0 delivered).
// Diagnóstico rápido: `select ... from crm_whatsapp_messages` por conta — 0 inbound + 0
// delivered com outbound alto = assinatura rejeitada; confirme com um POST sem assinatura
// no endpoint (deve dar 401) e com `GET /{waba_id}/subscribed_apps` (qual app entrega).
const META_APP_SECRETS = (Deno.env.get("CRM_META_APP_SECRET") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// Relay do inbound pro agente SDR. CRM_N8N_INBOUND_URL funciona como liga/desliga
// (vazio = relay off), mas a CHAMADA usa o kong INTERNO (SUPABASE_URL=http://kong:8000),
// não a URL pública: o container do edge-runtime não alcança o próprio domínio
// público (api.ppgeducacao.site) por hairpin NAT — só o pg_net da reconciliação
// (no container do banco) chega lá. Com a URL pública, TODO inbound caía na
// reconciliação de ~5min. O kong interno é o mesmo caminho usado p/ crm-whatsapp-send.
// Idade máxima (segundos) de um inbound para ele DISPARAR rodada do agente.
// A Meta reentrega webhook que falhou, com backoff crescente: depois de uma janela de
// rejeição (App Secret errado, edge fora do ar, deploy) a fila drena horas depois — e sem
// esta régua CADA mensagem antiga vira uma rodada NOVA, floodando o lead com respostas fora
// de contexto. Caso 2026-08-27 (BM 03): 7 mensagens de teste voltaram entre 13min e 1h45
// depois, cada uma gerando 2 balões, com o lead sem ter escrito nada naquele momento.
// Default 15min: entrega normal da Meta é de segundos, então a folga é enorme.
const RELAY_IDADE_MAX_S = Number(Deno.env.get("CRM_RELAY_IDADE_MAX_S") ?? "900") || 900;

const RELAY_BASE = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
const N8N_INBOUND_URL = ((Deno.env.get("CRM_N8N_INBOUND_URL") ?? "") !== "" && RELAY_BASE)
  ? `${RELAY_BASE}/functions/v1/crm-agente-sdr`
  : "";
// Agente de RH e Contratação: número próprio, agente próprio. O inbound do número
// Administrativo PPG NÃO pode cair no João — o candidato receberia o qualificador
// comercial tentando vender pós-graduação. Este é o ÚNICO ponto onde os dois se
// encostam, e é um desvio por número, não uma mistura de código.
const AGENTE_RH_WA_ACCOUNT_ID = Deno.env.get("AGENTE_RH_WA_ACCOUNT_ID")
  ?? "31d9a4ff-9606-4018-a2fb-ffb0155e099b";
const AGENTE_RH_URL = RELAY_BASE ? `${RELAY_BASE}/functions/v1/crm-agente-rh` : "";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ── Saúde da conta (eventos da Meta que NÃO são mensagens) ────────────────────
// Template baixou de qualidade / foi pausado / desabilitado; conta com problema de
// pagamento / restrição / banimento; número perdeu qualidade. Gravamos em
// crm_whatsapp_alertas (via RPC idempotente) para a aba "Saúde da conta" + banner.
function upper(s: unknown): string {
  return String(s ?? "").toUpperCase();
}

function severidadePorPalavra(txt: string, criticas: string[], avisos: string[]): "info" | "aviso" | "critico" {
  const t = upper(txt);
  if (criticas.some((k) => t.includes(k))) return "critico";
  if (avisos.some((k) => t.includes(k))) return "aviso";
  return "info";
}

/** Resolve a conta CRM pelo WABA id (entry.id dos webhooks da WhatsApp Business Account). */
async function resolveAccountByWaba(admin: any, wabaId?: string | null): Promise<string | null> {
  if (!wabaId) return null;
  const { data } = await admin
    .from("crm_whatsapp_accounts")
    .select("id")
    .eq("waba_id", String(wabaId))
    .limit(1);
  return data?.[0]?.id ?? null;
}

interface AlertaConta {
  tipo: string;
  severidade: "info" | "aviso" | "critico";
  titulo: string;
  descricao: string | null;
  evento: string | null;
  referencia: string | null;
}

/** Mapeia um change (field != messages) para um alerta, ou null se for evento irrelevante. */
function mapearAlerta(field: string, value: any): AlertaConta | null {
  switch (field) {
    case "message_template_quality_update": {
      const nome = value?.message_template_name ?? value?.message_template_id ?? "template";
      const novo = upper(value?.new_quality_score);
      const ant = upper(value?.previous_quality_score);
      const sev = novo === "RED" ? "critico" : novo === "YELLOW" ? "aviso" : "info";
      return {
        tipo: "template_quality",
        severidade: sev,
        titulo: `Qualidade do template "${nome}": ${novo || "—"}`,
        descricao: `A Meta mudou a qualidade do template de ${ant || "—"} para ${novo || "—"}.`
          + (novo === "RED" ? " Em RED, a Meta pode pausar o envio do template." : ""),
        evento: novo || null,
        referencia: nome,
      };
    }
    case "message_template_status_update": {
      const nome = value?.message_template_name ?? value?.message_template_id ?? "template";
      const ev = upper(value?.event);
      const sev = ["REJECTED", "DISABLED", "PENDING_DELETION"].includes(ev)
        ? "critico"
        : ["PAUSED", "FLAGGED"].includes(ev) ? "aviso" : "info";
      const reason = value?.reason && value.reason !== "NONE" ? ` Motivo: ${value.reason}.` : "";
      return {
        tipo: "template_status",
        severidade: sev,
        titulo: `Template "${nome}": ${ev || "atualizado"}`,
        descricao: `A Meta mudou o status do template para ${ev || "—"}.${reason}`,
        evento: ev || null,
        referencia: nome,
      };
    }
    case "account_update": {
      const ev = upper(value?.event);
      const sev = severidadePorPalavra(
        ev,
        ["VIOLATION", "DISABLED", "RESTRICTION", "DELETED", "BAN", "PAYMENT"],
        ["WARNING", "FLAGGED", "DOWNGRADE", "REVIEW"],
      );
      const extra = value?.ban_info ?? value?.restriction_info ?? value?.violation_info ?? null;
      return {
        tipo: "account_update",
        severidade: sev,
        titulo: `Conta WhatsApp: ${ev || "atualização"}`,
        descricao: extra ? `Detalhes: ${JSON.stringify(extra)}` : `Evento de conta: ${ev || "—"}.`,
        evento: ev || null,
        referencia: value?.phone_number ?? null,
      };
    }
    case "account_alerts": {
      const tipoAlerta = value?.alert_type ?? value?.alert_status ?? "alerta";
      const sev = severidadePorPalavra(
        `${value?.alert_severity ?? ""} ${tipoAlerta}`,
        ["CRITICAL", "SEVERE", "PAYMENT", "DISABLED"],
        ["WARNING", "MEDIUM"],
      );
      return {
        tipo: "account_alert",
        severidade: sev,
        titulo: `Alerta da conta: ${tipoAlerta}`,
        descricao: value?.alert_description ?? `Severidade: ${value?.alert_severity ?? "—"}.`,
        evento: upper(tipoAlerta) || null,
        referencia: value?.entity_id ?? null,
      };
    }
    case "phone_number_quality_update": {
      const tel = value?.display_phone_number ?? "número";
      const ev = upper(value?.event);
      const sev = ev === "FLAGGED" ? "aviso" : "info";
      const limite = value?.current_limit ? ` Limite atual: ${value.current_limit}.` : "";
      return {
        tipo: "phone_quality",
        severidade: sev,
        titulo: `Número ${tel}: ${ev || "atualização de qualidade"}`,
        descricao: `Qualidade/limite do número mudou.${limite}`,
        evento: ev || null,
        referencia: String(tel),
      };
    }
    default:
      return null; // eventos não relacionados a saúde da conta são ignorados
  }
}

/** 55 + DDD + 9 + 8 — chave do espelho de permissão de ligação. */
function canonicalBrPhoneWh(raw: string): string {
  let d = (raw ?? "").replace(/\D/g, "");
  if (d.startsWith("55")) d = d.slice(2);
  if (d.length === 10 && ["6", "7", "8", "9"].includes(d[2])) {
    d = d.slice(0, 2) + "9" + d.slice(2);
  }
  return `55${d}`;
}

/**
 * Eventos da Calling API (field = "calls").
 *
 * ⚠️ ESTE É O CAMINHO DO ÁUDIO. O `connect` traz o **SDP answer** da Meta, e é a única
 * via por onde ele chega: a resposta HTTP do `POST /calls` só devolve o call_id. O
 * UPDATE em `crm_chamadas` abaixo é o que acorda o navegador do SDR pelo Realtime
 * (a tabela está na publicação `supabase_realtime`, com replica identity full). Sem
 * este ramo a ligação sai, toca no aparelho do lead e não passa som nenhum.
 *
 * Ligação RECEBIDA chega aqui como `connect` com sdp_type=offer e sem linha nossa —
 * criamos a linha na hora.
 *
 * É esse INSERT que faz o telefone tocar: o `ChamadaRecebidaDialog` (montado uma vez no
 * CrmLayout) assina a tabela pelo Realtime. Por isso os dois campos de roteamento são
 * gravados AQUI e não no navegador — `atendente_alvo_id` (dono do atendimento, atende
 * primeiro) e `plantao_em` (quando abre para todos). Relógio de cliente diverge; se cada
 * aba calculasse o plantão sozinha, ou todas tocariam juntas ou nenhuma tocaria.
 */
async function processarEventoChamada(admin: any, value: any): Promise<number> {
  let n = 0;
  const phoneNumberId = value?.metadata?.phone_number_id;

  // Resolve a conta uma vez (as duas listas abaixo pertencem ao mesmo número).
  let accountId: string | null = null;
  if (phoneNumberId) {
    const { data } = await admin
      .from("crm_whatsapp_accounts")
      .select("id")
      .eq("phone_number_id", phoneNumberId)
      .limit(1);
    accountId = data?.[0]?.id ?? null;
  }

  for (const call of value?.calls ?? []) {
    const callId = call?.id ?? null;
    if (!callId) continue;

    const evento = String(call?.event ?? "").toLowerCase();
    const status = upper(call?.status);
    const sdp = call?.session?.sdp ?? null;
    const sdpType = String(call?.session?.sdp_type ?? "").toLowerCase();
    const agora = new Date().toISOString();

    // A forma exata do envelope de `calls` ainda está sendo aprendida em produção —
    // sem este log, evento não mapeado vira chamada travada num status errado e
    // ninguém descobre por quê.
    console.log(`[crm-whatsapp-webhook] calls: event=${evento || "—"} status=${status || "—"} sdp=${sdpType || "—"} id=${callId}`);

    // A linha já existe quando a ligação partiu daqui (crm-whatsapp-call gravou antes
    // do POST justamente para este momento).
    const { data: existente } = await admin
      .from("crm_chamadas")
      .select("id, direcao, status, telefone, wa_account_id")
      .eq("call_id", callId)
      .maybeSingle();

    if (evento === "connect") {
      if (existente) {
        // Saída: o answer da Meta fecha a negociação WebRTC no browser.
        await admin.from("crm_chamadas").update({
          ...(sdpType === "answer" && sdp ? { sdp_answer: sdp } : {}),
          status: "ringing",
        }).eq("id", existente.id);
      } else if (accountId) {
        // Entrada: o lead está ligando. A linha é o que a tela assina para tocar.
        const de = String(call?.from ?? "");

        // Para QUEM toca. A ligação chega num número, não numa pessoa: o dono do
        // atendimento daquele telefone atende primeiro, e o plantão (todo mundo com o
        // CRM aberto) entra 15s depois. Sem dono, já nasce no plantão.
        let alvo: string | null = null;
        try {
          const { data } = await admin.rpc("crm_chamada_resolver_alvo", {
            p_wa_account_id: accountId,
            p_telefone: de,
          });
          alvo = (data as string | null) ?? null;
        } catch (e) {
          // Falhar aqui não pode calar o telefone — sem dono, toca para todos.
          console.error("[crm-whatsapp-webhook] resolver alvo falhou:", e instanceof Error ? e.message : String(e));
        }
        const plantaoEm = new Date(Date.now() + (alvo ? 15_000 : 0)).toISOString();

        // QUAL card do SAC v2 é o desta ligação: o da LINHA que recebeu. Vai gravado na
        // própria chamada para o "Abrir" da notificação cair nele — navegar só por
        // telefone caía no card de OUTRA linha (Web/Cobrança) em 03/09/2026.
        let alvoV2: { funil_id: string | null; atendimento_id: string | null } | null = null;
        try {
          const { data } = await admin.rpc("crm_chamada_alvo_v2", {
            p_wa_account_id: accountId,
            p_telefone: de,
          });
          const linha = Array.isArray(data) ? data[0] : data;
          if (linha?.atendimento_id) alvoV2 = linha;
        } catch (e) {
          console.error("[crm-whatsapp-webhook] alvo v2 falhou:", e instanceof Error ? e.message : String(e));
        }

        await admin.from("crm_chamadas").insert({
          wa_account_id: accountId,
          call_id: callId,
          direcao: "entrada",
          telefone: de,
          status: "ringing",
          atendente_alvo_id: alvo,
          plantao_em: plantaoEm,
          sac_v2_funil_id: alvoV2?.funil_id ?? null,
          sac_v2_atendimento_id: alvoV2?.atendimento_id ?? null,
          ...(sdpType === "offer" && sdp ? { sdp_offer: sdp } : {}),
          biz_opaque: call?.biz_opaque_callback_data ?? null,
          metadata: call ?? {},
        });
        console.log(`[crm-whatsapp-webhook] chamada recebida de ${de} — alvo=${alvo ?? "plantão"}`);

        // Faz o card SUBIR e marcar não lido, como faria uma mensagem nova — só que sem
        // inserir mensagem nenhuma (ver o porquê na migration 20260903030000). Sem isto,
        // ligação que ninguém pegou no ato não deixa rastro em lugar nenhum.
        await admin.rpc("crm_chamada_marcar_no_sac", {
          p_wa_account_id: accountId,
          p_telefone: de,
          p_preview: "📞 Ligação recebida",
          p_modo: "tocando",
        }).then(({ error }: { error: unknown }) => {
          if (error) console.error("[crm-whatsapp-webhook] bump SAC falhou:", error);
        });
      } else {
        console.warn("[crm-whatsapp-webhook] calls: phone_number_id sem conta:", phoneNumberId);
        continue;
      }
      n++;
      continue;
    }

    if (!existente) {
      console.warn("[crm-whatsapp-webhook] calls: evento de chamada desconhecida", callId, evento, status);
      continue;
    }

    if (evento === "terminate") {
      const duracao = call?.duration != null ? Number(call.duration) : null;

      // Desfecho no card. "Perdida" é a informação mais valiosa das duas: é o lead que
      // procurou a PPG e não foi atendido.
      const seg = Number.isFinite(duracao as number) ? (duracao as number) : 0;
      const dur = seg > 0 ? `${Math.floor(seg / 60)}min${String(seg % 60).padStart(2, "0")}` : "";
      const preview = existente.direcao === "entrada"
        ? (seg > 0 ? `📞 Ligação recebida · ${dur}` : "📞 Ligação perdida")
        : (seg > 0 ? `📞 Ligação feita · ${dur}` : "📞 Ligação não atendida");
      await admin.rpc("crm_chamada_marcar_no_sac", {
        p_wa_account_id: existente.wa_account_id,
        p_telefone: existente.telefone,
        p_preview: preview,
        // Atendida limpa o "aguardando resposta" (conversamos); perdida deixa a pendência.
        p_modo: seg > 0 ? "atendida" : "perdida",
      }).then(({ error }: { error: unknown }) => {
        if (error) console.error("[crm-whatsapp-webhook] bump SAC (fim) falhou:", error);
      });

      await admin.from("crm_chamadas").update({
        status: upper(call?.status) === "COMPLETED" ? "completed" : "failed",
        encerrada_em: call?.end_time ? new Date(Number(call.end_time) * 1000).toISOString() : agora,
        duracao_segundos: Number.isFinite(duracao as number) ? duracao : null,
        erro_codigo: call?.error?.code ?? call?.errors?.[0]?.code ?? null,
        erro_msg: call?.error?.message ?? call?.errors?.[0]?.title ?? null,
      }).eq("id", existente.id);
      n++;
      continue;
    }

    // Status da chamada. A Meta ora manda em `status` (RINGING/ACCEPTED/REJECTED), ora
    // no próprio `event` — a primeira ligação real (03/09/2026) ficou parada em
    // "ringing" mesmo tendo sido atendida porque só o `status` era consultado aqui.
    const mapa: Record<string, string> = {
      RINGING: "ringing", ACCEPTED: "accepted", REJECTED: "rejected",
      ACCEPT: "accepted", REJECT: "rejected",
    };
    const novo = mapa[status ?? ""] ?? mapa[upper(evento)];
    if (novo) {
      await admin.from("crm_chamadas").update({
        status: novo,
        ...(novo === "accepted" ? { atendida_em: agora } : {}),
        ...(novo === "rejected" ? { encerrada_em: agora } : {}),
      }).eq("id", existente.id);
      n++;
    }
  }

  // Resposta ao pedido de permissão. A Meta ainda varia o envelope entre versões, então
  // aceitamos as duas formas que ela já usou e logamos o resto em vez de perder o evento.
  const permissoes = value?.call_permission_updates ?? value?.call_permissions ?? [];
  for (const p of permissoes) {
    const resposta = String(p?.response ?? p?.call_permission_reply?.response ?? "").toLowerCase();
    const isPermanent = p?.is_permanent ?? p?.call_permission_reply?.is_permanent ?? false;
    const expTs = p?.expiration_timestamp ?? p?.call_permission_reply?.expiration_timestamp ?? null;
    const de = String(p?.user_wa_id ?? p?.from ?? "");
    if (!de || !accountId) continue;

    await admin.from("crm_call_permissions").upsert({
      wa_account_id: accountId,
      telefone_canonico: canonicalBrPhoneWh(de),
      status: resposta === "accept" ? (isPermanent ? "permanent" : "temporary") : "no_permission",
      expira_em: expTs ? new Date(Number(expTs) * 1000).toISOString() : null,
      respondido_em: new Date().toISOString(),
      ultima_resposta: resposta === "accept" ? "accept" : "reject",
      metadata: p ?? {},
    }, { onConflict: "wa_account_id,telefone_canonico" });
    n++;
  }

  if (n === 0) {
    // Envelope que não soubemos ler é pior que erro: some sem deixar rastro.
    console.warn("[crm-whatsapp-webhook] calls: envelope não reconhecido:", JSON.stringify(value).slice(0, 1000));
  }
  return n;
}

async function processarAlertaConta(admin: any, entry: any, field: string, value: any): Promise<boolean> {
  const alerta = mapearAlerta(field, value);
  if (!alerta) return false;
  const accountId = await resolveAccountByWaba(admin, entry?.id);
  const { error } = await admin.rpc("crm_whatsapp_alerta_registrar", {
    p_wa_account_id: accountId,
    p_tipo: alerta.tipo,
    p_severidade: alerta.severidade,
    p_titulo: alerta.titulo,
    p_descricao: alerta.descricao,
    p_evento: alerta.evento,
    p_referencia: alerta.referencia,
    p_dados: value ?? {},
  });
  if (error) {
    console.error("[crm-whatsapp-webhook] registrar alerta erro:", error.message);
    return false;
  }
  return true;
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
  // Desvio por número: RH vai pro agente de RH, todo o resto segue pro João.
  const ehRh = payload?.wa_account_id === AGENTE_RH_WA_ACCOUNT_ID;
  const destino = ehRh ? AGENTE_RH_URL : N8N_INBOUND_URL;
  if (!destino) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(destino, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) console.log(`[crm-whatsapp-webhook] relay ${ehRh ? "RH" : "n8n"} respondeu ${res.status}`);
  } catch (e) {
    console.log(`[crm-whatsapp-webhook] relay ${ehRh ? "RH" : "n8n"} falhou:`, e instanceof Error ? e.message : String(e));
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

    // 1) Token GLOBAL (crm_whatsapp_config) — é o que a tela manda colar em App/BM novo.
    //    Na Meta o verify token é do APP, não do número: o wizard pede o webhook ANTES de
    //    existir o access_token permanente, ou seja, antes de dar pra cadastrar a conta
    //    aqui. Sem um token que já exista, App novo = 403 garantido.
    const { data: cfg } = await admin
      .from("crm_whatsapp_config")
      .select("webhook_verify_token")
      .maybeSingle();

    if (cfg?.webhook_verify_token && cfg.webhook_verify_token === token) {
      console.log("[crm-whatsapp-webhook] Webhook verificado pelo token global");
      return new Response(challenge, { status: 200 });
    }

    // 2) Compat: tokens POR CONTA, gerados no INSERT da conta antes de existir o global.
    //    Os apps já configurados na Meta seguem valendo sem reconfigurar nada.
    const { data: accounts } = await admin
      .from("crm_whatsapp_accounts")
      .select("id, webhook_verify_token")
      .eq("ativo", true);

    const matched = (accounts ?? []).find((a: any) => a.webhook_verify_token === token);
    if (!matched) {
      console.warn("[crm-whatsapp-webhook] verify_token não reconhecido:", token);
      return json({ error: "Token de verificação inválido" }, 403);
    }

    console.log("[crm-whatsapp-webhook] Webhook verificado pelo token da conta:", matched.id);
    return new Response(challenge, { status: 200 });
  }

  // ── POST: Eventos do Meta ──────────────────────────────────────────────────
  if (req.method !== "POST") {
    return json({ error: "Método não suportado" }, 405);
  }

  // Corpo cru: necessário para validar a assinatura HMAC sobre os bytes exatos.
  const rawBody = await req.text();
  const signature = req.headers.get("x-hub-signature-256");
  if (META_APP_SECRETS.length) {
    // Basta UM secret conferir: cada Meta App assina com o seu, e a mesma instalação
    // pode ter WABAs em apps/BMs diferentes.
    let valid = false;
    for (const secret of META_APP_SECRETS) {
      if (await validMetaSignature(rawBody, signature, secret)) { valid = true; break; }
    }
    if (!valid) {
      console.warn(
        `[crm-whatsapp-webhook] assinatura X-Hub-Signature-256 inválida — rejeitado ` +
        `(secrets configurados: ${META_APP_SECRETS.length}; se a WABA está num app novo, ` +
        `acrescente o App Secret dele em CRM_META_APP_SECRET, separado por vírgula)`,
      );
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
    let processedAlertas = 0;
    let processedChamadas = 0;
    // Inbound que NÃO conseguiu ser gravado. Com >0 devolvemos erro pra Meta reentregar —
    // silêncio aqui significa mensagem de lead perdida pra sempre.
    let falhasPersistencia = 0;

    for (const entry of entries) {
      const changes = entry?.changes ?? [];

      for (const change of changes) {
        const value = change?.value;
        if (!value) continue;

        // Ligações (Calling API). Vem ANTES do ramo de alertas porque `calls` não é
        // saúde de conta — e é o caminho por onde o SDP answer chega no softphone.
        if (change?.field === "calls") {
          try {
            processedChamadas += await processarEventoChamada(admin, value);
          } catch (e) {
            console.error("[crm-whatsapp-webhook] calls erro:", e instanceof Error ? e.message : String(e));
          }
          continue;
        }

        // Eventos de SAÚDE DA CONTA (template/conta/número) — não são mensagens.
        if (change?.field !== "messages") {
          try {
            if (await processarAlertaConta(admin, entry, change.field, value)) processedAlertas++;
          } catch (e) {
            console.error("[crm-whatsapp-webhook] alerta conta erro:", e instanceof Error ? e.message : String(e));
          }
          continue;
        }

        const phoneNumberId = value?.metadata?.phone_number_id;
        if (!phoneNumberId) continue;

        // Encontra a conta CRM pelo phone_number_id
        const { data: accountRows } = await admin
          .from("crm_whatsapp_accounts")
          .select("id, agente_ia_ativo, agente_ia_persona")
          .eq("phone_number_id", phoneNumberId)
          .eq("ativo", true)
          .limit(1);

        const accountId = accountRows?.[0]?.id;
        // Só os números marcados como "agente IA" repassam o inbound pro crm-agente-sdr.
        // Os demais (Monitor, pedagógico, etc.) são atendimento humano — a IA NÃO responde.
        const accountIaAtivo = accountRows?.[0]?.agente_ia_ativo === true;
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
          // Cartões de contato compartilhados (msg.contacts[]) — guardados crus na metadata.
          let contactCards: any[] | null = null;
          if (msgType === "text") {
            conteudo = msg?.text?.body ?? "";
          } else if (msgType === "interactive" && msg?.interactive?.type === "call_permission_reply") {
            // RESPOSTA AO PEDIDO DE PERMISSÃO DE LIGAÇÃO (Calling API). Chega como
            // mensagem inbound comum — e é bom que chegue: entra na timeline, sobe o
            // card e avisa o dono pelo notificador sem nenhum caminho novo. O que falta
            // sem este ramo é o TEXTO (virava "[interativo]") e o espelho em
            // crm_call_permissions. Formato: response accept|reject, is_permanent,
            // expiration_timestamp (unix), response_source user_action|automatic.
            const cpr = msg.interactive.call_permission_reply ?? {};
            const aceitou = String(cpr.response ?? "").toLowerCase() === "accept";
            const permanente = cpr.is_permanent === true;
            conteudo = aceitou
              ? (permanente
                ? "✅ Autorizou receber ligações da PPG (permanente)"
                : "✅ Autorizou receber ligações da PPG (7 dias)")
              : "❌ Recusou receber ligações da PPG";
            interactiveReply = {
              tipo: "call_permission_reply",
              id: aceitou ? "accept" : "reject",
              title: conteudo,
              description: cpr.expiration_timestamp
                ? new Date(Number(cpr.expiration_timestamp) * 1000).toISOString()
                : (permanente ? "permanente" : null),
            };
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
          } else if (msgType === "button") {
            // Clique num botão de TEMPLATE (quick-reply). Formato DIFERENTE do
            // "interactive" (que é botão/lista enviado por API): o texto visível
            // vem em button.text e o payload definido no template em button.payload.
            // Sem este branch o clique caía no default e virava "[button]",
            // perdendo o texto tanto no chat quanto na memória do agente (relay).
            conteudo = msg?.button?.text ?? msg?.button?.payload ?? "[button]";
            interactiveReply = {
              tipo: "template_button",
              id: msg?.button?.payload ?? null,
              title: msg?.button?.text ?? null,
              description: null,
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
          } else if (msgType === "contacts") {
            // Cartão(ões) de contato compartilhado(s). Sem este branch caía no default
            // "[contacts]" e nome/telefones eram DESCARTADOS (caso Thamires 2026-07-13) —
            // o chat mostrava "Mensagem não suportada" e o dado se perdia pra sempre.
            const cards: any[] = Array.isArray(msg?.contacts) ? msg.contacts : [];
            const linhas = cards.map((c: any) => {
              const nome =
                c?.name?.formatted_name ||
                [c?.name?.first_name, c?.name?.last_name].filter(Boolean).join(" ") ||
                "Contato";
              const fones = (Array.isArray(c?.phones) ? c.phones : [])
                .map((p: any) => p?.phone || p?.wa_id)
                .filter(Boolean)
                .join(", ");
              return fones ? `${nome} (${fones})` : nome;
            });
            conteudo = linhas.length
              ? `Contato compartilhado: ${linhas.join(" · ")}`
              : "[contacts]";
            contactCards = cards.length ? cards : null;
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

          // ── Reply/citação (WhatsApp "responder marcando a mensagem") ─────
          // A Meta manda o wamid da mensagem CITADA em msg.context.id, mas o texto do
          // lead vem só em text.body (às vezes um "." ou emoji). Sem a citação, o João
          // não sabe A QUE o lead respondeu — ele chega a dizer "não consegui visualizar
          // a marcação". Resolve o texto da mensagem citada e o embute no conteúdo, pra
          // o agente (e o atendente no chat) ENTENDEREM. Espelha no SAC pelo mirror.
          const quotedId: string | null = msg?.context?.id ?? null;
          let quotedConteudo: string | null = null;
          if (quotedId) {
            try {
              const { data: qrow } = await admin
                .from("crm_whatsapp_messages")
                .select("conteudo")
                .eq("wa_message_id", quotedId)
                .limit(1)
                .maybeSingle();
              quotedConteudo = (qrow?.conteudo ?? "").toString().trim() || null;
            } catch (_qe) { /* citação não resolvida — segue sem ela */ }
          }
          const conteudoComQuote = quotedConteudo
            ? `[Em resposta à mensagem: "${quotedConteudo}"] ${conteudo}`.trim()
            : conteudo;

          /* ── CLIQUE-PARA-WHATSAPP: o anúncio que abriu a conversa ─────────
             ⚠️ ESTE BLOCO ERA DESCARTADO. A campanha de WhatsApp não deixa UTM,
             não passa por landing page e não tem formulário: `msg.referral` é a
             ÚNICA marca de origem que ela produz. Sem guardá-lo, a campanha
             inteira ficava invisível — medido em 28/08/2026: 4 campanhas ativas
             desde 24/07, R$ 3.347,00 gastos, 993 pessoas atendidas e ZERO leads
             com campanha.

             ⚠️ Só vem na PRIMEIRA mensagem da conversa. A Meta não reenvia:
             perdeu aqui, perdeu para sempre. Por isso a gravação é no ato, e
             best-effort — falhar a atribuição NUNCA pode derrubar o inbound. */
          const adReferral = extrairReferral(msg);
          if (adReferral) {
            try {
              await admin.rpc("crm_whatsapp_referral_registrar", {
                p_telefone: (from ?? "").replace(/\D/g, ""),
                p_ad_id: adReferral.sourceId,
                p_ctwa_clid: adReferral.ctwaClid,
                p_source_type: adReferral.sourceType,
                p_source_url: adReferral.sourceUrl,
                p_headline: adReferral.headline,
                p_corpo: adReferral.body,
                p_wa_account_id: accountId,
                p_wa_message_id: msgId ?? null,
              });
            } catch (refErr) {
              console.error(
                "[crm-whatsapp-webhook] referral do anúncio não gravado:",
                (refErr as Error)?.message,
              );
            }
          }

          // Resolve a PESSOA pela régua canônica única do CRM. A Meta pode entregar o
          // wa_id de celular BR sem o 9º dígito (ex.: 554688166051), enquanto `leads`
          // guarda a forma com 9 (5546988166051). Comparar texto exato — mesmo com a
          // variante ±55 — deixava o inbound órfão e a janela de 24h parecia fechada.
          const phoneDigits = (from ?? "").replace(/\D/g, "");
          const { data: leadIdResolvido, error: leadResolveErr } = await admin.rpc(
            "crm_lead_find_by_canon",
            { p_telefone: phoneDigits },
          );
          if (leadResolveErr) {
            console.error("[crm-whatsapp-webhook] resolver lead por telefone:", leadResolveErr.message);
          }
          const leadId = typeof leadIdResolvido === "string" ? leadIdResolvido : null;

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

          // ⚠️ Hora REAL da mensagem, não a de chegada. A Meta reentrega evento rejeitado
          // (401 de App Secret, edge fora) horas ou DIAS depois; com `created_at` = agora a
          // janela de 24h (contada de quando o lead ESCREVEU) parecia aberta com a Meta já
          // recusando texto livre (131047). Caso BM 02, 03/09/2026: 89 telefones assim e 58
          // envios humanos recusados num dia. Chegada normal (< 60s) segue com o carimbo do
          // servidor; reentrega grava o relógio da Meta e guarda a chegada no metadata.
          const carimbo = carimboInbound(msg?.timestamp, Date.now());
          const { error: insertErr } = await admin.from("crm_whatsapp_messages").insert({
            wa_account_id: accountId,
            lead_id: leadId,
            oportunidade_id: oportunidadeId,
            telefone: phoneDigits,
            direcao: "inbound",
            tipo: msgType,
            conteudo: conteudoComQuote,
            anexos,
            wa_message_id: msgId,
            status_entrega: "delivered",
            created_at: carimbo.iso,
            metadata: {
              profile_name: profileName,
              original_type: msgType,
              timestamp: msg?.timestamp,
              ...(carimbo.reentrega ? { chegou_em: carimbo.chegouEm, atraso_s: carimbo.atrasoS } : {}),
              // CLIQUE-PARA-WHATSAPP: o anúncio que abriu a conversa. Guardar o
              // bloco cru aqui é o backup — a atribuição de verdade é a linha em
              // `crm_whatsapp_referral`, gravada logo abaixo.
              ...(adReferral ? { referral: adReferral } : {}),
              ...(interactiveReply ? { interactive_reply: interactiveReply } : {}),
              ...(contactCards ? { contacts: contactCards } : {}),
              ...(quotedId ? { context: { id: quotedId, conteudo: quotedConteudo } } : {}),
            },
          });

          if (insertErr) {
            // 23505 só é retry benigno da Meta se o wamid JÁ ESTIVER gravado. Tratar TODO
            // unique_violation como retry escondeu por semanas uma perda total de inbound:
            // o espelho do SAC batia em uq_sac_atend_contato_funil_linha (card arquivado),
            // a transação abortava e a gente respondia 200 dizendo "duplicada".
            // (incidente 13/08/2026 — ver docs/CRM Comercial.md)
            const code = (insertErr as { code?: string }).code ?? "";
            let retryBenigno = false;
            if (code === "23505" && msgId) {
              const { data: jaGravada } = await admin
                .from("crm_whatsapp_messages")
                .select("id")
                .eq("wa_message_id", msgId)
                .limit(1);
              retryBenigno = (jaGravada?.length ?? 0) > 0;
            }
            if (retryBenigno) {
              console.log("[crm-whatsapp-webhook] msg duplicada (retry meta), ignorada:", msgId);
            } else {
              falhasPersistencia++;
              console.error(
                `[crm-whatsapp-webhook] FALHA AO GRAVAR INBOUND de ${from} ` +
                `(wamid=${msgId}, code=${code}): ${insertErr.message}`,
              );
            }
          } else {
            processedMessages++;
            console.log(
              `[crm-whatsapp-webhook] msg inbound de ${from} (lead=${leadId ?? "?"}, op=${oportunidadeId ?? "?"}, anexos=${anexos.length}): ${conteudo.slice(0, 80)}`,
            );
            if (carimbo.reentrega && msgId) {
              // Reentrega da Meta: a mensagem entrou com a hora REAL (antiga). A denormalização
              // de `sac_conversas` tem anti-retrocesso — carimbo antigo não sobe o card nem
              // troca o preview, e está certo, ela NÃO é nova. Mas o atendente precisa vê-la:
              // marca a conversa como não lida à mão. Best-effort, nunca derruba o inbound.
              console.log(
                `[crm-whatsapp-webhook] inbound ${msgId} REENTREGUE pela Meta com ` +
                `${Math.round(carimbo.atrasoS / 60)}min de atraso — gravado com a hora real ` +
                `(${carimbo.iso}); chegada em metadata.chegou_em`,
              );
              try {
                const { data: espelho } = await admin
                  .from("sac_mensagens")
                  .select("conversa_id")
                  .eq("wa_message_id", msgId)
                  .not("conversa_id", "is", null)
                  .limit(1);
                const conversaId = espelho?.[0]?.conversa_id ?? null;
                if (conversaId) {
                  const { error: naoLidoErr } = await admin
                    .from("sac_conversas")
                    .update({ nao_lido: true })
                    .eq("id", conversaId);
                  if (naoLidoErr) console.error("[crm-whatsapp-webhook] reentrega: marcar não lida falhou:", naoLidoErr.message);
                }
              } catch (e) {
                console.error("[crm-whatsapp-webhook] reentrega: marcar não lida falhou:", (e as Error)?.message);
              }
            }

            // Espelho da permissão de ligação. A Meta continua sendo a autoridade (a tela
            // reconsulta GET /call_permissions ao abrir) — isto é o que faz o selo do card
            // e o "pode ligar" aparecerem sem esperar ninguém abrir o painel.
            if (interactiveReply?.tipo === "call_permission_reply") {
              const cpr = msg?.interactive?.call_permission_reply ?? {};
              const aceitou = interactiveReply.id === "accept";
              const permanente = cpr.is_permanent === true;
              const { error: permErr } = await admin.from("crm_call_permissions").upsert({
                wa_account_id: accountId,
                telefone_canonico: canonicalBrPhoneWh(phoneDigits),
                status: aceitou ? (permanente ? "permanent" : "temporary") : "no_permission",
                expira_em: aceitou && !permanente && cpr.expiration_timestamp
                  ? new Date(Number(cpr.expiration_timestamp) * 1000).toISOString()
                  : null,
                respondido_em: new Date().toISOString(),
                ultima_resposta: aceitou ? "accept" : "reject",
                metadata: { reply: cpr, wa_message_id: msgId },
              }, { onConflict: "wa_account_id,telefone_canonico" });
              if (permErr) console.error("[crm-whatsapp-webhook] espelho de permissão falhou:", permErr.message);
              else console.log(`[crm-whatsapp-webhook] permissão de ligação de ${from}: ${aceitou ? (permanente ? "PERMANENTE" : "7 dias") : "recusada"}`);
            }
            // Relay pro agente de IA — SÓ se este número está marcado com agente_ia_ativo.
            // (at-most-once garantido pelo índice único em wa_message_id no insert acima.)
            // Idade REAL da mensagem (relógio da Meta), não o created_at: numa
            // reentrega o created_at é "agora" e a mensagem parece nova.
            // Sem timestamp confiável trata como nova — fail-open, nunca engolir lead.
            const tsMeta = Number(msg?.timestamp);
            const idadeS = Number.isFinite(tsMeta) && tsMeta > 0
              ? Math.floor(Date.now() / 1000) - tsMeta
              : 0;
            const redelivery = idadeS > RELAY_IDADE_MAX_S;

            if (interactiveReply?.tipo === "call_permission_reply") {
              // Clique em "Permitir ligações" não é fala do lead. Repassar ao agente faria
              // o João responder a um botão de sistema com texto de venda.
              console.log(`[crm-whatsapp-webhook] resposta de permissão de ligação — relay ao agente pulado`);
            } else if (accountIaAtivo && redelivery) {
              console.warn(
                `[crm-whatsapp-webhook] inbound de ${from} tem ${Math.round(idadeS / 60)}min ` +
                `(limite ${Math.round(RELAY_IDADE_MAX_S / 60)}min) — redelivery da Meta, ` +
                `rodada do agente PULADA. A msg está gravada: aparece no SAC e entra no ` +
                `histórico da próxima rodada (wamid=${msgId})`,
              );
              // Marca como já tratada para a reconciliação não ressuscitar em 4min: ela
              // filtra por created_at (= agora, acabamos de gravar) e não enxerga a idade
              // real, então sem isto o cron desfaria esta guarda.
              if (msgId) {
                const { error: marcaErr } = await admin
                  .from("crm_agente_sdr_reconciliados")
                  .upsert(
                    {
                      wa_message_id: msgId,
                      remotejid: `${canonicalBrDigits(phoneDigits)}@s.whatsapp.net`,
                      conteudo: (`[redelivery ${Math.round(idadeS / 60)}min — rodada pulada] ` +
                        `${conteudoComQuote ?? ""}`).slice(0, 500),
                    },
                    { onConflict: "wa_message_id", ignoreDuplicates: true },
                  );
                if (marcaErr) {
                  console.error(
                    "[crm-whatsapp-webhook] falha ao marcar redelivery em reconciliados " +
                    `(cron pode reinjetar): ${marcaErr.message}`,
                  );
                }
              }
            } else if (accountIaAtivo) {
              await relayToN8n({
                remotejid: `${canonicalBrDigits(phoneDigits)}@s.whatsapp.net`,
                id: msgId,
                timestamp: Number(msg?.timestamp) || Math.floor(Date.now() / 1000),
                direcao: "inbound", // relay só dispara p/ inbound; nunca p/ as próprias saídas
                from_me: false,     // Meta Cloud API não ecoa mensagens do negócio -> sempre false
                tipo: msgType,
                // conteúdo JÁ com a citação embutida ("[Em resposta à mensagem: ...]"),
                // pro agente entender a que o lead está respondendo (reply/quote).
                conteudo: conteudoComQuote,
                quoted: quotedId ? { id: quotedId, conteudo: quotedConteudo } : null,
                caption,
                mime_type: anexos[0]?.mime_type ?? mediaInbound?.mime_type ?? null,
                anexos,
                // Clique em botão/lista: o agente (n8n) roteia pelo id/título escolhido.
                interactive_reply: interactiveReply,
                profile_name: profileName,
                telefone: phoneDigits,
                wa_account_id: accountId,
                // Persona do agente neste número: 'recontato' (no-show) | 'qualificador'.
                agente_ia_persona: accountRows?.[0]?.agente_ia_persona ?? 'qualificador',
                lead_id: leadId,
                oportunidade_id: oportunidadeId,
              });
            } else {
              console.log(`[crm-whatsapp-webhook] número ${phoneNumberId} sem agente IA — relay pulado (atendimento humano)`);
            }
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
      `[crm-whatsapp-webhook] processado: ${processedMessages} msgs, ${processedStatuses} statuses, ${processedAlertas} alertas, ${processedChamadas} chamadas`,
    );
    // Falha de persistência NUNCA responde 200: a Meta reentrega e a mensagem se salva.
    // A reentrega do que já gravou cai no "retry benigno" acima, então é idempotente.
    if (falhasPersistencia > 0) {
      return json({
        ok: false,
        erro: "falha ao persistir inbound",
        falhas: falhasPersistencia,
        messages: processedMessages,
      }, 503);
    }
    return json({ ok: true, messages: processedMessages, statuses: processedStatuses, alertas: processedAlertas, chamadas: processedChamadas });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[crm-whatsapp-webhook] erro de processamento:", msg);
    // Antes devolvíamos 200 aqui pra evitar retry da Meta — mas isso transforma qualquer
    // exceção em perda silenciosa de mensagem. Erro é erro: 500 e a Meta reentrega.
    return json({ ok: false, processed: false, erro: msg }, 500);
  }
});
