// FONTE ÚNICA da pergunta "esta rodada terminou o atendimento, e de que jeito?".
//
// Mora aqui (e não no crm-webchat) pelo mesmo motivo do escolaGratuita.ts: os DOIS agentes
// precisam da mesma resposta, e o runtime resolve import entre pastas de function
// (crm-webchat/agente.ts já importa '../crm-agente-sdr/escolaGratuita.ts'). Uma cópia por
// agente vira divergência silenciosa na primeira vez que alguém ajustar só um lado.
//
// Desde 14/09/2026, o texto dos encerramentos conhecidos também é compartilhado:
// o preâmbulo da tool é interno, nunca uma despedida (incidente Adriana).

/** Sinal de que uma tool de encerramento rodou nesta rodada. */
export type Encerramento = { tool: string; input: Record<string, unknown> };

export type MotivoEncerramento =
  | 'sem_graduacao'
  | 'humano'
  | 'ligacao'
  | 'aluno'
  | 'incompativel'
  | 'proxima_turma'
  | 'cancelamento'
  | 'desinteresse';

const DESPEDIDAS: Record<MotivoEncerramento, string> = {
  sem_graduacao: 'nossas pós seguem o modelo lato sensu, que pede graduação completa pra matrícula. '
    + 'fica à vontade pra nos procurar quando concluir, vai ser um prazer marcar essa conversa.',
  humano: 'claro, já te passo pra alguém do time aqui.',
  ligacao: 'beleza, já vou te ligar.',
  aluno: 'esse convite era pra quem ainda não é aluno, desculpa a confusão. '
    + 'vou te direcionar pra alguém do suporte, que cuida da sua turma.',
  // 16/10/2026: "pede graduação completa compatível" fazia quem TEM graduação perguntar "o que seria
  // compatível?" (2 leads no mesmo dia). A frase diz que a graduação dele não está entre as aceitas.
  incompativel: 'essa pós aceita algumas formações específicas, e a sua graduação não está entre elas. '
    + 'fica à vontade pra nos procurar futuramente, vai ser um prazer te ajudar.',
  proxima_turma: 'fechado, deixo anotado pra te chamar quando abrir a próxima turma. obrigado!',
  cancelamento: 'tranquilo, já vou verificar isso pra vc aqui.',
  desinteresse: 'tranquilo, agradeço sua preferência pelo Grupo PPG e fico à disposição se precisar. 🙌',
};

export const DESPEDIDA_GENERICA = DESPEDIDAS.desinteresse;

/** As tools legadas também devolvem falha no campo resultado, sem status. */
export function toolConcluida(output: Record<string, unknown> | undefined): boolean {
  if (!output || output.status === 'bloqueado' || output.status === 'erro' || output.ok === false) return false;
  return !/^(?:Erro ao executar|Não consegui agendar)\b/i.test(String(output.resultado ?? ''));
}

export function despedidaDe(e: Encerramento | null): string | null {
  if (!e) return null;
  const motivo = motivoDoEncerramento(e);
  return motivo ? DESPEDIDAS[motivo] : null;
}

/**
 * A pós EXCLUSIVA de médico veterinário que reprovou este lead, lida do resultado mais recente da
 * conferência de compatibilidade no histórico. null = a última conferência não foi esse caso.
 */
export function posExclusivaDaConversa(historico: readonly { role?: string; content?: unknown }[] | null | undefined): string | null {
  const r = ultimaReprovacao(historico);
  return r?.exclusiva ? r.nome : null;
}

/** A pós que a conferência mais recente reprovou (exclusiva de vet ou não); null = a última não reprovou. */
export function posReprovadaDaConversa(historico: readonly { role?: string; content?: unknown }[] | null | undefined): string | null {
  return ultimaReprovacao(historico)?.nome ?? null;
}

function ultimaReprovacao(historico: readonly { role?: string; content?: unknown }[] | null | undefined): { nome: string; exclusiva: boolean } | null {
  for (let i = (historico?.length ?? 0) - 1; i >= 0; i--) {
    const conteudo = historico![i]?.content;
    if (!Array.isArray(conteudo)) continue;
    for (let j = conteudo.length - 1; j >= 0; j--) {
      const bloco = conteudo[j] as { type?: string; content?: unknown } | null;
      if (bloco?.type !== 'tool_result' || typeof bloco.content !== 'string') continue;
      let r: Record<string, unknown> | null = null;
      try { r = JSON.parse(bloco.content); } catch { continue; }
      if (!r || typeof r !== 'object' || !('pode_cursar' in r || 'curso_exclusivo_veterinario' in r)) continue;
      const nome = String(r.curso_solicitado ?? '').replace(/^\s*(?:P[ÓO]S|MBA)\s*\|\s*/i, '').trim();
      return r.pode_cursar === false && nome ? { nome, exclusiva: r.curso_exclusivo_veterinario === true } : null;
    }
  }
  return null;
}

