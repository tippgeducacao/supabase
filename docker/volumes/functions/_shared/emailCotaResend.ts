/**
 * Reserva da conta Resend para outros sistemas (14/10/2026).
 *
 * A conta tem 200.000 e-mails por ciclo e é dividida com outra plataforma. O PPGVET para de
 * enviar pelo Resend quando o uso da CONTA (cabeçalho `x-resend-monthly-quota`, que já soma a
 * outra plataforma) chega a `limite_plano - reserva_externa` — os últimos 5.000 ficam sempre
 * livres para os outros. A régua mora no banco (`email_resend_cota_liberar`, migration
 * 20261014130000); aqui fica só a leitura da resposta e o texto, TypeScript puro para o vitest.
 */

export interface LiberacaoCotaResend {
  liberado: boolean;
  /** true = trava fechada, mas este envio passa para reler o uso (1 a cada 6 h). */
  sonda: boolean;
  uso: number | null;
  teto: number | null;
  limitePlano: number | null;
  reservaExterna: number | null;
}

/** Prefixo do `erro_msg` do envio retido — é por ele que a tela conta os retidos. */
export const CODIGO_RESERVA_RESEND = "ppgvet_reserva_resend";

const inteiro = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;

/**
 * Resposta da RPC → liberação. Qualquer coisa fora do formato LIBERA: a trava protege a
 * reserva, mas falha de leitura não pode parar todo e-mail do sistema.
 */
export function lerLiberacaoCotaResend(dados: unknown): LiberacaoCotaResend {
  const d = dados && typeof dados === "object" ? dados as Record<string, unknown> : {};
  return {
    liberado: d.liberado !== false,
    sonda: d.sonda === true,
    uso: inteiro(d.uso),
    teto: inteiro(d.teto),
    limitePlano: inteiro(d.limite_plano),
    reservaExterna: inteiro(d.reserva_externa),
  };
}

const num = (n: number) => n.toLocaleString("pt-BR");

/** O motivo gravado no envio retido e devolvido a quem chamou. */
export function motivoReservaResend(c: LiberacaoCotaResend): string {
  const uso = c.uso != null && c.limitePlano != null
    ? `a conta já usou ${num(c.uso)} de ${num(c.limitePlano)} e-mails neste ciclo`
    : "a conta chegou ao limite do PPGVET neste ciclo";
  const reserva = c.reservaExterna != null
    ? `os últimos ${num(c.reservaExterna)} ficam reservados para outros sistemas`
    : "o restante fica reservado para outros sistemas";
  return `O PPGVET parou de enviar pelo Resend: ${uso}, e ${reserva}. Volta sozinho quando o Resend renovar o ciclo ou o plano for ampliado.`;
}
