import type { Msg } from './historico.ts';

export type EvidenciaSemGraduacao = {
  autorizada: boolean;
  motivo: 'declaracao_explicita' | 'resposta_a_pergunta' | 'sem_declaracao_explicita' | 'formacao_ou_curso_informado';
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

export function textoDoLead(mensagem: Msg): string | null {
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

export function avaliarEvidenciaSemGraduacao(historico?: readonly Msg[], opcoes: { respostaCurta?: boolean } = {}): EvidenciaSemGraduacao {
  const falas = (historico ?? []).map((mensagem, indiceMensagem) => ({
    texto: textoDoLead(mensagem), indiceMensagem,
  })).filter((fala): fala is { texto: string; indiceMensagem: number } => fala.texto !== null);
  const ultima = falas.at(-1);
  if (!ultima) return { autorizada: false, motivo: 'sem_declaracao_explicita' };
  // A resposta à nossa pergunta de graduação ("eu nem tenho faculdade") cita a palavra faculdade e
  // cairia no conflito abaixo; ela sai dessa conta. As OUTRAS falas seguem bloqueando.
  const respostaOk = opcoes.respostaCurta === true && respostaCurtaSemGraduacao(historico ?? [], ultima.indiceMensagem, ultima.texto);

  // Conflito de formação, inclusive antigo, requer esclarecimento humano/lead.
  // Ausência de campo no cadastro e motivo escrito pela IA não entram aqui.
  if (falas.some((fala) => !(respostaOk && fala === ultima) && temOutraInformacaoAcademica(fala.texto))) {
    return { autorizada: false, motivo: 'formacao_ou_curso_informado' };
  }

  const frases = declaracoes(ultima.texto);
  const apenasDeclaracoes = frases.length > 0 && frases.every(negativaConhecida);
  const nuncaOuUnica = frases.some((frase) => NUNCA_CURSOU.test(frase) || UNICA_FORMACAO.test(frase));
  const semDiplomaENaoCursa = frases.some((frase) => SEM_DIPLOMA.test(frase))
    && frases.some((frase) => NAO_CURSA.test(frase));
  if (!apenasDeclaracoes || (!nuncaOuUnica && !semDiplomaENaoCursa)) {
    if (respostaOk) {
      return { autorizada: true, motivo: 'resposta_a_pergunta', indiceMensagem: ultima.indiceMensagem };
    }
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

// ── Resposta curta à pergunta de graduação (14/10/2026, caso Marciano) ─────────
// A guarda acima só aceita frases completas ("nunca fiz faculdade"). Quem RESPONDE a uma pergunta
// direta da IA responde curto: "Não", "Nunca nem uma", "só ensino médio". Em 7 dias a guarda barrou
// o encerramento por falta de graduação 271 vezes (90 leads) e não liberou nenhum: a IA voltava a
// perguntar ("só pra confirmar, vc nunca iniciou uma graduação…?"). Aqui a resposta é lida junto da
// pergunta que ela responde. Só vale pergunta sobre GRADUAÇÃO (o caso Angélica era "nenhuma" sobre
// área de atuação), e o conflito de formação em qualquer fala continua bloqueando antes.
const PERGUNTA_DE_GRADUACAO = /\b(?:graduacao|faculdade|curso superior|ensino superior)\b/;
// "Não" só vale para pergunta de ter FREQUENTADO ("chegou a cursar…?"): "tem graduação?" + "não"
// pode vir de quem ainda está cursando.
const PERGUNTA_DE_FREQUENTAR = /\b(?:cursou|cursar|iniciou|iniciar|comecou|comecar|frequentou|frequentar|fez|fazer)\b/;
const PERGUNTA_COM_ALTERNATIVA = /\bou\b/;
const PERGUNTA_NEGATIVA = /\bnunca\b|\bnenhuma\b|\bnao (?:esta|tem|fez|cursou|iniciou|comecou)\b/;
const RESP_NUNCA = /^(?:nao,? )?(?:nunca|nenhuma|nenhum|nem uma)(?: (?:nem uma|nenhuma|fiz|cursei|comecei|iniciei|frequentei|graduacao|faculdade))*$/;
const RESP_SO_MEDIO = /^(?:eu )?(?:(?:tenho )?(?:so|apenas|somente) (?:tenho )?(?:o )?)?(?:ensino medio|segundo grau|medio|tecnico|curso tecnico)(?: completo)?$/;
const RESP_NAO = /^(?:nao|nao fiz|nao cursei|nao comecei|nao nenhuma|nao nunca)$/;
const RESP_SIM = /^(?:sim|isso|isso mesmo|exato|correto|s|ss)$/;
// Declaração dentro de uma resposta mais longa ("boa tarde, não tenho curso superior amigo", "eu nem
// tenho faculdade", "eu nunca fiz faculdade não"). Vale só sem ressalva de estudo ou de "ainda".
const DECLARA_NAO_TEM = /\b(?:nao|n|nem) (?:tenho|tem|possuo)(?: nem| nenhuma| nenhum| uma| um)? (?:faculdade|graduacao|curso superior|ensino superior|formacao)\b/;
const DECLARA_NUNCA_FEZ = /\bnunca (?:fiz|cursei|comecei|iniciei|frequentei)(?: uma| nenhuma)? (?:faculdade|graduacao|curso superior)\b/;
const RESSALVA = /\b(?:ainda|cursando|cursar|curso|estudando|estudo|semestre|periodo|vou|pretendo|quero|termino|formo|formar|ano que vem)\b/;

function textoDoBloco(mensagem: Msg): string {
  return typeof mensagem?.content === 'string' ? mensagem.content
    : Array.isArray(mensagem?.content) ? mensagem.content
      .filter((bloco: any) => bloco?.type === 'text' && typeof bloco.text === 'string').map((bloco: any) => bloco.text).join('\n') : '';
}

function textoDaIA(mensagem: Msg): string {
  if (mensagem?.role !== 'assistant') return '';
  const texto = textoDoBloco(mensagem);
  // Fala de vendedor e registros internos não contam como a pergunta da IA.
  return /^\s*\[(?:ATENDIMENTO_HUMANO|INTERNAL_|CORRECAO_INTERNA)/i.test(texto) ? '' : texto;
}

export function respostaCurtaSemGraduacao(historico: readonly Msg[], indiceResposta: number, resposta: string): boolean {
  const r = normalizar(resposta).replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!r || r.length > 200 || resposta.includes('?')) return false;
  // A resposta é à ÚLTIMA fala nossa antes dela. Se essa fala foi do vendedor (ou registro interno),
  // a regra não decide (caso de 08/10: "Isso" respondia a um vendedor que falava da formatura).
  let ultimaNossa: Msg | null = null;
  for (let i = indiceResposta - 1; i >= 0 && !ultimaNossa; i--) {
    if (historico[i]?.role === 'assistant' && textoDoBloco(historico[i]).trim()) ultimaNossa = historico[i];
  }
  const pergunta = ultimaNossa ? textoDaIA(ultimaNossa) : '';
  const perguntas = (normalizar(pergunta).match(/[^.!?\n]*\?/g) ?? []).filter((p) => PERGUNTA_DE_GRADUACAO.test(p));
  const curta = r.length <= 40;
  const semRessalva = !RESSALVA.test(r);
  return perguntas.some((p) => {
    const alternativa = PERGUNTA_COM_ALTERNATIVA.test(p);
    const negativa = PERGUNTA_NEGATIVA.test(p);
    if (curta && (RESP_NUNCA.test(r) || RESP_SO_MEDIO.test(r))) return true;
    if (curta && RESP_NAO.test(r)) return !alternativa && !negativa && PERGUNTA_DE_FREQUENTAR.test(p);
    if (curta && RESP_SIM.test(r)) return !alternativa && negativa;
    if (semRessalva && DECLARA_NUNCA_FEZ.test(r)) return true;
    // "não tenho graduação" também sai de quem ainda cursa: só vale quando a pergunta era se ele
    // chegou a cursar, a confirmação negativa ou a que separa ensino médio de graduação.
    if (semRessalva && DECLARA_NAO_TEM.test(r)) return PERGUNTA_DE_FREQUENTAR.test(p) || negativa || /ensino medio/.test(p);
    return false;
  });
}

/**
 * A leitura da resposta curta vale para este telefone? Ligada para todos
 * (crm_agente_sdr_config.sem_graduacao_resposta_curta) ou só nos telefones de ensaio.
 */
export async function respostaCurtaLigada(supabase: { from: (t: string) => any }, telefone: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.from('crm_agente_sdr_config')
      .select('sem_graduacao_resposta_curta, sem_graduacao_resposta_curta_telefones').eq('id', 1).maybeSingle();
    if (error || !data) return false;
    if (data.sem_graduacao_resposta_curta === true) return true;
    const fim = String(telefone ?? '').replace(/\D/g, '').slice(-8);
    const lista: unknown[] = Array.isArray(data.sem_graduacao_resposta_curta_telefones) ? data.sem_graduacao_resposta_curta_telefones : [];
    return fim.length === 8 && lista.some((t) => String(t).replace(/\D/g, '').slice(-8) === fim);
  } catch { return false; }
}
