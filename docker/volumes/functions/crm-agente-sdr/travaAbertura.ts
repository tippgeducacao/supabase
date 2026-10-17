// Convite sem a abertura do lote (16/10/2026, caso Antônio).
//
// Sanidade Avícola (exclusiva de vet) → "quer conhecer gestão e produção avícola?" → "Sim". A IA tratou o
// "Sim" como aceite da reunião, checou a formação (APROVADO), consultou horários e mandou "é uma conversa
// individual de 10 minutos com o monitor… quer marcar?". A abertura (o lote promocional, o que o monitor
// mostra e por que a condição só sai no meet) nunca foi dita, mesmo com o bloco do mapa dizendo "hora da
// abertura" nas três rodadas: a regra "com APROVADO, todo convite leva horário" passou na frente.
//
// Conferência na fala, como as de valor e de reunião (travasDeterministicas.ts): convite pro meet ou horário
// sem a abertura feita nesta conversa volta UMA vez para a IA refazer começando por ela.
import type { Msg } from './historico.ts';
import { resultadosDeFerramenta } from './travasDeterministicas.ts';
import { cursoDaConversa } from './ganchoLote.ts';

const textoDe = (m: Msg): string => typeof m.content === 'string' ? m.content
  : Array.isArray(m.content) ? m.content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n') : '';

const RE_CONVITE = /\b(?:monitor|meet|reuni[aã]o)\b|\b(?:[01]?\d|2[0-3])h(?:[0-5]\d)?\b/i;
// Abertura feita = o lote E o porquê do meet. Só "estamos em fechamento do primeiro lote promocional" (o toque da
// pendência do follow-up, 17/10/2026) não explica o meet e não conta.
const aberturaFeita = (t: string) => /condi[cç][aã]o promocional exclusiva/i.test(t)
  || (/primeiro lote promocional/i.test(t) && /\b(?:meet|monitor)\b/i.test(t));

/** A fala convida pro meet (ou oferece horário) sem que a abertura do lote tenha sido feita na conversa? */
export function conviteSemAbertura(resposta: string, historico: readonly Msg[]): boolean {
  if (!RE_CONVITE.test(resposta) || aberturaFeita(resposta)) return false;
  // A 1ª fala nossa é o template; o vendedor humano também conta (se ele já apresentou, não repetimos).
  return !historico.some((m) => m?.role === 'assistant' && aberturaFeita(textoDe(m)));
}

/** O curso da abertura: o último APROVADO da conversa (a alternativa aceita) ou o do cadastro. */
export function cursoDaAbertura(historico: readonly Msg[], cadastro: string | null | undefined): string {
  const aprovados = resultadosDeFerramenta(historico).filter((r) => r?.compativel === true && typeof r?.curso_solicitado === 'string');
  return String(aprovados.at(-1)?.curso_solicitado ?? cadastro ?? '');
}

export function correcaoDaAbertura(texto: string, curso: string): string {
  const abertura = `a gente tá fechando o primeiro lote promocional ${cursoDaConversa(curso)}, e eu queria te mostrar a condição, `
    + 'como funcionam as aulas, o cronograma e quem são os professores. é uma conversa rápida no meet com um monitor especialista, '
    + 'uns 10 minutos, e vc já tira suas dúvidas.';
  return '[CORRECAO_INTERNA_AUTO_IGNORE] Sua última mensagem NÃO foi enviada ao lead: ela convida pra conversa com o monitor (ou '
    + 'oferece horário) sem a abertura do lote, que ainda não foi feita nesta conversa. O lead precisa saber POR QUE ir ao meet. '
    + `Refaça começando pela abertura, com estas palavras: "${abertura}" e depois o resto (os horários, se você já tinha). `
    + 'Não use "conversa individual". O texto barrado foi:\n"""\n' + texto.slice(0, 600) + '\n"""\nNão mencione esta correção ao lead.';
}
