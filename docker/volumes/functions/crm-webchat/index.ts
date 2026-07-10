// crm-webchat — chat ao vivo embedado nas landing pages (GreatPages) — FASE 1
// URL: POST https://api.ppgeducacao.site/functions/v1/crm-webchat
// Chamado pelo widget public/webchat-widget.js (anônimo, CORS aberto — é página pública).
//
// Ações (body JSON { acao, ... }):
//   iniciar → { nome, telefone, pagina?, origem_url? }  cria a sessão, devolve { sessao_id }
//   enviar  → { sessao_id, conteudo }                    grava inbound + eco, devolve { mensagem_id }
//   poll    → { sessao_id, apos }                        mensagens com id > apos (cursor do widget)
//
// FASE 1 = teste de recebimento: toda mensagem recebe uma resposta de ECO automática
// (origem 'eco') pra validar o ciclo completo no widget. FASE 2 (declarada, NÃO feita):
// plugar a IA SDR (persona/tools do crm-agente-sdr) + criar lead a partir da sessão.
//
// Anti-abuso (endpoint público): rate limit de sessão por IP (20/h), de mensagem por
// sessão (15/min), conteúdo <= 2000 chars, sessão bloqueável (webchat_sessoes.bloqueada).
// Escrita nas tabelas SÓ por aqui (service role); RLS não tem policy de escrita.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

// FASE 1: resposta automática de eco (neutra — não assusta lead real se a LP for ao ar).
const RESPOSTA_ECO = "Recebemos sua mensagem! 😊 Já já te respondemos por aqui.";

const MAX_SESSOES_POR_IP_HORA = 20;
const MAX_MSGS_POR_SESSAO_MIN = 15;
const MAX_CONTEUDO = 2000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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

function ipDe(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  return fwd.split(",")[0].trim() || "desconhecido";
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

  const { data, error } = await supabase
    .from("webchat_sessoes")
    .insert({
      nome,
      telefone,
      pagina: texto(body.pagina, 200) || null,
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
    .select("id, bloqueada")
    .eq("id", sessaoId)
    .maybeSingle();
  return data as { id: string; bloqueada: boolean } | null;
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

  // FASE 1: eco automático (prova o ciclo ida-e-volta no widget).
  // FASE 2: substituir este bloco pelo handoff à IA SDR.
  await supabase.from("webchat_mensagens").insert({
    sessao_id: sessaoId,
    direcao: "outbound",
    origem: "eco",
    conteudo: RESPOSTA_ECO,
  });

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

  let body: Record<string, unknown>;
  try {
    body = await req.json();
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
