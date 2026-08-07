// crm-webchat — chat ao vivo embedado nas landing pages (GreatPages) — FASE 2
// URL: POST https://api.ppgeducacao.site/functions/v1/crm-webchat
// Chamado pelo widget public/webchat-widget.js (anônimo, CORS aberto — é página pública).
//
// Ações (body JSON { acao, ... }):
//   iniciar → { nome, telefone, pagina?, curso?, origem_url?, produto? }  cria sessão + LEAD, devolve { sessao_id }
//             produto: 'pos' (padrão, LPs de pós) | 'escola' (chat DENTRO da Escola de
//             Especialização — persona própria do João, ver escola.ts)
//   enviar  → { sessao_id, conteudo }   grava inbound + resposta do João (IA), devolve { mensagem_id }
//   poll    → { sessao_id, apos }       mensagens com id > apos (cursor do widget)
//
// FASE 2: o João (cérebro ISOLADO em agente.ts, reusa a sdr-api pra agenda/reunião —
// NÃO toca o crm-agente-sdr de WhatsApp) atende no chat, qualifica e AGENDA; e a sessão
// CRIA lead real no CRM (webchat_lead_upsert). Link do Meet fica p/ 2ª etapa.
// (Fase 1 era só um eco de recebimento — substituído.)
//
// Anti-abuso (endpoint público): rate limit de sessão por IP (20/h), de mensagem por
// sessão (15/min), conteúdo <= 2000 chars, sessão bloqueável (webchat_sessoes.bloqueada).
// Escrita nas tabelas SÓ por aqui (service role); RLS não tem policy de escrita.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { responderWebchat, aberturaWebchat } from "./agente.ts";
import { pushParaSessao } from "../_shared/webchatPush.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

const MAX_SESSOES_POR_IP_HORA = 20;
const MAX_MSGS_POR_SESSAO_MIN = 15;
const MAX_CONTEUDO = 2000;
const MAX_BODY_BYTES = 16_384;
const MAX_AUDIOS_POR_CHAT = 4; // teto de áudios por conversa (decisão diretor)
// Áudio inbound chega inline (base64) → cap próprio, maior (o de texto é DoS guard).
// ~3MB de payload ≈ ~2,2MB de áudio ≈ >1min de webm/opus — suficiente pra nota de voz.
const MAX_BODY_AUDIO = 3_000_000;

// Whisper (OpenAI) — mesma chave/modelo do crm-transcrever-audio / midia.ts (já no container).
const OPENAI_KEY = Deno.env.get("AGENTE_SDR_OPENAI_KEY") ?? Deno.env.get("OPENAI_API_KEY") ?? "";
const WHISPER_MODEL = Deno.env.get("OPENAI_TRANSCRIBE_MODEL") ?? "whisper-1";

// Chave pública VAPID do Web Push (é PÚBLICA — o popup de opt-in a busca daqui pra subscrever).
const VAPID_PUBLIC = Deno.env.get("WEBCHAT_VAPID_PUBLIC") ?? "";

// getPublicUrl dentro do container devolve o host INTERNO (http://kong:8000 / supabase-kong)
// — o navegador do lead não alcança. Troca pela URL pública (padrão do whatsapp-webhook).
const PUBLIC_SUPABASE_URL = Deno.env.get("PUBLIC_SUPABASE_URL") || "https://api.ppgeducacao.site";
function toPublicUrl(internalUrl: string): string {
  return internalUrl.replace(/^https?:\/\/(supabase-)?kong:8000/i, PUBLIC_SUPABASE_URL);
}

// Disjuntores GLOBAIS (protegem banco/custo mesmo com IPs distribuídos — botnet fura
// limite por IP). Ajustáveis por env sem mexer em código (env do Dokploy/compose).
const MAX_SESSOES_HORA_GLOBAL = Number(Deno.env.get("WEBCHAT_MAX_SESSOES_HORA_GLOBAL") ?? 300);
const MAX_MSGS_HORA_GLOBAL = Number(Deno.env.get("WEBCHAT_MAX_MSGS_HORA_GLOBAL") ?? 3000);

