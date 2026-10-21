// 10/09/2026: HTTP 200 significa aceite do provedor, não entrega ao lead.
// O mesmo contrato atende documento, template e o retorno da ferramenta SDR.
export type StatusMaterial = 'aceito' | 'entregue' | 'lido' | 'falhou' | 'desconhecido' | 'nao_solicitado';
export type ResultadoMaterial = {
  cronograma_enviado: boolean;
  cronograma_status: StatusMaterial;
  wa_message_id: string | null;
  cronograma_erro?: string;
  cronograma_codigo?: string;
  reenvio_agendado_id?: string;
  reenvio_em?: string;
};

export function statusMaterial(status: unknown): StatusMaterial {
  switch (status) {
    case 'sent': case 'aceito': return 'aceito';
    case 'delivered': case 'entregue': return 'entregue';
    case 'read': case 'lido': return 'lido';
    case 'failed': case 'falhou': return 'falhou';
    default: return 'desconhecido';
  }
}

export function resultadoMaterial(status: StatusMaterial, id: unknown = null, erro?: string, codigo?: string): ResultadoMaterial {
  return {
    cronograma_enviado: ['aceito', 'entregue', 'lido'].includes(status),
    cronograma_status: status,
    wa_message_id: typeof id === 'string' && id.trim() ? id : null,
    ...(erro ? { cronograma_erro: erro } : {}),
    ...(codigo ? { cronograma_codigo: codigo } : {}),
  };
}

export function objetoMaterial(valor: unknown): Record<string, unknown> {
  return valor && typeof valor === 'object' && !Array.isArray(valor) ? valor as Record<string, unknown> : {};
}

export function interpretarEnvioMaterial(httpOk: boolean, valor: unknown, httpStatus = httpOk ? 200 : 422): ResultadoMaterial {
  const body = objetoMaterial(valor);
  // Um proxy pode devolver 5xx depois de o provedor aceitar a mensagem.
  if (httpStatus >= 500) return resultadoMaterial('desconhecido', body.wa_message_id,
    'A integração não confirmou o resultado do envio.', 'envio_sem_confirmacao');
  if (!httpOk || body?.error || body?.success === false || body?.status_entrega === 'failed') {
    return resultadoMaterial('falhou', body?.wa_message_id,
      typeof body?.error === 'string' ? body.error : 'O provedor recusou o envio.',
      String(body?.code ?? body?.meta_code ?? 'envio_recusado'));
  }
  if (body?.success !== true || typeof body?.wa_message_id !== 'string' || !body.wa_message_id.trim()) {
    return resultadoMaterial('desconhecido', null, 'Não foi possível confirmar o aceite do envio.', 'envio_sem_confirmacao');
  }
  // crm-whatsapp-send devolve success + id ao aceitar; o receipt atualiza o CRM depois.
  return resultadoMaterial(statusMaterial(body.status_entrega ?? 'sent'), body.wa_message_id);
}

/** O que o João diz quando o cronograma sai (10/10/2026). O PDF traz professores, módulos e o valor integral. */
export const FALA_CRONOGRAMA_ENVIADO = 'te enviei o cronograma da pós por aqui, com os professores, os módulos e o valor integral.';
/**
 * O convite que vem junto, dizendo POR QUE ir ao meet (16/10/2026, texto do Gustavo): a condição do meet é
 * outra, diferente do valor integral que acabou de ir no PDF, e só o monitor apresenta.
 */
export const falaConviteDepoisDoCronograma = (condicao: string) =>
  `${condicao}, totalmente diferente desse valor que eu te passei, é somente com o monitor no meet. são 10 minutos.`;
/** Sem compatibilidade aprovada ainda, o convite fecha com esta pergunta (com APROVADO, vão os horários). */
export const PERGUNTA_CONVITE_SEM_HORARIO = 'posso procurar um horário pra vc?';

