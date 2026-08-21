/**
 * Frases que viram PARÂMETRO de template do WhatsApp — parte pura, sem I/O.
 *
 * Moram aqui, e não no agente.ts, por dois motivos: o agente importa `Deno.env` e o cliente
 * Supabase no topo (não roda sob vitest), e essas frases são exatamente o tipo de coisa que
 * precisa de teste — elas saem para o WhatsApp de um lead, com a marca da PPGVET.
 *
 * ⚠️ REGRA QUE VALE PARA TODAS: **uma linha só**. Parâmetro de corpo com quebra de linha faz
 * a Meta recusar o envio inteiro. O corpo do template pode ter quebras; o parâmetro, não.
 */

/** Tira o prefixo de catálogo ("PÓS | X", "MBA | X") e devolve o nome como se fala. */
export function limparCurso(c: string | null | undefined): string {
  if (!c) return "";
  return String(c)
    .replace(/^p[oó]s\s*\|\s*/i, "")
    .replace(/^mba\s*\|\s*/i, "MBA ")
    .replace(/^curso\s*\|\s*/i, "")
    .trim();
}

/** MBA é "o MBA X"; pós é "a pós em X". Errar o artigo entrega que é robô. */
function comoSeChama(pos: string): string {
  return /^mba\b/i.test(pos.trim()) ? `o ${pos}` : `a pós em ${pos}`;
}

/**
 * {{2}} do template do cronograma.
 * O corpo é "Oi {{1}}. / {{2}} / Consegue confirmar?" — então {{2}} tem que terminar puxando
 * algo que "Consegue confirmar?" complete, senão a última linha fica órfã ("confirmar o quê?").
 */
export function frasePedidoCronograma(curso: string): string {
  return `Segue o cronograma ${comoSeChama(curso)}, que vc pediu no site. Pra eu seguir com o seu atendimento, `
    + "preciso saber se é essa mesmo a pós que te interessa.";
}

/**
 * {{2}} do template da ponte pro WhatsApp (fase 4).
 * O corpo fecha com "Estou por aqui.", então esta frase é o convite em si.
 * Sem curso conhecido ela ainda funciona — o visitante pode ter pedido o WhatsApp antes de
 * escolher a pós, e citar "a pós em " com o nome vazio seria pior que não citar.
 */
export function fraseConviteWhatsapp(curso: string | null | undefined): string {
  const pos = limparCurso(curso);
  if (!pos) return "Pode me responder por aqui que eu sigo com você de onde a gente parou.";
  return `Pode me responder por aqui que a gente segue falando sobre ${comoSeChama(pos)} de onde parou.`;
}
