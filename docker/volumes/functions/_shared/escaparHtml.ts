/**
 * Escapa texto para interpolar dentro de HTML.
 *
 * ⚠️ Existe porque as páginas de retorno dos callbacks de OAuth montam HTML com template
 * string e jogavam parâmetro de URL lá dentro sem tratar. Provado em produção em 12/10/2026:
 * `?error=<b id=xss>INJETADO</b>` voltava renderizado na página. São páginas PÚBLICAS (o
 * callback não exige login), então o link podia ser mandado para qualquer pessoa.
 *
 * Use em TODO valor que não nasceu no nosso código: parâmetro de URL, mensagem de exceção,
 * nome de perfil vindo da API de terceiro. O que é HTML nosso de propósito (um `<span>` de
 * layout) passa direto — o escape é no pedaço de fora, não no molde.
 */
export function escaparHtml(valor: unknown): string {
  return String(valor ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
