// Márcio, 15/09/2026: o campo mensagem de responder_ao_cliente continha um
// relatório "Success / Explanation" depois de </antml>. O schema estava correto,
// mas a fala era uma avaliação interna. Esta régua também protege o replay da
// memória; não depende de Deno, transporte ou do provedor usado para gerar texto.

// O corpus revelou também </antmlpar e </antml.parameter>. Não há limite de
// palavra confiável depois de "antml" quando o modelo corrompe o protocolo.
// Só as tags completas que o removedor legado entende ficam fora desta guarda.
const TAG_RACIOCINIO_CONHECIDA = /^<\/?antml:(?:thinking|thoughts|thought|scratchpad|reasoning|reflection|analysis)(?:\s[^<>]*)?>/i;

/** Prefixo antml corrompido ou desconhecido invalida a saída inteira. */
export function contemArtefatoAntml(texto: string): boolean {
  const original = texto ?? '';
  for (const trecho of original.matchAll(/<\s*\/?\s*antml/gi)) {
    if (!TAG_RACIOCINIO_CONHECIDA.test(original.slice(trecho.index))) return true;
  }
  return false;
}

// <function_results> pode vazar sem nenhuma raiz antml. É protocolo entre
// sistema/modelo, assim como uma instrução para usar o canal pelo nome interno.
const ARTEFATO_FERRAMENTA = /<\s*\/?\s*function_(?:results?|calls?)(?=[\s/>]|$)/i;

function semDecoracaoMarkdown(texto: string): string {
  return (texto ?? '').normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/\*{1,3}|`{1,3}|~~/g, '')
    // Sublinhados no meio de atendimento_incompativel são parte do identificador,
    // enquanto _Explanation_ é somente decoração do cabeçalho.
    .replace(/(?<!\w)_{1,3}|_{1,3}(?!\w)/g, '')
    .replace(/^[ \t]*(?:>[ \t]*)*(?:#{1,6}[ \t]*)?(?:(?:[-+]|\d+[.)])[ \t]+)?(?:[✅❌✔✘✓✗]\uFE0F?[ \t]*)?/gm, '')
    .trim();
}

const STATUS = '(?:success|failure|pass|fail|passed|failed|successful|unsuccessful)';
const EXPLICACAO = '(?:explanation|rationale|reasoning|assessment|evaluation|justification)';
const CABECALHO_STATUS = new RegExp(`^(?:(?:status|result|outcome|evaluation)[ \\t]*:[ \\t]*)?${STATUS}[ \\t]*[:.!]?[ \\t]*$`, 'im');
const CABECALHO_EXPLICACAO = new RegExp(`^${EXPLICACAO}(?:[ \\t]*:|[ \\t]*$)`, 'im');
const AVALIACAO_NA_MESMA_LINHA = new RegExp(`^(?:(?:status|result|outcome)[ \\t]*:[ \\t]*)?${STATUS}[ \\t]*(?:[:;.|—–-][ \\t]*)?${EXPLICACAO}[ \\t]*:`, 'im');
const JULGAMENTO_IMPESSOAL = /(?:^|\n|[.!?][ \t]+)(?:(?:the[ \t]+)?(?:assistant|agent|model|response|answer)[ \t]+)?(?:correctly|accurately|appropriately|properly|successfully)[ \t]+(?:identifies|recognizes|concludes|determines|understands|handles|follows|avoids|maintains|refrains|responds|remains)\b/i;
const ASSUNTO_DO_FLUXO = /\b(?:paus(?:e|ed|ing)|automated[ \t]+(?:message|reply|response)|(?:new|further|additional)[ \t]+(?:response|reply|action)|remain(?:s|ed)?[ \t]+silent|silence|tool[ \t]+(?:call|result)|function[ \t]+call|workflow|conversation|user|lead)\b/i;
const SILENCIO_NARRADO = /^(?:(?:the[ \t]+)?(?:assistant|agent|model)[ \t]+(?:should[ \t]+)?remain(?:s|ed)?[ \t]+silent\b|(?:so[ \t]+)?remain(?:s|ed)?[ \t]+silent[.!]?[ \t]*$)/im;

/**
 * Detecta a estrutura de uma avaliação, não palavras inglesas avulsas. Uma frase
 * legítima citando "success" ou "explanation" continua permitida. O julgamento
 * impessoal sem cabeçalho exige também assunto do fluxo para não bloquear, por
 * exemplo, uma descrição de conteúdo veterinário em inglês.
 */
export function contemAvaliacaoInterna(texto: string): boolean {
  const normalizado = semDecoracaoMarkdown(texto);
  if (!normalizado) return false;
  if (ARTEFATO_FERRAMENTA.test(normalizado)) return true;
  if (/\b(?:atendimento_incompativel|responder_ao_cliente)\b/i.test(normalizado)) return true;
  if (CABECALHO_STATUS.test(normalizado) && CABECALHO_EXPLICACAO.test(normalizado)) return true;
  if (AVALIACAO_NA_MESMA_LINHA.test(normalizado)) return true;
  return SILENCIO_NARRADO.test(normalizado)
    || (JULGAMENTO_IMPESSOAL.test(normalizado) && ASSUNTO_DO_FLUXO.test(normalizado));
}

export function contemBastidorEditorial(texto: string): boolean {
  return contemArtefatoAntml(texto) || contemAvaliacaoInterna(texto);
}
