/**
 * Seleção do provedor de envio.
 *
 * Duas camadas, e a ordem importa:
 *   1. o REMETENTE manda (`email_remetentes.provider`) — é o que permite o funil de TCC
 *      continuar saindo pelo Gmail enquanto a campanha sai por SES;
 *   2. `EMAIL_PROVIDER` só decide o padrão de quem não declarou nada, e é o que faz o
 *      ambiente de desenvolvimento cair no SMTP sem tocar em dado.
 */
import type { EmailProvider } from "./types.ts";
import { SesProvider } from "./ses.ts";
import { SmtpProvider } from "./smtp.ts";

export * from "./types.ts";
export { SesProvider } from "./ses.ts";
export { SmtpProvider } from "./smtp.ts";

export type NomeProvedor = "smtp" | "ses" | "resend";

function lerEnv(chave: string): string | undefined {
  const g = globalThis as { Deno?: { env: { get(k: string): string | undefined } } };
  return g.Deno?.env.get(chave);
}

/** Padrão do ambiente. `smtp` de propósito: nada de produção sai sem configuração explícita. */
export function provedorPadrao(): NomeProvedor {
  const v = (lerEnv("EMAIL_PROVIDER") ?? "smtp").toLowerCase();
  return v === "ses" || v === "resend" ? v : "smtp";
}

/** Rate limit do provedor, em mensagens por segundo. SES começa em 14/s na maioria das contas. */
export function limiteEnvioPorSegundo(): number {
  const n = Number(lerEnv("EMAIL_RATE_LIMIT") ?? 14);
  return Number.isFinite(n) && n > 0 ? n : 14;
}

/** Intervalo mínimo entre envios, derivado do rate limit. */
export function intervaloThrottleMs(): number {
  return Math.ceil(1000 / limiteEnvioPorSegundo());
}

export interface OpcoesFabrica {
  /** Provedor declarado no remetente. Vazio = usa o padrão do ambiente. */
  doRemetente?: string | null;
  /** Injetados nos testes. */
  instancias?: Partial<Record<NomeProvedor, EmailProvider>>;
}

/**
 * Provedor que realmente vai enviar.
 *
 * `EMAIL_PROVIDER=smtp` FUNCIONA COMO OVERRIDE, e não só como padrão: sem isso ele
 * nunca entraria em ação, porque `email_remetentes.provider` é NOT NULL com default
 * `gmail` — ou seja, todo remetente sempre declara algo. É este desvio que permite
 * rodar o fluxo inteiro contra um SMTP local sem tocar em nenhum dado.
 */
export function provedorEfetivo(doRemetente?: string | null): NomeProvedor {
  if (provedorPadrao() === "smtp") return "smtp";
  const n = (doRemetente ?? "") as NomeProvedor;
  return n === "ses" || n === "resend" || n === "smtp" ? n : provedorPadrao();
}

/**
 * Devolve o provedor a usar. `resend` não é instanciado aqui: ele vive em
 * `_shared/resend.ts` com a própria lógica de retry e idempotência, e o `email-send`
 * continua chamando aquele caminho — trazê-lo para cá exigiria reescrever o que já
 * está testado, sem ganho.
 */
export function obterProvedor(opcoes: OpcoesFabrica = {}): EmailProvider {
  const nome = provedorEfetivo(opcoes.doRemetente);

  const injetado = opcoes.instancias?.[nome];
  if (injetado) return injetado;

  switch (nome) {
    case "ses":
      return new SesProvider();
    case "smtp":
      return new SmtpProvider();
    default:
      throw new Error(
        `provedor "${nome}" não é instanciável por esta fábrica (resend tem caminho próprio em _shared/resend.ts)`,
      );
  }
}
