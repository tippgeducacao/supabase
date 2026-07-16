// Camada de banco do assistente interno. TUDO em tabelas próprias `assistente_*`
// (service_role). NUNCA toca crm_whatsapp_messages / sac_* / leads / crm_agente_sdr_*.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export function makeAdmin() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

export interface Dono {
  canon: string;
  nome: string;
  profile_id: string | null;
  calendar_integration_id: string | null;
  ativo: boolean;
}

export interface Ctx {
  admin: any;
  dono: Dono;
  canon: string;
  rodada_id: string;
  /** Linha WhatsApp + número do dono — necessários p/ ferramentas que ENVIAM arquivo (ex.: PDF). */
  linha?: any;
  numero?: string;
}

/**
 * Telefone -> chave canônica (DDD + 8 últimos dígitos). Espelha fn_canon_ddd8:
 * colapsa DDI 55 e 9º dígito presente/ausente na MESMA chave estável.
 * Ex.: +5546999321082 / 554699321082 -> '4699321082'.
 */
export function canon(raw: string | null | undefined): string | null {
  let d = String(raw ?? "").replace(/\D/g, "").replace(/^0+/, "");
  if (d.length >= 12 && d.startsWith("55")) d = d.slice(2);
  if (d.length < 10 || d.length > 11) return null;
  const ddd = d.slice(0, 2);
  if (Number(ddd) < 11) return null; // DDD plausível
  return ddd + d.slice(-8);
}

/** Resolve o dono (allowlist) pela chave canônica. NULL = fora da allowlist. */
export async function resolverDono(admin: any, c: string): Promise<Dono | null> {
  const { data } = await admin
    .from("assistente_donos")
    .select("canon, nome, profile_id, calendar_integration_id, ativo")
    .eq("canon", c)
    .eq("ativo", true)
    .maybeSingle();
  return (data as Dono) ?? null;
}

export async function jaProcessada(admin: any, externalId: string): Promise<boolean> {
  const { data } = await admin
    .from("assistente_mensagens")
    .select("id")
    .eq("wa_message_id", externalId)
    .eq("direcao", "inbound")
    .limit(1)
    .maybeSingle();
  return !!data;
}

export async function logMensagem(
  admin: any,
  c: string,
  direcao: "inbound" | "outbound",
  conteudo: string,
  tipo = "texto",
  waMessageId: string | null = null,
  anexos: any[] = [],
) {
  await admin.from("assistente_mensagens").insert({
    canon: c, direcao, tipo, conteudo, wa_message_id: waMessageId, anexos,
  });
}

/**
 * CLAIM da mensagem inbound: grava a marca de dedup ANTES do processamento pesado.
 * O índice único parcial (wa_message_id, direcao='inbound') detecta reentrega do webhook.
 * Retorna { dup:true } quando é retry (já processada). O log inbound É este claim.
 */
export async function claimInbound(
  admin: any,
  c: string,
  msgKey: string,
  tipo: string,
  conteudo: string,
  anexos: any[] = [],
): Promise<{ dup: boolean; id: string | null }> {
  const { data, error } = await admin
    .from("assistente_mensagens")
    .insert({ canon: c, direcao: "inbound", tipo, conteudo, wa_message_id: msgKey, anexos })
    .select("id")
    .maybeSingle();
  if (error) {
    if ((error as any).code === "23505") return { dup: true, id: null }; // reentrega
    return { dup: false, id: null }; // erro transitório: processa mesmo sem a marca
  }
  return { dup: false, id: data?.id ?? null };
}

/** Atualiza o conteúdo do inbound já reivindicado (ex.: áudio → texto transcrito). */
export async function atualizarConteudoInbound(admin: any, id: string | null, conteudo: string, tipo: string) {
  if (!id) return;
  await admin.from("assistente_mensagens").update({ conteudo, tipo }).eq("id", id);
}

/** Histórico recente como messages do Anthropic (garante 1º turno = user). */
export async function historicoRecente(admin: any, c: string, limite = 12) {
  const { data } = await admin
    .from("assistente_mensagens")
    .select("direcao, conteudo")
    .eq("canon", c)
    .order("criado_em", { ascending: false })
    .limit(limite);
  const linhas = (data ?? []).reverse();
  const msgs = linhas
    .filter((m: any) => String(m.conteudo ?? "").trim().length > 0)
    .map((m: any) => ({ role: m.direcao === "inbound" ? "user" : "assistant", content: String(m.conteudo) }));
  while (msgs.length && msgs[0].role === "assistant") msgs.shift(); // Anthropic exige 1º = user
  // Funde turnos consecutivos do mesmo role (double-text não pode virar [user,user] -> 400).
  const merged: { role: string; content: string }[] = [];
  for (const m of msgs) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += "\n" + m.content;
    else merged.push({ ...m });
  }
  return merged;
}

// ── Ações pendentes (confirmação antes de agir) ──────────────────────────────
export async function pendenteAtual(admin: any, c: string) {
  const { data } = await admin
    .from("assistente_acoes_pendentes")
    .select("*")
    .eq("canon", c)
    .eq("status", "pendente")
    .gt("expira_em", new Date().toISOString())
    .order("criado_em", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

export async function criarPendente(admin: any, c: string, tipo: string, payload: any, resumo: string) {
  await admin.from("assistente_acoes_pendentes")
    .update({ status: "cancelada" })
    .eq("canon", c).eq("status", "pendente"); // só a última proposta vale
  const { data } = await admin.from("assistente_acoes_pendentes")
    .insert({ canon: c, tipo, payload, resumo })
    .select().single();
  return data;
}

export async function marcarPendente(admin: any, id: string, status: string) {
  await admin.from("assistente_acoes_pendentes").update({ status }).eq("id", id);
}

// ── Telemetria (fire-and-forget) ─────────────────────────────────────────────
export async function tel(
  admin: any, c: string | null, rodada_id: string, tipo: string,
  dados: any = null, duracao_ms: number | null = null, erro: string | null = null,
) {
  try {
    await admin.from("assistente_eventos").insert({ canon: c, rodada_id, tipo, dados, duracao_ms, erro });
  } catch { /* nunca derruba a rodada */ }
}
