/** Efeito confirmado pelo adaptador de envio, nunca inferido do nome da ferramenta. */
export type EfeitoWhatsAppConfirmado = {
  tipo: "cronograma" | "transferencia";
  curso: string | null;
};

type ClienteContinuidade = {
  rpc: (nome: string, parametros: Record<string, unknown>) => PromiseLike<{
    error: { message: string } | null;
  }>;
};

/**
 * A RPC faz histórico, marcador e vínculo na mesma transação. Não escondemos erro:
 * o chamador registra a falha como best-effort sem repetir o envio já confirmado.
 * O modo_teste é conferido no banco antes de qualquer escrita.
 */
export async function semearHistoricoWhatsApp(
  supabase: ClienteContinuidade,
  sessaoId: string,
  efeito: EfeitoWhatsAppConfirmado,
): Promise<void> {
  const { error } = await supabase.rpc("webchat_semear_historico_whatsapp", {
    p_sessao_id: sessaoId,
    p_tipo: efeito.tipo,
    p_curso: efeito.curso,
  });
  if (error) throw new Error(`semearHistoricoWhatsApp: ${error.message}`);
}
