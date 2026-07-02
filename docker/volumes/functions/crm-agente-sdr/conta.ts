// crm-agente-sdr/conta.ts — resolve A CONTA META "DO LEAD" pras esteiras de follow-up.
//
// Com MAIS DE UM número qualificador em produção (2026-07-02: João IA SDR +
// PPGVET - Pós-graduação), as esteiras não podem mais mandar pela "conta ativa":
// a janela de 24h da Meta é POR NÚMERO (par número×lead) e a conversa do lead
// vive num número específico. Regra: o follow-up sai pelo número onde o lead é
// atendido — resolvido pela última mensagem dele em crm_whatsapp_messages.
//
// Persona importa: número com agente_ia_persona='recontato' NUNCA é escolhido
// pra lead de cadência normal — se o lead respondesse lá, o gate de persona
// PULARIA a IA (skip fora_do_modo_recontato) e a conversa morreria no humano.

// deno-lint-ignore-file no-explicit-any

// Variantes do telefone (com/sem DDI 55, com/sem 9º dígito) — espelha o
// phoneVariants do crm-whatsapp-send, pra casar a coluna telefone persistida.
export function phoneVariants(raw: string): string[] {
  let d = (raw ?? '').replace(/\D/g, '');
  if (d.startsWith('55')) d = d.slice(2);
  const ddd = d.slice(0, 2);
  const rest = d.slice(2);
  const set = new Set<string>();
  const add = (x: string) => { set.add(x); set.add(`55${x}`); };
  if (rest) add(ddd + rest);
  if (rest.length === 8) add(`${ddd}9${rest}`);
  if (rest.length === 9 && rest[0] === '9') add(ddd + rest.slice(1));
  return [...set];
}

// Personas das contas Meta, com cache curto (o worker vive entre requests; o tick
// processa dezenas/centenas de leads — não martelar a tabela a cada envio).
let cachePersonas: { at: number; mapa: Map<string, string | null> } | null = null;
async function personasContas(supabase: any): Promise<Map<string, string | null>> {
  if (cachePersonas && Date.now() - cachePersonas.at < 60_000) return cachePersonas.mapa;
  const { data, error } = await supabase
    .from('crm_whatsapp_accounts')
    .select('id, agente_ia_persona');
  if (error) {
    console.error(`[crm-agente-sdr][conta] personasContas: ${error.message}`);
    return cachePersonas?.mapa ?? new Map();
  }
  const mapa = new Map<string, string | null>(
    (data ?? []).map((r: any) => [String(r.id), r.agente_ia_persona ?? null]),
  );
  cachePersonas = { at: Date.now(), mapa };
  return mapa;
}

/**
 * Conta Meta "do lead": a da mensagem mais recente dele em crm_whatsapp_messages
 * cuja conta tem persona QUALIFICADORA (persona 'recontato' é pulada — ver topo).
 *
 * opts.direcao='inbound' → considera só mensagens DO LEAD (é onde a janela de 24h
 * da Meta está aberta; use no follow-up de texto livre). Sem direcao, considera
 * qualquer direção (o template da cadência também "gruda" o lead no número).
 *
 * Retorna null quando o lead não tem mensagem em nenhum número qualificador —
 * o chamador decide o fallback (config do toque / conta ativa).
 */
export async function contaDoLead(
  supabase: any,
  telefone: string,
  opts?: { direcao?: 'inbound' | 'outbound' },
): Promise<string | null> {
  const variants = phoneVariants(telefone);
  if (!variants.length) return null;
  let q = supabase
    .from('crm_whatsapp_messages')
    .select('wa_account_id, direcao')
    .in('telefone', variants)
    .not('wa_account_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(8);
  if (opts?.direcao) q = q.eq('direcao', opts.direcao);
  const { data, error } = await q;
  if (error) {
    console.error(`[crm-agente-sdr][conta] contaDoLead ${telefone}: ${error.message}`);
    return null;
  }
  const rows = (data ?? []) as { wa_account_id: string }[];
  if (!rows.length) return null;
  const personas = await personasContas(supabase);
  for (const r of rows) {
    const id = String(r.wa_account_id);
    if (personas.get(id) === 'recontato') continue; // número da persona de no-show: nunca
    return id;
  }
  return null;
}
