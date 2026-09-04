// crm-webchat — chat ao vivo embedado nas landing pages (GreatPages) — FASE 2
// URL: POST https://api.ppgeducacao.site/functions/v1/crm-webchat
// Chamado pelo widget public/webchat-widget.js (anônimo, CORS aberto — é página pública).
//
// Ações (body JSON { acao, ... }):
//   iniciar → { nome, telefone, pagina?, curso?, origem_url?, produto? }  cria sessão + LEAD, devolve { sessao_id }
//             produto: 'pos' (padrão, LPs de pós) | 'escola' (chat DENTRO da Escola de
//             Especialização — persona própria do João, ver escola.ts)
//   enviar  → { sessao_id, conteudo }   grava inbound + resposta do João (IA), devolve { mensagem_id }
//   teste_* → mesmas etapas do chat, restritas a admin/diretor e sem efeitos externos
//   poll    → { sessao_id, apos }       mensagens com id > apos (cursor do widget)
//   push_status → { sessao_id }        a sessão já tem Web Push ativo? (a LP não sabe:
//                                      a permissão foi dada no popup, em OUTRA origem)
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
import { processarRodadaWebchat } from "./rodada.ts";
import { semearHistoricoWhatsApp } from "./continuidade.ts";
// A ponte pro WhatsApp tem DUAS origens (a tool do João e o botão do atendente) e uma
// idempotência só. O template e a conta vêm do agente pra não divergirem entre as duas.
import { WEBCHAT_TEMPLATE_CONTINUIDADE, WEBCHAT_WA_ACCOUNT_ID, WHATSAPP_REENVIO_COOLDOWN_MIN } from "./agente.ts";
import { fraseConviteWhatsapp } from "./frases.ts";
import { pushParaSessao } from "../_shared/webchatPush.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

const MAX_SESSOES_POR_IP_HORA = 20;
// Teto por TELEFONE (não só IP): fecha o alvejamento de uma vítima via IPs rotativos —
// cada sessão dela com ≥1 inbound vira um cutucão de WhatsApp (cron webchat-reengajar).
// Uso legítimo cria ~1/dia (o widget reusa a sessão no localStorage); 5 é folgado.
const MAX_SESSOES_POR_TELEFONE_DIA = Number(Deno.env.get("WEBCHAT_MAX_SESSOES_TELEFONE_DIA") ?? 5);
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

/** Autorização explícita: a function é pública para o widget, então verify_jwt=false. */
async function usuarioGestao(req: Request): Promise<string | null> {
  const cabecalho = req.headers.get("authorization") ?? "";
  const token = cabecalho.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) return null;
  const { data: auth, error: authError } = await supabase.auth.getUser(token);
  if (authError || !auth.user?.id) return null;
  const { data: permitido, error } = await supabase.rpc("has_admin_permission", {
    _user_id: auth.user.id,
  });
  if (error || permitido !== true) return null;
  return auth.user.id;
}

function telefoneSeguroDeTeste(id: string): string {
  // Nunca é usado em saída externa; ainda assim mantém 11 dígitos para o agente receber
  // o mesmo formato do canal real. O prefixo 000 também deixa a natureza sintética óbvia.
  const cauda = id.replace(/-/g, "").slice(0, 8)
    .split("").map((c) => String(Number.parseInt(c, 16) % 10)).join("");
  return `000${cauda}`;
}

