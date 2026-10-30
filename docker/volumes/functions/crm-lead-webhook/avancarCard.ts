/**
 * "Trazer o card de outra etapa" da ação Criar oportunidade (30/10/2026, opt-in `avancarDe`).
 * Duas páginas do MESMO processo são duas webhooks (pré-inscrição → inscrição completa do
 * Seletivo Professores). O "não criar repetidas" só enxerga a própria webhook, então a 2ª
 * abria outro card. Com as etapas marcadas, o card ABERTO do contato nelas é reaproveitado.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Etapas de onde o card é trazido. Lixo e repetição ficam de fora; vazio = opção desligada. */
export function etapasDeOrigem(params: { avancarDe?: unknown } | null | undefined): string[] {
  const lista = Array.isArray(params?.avancarDe) ? params!.avancarDe : [];
  return [...new Set(lista.filter((v): v is string => typeof v === "string" && UUID.test(v)))];
}

/**
 * Anda só para a frente: card ANTES da etapa da ação vai para ela; card já nela ou depois só
 * ganha o recadastro. Ordem desconhecida (etapa apagada no meio) não move — card no lugar
 * errado é pior que card parado.
 */
export function decidirAvanco(ordemAtual: number | null | undefined, ordemDestino: number | null | undefined): "mover" | "recadastro" {
  if (typeof ordemAtual !== "number" || typeof ordemDestino !== "number") return "recadastro";
  return ordemAtual < ordemDestino ? "mover" : "recadastro";
}
