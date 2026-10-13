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

// Pergunta de CONCLUSÃO, sem alternativa: "já se formou ou ainda cursa?" torna o "sim" ambíguo.
const RE_PERGUNTA_CONCLUSAO = /\b(ja se formou|ja e formad[oa]|ja concluiu|ja terminou|e formad[oa]|se formou|concluiu a graduacao|terminou a graduacao|graduacao concluida)\b/;
const RE_ALTERNATIVA = /\b(ou|quando|qual|que ano|em que)\b/;

const SIM_CLARO = new Set([
  'sim', 's', 'ss', 'sim sim', 'ja', 'ja sim', 'sim ja', 'isso', 'isso mesmo', 'exato', 'correto', 'certo',
  'formei', 'me formei', 'ja me formei', 'ja formei', 'sim me formei', 'sim ja me formei', 'sim formei',
  'sou formado', 'sou formada', 'ja sou formado', 'ja sou formada', 'sim sou formado', 'sim sou formada',
  'formado', 'formada', 'ja conclui', 'conclui', 'sim ja conclui', 'sim conclui', 'ja terminei', 'terminei',
  'sim ja terminei', 'uhum', 'aham', 'claro', 'com certeza', 'sim senhor', 'sim senhora', 'ja sim me formei',
]);
// Qualquer um destes na resposta tira o caso da regra, mesmo com um "sim" junto.
const RE_RESSALVA = /\b(nao|ainda|falta|faltam|cursando|curso|tcc|semestre|periodo|quase|mas|porem|ano que vem|estagio|trancad[oa]|tranquei|vou|termino|formo|concluo|talvez|acho)\b/;

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
  if (!RE_PERGUNTA_CONCLUSAO.test(pergunta) || RE_ALTERNATIVA.test(pergunta)) return false;

  const respostas = historico.slice(iPergunta + 1).filter((m) => m.role === 'user').map(textoDe)
    .flatMap((t) => t.split(/\n+/)).map((t) => limpar(t).replace(/\?/g, '').trim()).filter(Boolean);
  if (!respostas.length) return false;
  if (respostas.some((r) => RE_RESSALVA.test(r))) return false;
  return SIM_CLARO.has(respostas[0]);
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