/**
 * Só usar DEPOIS de confirmar que a ferramenta concluiu, nunca pela intenção do modelo.
 * `posExclusiva` (13/10/2026, caso Regislaine): formada e com duas pós, recusou a alternativa e
 * recebeu "pede graduação completa compatível", que soa como se ela não tivesse formação. Quando a
 * pós pedida é exclusiva de veterinário, a despedida diz isso.
 */
export function respostaDoEncerramento(e: Encerramento | null,
  opcoes: { posExclusiva?: string | null; posReprovada?: string | null } = {}): string | null {
  if (e && opcoes.posExclusiva && motivoDoEncerramento(e) === 'incompativel') {
    return `a pós de ${opcoes.posExclusiva.toLowerCase()} é exclusiva para médicos veterinários. `
      + 'fica à vontade pra nos procurar futuramente, vai ser um prazer te ajudar.';
  }
  if (e && opcoes.posReprovada && motivoDoEncerramento(e) === 'incompativel') {
    return `a pós de ${opcoes.posReprovada.toLowerCase()} aceita algumas formações específicas, e a sua graduação não está entre elas. `
      + 'fica à vontade pra nos procurar futuramente, vai ser um prazer te ajudar.';
  }
  if (e?.tool === 'agendar_retorno' && e.input.tipo === 'formatura') {
    // 21/09/2026 (teste do usuário): a despedida precisa dizer POR QUE — a pós é lato sensu.
    return 'como a pós é lato sensu e exige graduação concluída pra matrícula, não vou marcar a reunião agora. '
      + 'deixo anotado pra te procurar quando estiver mais perto de se formar. bons estudos.';
  }
  return despedidaDe(e);
}

/**
 * Classifica o encerramento pelo que a tool recebeu. O `tipo` manda; o `motivo` é texto
 * livre do modelo e só serve de desempate — nunca o contrário (é a mesma régua do
 * arquivamento no tools.ts: o discriminador é o ENUM, não a redação).
 *
 * ⚠️ Motivo que não bate com nada devolve **null** de propósito. `pausa_ia` é chamada pra
 * coisas que não são despedida — cancelamento e remarcação, por exemplo — e chutar
 * "desinteresse" no desconhecido trocaria uma frase certa por uma errada.
 */
export function motivoDoEncerramento(e: Encerramento): MotivoEncerramento | null {
  if (e.tool === 'temporizador_proxima_turma') return 'proxima_turma';
  if (e.tool !== 'pausa_ia') return null;

  const tipo = String(e.input?.tipo ?? '').toLowerCase();
  if (tipo === 'sem_graduacao') return 'sem_graduacao';
  if (tipo === 'nao_perturbe') return 'desinteresse';

  const motivo = String(e.input?.motivo ?? '').toLowerCase();
  if (/human[oa]|atendente|pessoa de verdade/.test(motivo)) return 'humano';
  if (/liga(ç|c)(ã|a)o|telefon/.test(motivo)) return 'ligacao';
  if (/alun[oa]|matriculad|pagou a matr|paguei/.test(motivo)) return 'aluno';
  if (/cancel|remarc|desmarc/.test(motivo)) return 'cancelamento';
  if (/incompat|forma(ç|c)(ã|a)o/.test(motivo)) return 'incompativel';
  if (/desinteress|sem interesse|n(ã|a)o quer|parar de/.test(motivo)) return 'desinteresse';
  return null;
}

// Nem toda pausa é adeus. Em `humano`, `ligacao`, `aluno` e `cancelamento` o atendimento
// CONTINUA — alguém do time assume. Só nos outros a conversa acabou de verdade.
const NAO_SAO_ADEUS = new Set<MotivoEncerramento>(['humano', 'ligacao', 'aluno', 'cancelamento']);

/**
 * Alguém do time vai assumir daqui? (ligação, atendente, suporte de aluno, remarcação)
 *
 * Repare que isto é RECONHECER a continuação, não reconhecer a despedida — e a diferença
 * importa, porque os dois lados falham para lados opostos. Ver `ehDespedidaDeVerdade` e
 * `mereceOPresente` (escolaGratuita.ts): um é default-não, o outro é default-sim, de
 * propósito.
 */
export function alguemDoTimeAssume(e: Encerramento | null): boolean {
  if (!e) return false;
  const motivo = motivoDoEncerramento(e);
  return Boolean(motivo) && NAO_SAO_ADEUS.has(motivo as MotivoEncerramento);
}

/**
 * O atendimento acabou mesmo? **Default-NÃO**: motivo que o classificador não reconhece
 * devolve `false`. Quem usa isto TROCA o texto do modelo pelo nosso, e trocar uma frase
 * certa por uma errada é pior que não trocar.
 */
export function ehDespedidaDeVerdade(e: Encerramento | null): boolean {
  if (!e) return false;
  const motivo = motivoDoEncerramento(e);
  return Boolean(motivo) && !NAO_SAO_ADEUS.has(motivo as MotivoEncerramento);
}
