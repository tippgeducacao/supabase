/**
 * Abstração de provedor de envio.
 *
 * Fonte única (edge Deno + vitest): TypeScript puro, sem API de plataforma no topo do
 * módulo e sem import estático de SDK — ver `ses.ts` para o porquê.
 */

export interface AnexoEmail {
  filename: string;
  /** base64 puro, sem data-uri */
  content: string;
  contentType?: string;
}

export interface OutboundEmail {
  /** "Nome <endereco@dominio>" ou só o endereço. */
  from: string;
  to: string | string[];
  subject: string;
  html: string;
  text?: string | null;
  replyTo?: string | null;
  bcc?: string | string[] | null;
  headers?: Record<string, string>;
  attachments?: AnexoEmail[];
  /** Metadados que voltam nos eventos do provedor. */
  tags?: Array<{ name: string; value: string }>;
  /** Chave estável do envio lógico, para o provedor não entregar duas vezes. */
  idempotencyKey?: string;
  /**
   * Conjunto de configuração do provedor. No SES é o que liga o envio ao tópico SNS
   * que devolve bounce/complaint — sem ele os eventos simplesmente não chegam.
   */
  configurationSet?: string | null;
}

export interface ResultadoEnvio {
  providerMessageId: string;
}

export interface EmailProvider {
  readonly nome: "smtp" | "ses" | "resend";
  send(msg: OutboundEmail): Promise<ResultadoEnvio>;
}

/**
 * Erro de envio com a informação que o chamador precisa para decidir:
 * repetir (throttling/5xx) ou desistir (endereço inválido, domínio não verificado).
 */
export class ErroEnvio extends Error {
  readonly status: number;
  readonly rateLimited: boolean;
  readonly codigo?: string;
  /** true quando faz sentido tentar de novo com backoff. */
  readonly repetivel: boolean;

  constructor(
    mensagem: string,
    opcoes: { status?: number; rateLimited?: boolean; codigo?: string; repetivel?: boolean } = {},
  ) {
    super(mensagem);
    this.name = "ErroEnvio";
    this.status = opcoes.status ?? 0;
    this.rateLimited = opcoes.rateLimited ?? false;
    this.codigo = opcoes.codigo;
    this.repetivel = opcoes.repetivel ?? (this.rateLimited || this.status >= 500);
  }
}

/** Normaliza destinatário para lista — os três provedores aceitam formatos diferentes. */
export function comoLista(v: string | string[] | null | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v.filter(Boolean) : [v];
}
