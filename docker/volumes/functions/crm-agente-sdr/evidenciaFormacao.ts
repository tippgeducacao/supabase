import type { Msg } from './historico.ts';

export type EvidenciaSemGraduacao = {
  autorizada: boolean;
  motivo: 'declaracao_explicita' | 'sem_declaracao_explicita' | 'formacao_ou_curso_informado';
  indiceMensagem?: number;
};

// 12/09/2026, Angélica: “nenhuma” sobre ATUAÇÃO virou falta de graduação e
// arquivamento. Esta guarda não tenta deduzir escolaridade: só reconhece uma
// lista curta de declarações completas, próprias e atuais. Qualquer formulação
// fora do contrato exige esclarecer, pois uma falsa saída definitiva custa mais
// que deixar de automatizar uma pausa. Não é validação documental de formação.
const SUPERIOR = '(?:faculdade|graduacao|ensino superior|curso superior|universidade)';
const NUNCA_CURSOU = new RegExp(`^(?:eu )?nunca (?:fiz|cursei|iniciei|comecei|frequentei)(?: (?:uma?|nenhuma?))? ${SUPERIOR}$`);
// “Só fiz/concluí técnico” pode responder quais cursos fez ESTE ANO, mesmo
// tendo graduação anterior. Só a declaração de formação possuída entra aqui.
const UNICA_FORMACAO = /^(?:(?:eu )?(?:(?:so|somente|apenas) tenho|tenho (?:so|somente|apenas))(?: o)?|minha unica formacao e(?: o)?) (?:ensino medio|segundo grau|curso tecnico|tecnico)(?: completo| concluido)?$/;
const SEM_DIPLOMA = new RegExp(`^(?:eu )?nao (?:tenho|possuo)(?: (?:nenhuma|qualquer))? ${SUPERIOR}(?: complet[ao]| concluid[ao])?$`);
const NAO_CURSA = new RegExp(`^(?:eu )?nao (?:(?:estou|to) (?:cursando|fazendo)|curso|faco|frequento)(?: (?:uma?|nenhuma?))? ${SUPERIOR}$`);
// 15/09/2026: estes títulos também são informação conflitante com "nunca
// cursei faculdade". Isto só impede arquivamento automático; não aprova a
// formação, não chama a matriz e não classifica graduação por regex.
const TITULO_PROFISSIONAL = '(?:zootecnista|(?:sub[ -]?)?chefe de veterinaria)';
const TITULO_DECLARADO = new RegExp(`^(?:eu )?(?:sou|trabalho como) ${TITULO_PROFISSIONAL}(?:$|[ ,:])`);
const TITULO_COMO_RESPOSTA = new RegExp(`^${TITULO_PROFISSIONAL}$`);