function nomeContatoTeste(cenario: string, execucaoId: string): string {
  return `[TESTE IA] ${cenario} · ${execucaoId.slice(0, 8)}`.slice(0, 120);
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

// Detecta o tipo de áudio pelos BYTES MÁGICOS (assinatura), ignorando o MIME que o cliente
// alega. O upload de áudio é anônimo e vai pra um bucket PÚBLICO — sem isto, um atacante
// mandava base64 de HTML/SVG com mime "audio/webm" e ganhava uma URL de conteúdo arbitrário
// hospedada no domínio da PPG (phishing com cara de origem confiável). Aqui só passa o que
// realmente tem cara de áudio; o tipo devolvido é o DETECTADO, nunca o do cliente.
// Retorna o mime canônico, ou null quando não reconhece um container de áudio.
function detectarMimeAudio(b: Uint8Array): string | null {
  if (b.length < 12) return null;
  const u32 = (i: number) => (b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3];
  const ascii = (i: number, n: number) => String.fromCharCode(...b.slice(i, i + n));
  // OGG (Opus/Vorbis) — "OggS"
  if (ascii(0, 4) === "OggS") return "audio/ogg";
  // WebM / Matroska (EBML) — 1A 45 DF A3
  if (u32(0) === 0x1a45dfa3) return "audio/webm";
  // WAV — "RIFF"...."WAVE"
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return "audio/wav";
  // MP4 / M4A — "ftyp" no offset 4 (box size ocupa 0..4)
  if (ascii(4, 4) === "ftyp") return "audio/mp4";
  // AMR — "#!AMR"
  if (ascii(0, 5) === "#!AMR") return "audio/amr";
  // MP3 — "ID3" (tag) ou frame sync 0xFFEx (MPEG audio / ADTS-AAC)
  if (ascii(0, 3) === "ID3") return "audio/mpeg";
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return "audio/mpeg";
  return null;
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
) {
  const rodada = await processarRodadaWebchat(supabase, sessaoId, sessao, responderWebchat);
  if (rodada.erro) console.error(`[crm-webchat] cerebro: ${rodada.erro}`);

  // A tool registra o EFEITO confirmado, não uma tentativa nem uma frase do modelo.
  // Mesmo que um humano assuma durante a geração, o envio que já ocorreu é real.
  for (const tool of rodada.tools) {
    if (tool.mockado || !tool.efeito_whatsapp) continue;
    try {
      await semearHistoricoWhatsApp(supabase, sessaoId, tool.efeito_whatsapp);
    } catch (e) {
      console.error("[crm-webchat] continuidade WhatsApp:", e instanceof Error ? e.message : String(e));
    }
  }
  if (rodada.status !== "publicado") return rodada;

  // Só espelha/notifica balões que passaram pelo commit e pelo gate de humano.
  for (const mensagem of rodada.mensagens ?? []) {
    await syncSac(sessaoId, "outbound", rodada.erro ? "sistema" : "ia", mensagem.conteudo);
  }
  if (!sessao.modo_teste && rodada.mensagens?.length) {
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
  }
  return rodada;
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

  // Anti-abuso por NÚMERO: limita quantas sessões um mesmo telefone canônico abre por dia,
  // pra que rotação de IP não permita alvejar a vítima repetidamente (cada sessão com
  // inbound = 1 possível cutucão de WhatsApp pra ela). Fail-open: erro no throttle não
  // derruba chat legítimo, e o atacante não tem como forçar o erro (é um count simples);
  // o limite por IP + disjuntor global seguem valendo por baixo.
  try {
    const { data: ctTel } = await supabase.rpc("webchat_sessoes_por_telefone", {
      p_telefone: telefone,
      p_horas: 24,
    });
    if ((ctTel ?? 0) >= MAX_SESSOES_POR_TELEFONE_DIA) {
      return json({ ok: false, erro: "limite_sessoes" }, 429);
    }
  } catch (e) {
    console.error(`[crm-webchat] throttle telefone: ${(e as Error).message}`);
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
      // CONSENTIMENTO (LGPD art. 8º §2: o ônus de provar é do controlador).
      // Guardamos o TEXTO que o visitante leu, não um booleano: a redação muda com o
      // tempo e "aceitou=true" não diz a QUE ele aceitou. Widget antigo não manda nada
      // e a sessão fica com os campos nulos, que é a leitura honesta de "sem registro".
      consentimento_texto: texto(body.consentimento_texto, 600) || null,
      consentimento_versao: texto(body.consentimento_versao, 20) || null,
      consentimento_em: texto(body.consentimento_texto, 600) ? new Date().toISOString() : null,
      consentimento_ip: texto(body.consentimento_texto, 600) ? ip : null,
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
  // FLUXO DE BOTÕES (2026-08-19): sem curso na página (home das pós), a conversa NÃO
  // abre com IA. O visitante escolhe área → pós nos botões do widget, e a fala de
  // abertura é a mensagem PRONTA de 'escolher_pos' — determinística e sem custo de
  // modelo. A abertura por IA segue valendo quando a LP informa o curso e na Escola.
  if (produto === "pos" && !texto(body.curso, 120)) {
    return json({ ok: true, sessao_id: data.id, escolher_pos: true });
  }

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
    .select("id, bloqueada, nome, telefone, curso, pagina, produto, estagio, lead_id, chat_visivel, presenca_em, origem_url, atendimento_humano, modo_teste, teste_execucao_id, teste_cenario, teste_tool_chamadas")
    .eq("id", sessaoId)
    .maybeSingle();
  return data as {
    id: string; bloqueada: boolean; nome: string | null; telefone: string | null;
    curso: string | null; pagina: string | null; produto: string | null; estagio: "validacao" | "qualificador" | null;
    lead_id: string | null; chat_visivel: boolean | null; presenca_em: string | null;
    origem_url: string | null; atendimento_humano: boolean | null; modo_teste: boolean;
    teste_execucao_id: string | null; teste_cenario: string | null; teste_tool_chamadas: unknown[];
  } | null;
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

// ── escolher_pos: o visitante tocou na pós nos botões ────────────────────────
// Grava a pós na sessão e escreve a MENSAGEM PRONTA do João. Ela NÃO vem do modelo, mas
// entra no histórico como fala dele (e no espelho do SAC) por dois motivos: o visitante
// precisa vê-la ao recarregar a página, e a IA precisa saber o que já foi dito — senão
// ela cumprimenta de novo e repergunta a graduação.
// A sessão já vai pra 'qualificador': a graduação está sendo perguntada AGORA, e a etapa
// de validação existe justamente pro caso oposto (descobrir o interesse primeiro).

// -- Captacao: manda o lead pro webhook do CRM -------------------------------
// Quem decide funil, etapa e segmento e a INTEGRACAO (configurada na tela), nao este
// codigo e muito menos o agente. Aqui a gente so entrega os dados no momento em que os
// tres campos que importam ficam completos: nome, telefone e curso.
//
// O segredo NAO fica no codigo: lemos da propria integracao (service_role), entao
// rotacionar o secret na tela nao quebra nada aqui.
//
// Best-effort: falha aqui NUNCA derruba a conversa. O visitante ja tem lead pelo
// webchat_lead_upsert; sem o webhook ele fica sem oportunidade, o que e ruim mas e
// recuperavel -- perder a resposta do chat nao e.
const WEBCHAT_CAPTACAO_SLUG = Deno.env.get("WEBCHAT_CAPTACAO_SLUG") ?? "pos-3-em-1-webchat";

async function dispararCaptacao(
  sessao: { nome: string | null; telefone: string | null; origem_url: string | null; pagina: string | null },
  curso: string,
): Promise<void> {
  try {
    const telefone = String(sessao.telefone ?? "").replace(/\D/g, "");
    if (!telefone || !curso) return;

    const { data: integ } = await supabase
      .from("crm_webhook_integrations")
      .select("slug, secret, ativa")
      .eq("slug", WEBCHAT_CAPTACAO_SLUG).maybeSingle();
    const integracao = integ as { slug: string; secret: string | null; ativa: boolean | null } | null;
    if (!integracao?.secret || integracao.ativa === false) {
      console.error(`[crm-webchat] captacao: integracao ${WEBCHAT_CAPTACAO_SLUG} inativa ou sem secret`);
      return;
    }

    // Resolve o curso no catalogo: o rotulo do botao ("Reproducao... (3 em 1)") nao e o
    // nome oficial ("POS | ... (3EM1)"). O resolver e o MESMO que o agente usa.
    let nomeOficial = curso;
    let segmentoId: string | null = null;
    try {
      const { data: resolvido } = await supabase.rpc("fn_sdr_api_resolver_pos_graduacao", { p_valor: curso });
      const cursoId = (resolvido as { id?: string } | null)?.id ?? null;
      if (cursoId) {
        const { data: c } = await supabase.from("cursos").select("nome, segmento_id").eq("id", cursoId).maybeSingle();
        const linha = c as { nome: string | null; segmento_id: string | null } | null;
        if (linha?.nome) nomeOficial = linha.nome;
        segmentoId = linha?.segmento_id ?? null;
      }
    } catch (e) {
      console.error(`[crm-webchat] captacao resolver curso: ${(e as Error).message}`);
    }
    // Titulo da oportunidade = nome do catalogo sem o prefixo, como nas integracoes de LP.
    const titulo = nomeOficial.replace(/^(PÓS|MBA)\s*\|\s*/i, "").trim();

    const url = `${SUPABASE_URL}/functions/v1/crm-lead-webhook`
      + `?int=${encodeURIComponent(integracao.slug)}&secret=${encodeURIComponent(integracao.secret)}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nome: sessao.nome ?? "",
        telefone,
        curso: titulo,
        titulo,
        segmento_id: segmentoId ?? "",
        fonte: "Webchat",
        pagina: sessao.pagina ?? "",
        origem_url: sessao.origem_url ?? "",
      }),
    });
    const resp = await r.json().catch(() => ({}));
    if (!r.ok || (resp as { ok?: boolean }).ok === false) {
      console.error(`[crm-webchat] captacao HTTP ${r.status}: ${JSON.stringify(resp).slice(0, 300)}`);
    }
  } catch (e) {
    console.error(`[crm-webchat] captacao: ${(e as Error).message}`);
  }
}

async function acaoEscolherPos(body: Record<string, unknown>) {
  const sessaoId = texto(body.sessao_id, 40);
  const curso = texto(body.curso, 120);
  if (!UUID_RE.test(sessaoId)) return json({ ok: false, erro: "sessao_invalida" }, 400);
  if (!curso) return json({ ok: false, erro: "curso_obrigatorio" }, 400);

  const sessao = await carregarSessao(sessaoId);
  if (!sessao) return json({ ok: false, erro: "sessao_nao_encontrada" }, 404);
  if (sessao.bloqueada) return json({ ok: false, erro: "sessao_bloqueada" }, 403);
  // Idempotente: dois toques (ou um recarregar no meio) não duplicam a mensagem.
  if (sessao.curso) return json({ ok: true, ja_escolhida: true });

  // NÃO força estágio (2026-08-19): quem decide validação x qualificador é o router, como
  // em toda conversa. Forçar qualificador pulava a oferta da reunião e jogava o João direto
  // na coleta — e a reunião é o objetivo, não o cronograma.
  await supabase.from("webchat_sessoes")
    .update({ curso })
    .eq("id", sessaoId);

  // Os três campos (nome, telefone, curso) ficaram completos AGORA: é o gatilho da
  // captação. A guarda de `sessao.curso` acima já garante uma vez só por sessão.
  await dispararCaptacao(sessao, curso);

  // Esta ação só REGISTRA a escolha e dispara a captação. Quem manda a mensagem é o
  // WIDGET, pelo caminho normal de envio — o toque no botão vira fala do visitante.
  // ⚠️ Foi tentado criar a mensagem aqui e não funciona: o widget DESCARTA inbound vindo
  // do poll ("já foi renderizado otimista no envio"), então a fala nunca aparecia na tela.
  // Mensagem criada pelo servidor não tem quem a desenhe.
  return json({ ok: true });
}

async function acaoEnviar(body: Record<string, unknown>, canal: "publico" | "teste" = "publico") {
  const sessaoId = texto(body.sessao_id, 40);
  const conteudo = texto(body.conteudo, MAX_CONTEUDO);
  if (!UUID_RE.test(sessaoId)) return json({ ok: false, erro: "sessao_invalida" }, 400);
  if (!conteudo) return json({ ok: false, erro: "mensagem_vazia" }, 400);

  const sessao = await carregarSessao(sessaoId);
  if (!sessao) return json({ ok: false, erro: "sessao_nao_encontrada" }, 404);
  if (sessao.bloqueada) return json({ ok: false, erro: "sessao_bloqueada" }, 403);
  if (canal === "publico" && sessao.modo_teste) return json({ ok: false, erro: "sessao_nao_encontrada" }, 404);
  if (canal === "teste" && !sessao.modo_teste) return json({ ok: false, erro: "sessao_nao_encontrada" }, 404);

  if (canal === "publico") {
    const limite = await checarLimitesInbound(sessaoId);
    if (limite) return limite;
  }

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
// de CPU/wall-clock do edge. A reserva no banco identifica os inbounds ainda não consumidos.
async function acaoResponder(body: Record<string, unknown>, canal: "publico" | "teste" = "publico") {
  const sessaoId = texto(body.sessao_id, 40);
  if (!UUID_RE.test(sessaoId)) return json({ ok: false, erro: "sessao_invalida" }, 400);
  const sessao = await carregarSessao(sessaoId);
  if (!sessao) return json({ ok: false, erro: "sessao_nao_encontrada" }, 404);
  if (sessao.bloqueada) return json({ ok: false, erro: "sessao_bloqueada" }, 403);
  if (canal === "publico" && sessao.modo_teste) return json({ ok: false, erro: "sessao_nao_encontrada" }, 404);
  if (canal === "teste" && !sessao.modo_teste) return json({ ok: false, erro: "sessao_nao_encontrada" }, 404);

  /*
    Um atendente assumiu a conversa pelo SAC 2.0 (`sac_v2_webchat_enviar` marca
    `atendimento_humano`): o João CALA até alguém devolver a conversa a ele. Sem isso,
    a resposta do humano e a do agente sairiam intercaladas no mesmo chat.
  */
  if (sessao.atendimento_humano) return json({ ok: true, skip: "atendimento_humano" });

  const rodada = await responderComoJoao(sessao, sessaoId);
  return json({
    ok: true,
    ...(rodada.status !== "publicado" ? { skip: rodada.status } : {}),
    pendente: rodada.ha_pendencia === true,
  });
}

/**
 * Cria uma conversa sintética no MESMO SAC do chat ao vivo. Não passa por captcha,
 * rate limit nem lead_upsert porque só gestão autenticada entra aqui. O cérebro e os
 * prompts são os reais; as tools de efeito ficam mockadas em agente.ts.
 */
async function acaoTesteIniciar(body: Record<string, unknown>, req: Request) {
  const userId = await usuarioGestao(req);
  if (!userId) return json({ ok: false, erro: "acesso_negado" }, 403);

  const execucaoId = texto(body.execucao_id, 40);
  const cenarioId = texto(body.cenario_id, 80);
  const cenarioNome = texto(body.cenario_nome, 100);
  const nome = texto(body.nome_lead, 80);
  if (!UUID_RE.test(execucaoId) || !cenarioId || !cenarioNome || nome.length < 2) {
    return json({ ok: false, erro: "cenario_invalido" }, 400);
  }
  const produto = texto(body.produto, 20).toLowerCase() === "escola" ? "escola" : "pos";
  const curso = texto(body.curso, 120) || null;
  const id = crypto.randomUUID();
  const telefone = telefoneSeguroDeTeste(id);
  const marcador = nomeContatoTeste(cenarioNome, execucaoId);

  const { error } = await supabase.from("webchat_sessoes").insert({
    id,
    nome,
    telefone,
    produto,
    pagina: "Harness do SAC 2.0",
    curso,
    origem_url: null,
    ip: "harness-interno",
    user_agent: "SAC 2.0 · teste automatizado",
    modo_teste: true,
    teste_execucao_id: execucaoId,
    teste_cenario: cenarioNome,
    teste_criado_por: userId,
    teste_tool_chamadas: [],
  });
  if (error) {
    console.error(`[crm-webchat] teste_iniciar: ${error.message}`);
    return json({ ok: false, erro: "erro_interno" }, 500);
  }

  let chunks = [`Oi, ${nome.split(" ")[0]}! 👋 Me conta como posso te ajudar.`];
  try {
    chunks = await aberturaWebchat(nome, curso, produto);
  } catch (e) {
    console.error(`[crm-webchat] teste abertura: ${(e as Error).message}`);
  }
  for (const chunk of chunks) {
    await supabase.from("webchat_mensagens").insert({
      sessao_id: id, direcao: "outbound", origem: "ia", conteudo: chunk,
    });
    await syncSac(id, "outbound", "ia", chunk);
  }

  const { data: funil } = await supabase.from("sac_v2_funis")
    .select("id").eq("ativo", true).eq("canal_webchat", true).order("ordem").limit(1).maybeSingle();
  return json({
    ok: true,
    sessao_id: id,
    execucao_id: execucaoId,
    cenario_id: cenarioId,
    marcador,
    sac_funil_id: funil?.id ?? null,
  });
}

async function acaoTesteEnviar(body: Record<string, unknown>, req: Request) {
  if (!(await usuarioGestao(req))) return json({ ok: false, erro: "acesso_negado" }, 403);
  return acaoEnviar(body, "teste");
}

async function acaoTesteResponder(body: Record<string, unknown>, req: Request) {
  if (!(await usuarioGestao(req))) return json({ ok: false, erro: "acesso_negado" }, 403);
  return acaoResponder(body, "teste");
}

// Áudio do lead: base64 → Storage (whatsapp-anexos/webchat) → Whisper → vira a mensagem
// inbound (conteudo=transcrição, anexos=[áudio]) → o João responde ao que foi falado.
async function acaoAudio(body: Record<string, unknown>, req: Request) {
  const sessaoId = texto(body.sessao_id, 40);
  if (!UUID_RE.test(sessaoId)) return json({ ok: false, erro: "sessao_invalida" }, 400);
  const b64 = typeof body.audio_base64 === "string" ? body.audio_base64 : "";
  if (!b64) return json({ ok: false, erro: "audio_vazio" }, 400);
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

  // Valida pelos BYTES, não pelo mime do cliente: bucket público + upload anônimo.
  const mimeReal = detectarMimeAudio(bytes);
  if (!mimeReal) return json({ ok: false, erro: "audio_invalido" }, 400);

  // sobe pro Storage (mesmo bucket público do WhatsApp; pasta webchat/)
  let url: string | null = null;
  try {
    const ext = extDoMime(mimeReal);
    const path = `webchat/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${ext}`;
    const { error: stErr } = await supabase.storage.from("whatsapp-anexos").upload(path, bytes, { contentType: mimeReal, upsert: false });
    if (stErr) console.error(`[crm-webchat] storage upload: ${stErr.message}`);
    else url = toPublicUrl(supabase.storage.from("whatsapp-anexos").getPublicUrl(path).data.publicUrl);
  } catch (e) {
    console.error(`[crm-webchat] storage: ${(e as Error).message}`);
  }

  // transcreve (Whisper); vazio → "[áudio]" (a conversa segue mesmo sem transcrição)
  const transcricao = await transcreverWhisper(bytes, mimeReal);
  const conteudo = transcricao || "[áudio]";
  const anexos = url ? [{ tipo: "audio", mime_type: mimeReal, url, url_storage: url }] : [];

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

// A LP não consegue saber se a pessoa já ativou os avisos: a permissão foi dada no POPUP,
// que roda na NOSSA origem (Notification.permission é POR ORIGEM). Quem sabe é o servidor —
// a sessão tem subscription registrada. Sem isto o convite de push reaparecia no chat pra
// quem tinha acabado de aceitar no cadastro (relatado 2026-08-07).
async function acaoPushStatus(body: Record<string, unknown>) {
  const sessaoId = texto(body.sessao_id, 40);
  if (!UUID_RE.test(sessaoId)) return json({ ok: false, erro: "sessao_invalida" }, 400);
  const { count, error } = await supabase
    .from("webchat_push_subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("sessao_id", sessaoId);
  if (error) {
    console.error(`[crm-webchat] push_status: ${error.message}`);
    return json({ ok: true, ativo: false }); // fail-open: melhor convidar de novo que travar
  }
  return json({ ok: true, ativo: (count ?? 0) > 0 });
}

/**
 * Usuário LOGADO (qualquer um do time), não só diretor.
 * ⚠️ Diferente de `usuarioGestao`: o botão de levar a conversa pro WhatsApp é do
 * ATENDENTE. Exigir permissão de admin ali entregaria um botão que só o diretor
 * conseguiria usar — e quem está no card é quem precisa dele.
 */
async function usuarioLogado(req: Request): Promise<string | null> {
  const token = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user?.id) return null;
  return data.user.id;
}

/**
 * BOTÃO MANUAL da ponte pro WhatsApp (fase 4).
 *
 * Mesmo efeito da tool `levar_para_whatsapp`, com o gatilho no atendente em vez de no
 * João: às vezes quem percebe que a conversa morreu no site é a pessoa olhando o card.
 *
 * ⚠️ A janela anti-duplicata é a MESMA do João (`levado_para_whatsapp_em` +
 * WHATSAPP_REENVIO_COOLDOWN_MIN), de propósito: o botão não repete um envio que acabou de
 * sair, senão o lead recebe dois templates pelo mesmo motivo, um de cada origem, e cada
 * template é cobrado. Passada a janela o botão manda de novo normalmente — a ponte pode ser
 * usada mais de uma vez no mesmo lead.
 */
async function acaoLevarParaWhatsapp(body: Record<string, unknown>, req: Request) {
  if (!(await usuarioLogado(req))) return json({ ok: false, erro: "acesso_negado" }, 403);
  const sessaoId = texto(body.sessao_id, 40);
  if (!UUID_RE.test(sessaoId)) return json({ ok: false, erro: "sessao_invalida" }, 400);

  const { data: s, error } = await supabase
    .from("webchat_sessoes")
    .select("id, nome, telefone, curso, levado_para_whatsapp_em, modo_teste")
    .eq("id", sessaoId)
    .maybeSingle();
  if (error || !s) return json({ ok: false, erro: "sessao_nao_encontrada" }, 404);
  if (s.modo_teste) return json({ ok: false, erro: "sessao_de_teste" }, 403);
  if (!String(s.telefone ?? "").trim()) return json({ ok: false, erro: "sem_telefone" }, 400);
  const levadoEm = s.levado_para_whatsapp_em as string | null;
  if (
    levadoEm && WHATSAPP_REENVIO_COOLDOWN_MIN > 0 &&
    Date.now() - new Date(levadoEm).getTime() < WHATSAPP_REENVIO_COOLDOWN_MIN * 60_000
  ) {
    return json({ ok: true, ja_enviado: true, em: levadoEm });
  }

  const primeiro = String(s.nome ?? "").trim().split(/\s+/)[0] || "tudo bem";
  const r = await fetch(`${SUPABASE_URL}/functions/v1/crm-whatsapp-send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      telefone: s.telefone,
      tipo: "template",
      template_name: WEBCHAT_TEMPLATE_CONTINUIDADE,
      template_lang: "pt_BR",
      template_components: [{
        type: "body",
        parameters: [
          { type: "text", text: primeiro },
          { type: "text", text: fraseConviteWhatsapp(s.curso) },
        ],
      }],
      wa_account_id: WEBCHAT_WA_ACCOUNT_ID || null,
      origem: "humano",
    }),
  });
  const b: any = await r.json().catch(() => ({}));
  // crm-whatsapp-send confirma o aceite com success:true. HTTP 2xx sozinho,
  // inclusive corpo vazio/inválido, não comprova que a mensagem foi enviada.
  if (!r.ok || b?.success !== true || b?.error || b?.data?.error || b?.ok === false) {
    console.error(`[crm-webchat] levar_para_whatsapp manual: ${b?.error ?? r.status}`);
    return json({ ok: false, erro: b?.error ?? "falha_no_envio" }, 400);
  }
  await supabase.from("webchat_sessoes")
    .update({ levado_para_whatsapp_em: new Date().toISOString() })
    .eq("id", sessaoId);
  try {
    await semearHistoricoWhatsApp(supabase, sessaoId, { tipo: "transferencia", curso: s.curso });
  } catch (e) {
    console.error("[crm-webchat] continuidade manual:", e instanceof Error ? e.message : String(e));
  }
  return json({ ok: true, ja_enviado: false });
}

