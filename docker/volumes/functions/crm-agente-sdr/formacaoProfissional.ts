// 14/11/2026: a regra comercial vale para as demais áreas, não só veterinária.
// Reconhecer a formação evita repetir a entrevista; não aprova a pós nem verifica diploma.
const normalizar = (fala: string) => fala
  .replace(/"[^"]*"|“[^”]*”|'[^']*'/g, '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const TITULOS = /\b(?:sou|atuo\s+como|trabalho\s+como)\s+(?:um[ae]?\s+)?((?:medic[oa]\s+)?veterinari[oa]|vet|zootecnista|agronom[oa]|engenheir[oa](?:\s+(?:de\s+(?:alimentos|producao)|agronom[oa]|agricola))?|biolog[oa]|advogad[oa]|dentista|nutricionista|farmaceutic[oa]|biomedic[oa]|medic[oa]|enfermeir[oa]|fisioterapeuta|psicolog[oa]|contador[ae]?|pedagog[oa])\b/;
const TITULO_RESPOSTA = /^(?:(?:medic[oa]\s+)?veterinari[oa]|vet|zootecnista|agronom[oa]|engenheir[oa](?:\s+(?:de\s+(?:alimentos|producao)|agronom[oa]|agricola))?|biolog[oa]|advogad[oa]|dentista|nutricionista|farmaceutic[oa]|biomedic[oa]|medic[oa]|enfermeir[oa]|fisioterapeuta|psicolog[oa]|contador[ae]?|pedagog[oa])(?:[.!;,]|$)/;
const RESSALVA = /\b(?:ainda\s+)?nao\s+(?:me\s+formei|conclui|terminei)|\b(?:sou|estou|to)\s+(?:ainda\s+)?(?:estudante|estagiari[oa])|\b(?:ainda\s+(?:curso|estudo|faco)|cursando\s+(?:a\s+)?(?:graduacao|medicina\s+veterinaria))|\b(?:me\s+formo|vou\s+me\s+formar)\b/;

/** Recebe apenas falas próprias, já sem citação e sem registros internos (falasDoLead). */
export function declaracaoProfissionalDeConclusao(falas: readonly string[]): string | null {
  const textos = falas.map(normalizar);
  // Sem evidência suficiente para vincular duas graduações, prefira esclarecer a situação.
  const cursoEmAndamento = /\b(?:curso|estudo|faco)\s+(?:a\s+)?(?:graduacao|medicina\s+veterinaria|veterinaria|agronomia|nutricao|direito|biologia|odontologia|farmacia|enfermagem|fisioterapia|psicologia)\b|\b(?:estou|to)\s+no\s+\d+[oaºª]?\s+(?:periodo|semestre)\b/;
  if (textos.some(t => RESSALVA.test(t) || cursoEmAndamento.test(t))) return null;
  for (let i = 0; i < textos.length; i++) {
    const t = textos[i];
    const m = TITULOS.exec(t);
    const antes = m ? t.slice(Math.max(0, m.index - 35), m.index) : '';
    if ((m && !/\b(?:nao|nunca|quero|pretendo|se|quando)\s+(?:\S+\s+){0,2}$/.test(antes)) || TITULO_RESPOSTA.test(t)) return falas[i].slice(0, 160);
  }
  // Exemplo que motivou a correção: curso próprio + exercício clínico, inclusive
  // em respostas separadas. Não combina campos do CRM nem profissão de terceiros.
  const cursoProprio = /\bminha\s+(?:graduacao|formacao)\s+(?:(?:e|eh|foi)\s+)?(?:em\s+)?(?:medicina\s+veterinaria|med\s*vet)\b|^(?:medicina\s+veterinaria|med\s*vet)\b/;
  const clinica = /\b(?:ja\s+)?(?:atuo|trabalho|atendo)\s+(?:(?:em|na|no|com|uma|um|a|o|area|de|da|do|parte)\s+){0,5}(?:clinica|clinico|consultorio|atendimento\s+clinico)\b/;
  const apoio = /\b(?:como|de|sou)\s+(?:auxiliar|tecnic[oa]|estagiari[oa]|recepcionista)\b/;
  const negaAtuacao = /\b(?:nao|nunca|quero|pretendo|vou|gostaria\s+de)\s+(?:\S+\s+){0,2}(?:atuo|trabalho|atendo|atuar|trabalhar|atender)\b/;
  if (textos.some(t => apoio.test(t) || negaAtuacao.test(t))) return null;
  const c = textos.findIndex(t => cursoProprio.test(t));
  const a = textos.findIndex(t => clinica.test(t));
  return c >= 0 && a >= 0 ? [...new Set([falas[c], falas[a]])].join(' / ').slice(0, 320) : null;
}
