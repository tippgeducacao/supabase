// 05/09/2026: a menção a dinheiro não basta quando o lead nega a dificuldade.
// Mantemos o léxico comercial existente e verificamos a negação de CADA ocorrência:
// "não estou sem dinheiro, mas não consigo pagar" ainda tem uma dor afirmada.
const RE_DOR_FINANCEIRA =
  /\b(?:n[ãa]o\s+(?:tenho|tenho\s+como|consigo|dá\s+pra|da\s+pra|teria)\s+(?:condi[çc][õo]es|condi[çc][ãa]o|pagar|assumir|arcar|bancar)|sem\s+(?:condi[çc][õo]es|dinheiro|renda|grana|or[çc]amento)|fora\s+do\s+(?:meu\s+)?or[çc]amento|apertad[oa]\s+(?:agora|no\s+momento)|desempregad[oa]|entre\s+empregos|n[ãa]o\s+cabe\s+no\s+(?:meu\s+)?bolso|parcela\s+(?:alta|pesada|salgada)|t[áa]\s+caro\s+demais|muito\s+caro\s+pra\s+mim)\b/gi;

// Escopo local e explícito, sem atravessar outras orações/pontuação. O "não" de
// "não consigo pagar" pertence ao match financeiro, não ao prefixo, e é preservado.
// "não só/apenas" não é negação da dificuldade e não entra nestes padrões.
const RE_NEGACAO_ANTES = /\b(?:nao|nunca|nem)\s+(?:(?:e|eh)\s+que\s+(?:eu\s+)?|(?:(?:estou|esta|estamos|estao|to|ta|tou|sou|somos|e|eh|fico|fica|estava|era|tenho|tem)\s+)?(?:(?:mais|realmente|atualmente)\s+)?(?:um|uma)?\s*)$/;
// Inversão comum: "sem dinheiro não estou". Exigimos fim de oração para não
// confundir "estou sem dinheiro, não é de hoje" com uma negação da dificuldade.
// Interrogação não encerra este padrão: "é uma parcela alta, não é?" confirma a dor.
const RE_NEGACAO_DEPOIS = /^\s*,?\s*(?:eu\s+)?nao\s+(?:estou|esta|to|ta|sou|e|eh|fico|estava|era)(?:\s+mais)?\s*(?=$|[.!;,]|\b(?:mas|porem)\b)/;

function normalizarNegacao(texto: string): string {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export function temDorFinanceira(mensagem: string): boolean {
  for (const trecho of mensagem.matchAll(RE_DOR_FINANCEIRA)) {
    const inicio = trecho.index!;
    const antes = normalizarNegacao(mensagem.slice(0, inicio));
    const depois = normalizarNegacao(mensagem.slice(inicio + trecho[0].length));
    if (RE_NEGACAO_ANTES.test(antes) || RE_NEGACAO_DEPOIS.test(depois)) continue;
    return true;
  }
  return false;
}
