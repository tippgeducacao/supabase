/** Identificação solicitada pela direção, opt-in por integração (Fórum, 29/10/2026). */
export function nomeComPrefixo(nome: string | null | undefined, prefixo: unknown): string | null {
  const valor = nome?.trim();
  if (!valor) return null;
  if (typeof prefixo !== "string" || !prefixo.trim() || prefixo.length > 30) return valor;
  const inicio = prefixo.trim();
  return valor.toLocaleUpperCase("pt-BR").startsWith(`${inicio.toLocaleUpperCase("pt-BR")} `)
    ? valor : `${inicio} ${valor}`;
}
