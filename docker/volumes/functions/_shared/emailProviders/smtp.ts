/**
 * Provedor SMTP — o caminho de desenvolvimento e o fallback para qualquer servidor
 * SMTP (inclusive o SMTP do próprio SES, se um dia for preferido à API).
 *
 * Mesmo padrão do `ses.ts`: o cliente é INJETÁVEL e a lib só é importada sob demanda,
 * para o módulo continuar testável no vitest sem resolver especificador `npm:`.
 */
import {
  type EmailProvider,
  type OutboundEmail,
  type ResultadoEnvio,
  ErroEnvio,
  comoLista,
} from "./types.ts";

/** Superfície mínima que o transporte precisa expor. */
export interface TransporteSmtpLike {
  send(msg: Record<string, unknown>): Promise<unknown>;
  close?(): Promise<void> | void;
}

export interface OpcoesSmtp {
  host?: string;
  port?: number;
  usuario?: string;
  senha?: string;
  tls?: boolean;
  /** Injetado nos testes. Ausente = importa o denomailer sob demanda. */
  transporte?: TransporteSmtpLike;
}

export class SmtpProvider implements EmailProvider {
  readonly nome = "smtp" as const;

  private transporte?: TransporteSmtpLike;
  private readonly host: string;
  private readonly port: number;
  private readonly usuario?: string;
  private readonly senha?: string;
  private readonly tls: boolean;

  constructor(opcoes: OpcoesSmtp = {}) {
    this.transporte = opcoes.transporte;
    this.host = opcoes.host ?? lerEnv("SMTP_HOST") ?? "supabase-mail";
    this.port = opcoes.port ?? Number(lerEnv("SMTP_PORT") ?? 2500);
    this.usuario = opcoes.usuario ?? lerEnv("SMTP_USER");
    this.senha = opcoes.senha ?? lerEnv("SMTP_PASS");
    // Inbucket em desenvolvimento não fala TLS; servidor real fala.
    this.tls = opcoes.tls ?? (lerEnv("SMTP_TLS") === "true");
  }

  private async garantirTransporte(): Promise<void> {
    if (this.transporte) return;
    const mod = await import("https://deno.land/x/denomailer@1.6.0/mod.ts");
    const { SMTPClient } = mod as unknown as {
      SMTPClient: new (cfg: Record<string, unknown>) => TransporteSmtpLike;
    };
    this.transporte = new SMTPClient({
      connection: {
        hostname: this.host,
        port: this.port,
        tls: this.tls,
        ...(this.usuario ? { auth: { username: this.usuario, password: this.senha ?? "" } } : {}),
      },
    });
  }

  async send(msg: OutboundEmail): Promise<ResultadoEnvio> {
    await this.garantirTransporte();

    const destino = comoLista(msg.to);
    if (destino.length === 0) throw new ErroEnvio("sem destinatário", { repetivel: false });

    try {
      await this.transporte!.send({
        from: msg.from,
        to: destino,
        ...(comoLista(msg.bcc).length ? { bcc: comoLista(msg.bcc) } : {}),
        ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
        subject: msg.subject,
        content: msg.text ?? undefined,
        html: msg.html,
        ...(msg.headers && Object.keys(msg.headers).length ? { headers: msg.headers } : {}),
        ...(msg.attachments?.length
          ? {
            attachments: msg.attachments.map((a) => ({
              filename: a.filename,
              encoding: "base64",
              content: a.content,
              contentType: a.contentType ?? "application/octet-stream",
            })),
          }
          : {}),
      });

      // SMTP não devolve id utilizável de forma padronizada. Geramos um local para o
      // log ter chave — e é por isso que o rastreio de bounce por SMTP é pobre: não há
      // id do provedor para o webhook casar depois.
      return { providerMessageId: `smtp-${crypto.randomUUID()}` };
    } catch (e) {
      const msgErro = e instanceof Error ? e.message : String(e);
      // Falha de conexão/tempo é transitória; recusa do servidor (5xx SMTP) não é.
      const transitoria = /timeout|econnrefused|enotfound|connection|4\d\d/i.test(msgErro);
      throw new ErroEnvio(msgErro, { repetivel: transitoria });
    }
  }
}

function lerEnv(chave: string): string | undefined {
  const g = globalThis as { Deno?: { env: { get(k: string): string | undefined } } };
  return g.Deno?.env.get(chave);
}