// Allowlist de Origin OPT-IN (CSV de origens, ex.: "https://lp1.com.br,https://lp2.com.br").
// Vazia = aberto (default). Só barra navegador (curl forja Origin) — é fricção, não muro;
// o muro são os rate limits + disjuntores.
const ALLOWED_ORIGINS = (Deno.env.get("WEBCHAT_ALLOWED_ORIGINS") ?? "")
  .split(",").map((s) => s.trim().toLowerCase().replace(/\/$/, "")).filter(Boolean);

// Cloudflare Turnstile (captcha invisível). Secret setado = exige token válido no 'iniciar'.
// Vazio = desligado (passa direto). Sitekey (público) vai no widget via data-turnstile.
const TURNSTILE_SECRET = Deno.env.get("WEBCHAT_TURNSTILE_SECRET") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function origemBloqueada(req: Request): boolean {
  if (ALLOWED_ORIGINS.length === 0) return false;
  const origem = (req.headers.get("origin") ?? "").toLowerCase().replace(/\/$/, "");
  // navegador sempre manda Origin em POST cross-origin; sem Origin (curl/server) barra também
  return !ALLOWED_ORIGINS.includes(origem);
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function texto(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, max);
}

function telefoneValido(raw: string): string | null {
  const dig = raw.replace(/\D/g, "");
  // BR: DDD+numero (10-11 dígitos), com ou sem 55 na frente
  const semPais = dig.startsWith("55") && dig.length >= 12 ? dig.slice(2) : dig;
  if (semPais.length < 10 || semPais.length > 11) return null;
  return semPais;
}

// IP do cliente SEM confiar no que o cliente manda: o PRIMEIRO valor do
// x-forwarded-for é forjável (o atacante manda o header e o proxy só APÕE o IP real).
// Estratégia: varre da DIREITA (o que os NOSSOS proxies apuseram) e pega o primeiro
// IP público — furando XFF forjado à esquerda e IPs internos (Traefik/Kong) à direita.
const IP_PRIVADO_RE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:)/i;

function ipDe(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const partes = (req.headers.get("x-forwarded-for") ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  for (let i = partes.length - 1; i >= 0; i--) {
    if (!IP_PRIVADO_RE.test(partes[i])) return partes[i];
  }
  return partes[partes.length - 1] || "desconhecido";
}

// Verifica o token do Turnstile na siteverify da Cloudflare. Fail-CLOSED em token
// inválido/ausente; fail-OPEN só se a PRÓPRIA siteverify cair (rede) — pra um soluço da
// Cloudflare não zerar a captação de leads (rate limit + disjuntores seguem protegendo).
async function turnstileOk(token: string, ip: string): Promise<boolean> {
  if (!TURNSTILE_SECRET) return true; // captcha desligado
  if (!token) return false;
  try {
    const form = new URLSearchParams({ secret: TURNSTILE_SECRET, response: token });
    if (ip && ip !== "desconhecido") form.set("remoteip", ip);
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const data = await res.json().catch(() => ({}));
    return data?.success === true;
  } catch (e) {
    console.error(`[crm-webchat] turnstile siteverify caiu: ${(e as Error).message}`);
    return true; // fail-open só no erro de REDE da verificação
  }
}

// ── áudio (Whisper) ────────────────────────────────────────────────────────────
function b64ToBytes(b64: string): Uint8Array {
  const limpo = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64; // tira "data:...;base64,"
  const bin = atob(limpo);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Espelho do extDoMime do crm-transcrever-audio/midia.ts (Whisper exige nome com extensão).
function extDoMime(mime: string): string {
  const m = (mime || "").toLowerCase();
  if (m.includes("ogg") || m.includes("opus")) return "ogg";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("wav")) return "wav";
  if (m.includes("webm")) return "webm";
  return "webm";
}

// Transcreve via OpenAI Whisper (mesmo endpoint/modelo do crm-transcrever-audio). Best-effort:
// falha → "" (a mensagem entra como "[áudio]" e o João segue conduzindo).
async function transcreverWhisper(bytes: Uint8Array, mime: string): Promise<string> {
  if (!OPENAI_KEY) return "";
  try {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mime }), `audio.${extDoMime(mime)}`);
    form.append("model", WHISPER_MODEL);
    form.append("language", "pt");
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_KEY}` },
      body: form,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[crm-webchat] whisper HTTP ${res.status}: ${j?.error?.message ?? "falha"}`);
      return "";
    }
    return String(j?.text ?? "").trim();
  } catch (e) {
    console.error(`[crm-webchat] whisper: ${(e as Error).message}`);
    return "";
  }
}

