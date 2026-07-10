// crm-webchat — chat ao vivo embedado nas landing pages (GreatPages) — FASE 2
// URL: POST https://api.ppgeducacao.site/functions/v1/crm-webchat
// Chamado pelo widget public/webchat-widget.js (anônimo, CORS aberto — é página pública).
//
// Ações (body JSON { acao, ... }):
//   iniciar → { nome, telefone, pagina?, curso?, origem_url? }  cria sessão + LEAD, devolve { sessao_id }
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
import { responderWebchat } from "./agente.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

const MAX_SESSOES_POR_IP_HORA = 20;
const MAX_MSGS_POR_SESSAO_MIN = 15;
const MAX_CONTEUDO = 2000;
const MAX_BODY_BYTES = 16_384;

// Disjuntores GLOBAIS (protegem banco/custo mesmo com IPs distribuídos — botnet fura
// limite por IP). Ajustáveis por env sem mexer em código (env do Dokploy/compose).
const MAX_SESSOES_HORA_GLOBAL = Number(Deno.env.get("WEBCHAT_MAX_SESSOES_HORA_GLOBAL") ?? 300);
const MAX_MSGS_HORA_GLOBAL = Number(Deno.env.get("WEBCHAT_MAX_MSGS_HORA_GLOBAL") ?? 3000);

// Allowlist de Origin OPT-IN (CSV de origens, ex.: "https://lp1.com.br,https://lp2.com.br").
// Vazia = aberto (default). Só barra navegador (curl forja Origin) — é fricção, não muro;
// o muro são os rate limits + disjuntores.
const ALLOWED_ORIGINS = (Deno.env.get("WEBCHAT_ALLOWED_ORIGINS") ?? "")
  .split(",").map((s) => s.trim().toLowerCase().replace(/\/$/, "")).filter(Boolean);

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

// ── ações ────────────────────────────────────────────────────────────────────

async function acaoIniciar(body: Record<string, unknown>, req: Request) {
  const nome = texto(body.nome, 80);
  const telefone = telefoneValido(texto(body.telefone, 30));
  if (nome.length < 2) return json({ ok: false, erro: "nome_invalido" }, 400);
  if (!telefone) return json({ ok: false, erro: "telefone_invalido" }, 400);

  const ip = ipDe(req);
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

  const { data, error } = await supabase
    .from("webchat_sessoes")
    .insert({
      nome,
      telefone,
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

  // mensagem de boas-vindas na thread (o widget a exibe via poll)
  await supabase.from("webchat_mensagens").insert({
    sessao_id: data.id,
    direcao: "outbound",
    origem: "sistema",
    conteudo: `Oi, ${nome.split(" ")[0]}! Pode mandar sua mensagem por aqui. 👋`,
  });

  return json({ ok: true, sessao_id: data.id });
}

async function carregarSessao(sessaoId: string) {
  const { data } = await supabase
    .from("webchat_sessoes")
    .select("id, bloqueada, nome, telefone, curso")
    .eq("id", sessaoId)
    .maybeSingle();
  return data as { id: string; bloqueada: boolean; nome: string | null; telefone: string | null; curso: string | null } | null;
}

async function acaoEnviar(body: Record<string, unknown>) {
  const sessaoId = texto(body.sessao_id, 40);
  const conteudo = texto(body.conteudo, MAX_CONTEUDO);
  if (!UUID_RE.test(sessaoId)) return json({ ok: false, erro: "sessao_invalida" }, 400);
  if (!conteudo) return json({ ok: false, erro: "mensagem_vazia" }, 400);

  const sessao = await carregarSessao(sessaoId);
  if (!sessao) return json({ ok: false, erro: "sessao_nao_encontrada" }, 404);
  if (sessao.bloqueada) return json({ ok: false, erro: "sessao_bloqueada" }, 403);

  const umMinAtras = new Date(Date.now() - 60_000).toISOString();
  const { count } = await supabase
    .from("webchat_mensagens")
    .select("id", { count: "exact", head: true })
    .eq("sessao_id", sessaoId)
    .eq("direcao", "inbound")
    .gte("criado_em", umMinAtras);
  if ((count ?? 0) >= MAX_MSGS_POR_SESSAO_MIN) {
    return json({ ok: false, erro: "limite_mensagens" }, 429);
  }

  // disjuntor global de mensagens/hora (protege banco hoje; custo de LLM na Fase 2)
  const umaHoraAtras = new Date(Date.now() - 3600_000).toISOString();
  const { count: totalHora } = await supabase
    .from("webchat_mensagens")
    .select("id", { count: "exact", head: true })
    .eq("direcao", "inbound")
    .gte("criado_em", umaHoraAtras);
  if ((totalHora ?? 0) >= MAX_MSGS_HORA_GLOBAL) {
    console.error(`[crm-webchat] DISJUNTOR msgs/hora atingido (${totalHora})`);
    return json({ ok: false, erro: "ocupado" }, 429);
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

  await supabase
    .from("webchat_sessoes")
    .update({ ultima_atividade: new Date().toISOString() })
    .eq("id", sessaoId);

  // FASE 2: o João responde (síncrono; o widget mostra "digitando" e faz polling).
  // Carrega o histórico da thread e gera a resposta reusando a sdr-api (agenda/reunião).
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

    const resposta = await responderWebchat(
      sessao.nome ?? "",
      sessao.telefone ?? "",
      sessao.curso ?? null,
      history,
    );
    await supabase.from("webchat_mensagens").insert({
      sessao_id: sessaoId,
      direcao: "outbound",
      origem: "ia",
      conteudo: resposta,
    });
  } catch (e) {
    console.error(`[crm-webchat] cerebro: ${(e as Error).message}`);
    await supabase.from("webchat_mensagens").insert({
      sessao_id: sessaoId,
      direcao: "outbound",
      origem: "sistema",
      conteudo: "Tive uma instabilidade aqui, mas já já te respondo. 🙏",
    });
  }

  return json({ ok: true, mensagem_id: msg.id });
}

async function acaoPoll(body: Record<string, unknown>) {
  const sessaoId = texto(body.sessao_id, 40);
  if (!UUID_RE.test(sessaoId)) return json({ ok: false, erro: "sessao_invalida" }, 400);
  const apos = Number(body.apos ?? 0);
  const cursor = Number.isFinite(apos) && apos > 0 ? Math.floor(apos) : 0;

  const sessao = await carregarSessao(sessaoId);
  if (!sessao) return json({ ok: false, erro: "sessao_nao_encontrada" }, 404);

  const { data, error } = await supabase
    .from("webchat_mensagens")
    .select("id, direcao, origem, conteudo, criado_em")
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
    if (cru.length > MAX_BODY_BYTES) return json({ ok: false, erro: "payload_grande" }, 413);
    body = JSON.parse(cru);
  } catch {
    return json({ ok: false, erro: "json_invalido" }, 400);
  }

  try {
    switch (body.acao) {
      case "iniciar":
        return await acaoIniciar(body, req);
      case "enviar":
        return await acaoEnviar(body);
      case "poll":
        return await acaoPoll(body);
      default:
        return json({ ok: false, erro: "acao_invalida" }, 400);
    }
  } catch (e) {
    console.error(`[crm-webchat] erro: ${(e as Error).message}`);
    return json({ ok: false, erro: "erro_interno" }, 500);
  }
});