function normalizar(texto: string): string {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function textoDoLead(mensagem: Msg): string | null {
  if (mensagem?.role !== 'user') return null;
  const texto = typeof mensagem.content === 'string' ? mensagem.content
    : Array.isArray(mensagem.content) ? mensagem.content
      .filter((bloco) => bloco?.type === 'text' && typeof bloco.text === 'string')
      .map((bloco) => bloco.text).join('\n') : '';
  // Tool results têm role=user na API, mas nunca são declaração do contato.
  if (!texto.trim()) return null;
  if (/\[(?:ATENDIMENTO_HUMANO|INTERNAL_|CONTEXTO DO ATENDIMENTO)/i.test(texto)) return null;
  return texto
    .replace(/^\[MENSAGEM_LEAD_PAUSA\][^\n]*\n/i, '')
    .replace(/^\[Transcrição do áudio recebido do lead\]\s*/i, '')
    .replace(/\[Em resposta [^\]]*\]/gi, '')
    .replace(/```[\s\S]*?```/g, '[citacao]')
    .replace(/^\s*>.*$/gm, '[citacao]')
    .replace(/"[^"\n]*"|“[^”]*”|‘[^’]*’|'[^'\n]*'|`[^`]*`/g, '[citacao]')
    .trim();
}

function declaracoes(texto: string): string[] {
  // Separar antes de retirar acentos: o verbo “é” não é a conjunção “e”.
  return texto.split(/[.;!\n]+|\s+(?:e|nem)\s+/i)
    .map((parte) => normalizar(parte).replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function negativaConhecida(frase: string): boolean {
  return NUNCA_CURSOU.test(frase) || UNICA_FORMACAO.test(frase)
    || SEM_DIPLOMA.test(frase) || NAO_CURSA.test(frase);
}

function temOutraInformacaoAcademica(texto: string): boolean {
  // Ampla só para BLOQUEAR, nunca para autorizar. Por exemplo, “sou técnica e
  // estou no 5º semestre” não vira ausência de graduação. Uma pergunta/menção
  // ambígua de formação também conserva o atendimento até esclarecer.
  const restante = declaracoes(texto).filter((frase) => !negativaConhecida(frase)).join('\n');
  return /\b(?:graduacao|faculdade|universidade|superior|pos|mestrado|doutorado|bacharel|licenciad[oa]|formad[oa]|graduad[oa]|universitari[oa]|graduand[oa]|estudante|cursando|estudando|semestre|periodo|me formei|me formo)\b/.test(restante)
    || /\b(?:sou|trabalho como) (?:medic[oa]|veterinari[oa]|enfermeir[oa]|engenheir[oa]|advogad[oa])\b/.test(restante)
    || restante.split('\n').some((frase) => !frase.includes('?')
      && (TITULO_DECLARADO.test(frase) || TITULO_COMO_RESPOSTA.test(frase)));
}

export function avaliarEvidenciaSemGraduacao(historico?: readonly Msg[]): EvidenciaSemGraduacao {
  const falas = (historico ?? []).map((mensagem, indiceMensagem) => ({
    texto: textoDoLead(mensagem), indiceMensagem,
  })).filter((fala): fala is { texto: string; indiceMensagem: number } => fala.texto !== null);
  const ultima = falas.at(-1);
  if (!ultima) return { autorizada: false, motivo: 'sem_declaracao_explicita' };

  // Conflito de formação, inclusive antigo, requer esclarecimento humano/lead.
  // Ausência de campo no cadastro e motivo escrito pela IA não entram aqui.
  if (falas.some((fala) => temOutraInformacaoAcademica(fala.texto))) {
    return { autorizada: false, motivo: 'formacao_ou_curso_informado' };
  }

  const frases = declaracoes(ultima.texto);
  const apenasDeclaracoes = frases.length > 0 && frases.every(negativaConhecida);
  const nuncaOuUnica = frases.some((frase) => NUNCA_CURSOU.test(frase) || UNICA_FORMACAO.test(frase));
  const semDiplomaENaoCursa = frases.some((frase) => SEM_DIPLOMA.test(frase))
    && frases.some((frase) => NAO_CURSA.test(frase));
  if (!apenasDeclaracoes || (!nuncaOuUnica && !semDiplomaENaoCursa)) {
    return { autorizada: false, motivo: 'sem_declaracao_explicita' };
  }
  return { autorizada: true, motivo: 'declaracao_explicita', indiceMensagem: ultima.indiceMensagem };
}

export function bloqueioSemEvidenciaGraduacao(id: string) {
  return {
    status: 'bloqueado',
    codigo: 'SEM_EVIDENCIA_SEM_GRADUACAO',
    resultado: 'Pausa e arquivamento NÃO executados: não há declaração própria, explícita e atual suficiente no histórico real do lead para concluir ausência de graduação e de curso superior em andamento. '
      + 'Não afirme que ele não tem graduação, não o desqualifique nem encerre o atendimento. '
      + 'Atuação profissional, campo vazio, falas de vendedores, citações e o motivo escrito por você não comprovam formação. '
      + 'Respeite o objetivo atual: se veio para aula aberta/conteúdo gratuito, continue nesse contexto sem entrevista de matrícula. '
      + 'Só se houver interesse em pós e a formação ainda for pertinente e desconhecida, esclareça-a com uma pergunta breve e neutra; aproveite o que o lead já informou. '
      + 'Não tente contornar esta recusa mudando o tipo ou o motivo da pausa.',
    id,
  };
}
