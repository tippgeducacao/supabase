/**
 * Uma mensagem lida do servidor tem o mesmo Message-ID de uma linha que já está na
 * thread, mas com OUTRA chave. Religar (dar a chave/UID reais à linha existente) ou não?
 *
 * Chave = `imap:<caixa>:<pasta>:<uid>`. Religa-se só o que é desta pasta:
 * - `imap:<caixa>:enviada:<message-id>` — o que o `imap-send` gravou antes de o sync ler
 *   a mensagem de volta dos Enviados (por isso só quando a pasta é `sent`);
 * - `imap:<caixa>:<pasta>@<rótulo>:<uid>` — chave aposentada quando o servidor renumerou
 *   a pasta (`email_imap_aposentar_chaves`, troca de servidor de 28/09/2026).
 *
 * ⚠️ E-mail para si mesmo tem o MESMO Message-ID na INBOX e nos Enviados. Religar
 * "qualquer uma" roubaria a chave da outra pasta — e UID é por pasta: a ação seguinte
 * (marcar lida, arquivar) cairia na mensagem errada do servidor.
 */
export function regraReligar(
  caixaId: string,
  apelido: "inbox" | "sent",
  linhas: { id: string; gmail_message_id: string | null }[],
): { religar: string | null; jaLigada: boolean } {
  const aposentada = `imap:${caixaId}:${apelido}@`;
  const provisoria = `imap:${caixaId}:enviada:`;
  const atual = `imap:${caixaId}:${apelido}:`;
  const chave = (l: { gmail_message_id: string | null }) => String(l.gmail_message_id ?? "");
  const alvo = linhas.find((l) =>
    chave(l).startsWith(aposentada) || (apelido === "sent" && chave(l).startsWith(provisoria)),
  );
  return {
    religar: alvo?.id ?? null,
    jaLigada: !alvo && linhas.some((l) => chave(l).startsWith(atual)),
  };
}
