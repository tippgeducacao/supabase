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

export function instrucaoResultadoMaterial(status: StatusMaterial, reenvioAgendado = false): string {
  const continuidade = ' Não chame pausa_ia nem encaminhe ao humano apenas por esta falha. Termine a mensagem com UMA pergunta: "Enquanto isso, podemos continuar com o agendamento?" Encerre esta rodada logo após essa pergunta. Não emende coleta de dados, perguntas de qualificação, oferta de horários nem argumentos de venda na mesma resposta. Aguarde o aceite; se preferir esperar o arquivo, respeite sem insistir. Se aceitar em uma nova mensagem, retome a qualificação/agenda sem exigir abertura do PDF, mantendo as verificações de elegibilidade e a escolha explícita de dia e horário.';
  switch (status) {
    case 'nao_solicitado': return 'Consulta apenas de valor: nenhum cronograma foi solicitado ou enviado nesta chamada.';
    case 'aceito': return 'O WhatsApp aceitou o envio do cronograma, mas a entrega ainda NÃO está confirmada. Diga que solicitou o envio e pergunte se o arquivo apareceu e abriu. Não diga que foi entregue nem que está acima. Aguarde a confirmação de acesso antes de retomar a agenda.';
    case 'entregue': case 'lido': return 'O WhatsApp registrou a entrega desta mensagem. Isso NÃO comprova abertura do PDF. Pergunte se o lead conseguiu abrir; se ele disser que não recebeu ou pedir novamente, reenvie pela ferramenta, sem contradizê-lo. Aguarde a confirmação de acesso antes de retomar a agenda.';
    case 'falhou': return 'O cronograma NÃO foi enviado nesta tentativa. Não diga que enviou ou que está acima. '
      + (reenvioAgendado
        ? 'Uma nova tentativa ficou registrada. Diga de forma natural: "O envio do cronograma pelo WhatsApp não está funcionando agora. Assim que normalizar, tento enviar novamente pra você." Não dê prazo nem garanta entrega; a fila tenta novamente enquanto a janela permitir.'
        : 'Diga: "Não estou conseguindo enviar o cronograma pelo WhatsApp agora." Não atribua arquivo ausente/configuração a uma instabilidade geral do WhatsApp. Não prometa envio automático posterior: nenhuma nova tentativa ficou registrada.')
      + continuidade;
    case 'desconhecido': return 'O resultado do envio é DESCONHECIDO. Diga que não conseguiu confirmar o envio do cronograma pelo WhatsApp agora. Não diga que enviou, entregou ou que está acima. Não repita automaticamente: pode duplicar um envio aceito sem resposta. Não prometa reenvio automático sem uma tentativa registrada.' + continuidade;
  }
}
