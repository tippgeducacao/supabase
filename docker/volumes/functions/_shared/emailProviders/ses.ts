/**
 * Provedor Amazon SES (SESv2, `SendEmailCommand`).
 *
 * ⚠️ O SDK da AWS NÃO é importado no topo deste módulo, e isso é deliberado:
 *   - o import seria `npm:@aws-sdk/client-sesv2`, especificador que o Deno resolve mas
 *     o vitest (Node) não — o arquivo inteiro deixaria de ser testável;
 *   - carregar o SDK custa caro no cold start de uma edge function que, na maioria das
 *     invocações, nem envia por SES.
 *
 * Em vez disso o cliente é INJETÁVEL: o teste passa um mock e o SDK real nunca é
 * carregado; em produção o import dinâmico acontece na primeira chamada.
 */
import {
  type EmailProvider,
  type OutboundEmail,
  type ResultadoEnvio,
  ErroEnvio,
  comoLista,
} from "./types.ts";

/** Superfície mínima do cliente SESv2 que usamos — o que o mock precisa implementar. */
export interface ClienteSesLike {
  send(comando: unknown): Promise<{ MessageId?: string }>;
}

export interface OpcoesSes {
  region?: string;
  configurationSet?: string | null;
  /** Injetado nos testes. Ausente = importa o SDK de verdade sob demanda. */
  cliente?: ClienteSesLike;
  /** Injetada nos testes junto com o cliente; monta o comando de envio. */
  criarComando?: (entrada: Record<string, unknown>) => unknown;
}

/** Erros do SES em que repetir tem chance real de mudar o resultado. */
const REPETIVEIS = new Set([
  "Throttling",
  "ThrottlingException",
  "TooManyRequestsException",
  "ServiceUnavailable",
  "InternalFailure",
  "RequestTimeout",
]);

export class SesProvider implements EmailProvider {
  readonly nome = "ses" as const;

  private cliente?: ClienteSesLike;
  private criarComando?: (entrada: Record<string, unknown>) => unknown;
  private readonly region: string;
  private readonly configurationSet: string | null;

  constructor(opcoes: OpcoesSes = {}) {
    this.cliente = opcoes.cliente;
    this.criarComando = opcoes.criarComando;
    this.region = opcoes.region ?? lerEnv("AWS_REGION") ?? "us-east-1";
    this.configurationSet = opcoes.configurationSet ?? lerEnv("SES_CONFIGURATION_SET_MKT") ?? null;
  }

  /** Carrega o SDK só quando não há cliente injetado (ou seja: nunca nos testes). */
  private async garantirCliente(): Promise<void> {
    if (this.cliente && this.criarComando) return;
    const mod = await import("npm:@aws-sdk/client-sesv2@3");
    const { SESv2Client, SendEmailCommand } = mod as unknown as {
      SESv2Client: new (cfg: { region: string }) => ClienteSesLike;
      SendEmailCommand: new (input: Record<string, unknown>) => unknown;
    };
    this.cliente ??= new SESv2Client({ region: this.region });
    this.criarComando ??= (entrada) => new SendEmailCommand(entrada);
  }

