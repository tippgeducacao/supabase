/**
 * Régua do LOG de eventos de webhook de e-mail.
 *
 * Existe separada do handler porque a decisão "isto merece guardar payload?" é a que
 * define se a tabela fica em MB ou em GB — e ela precisa estar num lugar só, testada,
 * em vez de espalhada em condicionais dentro do fluxo de ingestão.
 *
 * Spec: docs/superpowers/specs/2026-09-07-log-de-entregas-de-email-design.md
 */

/** O que o handler conseguiu fazer com o evento. */
export type ResultadoWebhook =
  | "processado"           // entendi o tipo E achei o e-mail no nosso banco
  | "sem_correspondencia"  // entendi o tipo, mas nenhum e-mail nosso casou
  | "tipo_desconhecido";   // não sei o que é este evento

/** A linha que vai para `email_webhook_eventos`. */
export interface LinhaLogWebhook {
  evento_id: string;
  provider: string;
  tipo: string | null;
  email_id: string | null;
  destinatario: string | null;
  motivo: string | null;
  resultado: ResultadoWebhook;
  payload: unknown | null;
}

/**
 * Tipos em que o payload cru vale o espaço, independentemente de ter casado.
 *
 * São os que alguém abre para entender POR QUE: o diagnóstico de um bounce está no
 * `diagnosticCode` da AWS, não nas nossas colunas. A comparação é por `includes` em
 * minúsculas para o dia em que a AWS acrescentar um tipo aparentado (`BounceDelay`,
 * etc.) — errar para "guardou demais" custa disco; errar para menos custa o
 * diagnóstico, que é o motivo desta tabela existir.
 */
const TIPOS_COM_PAYLOAD = ["bounce", "complaint", "reject", "deliverydelay"];

/**
 * Guardar o corpo cru deste evento?
 *
 * Entrega normal NÃO guarda: o payload de um "delivered" não responde nenhuma pergunta
 * que `tipo`, `destinatario` e `email_id` já não respondam, e guardá-lo levaria uma
 * campanha para a base inteira (~100k contatos) de ~5 MB para ~300 MB.
 *
 * Qualquer coisa que NÃO deu certo guarda — é exatamente aí que falta evidência.
 */
export function guardaPayload(tipo: string | null, resultado: ResultadoWebhook): boolean {
  if (resultado !== "processado") return true;
  const t = (tipo ?? "").toLowerCase();
  return TIPOS_COM_PAYLOAD.some((alvo) => t.includes(alvo));
}

/**
 * Classifica o evento. `tipoConhecido` é do handler: só ele sabe quais tipos traduz.
 *
 * Ordem importa: tipo desconhecido vence, porque nesse caso "não achei o e-mail" é
 * consequência de não ter entendido o evento, e apontar a consequência esconderia a causa.
 */
export function classificar(
  tipoConhecido: boolean,
  achouEmail: boolean,
): ResultadoWebhook {
  if (!tipoConhecido) return "tipo_desconhecido";
  return achouEmail ? "processado" : "sem_correspondencia";
}

/** Monta a linha completa, aplicando a régua do payload. */
export function montarLinhaLog(dados: {
  evento_id: string;
  provider: string;
  tipo: string | null;
  email_id: string | null;
  destinatario: string | null;
  motivo: string | null;
  tipoConhecido: boolean;
  achouEmail: boolean;
  corpo: unknown;
}): LinhaLogWebhook {
  const resultado = classificar(dados.tipoConhecido, dados.achouEmail);
  return {
    evento_id: dados.evento_id,
    provider: dados.provider,
    tipo: dados.tipo,
    email_id: dados.email_id,
    destinatario: dados.destinatario,
    motivo: dados.motivo,
    resultado,
    payload: guardaPayload(dados.tipo, resultado) ? dados.corpo : null,
  };
}