// Rate limit de inbound (por sessão/min + disjuntor global/hora) — compartilhado por
// 'enviar' e 'audio'. Retorna a Response de erro OU null (ok).
async function checarLimitesInbound(sessaoId: string): Promise<Response | null> {
  const umMinAtras = new Date(Date.now() - 60_000).toISOString();
  const { count } = await supabase
    .from("webchat_mensagens")
    .select("id", { count: "exact", head: true })
    .eq("sessao_id", sessaoId).eq("direcao", "inbound").gte("criado_em", umMinAtras);
  if ((count ?? 0) >= MAX_MSGS_POR_SESSAO_MIN) return json({ ok: false, erro: "limite_mensagens" }, 429);

  const umaHoraAtras = new Date(Date.now() - 3600_000).toISOString();
  const { count: totalHora } = await supabase
    .from("webchat_mensagens")
    .select("id", { count: "exact", head: true })
    .eq("direcao", "inbound").gte("criado_em", umaHoraAtras);
  if ((totalHora ?? 0) >= MAX_MSGS_HORA_GLOBAL) {
    console.error(`[crm-webchat] DISJUNTOR msgs/hora atingido (${totalHora})`);
    return json({ ok: false, erro: "ocupado" }, 429);
  }
  return null;
}

// Gera a resposta do João e grava UM balão por chunk (+ espelho SAC). Compartilhado por
// 'enviar' e 'audio'. O pacing temporal ("digitando" entre balões) é do widget.
async function responderComoJoao(
  sessao: NonNullable<Awaited<ReturnType<typeof carregarSessao>>>,
  sessaoId: string,
): Promise<void> {
  try {
    const { data: hist } = await supabase
      .from("webchat_mensagens")
      .select("direcao, conteudo")
      .eq("sessao_id", sessaoId)
      .order("id", { ascending: true })
      .limit(40);
    const history = (hist ?? []).map((m: any) => ({
      role: (m.direcao === "inbound" ? "user" : "assistant") as "user" | "assistant",
      text: String(m.conteudo ?? ""),
    })).filter((m) => m.text);

    const { chunks, estagio } = await responderWebchat(
      sessao.nome ?? "",
      sessao.telefone ?? "",
      sessao.curso ?? null,
      history,
      sessao.estagio === "qualificador" ? "qualificador" : "validacao",
      sessao.lead_id ?? null,
      sessao.produto === "escola" ? "escola" : "pos",
    );
    // ratchet: promoção validação→qualificador é persistida (nunca regride)
    if (estagio === "qualificador" && sessao.estagio !== "qualificador") {
      await supabase.from("webchat_sessoes").update({ estagio: "qualificador" }).eq("id", sessaoId);
    }
    // um balão por chunk (o widget mostra "digitando" entre eles)
    for (const chunk of chunks) {
      await supabase.from("webchat_mensagens").insert({
        sessao_id: sessaoId, direcao: "outbound", origem: "ia", conteudo: chunk,
      });
      await syncSac(sessaoId, "outbound", "ia", chunk);
    }

    // NOVA MENSAGEM em SEGUNDO PLANO → push imediato no navegador (com som do sistema).
    // Dispara quando a aba está OCULTA (widget avisa via acao 'presenca') OU quando o
    // sinal de presença é velho (>2min = navegador fechado sem o pagehide chegar).
    // Best-effort: sem subscription/lib, simplesmente não notifica (o cutucão de 20min
    // do cron segue como rede de segurança).
    try {
      const { data: pres } = await supabase
        .from("webchat_sessoes")
        .select("chat_visivel, presenca_em, origem_url, nome")
        .eq("id", sessaoId)
        .maybeSingle();
      const presencaVelha = !pres?.presenca_em ||
        (Date.now() - new Date(pres.presenca_em).getTime()) > 120_000;
      if (pres && (pres.chat_visivel === false || presencaVelha)) {
        const primeiro = (pres.nome ?? "").trim().split(/\s+/)[0];
        await pushParaSessao(supabase, sessaoId, {
          title: "💬 João te respondeu",
          body: `${primeiro ? primeiro + ", a" : "A"} resposta chegou — volte pra conversa quando puder.`,
          url: pres.origem_url || "/",
          tag: "ppgwc-nova-mensagem",
        });
      }
    } catch (e) {
      console.error(`[crm-webchat] push nova mensagem: ${(e as Error).message}`);
    }
  } catch (e) {
    console.error(`[crm-webchat] cerebro: ${(e as Error).message}`);
    const fb = "Tive uma instabilidade aqui, mas já já te respondo. 🙏";
    await supabase.from("webchat_mensagens").insert({
      sessao_id: sessaoId, direcao: "outbound", origem: "sistema", conteudo: fb,
    });
    await syncSac(sessaoId, "outbound", "sistema", fb);
  }
}

