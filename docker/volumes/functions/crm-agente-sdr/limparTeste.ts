// /limpar (29/09/2026, pedido do usuário): recomeça o TESTE do zero sem perder o cadastro.
// Só para os telefones de teste (crm_agente_sdr_config.luna_telefones, número exato em qualquer
// variante — nunca a fatia do luna_percentual): um lead de verdade que digite /limpar é atendido
// normalmente. Diferente do /excluirdados, que apaga o lead inteiro e o recria sem nome e sem curso.
//
// Zera: a memória do agente (cliente_ppg_mensagens_sdr), o estado do agente no lead (etapa, ficha,
// pausa, agendado, dados comerciais coletados), a elegibilidade registrada e buffer/lock.
// Mantém: nome, curso, e-mail e formação do cadastro. O chat do SAC continua visível; o agente
// passa a ignorar o que veio antes (jornada.limpo_em filtra status de materiais e troca de número).
// Zerar `agendado` dispara o trigger que move o card do lead no funil (é o lead de teste).
import { jidsDoTelefone } from './historico.ts';
import { phoneVariants } from './conta.ts';

export const COMANDO_LIMPAR = '/limpar';

export function ehComandoLimpar(conteudo: unknown): boolean {
  return String(conteudo ?? '').trim().toLowerCase() === COMANDO_LIMPAR;
}

/** O que o /limpar grava no lead: o estado do agente volta ao de um lead que acabou de chegar. */
export function estadoZerado(agora: string): Record<string, unknown> {
  return {
    agente_atual: null, jornada: { limpo_em: agora },
    pausa_ia: false, motivo_pausa: null, pausa_ia_ate: null, atendimento_finalizado: false,
    agendado: false, link_meet: null,
    situacao_trabalho_atual: null, objetivos_profissionais: null, experiencia_area: null,
  };
}

/** Desde quando o agente considera o chat do SAC (o último /limpar), ou null. */
export function limpoEm(lead: { jornada?: unknown } | null | undefined): string | null {
  const j = lead?.jornada;
  const v = j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>).limpo_em : null;
  return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null;
}

/** Telefone está na lista de teste (luna_telefones)? Falha de leitura = não é (nada é apagado). */
export async function ehTelefoneDeTeste(supabase: any, telefone: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.from('crm_agente_sdr_config').select('luna_telefones').eq('id', 1).maybeSingle();
    if (error || !data) return false;
    const variantes = new Set(phoneVariants(telefone));
    const lista: unknown[] = Array.isArray(data.luna_telefones) ? data.luna_telefones : [];
    return lista.some((t) => variantes.has(String(t).replace(/\D/g, '')));
  } catch { return false; }
}

export async function limparConversaDeTeste(supabase: any, remotejid: string, telefone: string): Promise<{ limpo_em: string }> {
  const agora = new Date().toISOString();
  const jids = jidsDoTelefone(remotejid);
  const passos: [string, PromiseLike<{ error: { message: string } | null }>][] = [
    ['mensagens', supabase.from('cliente_ppg_mensagens_sdr').delete().in('remotejid', jids)],
    ['lead', supabase.from('cliente_ppg_leads_sdr').update(estadoZerado(agora)).in('remotejid', jids)],
    ['elegibilidade', supabase.from('crm_agente_elegibilidade').delete().in('telefone_canonico', phoneVariants(telefone))],
    ['buffer', supabase.from('crm_agente_sdr_buffer').delete().in('remotejid', jids)],
    ['lock', supabase.from('crm_agente_sdr_lock').delete().in('remotejid', jids)],
    // Sem `rodada_fim` depois do /limpar, a reconciliação (crm_agente_sdr_reconciliar, 90 s) trata o
    // comando como inbound órfão, reenvia e apaga DE NOVO o teste que já recomeçou. Ela casa pelo
    // remotejid do lead, que pode estar em qualquer variante: grava nas duas.
    ['telemetria', supabase.from('crm_agente_sdr_eventos').insert(jids.map((remotejid) => ({
      remotejid, rodada_id: crypto.randomUUID(), tipo: 'rodada_fim',
      dados: { voltas_llm: 0, respondeu: false, motivo: 'limpar_teste', limpo_em: agora },
    })))],
  ];
  for (const [onde, passo] of passos) {
    const { error } = await passo;
    if (error) throw new Error(`/limpar (${onde}): ${error.message}`);
  }
  return { limpo_em: agora };
}
