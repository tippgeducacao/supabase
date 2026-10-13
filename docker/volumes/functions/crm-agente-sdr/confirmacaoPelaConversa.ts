// O "sim" que o modelo esqueceu de registrar (13/10/2026, caso Kamila).
//
// A IA perguntou "vc já se formou em agronomia?", a lead respondeu "Sim", e o modelo foi direto
// conferir a compatibilidade sem registrar a conclusão. A conferência só lia a FICHA: não achou a
// conclusão e mandou perguntar de novo. Em 7 dias, 16 de 74 leads que responderam um "sim" curto
// receberam a mesma pergunta duas vezes.
//
// Agora, no começo da rodada (o mesmo ponto que já lê "me formei" do histórico), o código olha a
// CONVERSA: se a última fala da IA terminou na pergunta de conclusão e a resposta do lead é um sim
// claro, a conclusão entra na ficha antes de o modelo rodar. Ele já recebe a ficha sem pendência.
// É regra fixa, não leitura do modelo. Qualquer resposta que não seja um sim limpo ("sim, mas falta
// o TCC", "quase", "ano que vem") fica de fora: aprovar quem não se formou é pior que perguntar
// duas vezes.
import type { Msg } from './historico.ts';

const limpar = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[^\p{L}\p{N}\s?]/gu, ' ').replace(/\s+/g, ' ').trim();

function textoDe(m: Msg): string {
  if (typeof m.content === 'string') return m.content;
  if (!Array.isArray(m.content)) return '';
  return m.content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n');
}

// Pergunta de CONCLUSÃO que fecha a fala da IA.
const RE_PERGUNTA_CONCLUSAO = /\b(ja se formou|ja e formad[oa]|ja concluiu|ja terminou|e formad[oa]|se formou|concluiu a graduacao|terminou a graduacao|graduacao concluida)\b/;
// "já se formou ou ainda cursa?": o "sim" sozinho fica ambíguo; só uma declaração ("concluído") responde.
const RE_COM_ALTERNATIVA = /\bou\b/;
// "quando/em que ano se formou?" não é pergunta de sim ou não.
const RE_PERGUNTA_ABERTA = /\b(quando|qual|que ano|em que)\b/;

const SIM_SOZINHO = new Set([
  'sim', 's', 'ss', 'sim sim', 'ja', 'ja sim', 'sim ja', 'isso', 'isso mesmo', 'exato', 'correto', 'certo',
  'uhum', 'aham', 'claro', 'com certeza', 'sim senhor', 'sim senhora',
]);
const DECLARACAO = new Set([
  'formei', 'me formei', 'ja me formei', 'ja formei', 'sim me formei', 'sim ja me formei', 'sim formei', 'ja sim me formei',
  'sou formado', 'sou formada', 'ja sou formado', 'ja sou formada', 'sim sou formado', 'sim sou formada',
  'formado', 'formada', 'ja conclui', 'conclui', 'sim ja conclui', 'sim conclui', 'ja terminei', 'terminei',
  'sim ja terminei', 'concluido', 'concluida', 'ja concluido', 'ja concluida', 'sim concluido', 'sim concluida',
]);
// "sim, há muito tempo", "já sim, a 5 anos", "sim, 11 anos de formação".
const RE_SIM_COM_TEMPO = /^(sim|ja|ja sim|sim ja)\s+(ha|a|faz|fazem|tem)?\s*(\d{1,2}|um|dois|tres|quatro|cinco|seis|sete|oito|nove|dez|muito|bastante|algum|alguns|varios)\s+(anos?|tempo)(\s+(ja|atras|(de\s+)?(formad[oa]|formacao|formatura)))?$/;
// "sim, já tenho até doutorado": quem tem pós concluiu a graduação.
const RE_SIM_TENHO_POS = /^(sim|ja|ja sim|sim ja)\s+(ja\s+)?(tenho|fiz|conclui)\s+(ate\s+)?(uma?\s+)?(pos|pos graduacao|mestrado|doutorado|especializacao|residencia)$/;
// Qualquer um destes na resposta tira o caso da regra, mesmo com um "sim" junto.
const RE_RESSALVA = /\b(nao|ainda|falta|faltam|cursando|curso|tcc|semestre|periodo|quase|mas|porem|ano que vem|estagio|trancad[oa]|tranquei|vou|termino|formo|concluo|talvez|acho)\b/;
// O gateway embute a mensagem citada no começo da resposta (crm-whatsapp-webhook).
const RE_CITACAO = /^\s*\[Em resposta à mensagem:\s*"([\s\S]*?)"\]\s*/i;

