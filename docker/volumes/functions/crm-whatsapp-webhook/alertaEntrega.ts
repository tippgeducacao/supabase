// Alerta de ENTREGA BLOQUEADA na conta (10/10/2026).
//
// Incidente: a WABA da BM02 (46999222248) ficou com pendência de pagamento na Meta de
// 08/10 a 10/10. A Meta ACEITA o envio (devolve wamid, a automação marca "Executou") e só
// depois manda status=failed com 131042 — 1.562 mensagens falharam em silêncio, incluindo
// um disparo de 716 templates, e ninguém soube. O webhook de conta (account_update) NÃO
// chegou: o único sinal foi o erro em cada status. Por isso o alerta nasce AQUI, do status.
//
// Só códigos que valem para a CONTA inteira (não para um destinatário): um 131026 de um
// número sem WhatsApp não pode acender faixa vermelha.

export const TIPO_ALERTA_ENTREGA = "entrega_conta";

const CODIGOS_DE_CONTA: Record<string, { titulo: string; descricao: string }> = {
  "131042": {
    titulo: "mensagens NÃO estão sendo entregues — pendência de pagamento na Meta (131042)",
    descricao:
      "A Meta aceita o envio e depois recusa a entrega por problema no método de pagamento da conta WhatsApp Business. " +
      "Nada sai por este número (automações, disparos e SAC) até regularizar no Billing Hub do Business Manager. " +
      "O que falhou NÃO é reenviado sozinho: dispare de novo depois de resolver.",
  },
  "131031": {
    titulo: "mensagens NÃO estão sendo entregues — conta bloqueada pela Meta (131031)",
    descricao:
      "A Meta bloqueou/restringiu a conta WhatsApp Business e recusa as entregas. Verifique o Business Manager " +
      "(Qualidade da conta). O que falhou NÃO é reenviado sozinho.",
  },
  "368": {
    titulo: "mensagens NÃO estão sendo entregues — conta bloqueada por política (368)",
    descricao:
      "A Meta bloqueou temporariamente a conta por violação de política e recusa as entregas. Verifique o " +
      "Business Manager. O que falhou NÃO é reenviado sozinho.",
  },
};

export type AlertaEntrega = { codigo: string; titulo: string; descricao: string };

/** O status de falha aponta um problema da CONTA? Devolve o alerta, ou null. */
export function alertaDeFalhaDeConta(errors: unknown): AlertaEntrega | null {
  if (!Array.isArray(errors)) return null;
  for (const e of errors) {
    const codigo = String((e as { code?: unknown })?.code ?? "");
    const def = CODIGOS_DE_CONTA[codigo];
    if (def) return { codigo, ...def };
  }
  return null;
}

/** Entregue ou lida = a conta voltou a entregar (fecha o alerta). */
export function statusProvaEntrega(status: unknown): boolean {
  return status === "delivered" || status === "read";
}
