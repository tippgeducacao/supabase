// 22/09/2026: a fala do WhatsApp usa "vc" e "kkk", mas o TTS soletrava essas
// marcas. Esta projeção é só para áudio: não reescreve fatos, não chama LLM e
// nunca substitui o texto original usado no fallback ou no envio por escrito.
const ABREVIACOES = new Map([
  ['vc', 'você'], ['vcs', 'vocês'], ['tb', 'também'], ['tbm', 'também'],
  ['hj', 'hoje'], ['amnh', 'amanhã'], ['agr', 'agora'], ['dps', 'depois'],
  ['msg', 'mensagem'], ['msgs', 'mensagens'], ['pfv', 'por favor'], ['pfvr', 'por favor'],
  ['qdo', 'quando'], ['qnd', 'quando'], ['pq', 'por que'], ['blz', 'beleza'],
  ['ctz', 'certeza'], ['msm', 'mesmo'], ['vdd', 'verdade'], ['td', 'tudo'],
]);

// O piloto já mantém links/dados copiáveis em texto. Mesmo assim, o helper não
// pode alterar endereços nem literais caso receba uma frase com esses trechos.
const TRECHOS_LITERAIS = /((?:https?:\/\/|www\.)[^\s<>]+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|`[^`\n]+`)/giu;
const PALAVRA = /(^|[^\p{L}\p{M}\p{N}_])([a-z]+)(?=$|[^\p{L}\p{M}\p{N}_])/giu;
const RISADA = /(^|[^\p{L}\p{M}\p{N}_])(?:k{2,}|(?:rs){2,}|(?:ha){2,}|(?:he){2,})(?=$|[^\p{L}\p{M}\p{N}_])/giu;

export function normalizarTextoParaVoz(texto: string): string {
  return texto.split(TRECHOS_LITERAIS).map((trecho, i) => {
    if (i % 2) return trecho;
    let fala = trecho.replace(PALAVRA, (original, antes: string, palavra: string) => {
      // TB/TD/AGR podem ser siglas profissionais. VC/VCS são o caso explícito
      // de pronome em caixa alta; não adivinhar outras siglas ou letras isoladas.
      if (palavra === palavra.toUpperCase() && !['VC', 'VCS'].includes(palavra)) return original;
      const expandida = ABREVIACOES.get(palavra.toLowerCase());
      return expandida ? antes + expandida : original;
    });
    const antesDaRisada = fala;
    // Multilingual v2: omitir a marca escrita; não enviar [laughs] nem "ha ha"
    // como promessa de risada natural. Não há síntese adicional de efeito sonoro.
    fala = fala.replace(RISADA, '$1').replace(/\[(?:risos|risada|laughs|laughing)\]/gi, '');
    if (fala !== antesDaRisada) fala = fala
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+([,;:.!?])/g, '$1')
      .replace(/[,;:](?=\s*[,;:.!?])/g, '')
      .replace(/^[\s,;:.!?]+/, '');
    return fala;
  }).join('').trim();
}