/**
 * ÁUDIO DO ATENDENTE no chat do site (fase 4).
 *
 * O caminho de ida já existia: o lead grava, o widget toca, o Whisper transcreve. Faltava a
 * volta — o atendente só podia escrever. Num chat onde a pessoa acabou de mandar um áudio,
 * responder por texto é uma assimetria que ela percebe.
 *
 * ⚠️ Espelha `acaoAudio` (a do lead) de propósito, invertendo só a direção: mesmo bucket,
 * mesma pasta, mesmo formato de `anexos` — o widget já sabe tocar isso, porque
 * `addBolhaMsg` lê o anexo pela direção, não pelo remetente.
 *
 * ⚠️ TRANSCREVE o áudio do atendente também. Não é pro lead (ele ouve), é para os DOIS
 * lugares onde a conversa continua sendo lida: o espelho no SAC, que mostraria só "[áudio]",
 * e o próprio João, se a conversa for devolvida pra ele — sem a transcrição ele retomaria
 * sem saber o que o humano prometeu.
 *
 * ⚠️ Assume a conversa, igual ao envio de texto (`sac_v2_webchat_enviar`): quem responde
 * passa a ser o atendente até alguém devolver ao João. Mandar áudio e continuar com a IA
 * respondendo por cima seria a pior combinação possível.
 */
