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

const MINUSCULAS = new Set(["de", "da", "do", "das", "dos", "e", "em", "na", "no", "com", "a", "o"]);
const SIGLAS = new Set(["rh", "ia", "ti"]);

/**
 * Tira o prefixo de catálogo ("PÓS | X", "MBA | X", "MBA X") e devolve o nome como se fala.
 * Sem "MBA": para o visitante tudo é pós-graduação (marca.md, 16/11/2026). Nome do banco em
 * caixa alta ("GESTÃO DE COOPERATIVAS DE CRÉDITO") volta em caixa de título.
 */
export function limparCurso(c: string | null | undefined): string {
  if (!c) return "";
  const s = String(c)
    .replace(/^\s*(p[oó]s|mba|curso)\s*\|\s*/i, "")
    .replace(/^mba\s+/i, "")
    .trim();
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().split(" ")
    .map((p, i) => (SIGLAS.has(p) ? p.toUpperCase() : i && MINUSCULAS.has(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(" ");
}

function comoSeChama(pos: string): string {
  return `a pós em ${limparCurso(pos)}`;
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