// ── ações ────────────────────────────────────────────────────────────────────

async function acaoIniciar(body: Record<string, unknown>, req: Request) {
  const nome = texto(body.nome, 80);
  const telefone = telefoneValido(texto(body.telefone, 30));
  if (nome.length < 2) return json({ ok: false, erro: "nome_invalido" }, 400);
  if (!telefone) return json({ ok: false, erro: "telefone_invalido" }, 400);

  const ip = ipDe(req);

  // captcha invisível (Turnstile) — só quando WEBCHAT_TURNSTILE_SECRET está setado
  if (!(await turnstileOk(texto(body.turnstile_token, 5000), ip))) {
    return json({ ok: false, erro: "captcha_falhou" }, 403);
  }

  const umaHoraAtras = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await supabase
    .from("webchat_sessoes")
    .select("id", { count: "exact", head: true })
    .eq("ip", ip)
    .gte("criado_em", umaHoraAtras);
  if ((count ?? 0) >= MAX_SESSOES_POR_IP_HORA) {
    return json({ ok: false, erro: "limite_sessoes" }, 429);
  }

  // disjuntor global (botnet com IPs distribuídos fura o limite por IP)
  const { count: totalHora } = await supabase
    .from("webchat_sessoes")
    .select("id", { count: "exact", head: true })
    .gte("criado_em", umaHoraAtras);
  if ((totalHora ?? 0) >= MAX_SESSOES_HORA_GLOBAL) {
    console.error(`[crm-webchat] DISJUNTOR sessões/hora atingido (${totalHora})`);
    return json({ ok: false, erro: "ocupado" }, 429);
  }

  // Produto da sessão: 'escola' (chat DENTRO da Escola de Especialização, persona própria)
  // ou 'pos' (LPs de pós-graduação, comportamento de sempre). Valor desconhecido → 'pos'.
  const produto = texto(body.produto, 20).toLowerCase() === "escola" ? "escola" : "pos";

  const { data, error } = await supabase
    .from("webchat_sessoes")
    .insert({
      nome,
      telefone,
      produto,
      pagina: texto(body.pagina, 200) || null,
      curso: texto(body.curso, 120) || null,
      origem_url: texto(body.origem_url, 500) || null,
      ip,
      user_agent: texto(req.headers.get("user-agent"), 300) || null,
    })
    .select("id")
    .single();
  if (error) {
    console.error(`[crm-webchat] iniciar: ${error.message}`);
    return json({ ok: false, erro: "erro_interno" }, 500);
  }

  // Fase 2: cria/vincula o LEAD real no CRM (find-or-create por telefone canônico).
  // Best-effort — falha aqui não impede o chat de abrir.
  try {
    const { data: leadId } = await supabase.rpc("webchat_lead_upsert", {
      p_nome: nome,
      p_telefone: telefone,
      p_pagina: texto(body.pagina, 200) || null,
      p_curso: texto(body.curso, 120) || null,
    });
    if (leadId) {
      await supabase.from("webchat_sessoes").update({ lead_id: leadId }).eq("id", data.id);
    }
  } catch (e) {
    console.error(`[crm-webchat] lead_upsert: ${(e as Error).message}`);
  }

  // Abertura PROATIVA do João (já puxa conversa com uma pergunta, referenciando o curso
  // da LP) — em vez de um "oi" genérico. Síncrona: quando o iniciar retorna, já está na
  // thread e o 1º poll do widget a exibe. Vem FRACIONADA em balões (o widget espaça).
  let chunks: string[] = [`Oi, ${nome.split(" ")[0]}! 👋 Que bom te ver por aqui. Me conta: qual pós ou área você tem em mente?`];
  try {
    chunks = await aberturaWebchat(nome, texto(body.curso, 120) || null, produto);
  } catch (e) {
    console.error(`[crm-webchat] abertura: ${(e as Error).message}`);
  }
  for (const chunk of chunks) {
    await supabase.from("webchat_mensagens").insert({
      sessao_id: data.id, direcao: "outbound", origem: "ia", conteudo: chunk,
    });
    await syncSac(data.id, "outbound", "ia", chunk);
  }

  return json({ ok: true, sessao_id: data.id });
}