async function acaoAtendenteAudio(body: Record<string, unknown>, req: Request) {
  if (!(await usuarioLogado(req))) return json({ ok: false, erro: "acesso_negado" }, 403);
  const sessaoId = texto(body.sessao_id, 40);
  if (!UUID_RE.test(sessaoId)) return json({ ok: false, erro: "sessao_invalida" }, 400);
  const b64 = typeof body.audio_base64 === "string" ? body.audio_base64 : "";
  if (!b64) return json({ ok: false, erro: "audio_vazio" }, 400);
  const sessao = await carregarSessao(sessaoId);
  if (!sessao) return json({ ok: false, erro: "sessao_nao_encontrada" }, 404);
  if (sessao.bloqueada) return json({ ok: false, erro: "sessao_bloqueada" }, 403);

  let bytes: Uint8Array;
  try {
    bytes = b64ToBytes(b64);
  } catch {
    return json({ ok: false, erro: "audio_invalido" }, 400);
  }
  if (!bytes.length) return json({ ok: false, erro: "audio_vazio" }, 400);

  // Mesma validação por bytes do lado do lead: nada entra no bucket público sem ser áudio.
  const mimeReal = detectarMimeAudio(bytes);
  if (!mimeReal) return json({ ok: false, erro: "audio_invalido" }, 400);

  // ⚠️ Sem URL não há o que tocar: aqui o upload é BLOQUEANTE, ao contrário do lado do lead,
  // onde a transcrição ainda salva a mensagem. Um balão de áudio sem áudio é pior que um erro.
  let url: string | null = null;
  try {
    const ext = extDoMime(mimeReal);
    const path = `webchat/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${ext}`;
    const { error: stErr } = await supabase.storage
      .from("whatsapp-anexos")
      .upload(path, bytes, { contentType: mimeReal, upsert: false });
    if (stErr) throw new Error(stErr.message);
    url = toPublicUrl(supabase.storage.from("whatsapp-anexos").getPublicUrl(path).data.publicUrl);
  } catch (e) {
    console.error(`[crm-webchat] atendente_audio storage: ${(e as Error).message}`);
    return json({ ok: false, erro: "falha_no_upload" }, 500);
  }

  const transcricao = await transcreverWhisper(bytes, mimeReal);
  const conteudo = transcricao || "[áudio]";
  const anexos = [{ tipo: "audio", mime_type: mimeReal, url, url_storage: url }];

  const { data: msg, error } = await supabase
    .from("webchat_mensagens")
    .insert({
      sessao_id: sessaoId,
      direcao: "outbound",
      origem: "humano",
      conteudo,
      anexos,
      transcricao: transcricao || null,
    })
    .select("id")
    .single();
  if (error) {
    console.error(`[crm-webchat] atendente_audio insert: ${error.message}`);
    return json({ ok: false, erro: "erro_interno" }, 500);
  }

  await syncSac(sessaoId, "outbound", "humano", conteudo, anexos);
  await supabase
    .from("webchat_sessoes")
    .update({ atendimento_humano: true, ultima_atividade: new Date().toISOString() })
    .eq("id", sessaoId);

  return json({ ok: true, mensagem_id: msg.id, transcricao });
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

  let body: Record<string, unknown>;
  try {
    const cru = await req.text();
    // Teto duro (áudio inline base64); depois de parsear, só a ação 'audio' pode passar
    // do cap de texto — as demais ficam no limite pequeno (anti-DoS).
    if (cru.length > MAX_BODY_AUDIO) return json({ ok: false, erro: "payload_grande" }, 413);
    body = JSON.parse(cru);
    // ⚠️ As DUAS ações de áudio (a do lead e a do atendente) passam do cap de texto: 16 KB
    // não cabe nem um segundo de gravação em base64, e o 413 sairia antes de qualquer
    // guard, virando "não consigo mandar áudio" sem explicação.
    const acaoComAudio = body.acao === "audio" || body.acao === "atendente_audio";
    if (!acaoComAudio && cru.length > MAX_BODY_BYTES) {
      return json({ ok: false, erro: "payload_grande" }, 413);
    }
  } catch {
    return json({ ok: false, erro: "json_invalido" }, 400);
  }

  const acao = texto(body.acao, 40);
  /*
    A allowlist de origem existe pra impedir que QUALQUER site embede o widget e gaste o
    nosso agente. Ações que exigem USUÁRIO LOGADO da PPGVET são outro modelo de ameaça — o
    token já é a barreira — e vêm do app (app.ppgeducacao.site), que não é uma LP e não
    está na lista. Sem esta isenção o botão "Chamar no WhatsApp" levaria 403 silencioso,
    exatamente como uma LP em domínio novo (incidente já conhecido).
    ⚠️ Só entra aqui ação que confere sessão do usuário logo na primeira linha.
  */
  const acaoDeUsuarioLogado = acao.startsWith("teste_")
    || acao === "levar_para_whatsapp" || acao === "atendente_audio";
  if (!acaoDeUsuarioLogado && origemBloqueada(req)) {
    return json({ ok: false, erro: "origem_nao_permitida" }, 403);
  }

  try {
    switch (acao) {
      case "iniciar":
        return await acaoIniciar(body, req);
      case "escolher_pos":
        return await acaoEscolherPos(body);
      case "enviar":
        return await acaoEnviar(body);
      case "audio":
        return await acaoAudio(body, req);
      case "responder":
        return await acaoResponder(body);
      case "teste_iniciar":
        return await acaoTesteIniciar(body, req);
      case "teste_enviar":
        return await acaoTesteEnviar(body, req);
      case "teste_responder":
        return await acaoTesteResponder(body, req);
      case "atendente_audio":
        return await acaoAtendenteAudio(body, req);
      case "levar_para_whatsapp":
        return await acaoLevarParaWhatsapp(body, req);
      case "poll":
        return await acaoPoll(body);
      case "push_vapid":
        return json({ ok: true, chave: VAPID_PUBLIC });
      case "push_subscribe":
        return await acaoPushSubscribe(body, req);
      case "push_status":
        return await acaoPushStatus(body);
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