/** A última fala da IA terminou na pergunta de conclusão e o lead respondeu um sim claro. */
export function leadConfirmouConclusao(historico: readonly Msg[] | null | undefined): boolean {
  if (!historico?.length) return false;
  let iPergunta = -1;
  for (let i = historico.length - 1; i >= 0; i--) {
    if (historico[i].role === 'assistant' && textoDe(historico[i]).trim()) { iPergunta = i; break; }
  }
  if (iPergunta < 0) return false;
  const fala = textoDe(historico[iPergunta]).trim();
  if (!fala.endsWith('?')) return false;
  // Só a ÚLTIMA frase da fala (a pergunta que fecha a mensagem): o "sim" responde a ela.
  const pergunta = limpar(fala.split(/[.!?\n]+/).map((f) => f.trim()).filter(Boolean).at(-1) ?? '');
  if (!RE_PERGUNTA_CONCLUSAO.test(pergunta) || RE_PERGUNTA_ABERTA.test(pergunta)) return false;

  const respostas: string[] = [];
  for (const bruta of historico.slice(iPergunta + 1).filter((m) => m.role === 'user').map(textoDe)) {
    // Reação (👍, ❤️) não é resposta. Resposta que cita OUTRA mensagem não responde a esta pergunta.
    if (/^\s*\[reacao\]/i.test(bruta)) continue;
    const citacao = RE_CITACAO.exec(bruta);
    // Mensagem que cita OUTRA mensagem responde àquela, não a esta pergunta: não entra na conta.
    if (citacao && !RE_PERGUNTA_CONCLUSAO.test(limpar(citacao[1]))) continue;
    const semCitacao = citacao ? bruta.slice(citacao[0].length) : bruta;
    for (const linha of semCitacao.split(/\n+/)) {
      // "Sim?" não é confirmação; uma pergunta DEPOIS do sim ("qual o valor?") não o desfaz.
      if (!respostas.length && linha.includes('?')) return false;
      const t = limpar(linha).replace(/\?/g, '').trim();
      if (t) respostas.push(t);
    }
  }
  if (!respostas.length) return false;
  if (respostas.some((r) => RE_RESSALVA.test(r))) return false;
  const primeira = respostas[0];
  if (DECLARACAO.has(primeira)) return true;
  if (RE_COM_ALTERNATIVA.test(pergunta)) return false;
  return SIM_SOZINHO.has(primeira) || RE_SIM_COM_TEMPO.test(primeira) || RE_SIM_TENHO_POS.test(primeira);
}

/** O que vai na telemetria (ficha_conclusao_do_historico) quando a regra registra a conclusão. */
export const TRECHO_SIM_A_PERGUNTA = 'sim à pergunta de conclusão';

type Banco = { from: (tabela: string) => any };

/** A regra está ligada na produção? (crm_agente_sdr_config.formacao_sim_pela_conversa). Falha de leitura = desligada. */
export async function simPelaConversaLigado(supabase: Banco): Promise<boolean> {
  try {
    const { data, error } = await supabase.from('crm_agente_sdr_config').select('formacao_sim_pela_conversa').eq('id', 1).maybeSingle();
    return !error && data?.formacao_sim_pela_conversa === true;
  } catch { return false; }
}
