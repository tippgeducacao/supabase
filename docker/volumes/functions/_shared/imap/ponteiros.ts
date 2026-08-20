/**
 * Onde o sync COMEÇA numa pasta: o teto (mensagem nova) e a fronteira do histórico.
 *
 * Isto é aritmética de intervalo, e é onde mora o erro de ±1 clássico — que aqui
 * não some uma linha de log, some **uma mensagem inteira**, em silêncio. Por isso
 * é função pura, com teste, em vez de três linhas dentro da edge.
 */

export interface PontoDePartida {
  /** Mensagem nova é UID **maior** que este. */
  teto: number;
  /** O histórico busca UIDs **menores** que este. */
  backfill: number;
  /** Verdadeiro quando a caixa foi adotada agora (primeira vez com dois ponteiros). */
  adotou: boolean;
}

/**
 * @param uidNext   `UIDNEXT` do `SELECT` — o UID que a PRÓXIMA mensagem vai receber.
 * @param teto      `ultimo_uid` guardado.
 * @param backfill  `uid_backfill` guardado; `null` = caixa ainda sem histórico iniciado.
 */
export function pontoDePartida(
  uidNext: number,
  teto: number,
  backfill: number | null | undefined,
): PontoDePartida {
  if (backfill !== null && backfill !== undefined) {
    return { teto, backfill, adotou: false };
  }

  // Adoção: a caixa passa a estar EM DIA agora, e o histórico vem por trás.
  const maiorNoServidor = Math.max(Number(uidNext) - 1, teto, 0);

  // ⚠️ `backfill` é EXCLUSIVO (busca-se abaixo dele) e `teto` também (busca-se acima
  // dele). Usar o mesmo número nos dois deixa exatamente **um UID sem dono**: o
  // maior do servidor não entra no topo (não é maior que ele mesmo) nem no
  // histórico (não é menor que ele mesmo). Foi assim que o e-mail que a pessoa
  // acabara de receber ficou invisível — e um furo de uma mensagem só é bem mais
  // difícil de notar do que um sync parado.
  return { teto: maiorNoServidor, backfill: maiorNoServidor + 1, adotou: true };
}
