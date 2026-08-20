/**
 * Régua das ações da Inbox numa caixa IMAP: o que muda no BANCO e o que muda no
 * SERVIDOR quando alguém marca como lida, arquiva, exclui ou marca spam.
 *
 * Mora aqui, fora da edge, por dois motivos:
 *  1. é lógica pura — dá para testar sem abrir socket nem subir Deno;
 *  2. é onde ficaram os três erros que a primeira versão do `imap-mark-read`
 *     cometia (ver comentários abaixo). Um lugar só, com teste em cima.
 */

export type AcaoMarcacao =
  | "read" | "unread"
  | "archive" | "unarchive"
  | "star" | "unstar"
  | "trash" | "spam"
  | "link_task";

/** Pastas que o sync percorre — e as ÚNICAS de onde sai um UID guardado. */
export type PastaImap = "inbox" | "sent";

/**
 * De qual pasta veio o UID de uma mensagem.
 *
 * ⚠️ **UID do IMAP é por pasta, não por caixa.** A INBOX e os Enviados têm
 * numerações independentes, e o UID 5 de uma não tem relação nenhuma com o UID 5
 * da outra. Por isso `email_mensagens.imap_uid` sozinho NÃO diz onde operar — a
 * pasta vive na chave (`imap:<caixa>:<pasta>:<uid>`), e é dela que se lê.
 *
 * Mandar um UID de Enviados para a INBOX selecionada faz o servidor obedecer
 * **na mensagem errada**: marcaria como lida — ou moveria para o Arquivo — um
 * e-mail de outra conversa, sem erro nenhum aparecer.
 *
 * `enviada` é a chave provisória que o `imap-send` grava antes de o sync ler a
 * mensagem de volta dos Enviados: ainda não há UID nenhum, então não é pasta.
 */
export function pastaDaChave(chave: unknown): PastaImap | null {
  const partes = String(chave ?? "").split(":");
  if (partes[0] !== "imap") return null;
  const apelido = partes[2];
  if (apelido === "inbox") return "inbox";
  if (apelido === "sent") return "sent";
  return null;
}

export interface MensagemMarcavel {
  gmail_message_id?: string | null;
  imap_uid?: number | string | null;
}

/** UIDs da thread separados pela pasta em que valem. */
export function agruparUidsPorPasta(
  mensagens: MensagemMarcavel[],
): Record<PastaImap, number[]> {
  const grupos: Record<PastaImap, number[]> = { inbox: [], sent: [] };
  for (const m of mensagens ?? []) {
    const pasta = pastaDaChave(m?.gmail_message_id);
    if (!pasta) continue;
    const uid = Number(m?.imap_uid);
    if (!Number.isFinite(uid) || uid <= 0) continue;
    if (!grupos[pasta].includes(uid)) grupos[pasta].push(uid);
  }
  grupos.inbox.sort((a, b) => a - b);
  grupos.sent.sort((a, b) => a - b);
  return grupos;
}

/**
 * O que a ação muda na linha da thread.
 *
 * ⚠️ **`pasta` não é enfeite: é o que a Inbox filtra.** A lista de conversas
 * consulta `pasta = 'inbox'` (e as abas Arquivadas/Lixeira/Spam consultam
 * `'archived'`/`'trash'`/`'spam'`). A primeira versão só escrevia `arquivado`,
 * então arquivar/excluir/marcar spam numa caixa IMAP **devolvia a conversa para
 * a lista** e deixava as outras abas vazias — enquanto a tela dizia "Conversa
 * excluída". Isto aqui é a paridade com o `gmail-mark-read`.
 */
export function patchLocalDaAcao(
  acao: AcaoMarcacao,
  opcoes: { taskId?: string | null; agora?: string } = {},
): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    updated_at: opcoes.agora ?? new Date().toISOString(),
  };
  if (acao === "read") patch.nao_lido = false;
  if (acao === "unread") patch.nao_lido = true;
  if (acao === "archive") { patch.arquivado = true; patch.pasta = "archived"; }
  if (acao === "unarchive") { patch.arquivado = false; patch.pasta = "inbox"; }
  if (acao === "star") patch.favoritado = true;
  if (acao === "unstar") patch.favoritado = false;
  if (acao === "trash") { patch.arquivado = true; patch.pasta = "trash"; }
  if (acao === "spam") { patch.arquivado = true; patch.pasta = "spam"; }
  if (acao === "link_task") patch.task_id = opcoes.taskId ?? null;
  return patch;
}

/** Ações que o protocolo IMAP não tem — valem só dentro do sistema. */
export function soLocal(acao: AcaoMarcacao): boolean {
  return acao === "link_task" || acao === "star" || acao === "unstar" || acao === "unarchive";
}

export interface PastasEspeciais {
  pasta_arquivo?: string | null;
  pasta_lixeira?: string | null;
  pasta_spam?: string | null;
}

export interface DestinoMovimento {
  /** Nome da pasta no servidor, ou `null` quando o servidor não tem essa pasta. */
  pasta: string | null;
  rotulo: "Arquivo" | "Lixeira" | "Spam";
}

/**
 * Para onde a mensagem vai no servidor.
 *
 * ⚠️ A primeira versão mandava as TRÊS ações para o Arquivo (o ternário
 * `archive ? pasta_arquivo : pasta_arquivo` era um no-op). Excluir um e-mail o
 * arquivava — ficava na caixa, visível no webmail, enquanto o sistema anunciava
 * exclusão. Lixeira e Spam são pastas próprias, e é para elas que se move.
 */
export function destinoDaAcao(acao: AcaoMarcacao, pastas: PastasEspeciais): DestinoMovimento | null {
  if (acao === "archive") return { pasta: pastas.pasta_arquivo ?? null, rotulo: "Arquivo" };
  if (acao === "trash") return { pasta: pastas.pasta_lixeira ?? null, rotulo: "Lixeira" };
  if (acao === "spam") return { pasta: pastas.pasta_spam ?? null, rotulo: "Spam" };
  return null;
}

/** Recado honesto quando o servidor não tem a pasta de destino. */
export function avisoSemPasta(rotulo: DestinoMovimento["rotulo"]): string {
  return `Este servidor não tem pasta de ${rotulo} — a conversa saiu da lista aqui no sistema, mas continua na caixa de entrada do webmail.`;
}
