export type StatusCronograma = 'nao_solicitado' | 'pendente' | 'delivered' | 'read' | 'falhou'

export interface ReferenciaCronograma {
  waMessageId: string | null
  waAccountId: string | null
  waConexaoId: string | null
}

/**
 * O aceite HTTP não prova entrega. Só o status persistido da MESMA mensagem e
 * conta/conexão pode elevar o cronograma a entregue/lido (incidente 09/09/2026).
 * Sem referência ou se a leitura falhar, a resposta continua pendente; não reenvia.
 */
export async function consultarEntregaCronograma(
  supabase: Pick<SupabaseClient, 'from'>,
  referencia: ReferenciaCronograma,
): Promise<Exclude<StatusCronograma, 'nao_solicitado'>> {
  if (!referencia.waMessageId || (!referencia.waAccountId && !referencia.waConexaoId)) return 'pendente'
  try {
    let consulta = supabase.from('crm_whatsapp_messages')
      .select('status_entrega')
      .eq('wa_message_id', referencia.waMessageId)
      .eq('direcao', 'outbound')
    consulta = referencia.waConexaoId
      ? consulta.eq('wa_conexao_id', referencia.waConexaoId)
      : consulta.eq('wa_account_id', referencia.waAccountId)
    const { data, error } = await consulta.maybeSingle()
    if (error) return 'pendente'
    if (data?.status_entrega === 'delivered' || data?.status_entrega === 'read') return data.status_entrega
    if (data?.status_entrega === 'failed') return 'falhou'
  } catch { /* uma falha de observação não pode provocar outro envio */ }
  return 'pendente'
}
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.3'