export function instrucaoResultadoMaterial(status: StatusMaterial, reenvioAgendado = false,
  opcoes: { condicao?: string; soFatos?: boolean } = {}): string {
  const continuidade = ' Não chame pausa_ia nem encaminhe ao humano apenas por esta falha. Termine a mensagem com UMA pergunta: "Enquanto isso, podemos continuar com o agendamento?" Encerre esta rodada logo após essa pergunta. Não emende coleta de dados, perguntas de qualificação, oferta de horários nem argumentos de venda na mesma resposta. Aguarde o aceite; se preferir esperar o arquivo, respeite sem insistir. Se aceitar em uma nova mensagem, retome a qualificação/agenda sem exigir abertura do PDF, mantendo as verificações de elegibilidade e a escolha explícita de dia e horário.';
  // 10/10/2026 (Gustavo e Wellinton): o valor NÃO é mais escrito na conversa. Ele vai dentro do
  // cronograma (página de investimento, por modalidade), e a fala do envio diz isso. O convite vem na
  // mesma mensagem: a condição do lote, com valor e parcelamento, só na conversa com o monitor.
  const semValor = ' O cronograma já traz os professores, os módulos e o valor integral: não escreva valor, parcela nem preço de matrícula na conversa.';
  // 21/10/2026 (caso Ellen): o texto abria com o status técnico ("O WhatsApp aceitou o envio do
  // cronograma, mas a entrega ainda NÃO está confirmada") e a Luna repassou isso ao lead em vez da fala
  // pronta: "o WhatsApp aceitou o envio…, mas ainda não consigo confirmar que chegou". Agora a fala vem
  // primeiro e o status é NOTA INTERNA, com a ordem de não narrá-lo. A trava segue: aceito não é
  // entrega, e a IA não diz "foi entregue" nem "está acima".
  const naoNarre = ' Status técnico do envio é assunto interno: com o lead não fale em WhatsApp aceitar, entrega confirmada ou não confirmada, nem "não consigo confirmar". Para o lead, você enviou o cronograma.';
  const notaInterna = status === 'aceito'
    ? ' NOTA INTERNA (não vai para o lead): o envio saiu e a entrega ainda não tem confirmação; não diga que foi entregue nem que está acima.'
    : ' NOTA INTERNA (não vai para o lead): a entrega foi registrada, o que não comprova que o PDF abriu.';
  // IA de aula v2 (`soInformar`): só o fato, sem roteiro de fala.
  if (opcoes.soFatos && (status === 'aceito' || status === 'entregue' || status === 'lido')) {
    return 'Cronograma enviado ao lead.' + notaInterna + naoNarre + semValor;
  }
  const roteiro = `FALA AO LEAD, com estas palavras: "${FALA_CRONOGRAMA_ENVIADO}" Em seguida, salvo se a formação ou o prazo dele já foram REPROVADOS nesta conversa (aí não convide) ou se essa explicação da condição exclusiva já foi dita nesta conversa (aí não repita): "${falaConviteDepoisDoCronograma(opcoes.condicao ?? 'a condição promocional exclusiva')}"`;
  switch (status) {
    case 'nao_solicitado': return 'Nenhum cronograma foi solicitado ou enviado nesta chamada.';
    // 19/09/2026 (decisão do usuário, vale para todos): "te enviei o cronograma", não "solicitei o
    // envio". "Enviei" é verdade (o WhatsApp aceitou); a entrega continua sem confirmação, por isso
    // a pergunta "chegou?" fica, e "entregue"/"está acima" seguem proibidos.
    // 09/10/2026: "aguarde a confirmação de acesso antes de retomar a agenda" segurava o convite e
    // a conversa morria no "chegou?" (Luna: 22 aprovados, 1 agendamento em 08/10). Com a
    // compatibilidade aprovada, o envio já leva os horários.
    case 'aceito': return roteiro
      + ` Se ele acabou de recusar a conversa com o monitor (respondeu "não" ao convite e só quis o material), diga só a fala do envio e pare: não convide nem ofereça horários. Senão, se a compatibilidade já está APROVADA nesta conversa, na mesma mensagem chame consulta_disponibilidade e ofereça até três horários reais pra essa conversa, sem esperar ele confirmar que abriu; sem APROVADO, feche com "${PERGUNTA_CONVITE_SEM_HORARIO}".`
      + semValor + notaInterna + naoNarre;
    case 'entregue': case 'lido': return roteiro
      + ` Se ele acabou de recusar a conversa com o monitor (respondeu "não" ao convite e só quis o material), diga só a fala do envio e pare: não convide nem ofereça horários. Senão, se a compatibilidade já está APROVADA nesta conversa, na mesma mensagem chame consulta_disponibilidade e ofereça até três horários reais pra essa conversa; sem APROVADO, feche com "${PERGUNTA_CONVITE_SEM_HORARIO}". Se ele disser que não recebeu ou pedir novamente, reenvie pela ferramenta, sem contradizê-lo.`
      + semValor + notaInterna + naoNarre;
    case 'falhou': return 'O cronograma NÃO foi enviado nesta tentativa. Não diga que enviou ou que está acima. O valor integral vai dentro do cronograma: não escreva valor na conversa; se ele perguntou o preço, diga que valor e condição o monitor apresenta na conversa. '
      + (reenvioAgendado
        ? 'Uma nova tentativa ficou registrada. Diga de forma natural: "O envio do cronograma pelo WhatsApp não está funcionando agora. Assim que normalizar, tento enviar novamente pra você." Não dê prazo nem garanta entrega; a fila tenta novamente enquanto a janela permitir.'
        : 'Diga: "Não estou conseguindo enviar o cronograma pelo WhatsApp agora." Não atribua arquivo ausente/configuração a uma instabilidade geral do WhatsApp. Não prometa envio automático posterior: nenhuma nova tentativa ficou registrada.')
      + continuidade;
    case 'desconhecido': return 'O resultado do envio é DESCONHECIDO. Diga que não conseguiu confirmar o envio do cronograma pelo WhatsApp agora. Não diga que enviou, entregou ou que está acima. Não escreva valor na conversa: ele vai dentro do cronograma. Não repita automaticamente: pode duplicar um envio aceito sem resposta. Não prometa reenvio automático sem uma tentativa registrada.' + continuidade;
  }
}