async function carregarSessao(sessaoId: string) {
  const { data } = await supabase
    .from("webchat_sessoes")
    .select("id, bloqueada, nome, telefone, curso, produto, estagio, lead_id, chat_visivel, presenca_em, origem_url, atendimento_humano")
    .eq("id", sessaoId)
    .maybeSingle();
  return data as { id: string; bloqueada: boolean; nome: string | null; telefone: string | null; curso: string | null; produto: string | null; estagio: "validacao" | "qualificador" | null; lead_id: string | null; chat_visivel: boolean | null; presenca_em: string | null; origem_url: string | null; atendimento_humano: boolean | null } | null;
}

// Espelha a mensagem no SAC (funil "Webchat") — a conversa aparece no Contato 360 /
// atendimentos do lead. Best-effort: falha aqui NÃO derruba o chat.
async function syncSac(sessaoId: string, direcao: string, origem: string, conteudo: string, anexos: unknown[] = []): Promise<void> {
  try {
    await supabase.rpc("webchat_sac_sync", {
      p_sessao_id: sessaoId, p_direcao: direcao, p_origem: origem, p_conteudo: conteudo, p_anexos: anexos,
    });
  } catch (e) {
    console.error(`[crm-webchat] sac_sync: ${(e as Error).message}`);
  }
}

async function acaoEnviar(body: Record<string, unknown>) {
  const sessaoId = texto(body.sessao_id, 40);
  const conteudo = texto(body.conteudo, MAX_CONTEUDO);
  if (!UUID_RE.test(sessaoId)) return json({ ok: false, erro: "sessao_invalida" }, 400);
  if (!conteudo) return json({ ok: false, erro: "mensagem_vazia" }, 400);

  const sessao = await carregarSessao(sessaoId);
  if (!sessao) return json({ ok: false, erro: "sessao_nao_encontrada" }, 404);
  if (sessao.bloqueada) return json({ ok: false, erro: "sessao_bloqueada" }, 403);

  const limite = await checarLimitesInbound(sessaoId);
  if (limite) return limite;

  const { data: msg, error } = await supabase
    .from("webchat_mensagens")
    .insert({ sessao_id: sessaoId, direcao: "inbound", origem: "lead", conteudo })
    .select("id")
    .single();
  if (error) {
    console.error(`[crm-webchat] enviar: ${error.message}`);
    return json({ ok: false, erro: "erro_interno" }, 500);
  }
  await syncSac(sessaoId, "inbound", "lead", conteudo);

  await supabase
    .from("webchat_sessoes")
    .update({ ultima_atividade: new Date().toISOString() })
    .eq("id", sessaoId);

  // A resposta do João roda numa 2ª requisição (acao 'responder') — Whisper/LLM pesados numa
  // requisição só estouravam o limite de CPU do edge. O widget chama 'responder' na sequência.
  return json({ ok: true, mensagem_id: msg.id });
}

