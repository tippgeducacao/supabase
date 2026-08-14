/**
 * Interpretação dos eventos que o SES publica no SNS.
 *
 * Separado do `index.ts` da edge para poder ser testado com as fixtures sem subir o
 * `Deno.serve` — a mesma razão pela qual a validação Svix foi extraída do webhook do
 * Resend.
 */

export type TipoEventoSes =
  | "Send" | "Delivery" | "Bounce" | "Complaint"
  | "Reject" | "Open" | "Click" | "DeliveryDelay" | "Subscription";

export interface EventoSesInterpretado {
  tipo: TipoEventoSes;
  /** MessageId do SES — casa com `emails_enviados.provider_message_id`. */
  messageId: string | null;
  destinatarios: string[];
  /** Status a gravar em `emails_enviados`. */
  status: string | null;
  /** Endereços que devem entrar na supressão, com o motivo. */
  suprimir: Array<{ email: string; motivo: "bounce" | "spam"; detalhe: string }>;
  detalhe?: string;
}

/** Mapa evento → status. Mesmos valores do enum `email_envio_status` já existente. */
const STATUS: Partial<Record<TipoEventoSes, string>> = {
  Send: "enviado",
  Delivery: "entregue",
  Open: "aberto",
  Click: "clicado",
  Bounce: "bounce",
  Complaint: "spam",
  Reject: "falhou",
  DeliveryDelay: "enviado",
};

/**
 * `Permanent` é o bounce duro: o endereço não existe e nunca vai existir.
 * `Transient` (caixa cheia, servidor fora) NÃO suprime — suprimir por caixa cheia
 * apagaria da base um aluno que só estava de férias.
 */
function ehBounceDuro(bounceType: string): boolean {
  return bounceType === "Permanent";
}

export function interpretarEventoSes(mensagemSes: unknown): EventoSesInterpretado {
  const m = mensagemSes as Record<string, any>;
  const tipo: TipoEventoSes = m?.notificationType ?? m?.eventType ?? "Send";
  const messageId: string | null = m?.mail?.messageId ?? null;

  const base: EventoSesInterpretado = {
    tipo,
    messageId,
    destinatarios: Array.isArray(m?.mail?.destination) ? m.mail.destination : [],
    status: STATUS[tipo] ?? null,
    suprimir: [],
  };

  if (tipo === "Bounce") {
    const bounce = m.bounce ?? {};
    const duro = ehBounceDuro(String(bounce.bounceType ?? ""));
    const detalhe = `${bounce.bounceType ?? "?"}/${bounce.bounceSubType ?? "?"}`;
    base.detalhe = detalhe;
    // Bounce transitório não muda o status para 'bounce': o e-mail pode ainda ser
    // entregue numa retentativa do próprio SES.
    if (!duro) base.status = "enviado";
    if (duro) {
      base.suprimir = (bounce.bouncedRecipients ?? [])
        .map((r: { emailAddress?: string; diagnosticCode?: string }) => r.emailAddress)
        .filter(Boolean)
        .map((email: string) => ({
          email,
          motivo: "bounce" as const,
          detalhe: `${detalhe} — ${bounce.bouncedRecipients?.[0]?.diagnosticCode ?? "sem diagnóstico"}`.slice(0, 500),
        }));
    }
  }

  if (tipo === "Complaint") {
    const c = m.complaint ?? {};
    base.detalhe = c.complaintFeedbackType ?? "abuse";
    base.suprimir = (c.complainedRecipients ?? [])
      .map((r: { emailAddress?: string }) => r.emailAddress)
      .filter(Boolean)
      .map((email: string) => ({
        email,
        motivo: "spam" as const,
        detalhe: `reclamação: ${base.detalhe}`,
      }));
  }

  if (tipo === "Reject") {
    base.detalhe = m.reject?.reason ?? "rejeitado pelo SES";
  }

  return base;
}
