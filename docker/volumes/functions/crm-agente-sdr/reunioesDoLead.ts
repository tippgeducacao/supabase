// Reuniões do lead no contexto de cada volta (30/09/2026).
// O agente sabia das reuniões só pelo histórico ("horário reservado…"). O que a equipe faz na tela —
// cancelar, remarcar, trocar o monitor, mudar o horário, registrar comparecimento — não chegava até ele:
// em 17/09 e 24/09 a IA disse "te espero às 15h" 9 e 15 min depois de a reunião ser cancelada (no caso
// Marwin, a Flávia tinha passado a reunião da Suéli para a Amanda, no mesmo horário). A AGENDA é a
// fonte: esta nota vai no contexto (fora do cache, relida a cada rodada) e vale para a Luna e o Sonnet.
// Falha de leitura = sem nota (a conversa segue como antes); nunca derruba a rodada.
// Duas revisões adversariais (30/09) moldaram as regras abaixo — cada caso real está citado onde pesa.

export type ReuniaoDoLead = {
  id: string;
  status: string | null;
  resultado_reuniao: string | null;
  data_agendamento: string | null;
  data_fim_agendamento?: string | null;
  monitor: string | null;
  origem: string | null;
  /** Última mudança de horário, cancelamento ou remarcação (agendamento_logs). */
  mudou_em: string | null;
  mudou_por: string | null;
  /** O lead já compareceu a esta reunião antes de ela ser remarcada (fechamento em outro dia). */
  compareceu_antes?: boolean | null;
};

export type SituacaoReuniao =
  | 'marcada' | 'em_andamento' | 'horario_encerrado' | 'passou_sem_registro' | 'realizada' | 'compareceu'
  | 'nao_compareceu' | 'comprou' | 'desqualificada' | 'cancelada';

const MIN = 60_000;
/** Reunião sem fim cadastrado dura isto (741 de 758 reuniões em 30 dias têm 30 min). */
const DURACAO_PADRAO_MS = 30 * MIN;
/** "Acontecendo agora" vale até o fim previsto + esta folga (o monitor costuma estender um pouco). */
const FOLGA_DEPOIS_DO_FIM_MS = 10 * MIN;
/**
 * Até aqui, sem resultado registrado, a reunião ainda é "ativa" no sistema: a mesma janela de 2 h do
 * bloqueio de duplicata (fn_sdr_api_agendar_reuniao) e do remarcar_agendamento. Entre o fim e isto, a
 * nota não afirma nada (caso Julimara: 'atrasado' desde 15h31, monitor já em outra reunião às 15h29).
 */
const JANELA_ATIVA_MS = 120 * MIN;

/** Situações em que a reunião está de pé (a trava e a frase "não há reunião marcada" dependem disto). */
const DE_PE = new Set<SituacaoReuniao>(['marcada', 'em_andamento']);