// Roda o cérebro do João (1 balão por chunk). Separado de 'enviar'/'audio' p/ caber no limite
// de CPU/wall-clock do edge. Só responde se a última mensagem for do lead (anti-spam do LLM).
async function acaoResponder(body: Record<string, unknown>) {
  const sessaoId = texto(body.sessao_id, 40);
  if (!UUID_RE.test(sessaoId)) return json({ ok: false, erro: "sessao_invalida" }, 400);
  const sessao = await carregarSessao(sessaoId);
  if (!sessao) return json({ ok: false, erro: "sessao_nao_encontrada" }, 404);
  if (sessao.bloqueada) return json({ ok: false, erro: "sessao_bloqueada" }, 403);

  /*
    Um atendente assumiu a conversa pelo SAC 2.0 (`sac_v2_webchat_enviar` marca
    `atendimento_humano`): o João CALA até alguém devolver a conversa a ele. Sem isso,
    a resposta do humano e a do agente sairiam intercaladas no mesmo chat.
  */
  if (sessao.atendimento_humano) return json({ ok: true, skip: "atendimento_humano" });

  const { data: ult } = await supabase
    .from("webchat_mensagens")
    .select("direcao")
    .eq("sessao_id", sessaoId)
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!ult || (ult as any).direcao !== "inbound") return json({ ok: true, skip: "sem_pendencia" });

  await responderComoJoao(sessao, sessaoId);
  return json({ ok: true });
}

// Áudio do lead: base64 → Storage (whatsapp-anexos/webchat) → Whisper → vira a mensagem
// inbound (conteudo=transcrição, anexos=[áudio]) → o João responde ao que foi falado.
async function acaoAudio(body: Record<string, unknown>, req: Request) {
  const sessaoId = texto(body.sessao_id, 40);
  if (!UUID_RE.test(sessaoId)) return json({ ok: false, erro: "sessao_invalida" }, 400);
  const b64 = typeof body.audio_base64 === "string" ? body.audio_base64 : "";
  if (!b64) return json({ ok: false, erro: "audio_vazio" }, 400);
  const mime = texto(body.mime, 60) || "audio/webm";

  const sessao = await carregarSessao(sessaoId);
  if (!sessao) return json({ ok: false, erro: "sessao_nao_encontrada" }, 404);
  if (sessao.bloqueada) return json({ ok: false, erro: "sessao_bloqueada" }, 403);

  const limite = await checarLimitesInbound(sessaoId);
  if (limite) return limite;

  // teto de áudios POR CHAT (conta mensagens do lead que TÊM anexo — 1 áudio = 1 anexo)
  const { count: audiosCt } = await supabase
    .from("webchat_mensagens")
    .select("id", { count: "exact", head: true })
    .eq("sessao_id", sessaoId)
    .eq("direcao", "inbound")
    .not("anexos->0", "is", null);
  if ((audiosCt ?? 0) >= MAX_AUDIOS_POR_CHAT) return json({ ok: false, erro: "limite_audios" }, 429);

  let bytes: Uint8Array;
  try {
    bytes = b64ToBytes(b64);
  } catch {
    return json({ ok: false, erro: "audio_invalido" }, 400);
  }
  if (!bytes.length) return json({ ok: false, erro: "audio_vazio" }, 400);

  // sobe pro Storage (mesmo bucket público do WhatsApp; pasta webchat/)
  let url: string | null = null;
  try {
    const ext = extDoMime(mime);
    const path = `webchat/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${ext}`;
    const { error: stErr } = await supabase.storage.from("whatsapp-anexos").upload(path, bytes, { contentType: mime, upsert: false });
    if (stErr) console.error(`[crm-webchat] storage upload: ${stErr.message}`);
    else url = toPublicUrl(supabase.storage.from("whatsapp-anexos").getPublicUrl(path).data.publicUrl);
  } catch (e) {
    console.error(`[crm-webchat] storage: ${(e as Error).message}`);
  }

  // transcreve (Whisper); vazio → "[áudio]" (a conversa segue mesmo sem transcrição)
  const transcricao = await transcreverWhisper(bytes, mime);
  const conteudo = transcricao || "[áudio]";
  const anexos = url ? [{ tipo: "audio", mime_type: mime, url, url_storage: url }] : [];

  const { data: msg, error } = await supabase
    .from("webchat_mensagens")
    .insert({ sessao_id: sessaoId, direcao: "inbound", origem: "lead", conteudo, anexos, transcricao: transcricao || null })
    .select("id")
    .single();
  if (error) {
    console.error(`[crm-webchat] audio insert: ${error.message}`);
    return json({ ok: false, erro: "erro_interno" }, 500);
  }
  await syncSac(sessaoId, "inbound", "lead", conteudo, anexos);

  await supabase
    .from("webchat_sessoes")
    .update({ ultima_atividade: new Date().toISOString() })
    .eq("id", sessaoId);

  // resposta do João vem na 2ª requisição ('responder') — ver acaoEnviar/acaoResponder.
  return json({ ok: true, mensagem_id: msg.id, transcricao });
}

