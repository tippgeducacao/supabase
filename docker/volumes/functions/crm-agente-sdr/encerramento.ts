// FONTE ÚNICA da pergunta "esta rodada terminou o atendimento, e de que jeito?".
//
// Mora aqui (e não no crm-webchat) pelo mesmo motivo do escolaGratuita.ts: os DOIS agentes
// precisam da mesma resposta, e o runtime resolve import entre pastas de function
// (crm-webchat/agente.ts já importa '../crm-agente-sdr/escolaGratuita.ts'). Uma cópia por
// agente vira divergência silenciosa na primeira vez que alguém ajustar só um lado.
//
// O que NÃO mora aqui: o TEXTO da despedida. Ele é do canal — o webchat tem o dele em
// guardas.ts, o WhatsApp deixa o modelo escrever. Aqui é só a classificação.

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
