// crm-whatsapp-call/pedidoPermissao.ts
// ----------------------------------------------------------------------------
// O pedido de permissão para ligar (Calling API) é uma MENSAGEM de verdade: a Meta
// devolve um wamid e o lead vê um balão com os botões nativos (7 dias · permanente ·
// não permitir). Até 03/09/2026 ele não ficava na conversa — o atendente não sabia se
// tinha saído, se o lead tinha recebido, nem que já tinha gasto o 1 pedido/24h daquele
// lead. Este helper monta o texto do balão de SAÍDA gravado em `crm_whatsapp_messages`
// (o espelho leva ao SAC; o webhook de status pinta os tiques pelo wamid).
// Helper PURO (sem Deno) de propósito: roda no vitest do repo.

export const TEXTO_PADRAO_PEDIDO_PERMISSAO =
  "Podemos te ligar aqui pelo WhatsApp para explicar melhor? É mais rápido que digitar.";

/** Primeira linha do balão — o que o atendente lê de relance na timeline. */
export const TITULO_PEDIDO_PERMISSAO = "📞 Pedido de permissão para ligar pelo WhatsApp";

/**
 * Texto do balão de saída: o título fixo + o corpo que o lead recebeu, entre aspas.
 * Corpo vazio cai no texto padrão (o mesmo que a função manda para a Meta).
 */
export function textoPedidoPermissao(texto: string | null | undefined): string {
  const corpo = String(texto ?? "").trim() || TEXTO_PADRAO_PEDIDO_PERMISSAO;
  return `${TITULO_PEDIDO_PERMISSAO}\n“${corpo}”`;
}