// Telemetria do opt-in de push (página /webchat-push reporta cada etapa) — diagnóstico
// de falha silenciosa de subscribe no navegador do lead. Append em webchat_sessoes.push_log.
async function acaoPushLog(body: Record<string, unknown>) {
  const sessaoId = texto(body.sessao_id, 40);
  if (!UUID_RE.test(sessaoId)) return json({ ok: false, erro: "sessao_invalida" }, 400);
  const etapa = texto(body.etapa, 200);
  if (!etapa) return json({ ok: false, erro: "etapa_vazia" }, 400);
  try {
    const { data } = await supabase.from("webchat_sessoes").select("push_log").eq("id", sessaoId).maybeSingle();
    const log = Array.isArray((data as any)?.push_log) ? (data as any).push_log : [];
    log.push({ t: new Date().toISOString(), etapa });
    await supabase.from("webchat_sessoes").update({ push_log: log.slice(-40) }).eq("id", sessaoId);
  } catch (e) {
    console.error(`[crm-webchat] push_log: ${(e as Error).message}`);
  }
  return json({ ok: true });
}

// Presença da aba do lead (visibilitychange/pagehide do widget, via sendBeacon).
// Governa o push imediato de "nova mensagem" (só notifica quem está em segundo plano).
async function acaoPresenca(body: Record<string, unknown>) {
  const sessaoId = texto(body.sessao_id, 40);
  if (!UUID_RE.test(sessaoId)) return json({ ok: false, erro: "sessao_invalida" }, 400);
  const visivel = body.visivel === true;
  await supabase
    .from("webchat_sessoes")
    .update({ chat_visivel: visivel, presenca_em: new Date().toISOString() })
    .eq("id", sessaoId);
  return json({ ok: true });
}