  async send(msg: OutboundEmail): Promise<ResultadoEnvio> {
    await this.garantirCliente();

    const destino = comoLista(msg.to);
    if (destino.length === 0) throw new ErroEnvio("sem destinatário", { repetivel: false });

    // O SES v2 tem dois formatos: Simple (sem anexo) e Raw (MIME cru). Anexo obriga
    // o Raw, então só montamos o MIME quando é necessário — Simple é mais barato de
    // montar e menos sujeito a erro de encoding.
    const temAnexo = !!msg.attachments?.length;
    const entrada: Record<string, unknown> = {
      FromEmailAddress: msg.from,
      Destination: { ToAddresses: destino, BccAddresses: comoLista(msg.bcc) },
      ConfigurationSetName: msg.configurationSet ?? this.configurationSet ?? undefined,
      ...(msg.replyTo ? { ReplyToAddresses: [msg.replyTo] } : {}),
      ...(msg.tags?.length
        ? { EmailTags: msg.tags.map((t) => ({ Name: t.name, Value: t.value })) }
        : {}),
    };

    if (temAnexo) {
      entrada.Content = { Raw: { Data: montarMime(msg) } };
    } else {
      entrada.Content = {
        Simple: {
          Subject: { Data: msg.subject, Charset: "UTF-8" },
          Body: {
            Html: { Data: msg.html, Charset: "UTF-8" },
            ...(msg.text ? { Text: { Data: msg.text, Charset: "UTF-8" } } : {}),
          },
          // List-Unsubscribe entra aqui: o formato Simple aceita cabeçalho extra, e é
          // o que Gmail e Yahoo exigem de quem manda volume.
          ...(msg.headers && Object.keys(msg.headers).length
            ? { Headers: Object.entries(msg.headers).map(([Name, Value]) => ({ Name, Value })) }
            : {}),
        },
      };
    }

    try {
      const resposta = await this.cliente!.send(this.criarComando!(entrada));
      const id = resposta?.MessageId;
      if (!id) throw new ErroEnvio("SES aceitou mas não devolveu MessageId", { repetivel: false });
      return { providerMessageId: id };
    } catch (e) {
      if (e instanceof ErroEnvio) throw e;
      throw traduzirErro(e);
    }
  }
}

function lerEnv(chave: string): string | undefined {
  // `Deno` não existe no vitest; o acesso é defensivo para o módulo continuar importável.
  const g = globalThis as { Deno?: { env: { get(k: string): string | undefined } } };
  return g.Deno?.env.get(chave);
}

function traduzirErro(e: unknown): ErroEnvio {
  const erro = e as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const codigo = erro?.name;
  const status = erro?.$metadata?.httpStatusCode ?? 0;
  const rateLimited = status === 429 || (codigo ? REPETIVEIS.has(codigo) : false);
  return new ErroEnvio(erro?.message ?? "falha no SES", {
    status,
    codigo,
    rateLimited,
    repetivel: rateLimited || status >= 500,
  });
}

/**
 * MIME cru para o caminho com anexo. Mantido aqui, e não numa lib, porque é o mesmo
 * formato que o caminho Gmail já monta — trazer dependência para isto seria peso sem
 * ganho, e o encoding é a parte que quebra em cliente de e-mail.
 */
function montarMime(msg: OutboundEmail): string {
  const limite = `mix_${crypto.randomUUID()}`;
  const limiteAlt = `alt_${crypto.randomUUID()}`;
  const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  const assunto = `=?UTF-8?B?${b64(msg.subject)}?=`;

  const cabecalhos = [
    `From: ${msg.from}`,
    `To: ${comoLista(msg.to).join(", ")}`,
    `Subject: ${assunto}`,
    "MIME-Version: 1.0",
    ...(msg.replyTo ? [`Reply-To: ${msg.replyTo}`] : []),
    ...Object.entries(msg.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
    `Content-Type: multipart/mixed; boundary="${limite}"`,
  ];

  const partes = [
    "",
    `--${limite}`,
    `Content-Type: multipart/alternative; boundary="${limiteAlt}"`,
    "",
    `--${limiteAlt}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    msg.text ?? msg.html.replace(/<[^>]+>/g, ""),
    "",
    `--${limiteAlt}`,
    "Content-Type: text/html; charset=UTF-8",
    "",
    msg.html,
    "",
    `--${limiteAlt}--`,
  ];

  for (const a of msg.attachments ?? []) {
    partes.push(
      `--${limite}`,
      `Content-Type: ${a.contentType ?? "application/octet-stream"}; name="${a.filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${a.filename}"`,
      "",
      a.content.replace(/(.{76})/g, "$1\r\n"),
    );
  }
  partes.push(`--${limite}--`);

  return [...cabecalhos, ...partes].join("\r\n");
}
