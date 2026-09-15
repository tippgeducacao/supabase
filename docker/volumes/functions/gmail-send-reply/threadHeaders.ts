import { headersDeMensagemGmail, montarHeadersResposta } from '../_shared/emailMessageId.ts';

type MensagemPai = { id: string; gmail_message_id: string; message_id?: string | null; references_header?: string | null };

/** Mensagens Gmail antigas não guardavam Message-ID. Recupera apenas a mensagem
 * pai autorizada pelo chamador; uma falha não autoriza inventar um cabeçalho. */
export async function resolverHeadersRespostaGmail(mensagem: MensagemPai | null, deps: {
  buscar: (gmailId: string) => Promise<unknown>;
  salvar: (id: string, valores: { message_id: string; references_header: string | null }) => Promise<void>;
}): Promise<{ inReplyTo: string; references: string }> {
  if (!mensagem) throw new Error('A conversa ainda não tem uma mensagem para responder.');
  const atuais = montarHeadersResposta(mensagem.message_id, mensagem.references_header);
  if (atuais) return atuais;
  const payload = await deps.buscar(mensagem.gmail_message_id);
  const headers = headersDeMensagemGmail(payload);
  const recuperados = montarHeadersResposta(headers.messageId, headers.references ?? mensagem.references_header);
  if (!recuperados) throw new Error('Não foi possível confirmar o cabeçalho da mensagem original. Tente sincronizar a caixa antes de responder.');
  await deps.salvar(mensagem.id, { message_id: recuperados.inReplyTo,
    references_header: headers.references ?? mensagem.references_header ?? null });
  return recuperados;
}