// Grava a subscription de Web Push do navegador do lead (opt-in vindo do popup na nossa
// origem). endpoint é UNIQUE → upsert (renova as chaves se o navegador re-subscrever).
async function acaoPushSubscribe(body: Record<string, unknown>, req: Request) {
  const sessaoId = texto(body.sessao_id, 40);
  if (!UUID_RE.test(sessaoId)) return json({ ok: false, erro: "sessao_invalida" }, 400);
  const sub = (body.subscription ?? {}) as any;
  const endpoint = texto(sub.endpoint, 1000);
  const p256dh = texto(sub?.keys?.p256dh, 300);
  const auth = texto(sub?.keys?.auth, 300);
  if (!endpoint || !p256dh || !auth) return json({ ok: false, erro: "subscription_invalida" }, 400);

  const sessao = await carregarSessao(sessaoId);
  if (!sessao) return json({ ok: false, erro: "sessao_nao_encontrada" }, 404);

  const { error } = await supabase
    .from("webchat_push_subscriptions")
    .upsert({
      sessao_id: sessaoId, endpoint, p256dh, auth,
      user_agent: texto(req.headers.get("user-agent"), 300) || null,
    }, { onConflict: "endpoint" });
  if (error) {
    console.error(`[crm-webchat] push_subscribe: ${error.message}`);
    return json({ ok: false, erro: "erro_interno" }, 500);
  }
  return json({ ok: true });
}

async function acaoPoll(body: Record<string, unknown>) {
  const sessaoId = texto(body.sessao_id, 40);
  if (!UUID_RE.test(sessaoId)) return json({ ok: false, erro: "sessao_invalida" }, 400);
  const apos = Number(body.apos ?? 0);
  const cursor = Number.isFinite(apos) && apos > 0 ? Math.floor(apos) : 0;

  const sessao = await carregarSessao(sessaoId);
  if (!sessao) return json({ ok: false, erro: "sessao_nao_encontrada" }, 404);

  // heartbeat de presença: poll rodando = página aberta (aba oculta segue pollando
  // throttled, mas o chat_visivel=false do 'presenca' é quem governa o push nesse caso).
  // NÃO toca chat_visivel aqui — senão o poll de aba oculta apagaria o sinal.
  supabase.from("webchat_sessoes").update({ presenca_em: new Date().toISOString() }).eq("id", sessaoId)
    .then(() => {}, () => {});

  const { data, error } = await supabase
    .from("webchat_mensagens")
    .select("id, direcao, origem, conteudo, anexos, criado_em")
    .eq("sessao_id", sessaoId)
    .gt("id", cursor)
    .order("id", { ascending: true })
    .limit(100);
  if (error) {
    console.error(`[crm-webchat] poll: ${error.message}`);
    return json({ ok: false, erro: "erro_interno" }, 500);
  }

  return json({ ok: true, mensagens: data ?? [] });
}

// ── entrada ──────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, erro: "metodo" }, 405);
  if (origemBloqueada(req)) return json({ ok: false, erro: "origem_nao_permitida" }, 403);

  let body: Record<string, unknown>;
  try {
    const cru = await req.text();
    // Teto duro (áudio inline base64); depois de parsear, só a ação 'audio' pode passar
    // do cap de texto — as demais ficam no limite pequeno (anti-DoS).
    if (cru.length > MAX_BODY_AUDIO) return json({ ok: false, erro: "payload_grande" }, 413);
    body = JSON.parse(cru);
    if (body.acao !== "audio" && cru.length > MAX_BODY_BYTES) {
      return json({ ok: false, erro: "payload_grande" }, 413);
    }
  } catch {
    return json({ ok: false, erro: "json_invalido" }, 400);
  }

  try {
    switch (body.acao) {
      case "iniciar":
        return await acaoIniciar(body, req);
      case "enviar":
        return await acaoEnviar(body);
      case "audio":
        return await acaoAudio(body, req);
      case "responder":
        return await acaoResponder(body);
      case "poll":
        return await acaoPoll(body);
      case "push_vapid":
        return json({ ok: true, chave: VAPID_PUBLIC });
      case "push_subscribe":
        return await acaoPushSubscribe(body, req);
      case "presenca":
        return await acaoPresenca(body);
      case "push_log":
        return await acaoPushLog(body);
      default:
        return json({ ok: false, erro: "acao_invalida" }, 400);
    }
  } catch (e) {
    console.error(`[crm-webchat] erro: ${(e as Error).message}`);
    return json({ ok: false, erro: "erro_interno" }, 500);
  }
});
