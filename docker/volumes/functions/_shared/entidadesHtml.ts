/**
 * Decodifica entidades HTML de um TEXTO (og:title, og:description, og:image lidos do HTML da página).
 *
 * Existe porque o unfurl lê as meta tags com regex e devolvia o atributo cru: o título do Instagram
 * chegava ao cartão como `Fulano on Instagram: &quot;Eu j&#xe1; passei…`. Roda na edge
 * (`unfurl-url`) e no front (cartões já salvos com o texto cru), por isso é TS puro, sem DOM.
 *
 * Uma passada só (`&amp;quot;` vira `&quot;`, como o navegador faz). Entidade desconhecida ou número
 * fora do Unicode fica como está. O resultado é TEXTO: quem exibe continua escapando/usando textContent.
 */
const NOMEADAS: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  laquo: "«", raquo: "»", middot: "·", bull: "•", copy: "©", reg: "®", trade: "™", deg: "°",
  ordf: "ª", ordm: "º", euro: "€", iexcl: "¡", iquest: "¿",
  aacute: "á", Aacute: "Á", agrave: "à", Agrave: "À", acirc: "â", Acirc: "Â", atilde: "ã", Atilde: "Ã",
  auml: "ä", Auml: "Ä", eacute: "é", Eacute: "É", egrave: "è", Egrave: "È", ecirc: "ê", Ecirc: "Ê",
  euml: "ë", Euml: "Ë", iacute: "í", Iacute: "Í", igrave: "ì", Igrave: "Ì", icirc: "î", Icirc: "Î",
  iuml: "ï", Iuml: "Ï", oacute: "ó", Oacute: "Ó", ograve: "ò", Ograve: "Ò", ocirc: "ô", Ocirc: "Ô",
  otilde: "õ", Otilde: "Õ", ouml: "ö", Ouml: "Ö", uacute: "ú", Uacute: "Ú", ugrave: "ù", Ugrave: "Ù",
  ucirc: "û", Ucirc: "Û", uuml: "ü", Uuml: "Ü", ccedil: "ç", Ccedil: "Ç", ntilde: "ñ", Ntilde: "Ñ",
};

export function decodificarEntidadesHtml(texto: string | null | undefined): string {
  if (!texto || !texto.includes("&")) return texto ?? "";
  return texto.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,8});/g, (inteira, corpo: string) => {
    if (corpo[0] !== "#") return NOMEADAS[corpo] ?? inteira;
    const n = corpo[1] === "x" || corpo[1] === "X" ? parseInt(corpo.slice(2), 16) : parseInt(corpo.slice(1), 10);
    // 0, surrogates e além do Unicode não viram caractere.
    if (!n || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return inteira;
    return String.fromCodePoint(n);
  });
}
