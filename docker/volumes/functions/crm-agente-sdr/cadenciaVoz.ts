// 22/09/2026: a escolha texto/áudio é um contador durável, não outra inferência.
// Uma resposta com vários balões conta uma vez, depois do primeiro aceite.
export type BancoCadenciaVoz = {
  rpc: (nome: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
};
export type ChaveCadenciaVoz = {
  contaId: string;
  telefone: string;
  interacaoId: string;
};
export type PlanoCadenciaVoz = {
  audioDevido: boolean;
  concluida: boolean;
  alvo: number;
  interacoes: number;
};

export async function planejarCadenciaVoz(banco: BancoCadenciaVoz, chave: ChaveCadenciaVoz): Promise<PlanoCadenciaVoz> {
  const { data, error } = await banco.rpc('crm_sdr_voz_planejar', {
    p_wa_account_id: chave.contaId, p_telefone: chave.telefone, p_interacao_id: chave.interacaoId,
  });
  if (error || !data || typeof data !== 'object' || Array.isArray(data)) throw new Error('cadencia_voz_indisponivel');
  const plano = data as Record<string, unknown>;
  if (!Number.isInteger(plano.alvo) || Number(plano.alvo) < 3 || Number(plano.alvo) > 5
    || !Number.isInteger(plano.interacoes) || Number(plano.interacoes) < 0 || Number(plano.interacoes) > Number(plano.alvo)
    || typeof plano.audio_devido !== 'boolean' || typeof plano.interacao_concluida !== 'boolean') {
    throw new Error('cadencia_voz_invalida');
  }
  return {
    audioDevido: plano.audio_devido && !plano.interacao_concluida,
    concluida: plano.interacao_concluida,
    alvo: Number(plano.alvo), interacoes: Number(plano.interacoes),
  };
}

export async function confirmarInteracaoVoz(
  banco: BancoCadenciaVoz, chave: ChaveCadenciaVoz, canal: 'texto' | 'audio', waMessageId?: string,
): Promise<void> {
  const { data, error } = await banco.rpc('crm_sdr_voz_confirmar', {
    p_wa_account_id: chave.contaId, p_telefone: chave.telefone, p_interacao_id: chave.interacaoId,
    p_canal: canal, p_wa_message_id: waMessageId ?? null,
  });
  if (error || !data || typeof data !== 'object' || (data as Record<string, unknown>).confirmado !== true) {
    throw new Error('cadencia_voz_confirmacao_indisponivel');
  }
}
