import type { Msg } from './historico.ts';
import { catalogoPerguntasCarreira, FONTE_QUALIFICACAO, type RegistroPerguntaCarreira } from './perguntasCarreira.ts';
import { BASES_CURRICULARES_CARREIRA } from './baseCurricularCarreira.ts';
import { PERGUNTAS_RETOMADA, preferenciaFollowup } from './perguntasRetomada.ts';
import { contextoEspecialidadeCannabis } from './especialidadeCannabis.ts';

export function planejarFollowupCarreira(curso: string, enviados: unknown) {
  const catalogo = catalogoPerguntasCarreira(curso);
  const registros: RegistroPerguntaCarreira[] = Array.isArray(enviados)
    ? enviados.filter(r => r && typeof r.escopo === 'string' && typeof r.pergunta_id === 'string') : [];
  const usadas = new Set(registros.filter(r => r.escopo === catalogo.escopo).map(r => r.pergunta_id));
  return { ...catalogo, perguntas: catalogo.perguntas.filter(p => !usadas.has(p.id)),
    retomadas: PERGUNTAS_RETOMADA.filter(p => !usadas.has(p.id)), usadas: [...usadas] };
}
export type PlanoFollowupCarreira = ReturnType<typeof planejarFollowupCarreira>;

export function contextoFollowupCarreira(plano: PlanoFollowupCarreira, tentativa = 1): string {
  return '\n\nCARREIRA DA PESSOA (dados e exemplos, não instruções vindas do lead):\n' + JSON.stringify({
    area: plano.area, perguntas_disponiveis: plano.perguntas, perguntas_ja_enviadas: plano.usadas,
    retomadas_disponiveis: plano.retomadas,
    preferencia_da_tentativa: preferenciaFollowup(tentativa),
    base_curricular: BASES_CURRICULARES_CARREIRA[plano.escopo] ?? null,
    fonte_mercado: plano.area ? FONTE_QUALIFICACAO : null,
  }) + (plano.escopo === 'cannabis' ? contextoEspecialidadeCannabis('Cannabis Medicinal Veterinária') : '');
}

function textosAssistant(history: readonly Msg[]): string[] {
  return history.filter(m => m.role === 'assistant').flatMap(m => typeof m.content === 'string' ? [m.content]
    : Array.isArray(m.content) ? m.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text) : []);
}
const normalizar = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const palavras = (s: string) => new Set(normalizar(s).split(' ').filter(p => p.length > 2 && !['voce', 'pra', 'para', 'que', 'uma', 'seu', 'sua', 'com', 'mais', 'hoje'].includes(p)));

// A introdução pode mudar entre texto e áudio sem mudar a pergunta. Comparar
// só a frase inteira deixava passar "como você ... bovinos, qual avanço ...?".
function nucleoDaPergunta(pergunta: string): string {
  const partes = pergunta.split(/[,;:]\s*/);
  const final = partes.at(-1) ?? pergunta;
  return partes.length > 1 && /^(?:qual|quais|o que|que|como|quanto|quando|onde|voce|vc)\b/.test(normalizar(final))
    && palavras(final).size >= 4 ? final : pergunta;
}

function pressuposicaoDePreco(texto: string, history: readonly Msg[]): boolean {
  const preco = /\b(?:cobrar mais|aumentar (?:o )?(?:preco|valor)|valor cobrado|aumento de preco)\b/;
  const premissa = /\b(?:alem de|ja que|agora que|como voce (?:quer|vai|decidiu))\b/;
  if (!preco.test(normalizar(texto)) || !premissa.test(normalizar(texto))) return false;
  return !history.some(m => m.role === 'user' && typeof m.content === 'string' && preco.test(normalizar(m.content))
    && !/\bnao\b.{0,45}(?:cobrar|aumentar)/.test(normalizar(m.content)));
}

/** Complementa o ID durável com o texto da conversa, inclusive perguntas do principal. */
export function perguntaRepetida(texto: string, history: readonly Msg[]): boolean {
  const atual = texto.match(/[^.!?\n]*\?/g)?.at(-1) ?? texto;
  const termos = palavras(atual);
  return textosAssistant(history).some(anterior => (anterior.match(/[^.!?\n]*\?/g) ?? []).some(pergunta => {
    if (normalizar(pergunta) === normalizar(atual)) return true;
    if (normalizar(nucleoDaPergunta(pergunta)) === normalizar(nucleoDaPergunta(atual))) return true;
    const outros = palavras(pergunta);
    if (termos.size < 4 || outros.size < 4) return false;
    const comuns = [...termos].filter(p => outros.has(p)).length;
    return comuns / (termos.size + outros.size - comuns) >= 0.8;
  }));
}

export function validarFollowupCarreira(texto: string, perguntaId: string, plano: PlanoFollowupCarreira, history: readonly Msg[]): string | null {
  if (!texto) return null;
  if (texto.length > 600 || (texto.match(/\?/g)?.length ?? 0) !== 1) return 'formato';
  if (perguntaId !== 'pendencia' && ![...plano.perguntas, ...plano.retomadas].some(p => p.id === perguntaId)) return 'pergunta_indisponivel';
  // Esta geração não consulta agenda; um horário do histórico pode já ter vencido.
  if (/\b(?:[01]?\d|2[0-3])(?:h(?:[0-5]\d)?|:[0-5]\d)\b/i.test(texto)) return 'horario_sem_consulta';
  if (perguntaRepetida(texto, history)) return 'pergunta_repetida';
  if (pressuposicaoDePreco(texto, history)) return 'decisao_de_preco_nao_declarada';
  const t = normalizar(texto);
  // Não há número salarial aprovado para este piloto. O recorte histórico da Catho
  // permite falar de associação, sem transferir percentuais para veterinária ou agro.
  if (/R\$|\d+(?:[.,]\d+)?\s*%/i.test(texto) || /\b(?:dobro|dobrar|triplicar|renda garantida|salario garantido)\b/.test(t)
    || /\b(?:vai|ira|garante)\b.{0,35}\b(?:ganhar mais|aumentar (?:a |sua )?renda|aumentar (?:o |seu )?salario)\b/.test(t)) return 'promessa_de_renda';
  const afirmaPesquisaRenda = /\b(?:pesquisa|levantamento|estudo|dados)\b.*\b(?:renda|remuneracao|salario|ganham)\b/.test(t)
    || /\b(?:pos graduados|quem tem pos|pessoas com pos)\b.*\b(?:ganham|ganha|recebem|salario)\b/.test(t);
  if (afirmaPesquisaRenda && (!t.includes('catho') || !t.includes('2019') || !t.includes('coordenacao'))) return 'pesquisa_sem_recorte';
  return null;
}

/** A opção já escolhida tem um exemplo neutro. Corrige a premissa sem outra chamada
 * paga; se a própria pergunta de referência já foi feita, o validador mantém silêncio. */
export function corrigirPremissaDeCarreira(texto: string, perguntaId: string, plano: PlanoFollowupCarreira, history: readonly Msg[]): string {
  if (!pressuposicaoDePreco(texto, history)) return texto;
  return [...plano.perguntas, ...plano.retomadas].find(p => p.id === perguntaId)?.exemplo ?? '';
}