type Banco = { rpc: (nome: string, params: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> };

/**
 * O que a reunião É hoje, pela agenda (status + resultado + data).
 * ⚠️ `remarcado` NÃO é reunião desfeita: remarcar na tela atualiza a MESMA linha (data nova, resultado
 * apagado, "volta para Agendadas"). Com data futura ela está de pé.
 */
export function situacaoDaReuniao(r: ReuniaoDoLead, agora: Date): SituacaoReuniao {
  const status = String(r.status ?? '').toLowerCase();
  const resultado = String(r.resultado_reuniao ?? '').toLowerCase();
  if (status === 'cancelado') return 'cancelada';
  if (status === 'finalizado_venda' || resultado === 'comprou') return 'comprou';
  if (resultado === 'nao_compareceu') return 'nao_compareceu';
  if (resultado === 'compareceu_nao_comprou') return 'compareceu';
  if (resultado === 'reuniao_desqualificada') return 'desqualificada';
  if (status === 'realizado') return 'realizada';
  const inicio = r.data_agendamento ? new Date(r.data_agendamento).getTime() : NaN;
  if (Number.isNaN(inicio)) return 'passou_sem_registro';
  const t = agora.getTime();
  if (inicio > t) return 'marcada';
  const fimInformado = r.data_fim_agendamento ? new Date(r.data_fim_agendamento).getTime() : NaN;
  const fim = Number.isNaN(fimInformado) || fimInformado <= inicio ? inicio + DURACAO_PADRAO_MS : fimInformado;
  if (t < fim + FOLGA_DEPOIS_DO_FIM_MS) return 'em_andamento';
  if (t < inicio + JANELA_ATIVA_MS) return 'horario_encerrado';
  return 'passou_sem_registro';
}

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const pad = (n: number) => String(n).padStart(2, '0');

/** "24/09 (quinta) 15h30" em Brasília (UTC-3, sem horário de verão desde 2019); com o ano se não for o atual. */
export function quandoEmBrasilia(iso: string | null, agora: Date): string {
  if (!iso) return 'data não informada';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'data não informada';
  const d = new Date(t - 3 * 3600_000);
  const ano = d.getUTCFullYear() !== new Date(agora.getTime() - 3 * 3600_000).getUTCFullYear() ? `/${d.getUTCFullYear()}` : '';
  const min = d.getUTCMinutes();
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}${ano} (${DIAS[d.getUTCDay()]}) ${d.getUTCHours()}h${min ? pad(min) : ''}`;
}

const TEXTO: Record<SituacaoReuniao, string> = {
  marcada: 'MARCADA',
  em_andamento: 'ACONTECENDO AGORA (começou há pouco; o lead pode estar entrando na sala)',
  horario_encerrado: 'o horário terminou e a equipe ainda não registrou o resultado — não diga que está acontecendo nem que acabou; se o lead disser que está entrando ou esperando, diga que vai confirmar com a equipe',
  passou_sem_registro: 'já passou; sem registro de comparecimento',
  realizada: 'realizada',
  compareceu: 'o lead COMPARECEU e não comprou',
  nao_compareceu: 'o lead NÃO COMPARECEU',
  comprou: 'o lead COMPROU',
  desqualificada: 'realizada e desqualificada pela equipe',
  cancelada: 'CANCELADA',
};

function detalheDaLinha(r: ReuniaoDoLead, s: SituacaoReuniao, agora: Date): string {
  const quem = r.mudou_em ? ` em ${quandoEmBrasilia(r.mudou_em, agora)}${r.mudou_por ? ` (${r.mudou_por})` : ''}` : '';
  if (s === 'cancelada') return quem;
  if (!DE_PE.has(s)) return '';
  // Remarcada depois de o lead comparecer (67 de 77 remarcações em 60 dias; caso Evelise): é a
  // continuação/fechamento, não a primeira apresentação adiada.
  if (r.compareceu_antes) return ' (o lead JÁ COMPARECEU à reunião anterior; esta é a continuação/fechamento marcada pela equipe para este horário)';
  // Horário mudado — com ou sem status 'remarcado' (83% das trocas mantêm 'agendado'; caso Americo).
  if (r.mudou_em) return ` (horário alterado para este${quem}; vale este, não o do histórico)`;
  return '';
}

/** A nota para o contexto; '' quando o lead não tem reunião (nada muda na conversa). */
export function notaDasReunioes(lista: readonly ReuniaoDoLead[] | null, agora: Date): string {
  if (!lista?.length) return '';
  const situacoes = lista.map((r) => situacaoDaReuniao(r, agora));
  const linhas = lista.map((r, i) =>
    `- ${quandoEmBrasilia(r.data_agendamento, agora)}${r.monitor ? ` com ${r.monitor}` : ''}: ${TEXTO[situacoes[i]]}${detalheDaLinha(r, situacoes[i], agora)}.`);
  const dePe = situacoes.some((s) => DE_PE.has(s));
  const indefinida = situacoes.includes('horario_encerrado');
  return '\n\nREUNIÕES DESTE LEAD NA AGENDA (situação atual registrada pela equipe; vale mais que as confirmações antigas do '
    + 'histórico. Se a equipe combinou outra coisa com o lead DEPOIS, na conversa, não afirme horário: siga a equipe):\n'
    + linhas.join('\n')
    + (dePe || indefinida ? '' : '\nNão há reunião marcada agora: uma reunião cancelada ou que já passou não está de pé, mesmo que o histórico mostre a confirmação dela.');
}

/**
 * true = há reunião de pé; false = não há; null = não dá para afirmar (leitura falhou, ou uma reunião
 * terminou há pouco sem resultado) — aí a trava segue a regra de sempre.
 */
export function reuniaoMarcadaNaAgenda(lista: readonly ReuniaoDoLead[] | null, agora: Date): boolean | null {
  if (lista === null) return null;
  const situacoes = lista.map((r) => situacaoDaReuniao(r, agora));
  if (situacoes.some((s) => DE_PE.has(s))) return true;
  if (situacoes.includes('horario_encerrado')) return null;
  return false;
}

/**
 * A ferramenta CRIOU ou REMARCOU uma reunião de fato (não só foi chamada). "Erro ao agendar",
 * "Nenhum agendamento ativo…", "Não consegui remarcar…" e a recusa da trava de horário não contam —
 * contá-los desligava a trava justo quando a reunião não existe.
 */
export function agendamentoFeito(nome: string, output: Record<string, unknown> | undefined): boolean {
  if (!output || output.status === 'erro' || output.status === 'bloqueado' || output.ok === false || output.trava) return false;
  if (nome === 'confirmar_agendamento') return typeof output.agendamento_id === 'string' && output.agendamento_id.length > 0;
  if (nome === 'remarcar_agendamento') return /^Reunião remarcada\b/.test(String(output.resultado ?? ''));
  return false;
}

/** As últimas reuniões do lead (por lead e telefone). null = falha de leitura (sem nota, sem trava nova). */
export async function carregarReunioesDoLead(banco: Banco, telefone: string, leadId: string | null | undefined): Promise<ReuniaoDoLead[] | null> {
  try {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(leadId ?? '')) ? leadId : null;
    const { data, error } = await banco.rpc('crm_sdr_reunioes_do_lead', { p_telefone: telefone, p_lead_id: uuid, p_limite: 5 });
    if (error) throw new Error(error.message);
    return Array.isArray(data) ? data as ReuniaoDoLead[] : [];
  } catch (e) {
    console.error('[crm-agente-sdr] reuniões do lead (segue sem a nota):', (e as Error)?.message ?? e);
    return null;
  }
}

/** Relê a agenda agora: a nota e o "de pé" (usado quando a própria rodada criou/remarcou uma reunião). */
export async function reunioesAgora(banco: Banco, telefone: string, leadId: string | null | undefined, agora = new Date()) {
  const lista = await carregarReunioesDoLead(banco, telefone, leadId);
  return { nota: notaDasReunioes(lista, agora), marcada: reuniaoMarcadaNaAgenda(lista, agora) };
}

/**
 * Troca a nota das reuniões dentro do contexto da rodada. Depois de confirmar/remarcar, a nota lida no
 * começo fica velha ("não há reunião marcada", ou o horário antigo como MARCADA) e contradiz a
 * ferramenta: 55 das 403 confirmações e 37 das 38 remarcações da IA desde 29/08 cairiam nisso.
 */
export function trocarNotaDasReunioes(contexto: string, antiga: string, nova: string): string {
  if (antiga && contexto.includes(antiga)) return contexto.replace(antiga, () => nova);
  return nova ? contexto + nova : contexto;
}
