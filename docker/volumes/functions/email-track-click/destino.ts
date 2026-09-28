/**
 * Destinos a conferir, em ordem: o recebido e, se ele tiver espaço/`<`/`>`, o trecho antes
 * disso.
 *
 * Por que o segundo: de 22/09 a 28/09/2026 o envio reescrevia o link SEM a aspa de
 * fechamento (`links.ts`), e o href engolia o atributo seguinte — o `u` chegava como
 * "https://www.youtube.com/watch?v=… target=". A assinatura (do destino limpo) não conferia
 * e o clique caía em "Link inválido". URL de verdade não tem espaço cru, então o corte
 * devolve exatamente o destino assinado. A trava continua: só redireciona se a assinatura
 * bater com o candidato — nenhum destino novo passa por aqui sem ter sido assinado no envio.
 */
export function candidatosDeDestino(bruto: string): string[] {
  const cortado = bruto.split(/[\s<>]/)[0];
  return cortado && cortado !== bruto ? [bruto, cortado] : [bruto];
}
