// Prazo inclui fetch, leitura do corpo e retries. Abort sozinho depende do
// transporte cooperar; o race também libera o worker se ele nunca resolver.
export const PRAZO_MODELO_PILOTO_MS = 45_000;
export const RESPOSTA_MODELO_INDISPONIVEL = 'não consegui concluir sua resposta agora. pode tentar novamente em instantes?';

export async function comPrazoModelo<T>(executar: (sinal: AbortSignal) => Promise<T>, prazoMs: number): Promise<T> {
  if (!Number.isFinite(prazoMs) || prazoMs <= 0) throw new Error('MODELO_PRAZO_INVALIDO');
  const controle = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const limite = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const erro = new Error('MODELO_TEMPO_ESGOTADO');
      controle.abort(erro);
      reject(erro);
    }, prazoMs);
  });
  try { return await Promise.race([executar(controle.signal), limite]); }
  finally { clearTimeout(timer!); }
}
