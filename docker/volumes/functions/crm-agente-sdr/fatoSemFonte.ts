// Alerta de ponto de uso: pergunta sobre título, reconhecimento ou validade — só no canário.
//
// Duelo cego Luna × Sonnet 5 (25/09/2026): a lead disse que, para valer o título de especialista,
// a pós precisaria se chamar "Medicina Endocanabinoide". A Luna respondeu de memória, sem chamar
// ferramenta, citando a entidade que concederia o título "conforme o edital" — nada disso estava
// na conversa nem em ferramenta alguma. A regra geral no system (INSTRUCAO_FICHA) não bastou duas
// rodadas seguidas; a Luna segue a frase exata no ponto de uso. Aqui o código reconhece o assunto
// na última fala do lead e põe a ordem no bloco da ficha daquela rodada.

const RE_TITULO_RECONHECIMENTO = new RegExp([
  String.raw`t[ií]tulo\s+de\s+especialista`,
  String.raw`\breconhecid[oa]s?\b`,
  String.raw`\breconhecimento\b`,
  String.raw`\bmec\b`,
  String.raw`\bcfmv\b`,
  String.raw`\bcrmv\b`,
  String.raw`\bedital\b`,
  String.raw`certificado\s+(?:[ée]\s+)?v[áa]lido`,
  String.raw`\bvale\s+(?:como|pra|para)\s+(?:o\s+)?t[ií]tulo`,
].join('|'), 'i');

export const ALERTA_FATO_SEM_FONTE = '[ATENÇÃO NESTA RESPOSTA] O lead falou de título, reconhecimento ou validade da pós. '
  + 'Chame consulta_objecoes com tipo_objecao="pergunta_instituicao" e responda só com o que ela devolver. '
  + 'Não cite entidade, conselho, edital, sigla ou regra que nenhuma ferramenta trouxe nesta conversa; '
  + 'o que a ferramenta não responder, diga que o monitor explica certinho na conversa.';

/** Alerta para o bloco da ficha quando a ÚLTIMA fala do lead toca em título/reconhecimento. */
export function alertaFatoSemFonte(ultimaFalaDoLead: string | undefined): string | null {
  return ultimaFalaDoLead && RE_TITULO_RECONHECIMENTO.test(ultimaFalaDoLead) ? ALERTA_FATO_SEM_FONTE : null;
}
