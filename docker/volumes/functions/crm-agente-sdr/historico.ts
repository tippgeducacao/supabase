// Histórico da conversa do agente SDR — port fiel dos code nodes do n8n
// "Limpa thinking para router" e "Code in JavaScript2" (sanitizador universal),
// mais a persistência em cliente_ppg_mensagens_sdr (1 linha por turno; a coluna
// conversation_history guarda o turno completo: texto, thinking, tool_use, tool_result).

// deno-lint-ignore-file no-explicit-any
export type Msg = { role: 'user' | 'assistant'; content: string | any[] };

export const MARCADOR_FOLLOWUP = '[INTERNAL_MARKER_FOLLOWUP_AUTO_IGNORE]';

export async function carregarHistorico(supabase: any, remotejid: string): Promise<Msg[]> {
  const { data, error } = await supabase
    .from('cliente_ppg_mensagens_sdr')
    .select('id, conversation_history')
    .eq('remotejid', remotejid)
    .order('id', { ascending: true });
  if (error) throw new Error(`carregarHistorico: ${error.message}`);
  return (data ?? [])
    .map((r: any) => r.conversation_history)
    .filter((m: any) => m && m.role);
}

export async function gravarMensagem(supabase: any, remotejid: string, msg: Msg): Promise<void> {
  const { error } = await supabase.from('cliente_ppg_mensagens_sdr').insert({
    remotejid,
    conversation_history: msg,
    timestamp: new Date().toISOString(),
  });
  if (error) throw new Error(`gravarMensagem: ${error.message}`);
}

// ── Router: só o diálogo em texto ───────────────────────────────────────────
// Remove thinking/tool_use/tool_result, funde turnos consecutivos do mesmo role,
// garante primeira mensagem user e última mensagem user (sem prefill).
export function limparParaRouter(brutas: Msg[]): Msg[] {
  const norm: { role: string; content: string }[] = [];
  for (const m of brutas) {
    if (!m || !m.role) continue;
    let texto = '';
    if (typeof m.content === 'string') {
      texto = m.content;
    } else if (Array.isArray(m.content)) {
      texto = m.content
        .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b: any) => b.text)
        .join('\n');
    }
    texto = (texto || '').trim();
    if (!texto) continue;

    const ult = norm[norm.length - 1];
    if (ult && ult.role === m.role) ult.content += '\n' + texto;
    else norm.push({ role: m.role, content: texto });
  }

  while (norm.length && norm[0].role !== 'user') norm.shift();
  if (!norm.length) norm.push({ role: 'user', content: '[início de conversa]' });
  if (norm[norm.length - 1].role === 'assistant') {
    norm.push({ role: 'user', content: MARCADOR_FOLLOWUP });
  }
  return norm as Msg[];
}

// ── Loop principal: pareia tool_use ↔ tool_result ───────────────────────────
// Turno assistant com tool_use sem result correspondente vira só os blocos de
// texto; tool_results soltos são reposicionados logo após seu tool_use; turnos
// consecutivos do mesmo role são fundidos (tool_results primeiro no bloco).
export function sanitizarHistorico(brutas: Msg[]): Msg[] {
  // Thinking de turnos ANTIGOS sai do replay: a API só exige os blocos de thinking no
  // turno assistant da cadeia de tools ATIVA (o último). Os antigos ENVENENAM o contexto
  // — thinking de dias atrás afirmando "Today is Thursday July 16" fez o agente insistir
  // numa data errada em 24/07 (caso Rafael) — e desperdiçam tokens (signatures enormes).
  let idxUltimoAssistant = -1;
  for (let i = brutas.length - 1; i >= 0; i--) {
    if (brutas[i]?.role === 'assistant') { idxUltimoAssistant = i; break; }
  }
  brutas = brutas
    .map((m, i) => {
      if (!m || m.role !== 'assistant' || !Array.isArray(m.content) || i === idxUltimoAssistant) return m;
      const semThinking = m.content.filter((b: any) => b?.type !== 'thinking' && b?.type !== 'redacted_thinking');
      if (semThinking.length === m.content.length) return m;
      return semThinking.length ? { ...m, content: semThinking } : null;
    })
    .filter((m): m is Msg => m !== null);

  const results = new Map<string, any>();
  for (const m of brutas) {
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'tool_result') results.set(b.tool_use_id, b);
      }
    }
  }

  const out: Msg[] = [];
  for (const m of brutas) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const toolUses = m.content.filter((b: any) => b.type === 'tool_use');
      if (toolUses.length) {
        const faltando = toolUses.some((t: any) => !results.has(t.id));
        if (faltando) {
          const textos = m.content.filter((b: any) => b.type === 'text');
          if (textos.length) out.push({ role: 'assistant', content: textos });
          continue;
        }
        out.push(m);
        out.push({ role: 'user', content: toolUses.map((t: any) => results.get(t.id)) });
        continue;
      }
      out.push(m);
      continue;
    }
    if (m.role === 'user' && Array.isArray(m.content)) {
      const resto = m.content.filter((b: any) => b.type !== 'tool_result');
      if (resto.length) out.push({ role: 'user', content: resto });
      continue;
    }
    out.push(m);
  }

  const fin: Msg[] = [];
  for (const m of out) {
    const ult = fin[fin.length - 1];
    if (ult && ult.role === m.role) {
      const toBlocks = (c: any) => Array.isArray(c) ? c : [{ type: 'text', text: String(c) }];
      const blocos = [...toBlocks(ult.content), ...toBlocks(m.content)];
      ult.content = [
        ...blocos.filter((b: any) => b.type === 'tool_result'),
        ...blocos.filter((b: any) => b.type !== 'tool_result'),
      ];
    } else {
      fin.push({ ...m });
    }
  }
  return fin;
}

// ── Lead (cliente_ppg_leads_sdr) ────────────────────────────────────────────

export async function buscarLead(supabase: any, remotejid: string): Promise<any | null> {
  const { data, error } = await supabase
    .from('cliente_ppg_leads_sdr')
    .select('*')
    .eq('remotejid', remotejid)
    .maybeSingle();
  if (error) throw new Error(`buscarLead: ${error.message}`);
  return data;
}

export async function criarLead(supabase: any, remotejid: string): Promise<void> {
  const { error } = await supabase.from('cliente_ppg_leads_sdr').insert({
    remotejid,
    timestamp: new Date().toISOString(),
  });
  if (error) throw new Error(`criarLead: ${error.message}`);
}

export async function atualizarLead(supabase: any, remotejid: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await supabase
    .from('cliente_ppg_leads_sdr')
    .update(patch)
    .eq('remotejid', remotejid);
  if (error) throw new Error(`atualizarLead: ${error.message}`);
}

// Ratchet do router: quem já é qualificador NUNCA volta pra validação
// (port do UPDATE ... SET agente_atual = CASE ... do n8n; seguro aqui porque
// a rodada inteira roda sob o lock da conversa).
export async function atualizarAgenteComRatchet(
  supabase: any,
  remotejid: string,
  agenteAtual: string | null,
  proximoAgente: string,
): Promise<string> {
  const efetivo = agenteAtual === 'agente_qualificador' ? 'agente_qualificador' : proximoAgente;
  await atualizarLead(supabase, remotejid, { agente_atual: efetivo });
  return efetivo;
}

// Reset /excluirdados: apaga lead + mensagens (port do "reset da conversa").
export async function excluirDadosLead(supabase: any, remotejid: string): Promise<void> {
  await supabase.from('cliente_ppg_mensagens_sdr').delete().eq('remotejid', remotejid);
  await supabase.from('cliente_ppg_leads_sdr').delete().eq('remotejid', remotejid);
}
