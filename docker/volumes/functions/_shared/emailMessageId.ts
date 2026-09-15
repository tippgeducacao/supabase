/** IDs RFC 5322, separados dos IDs internos Gmail/Resend. Nunca fabricar um pai. */
export function normalizarMessageId(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  const limpo = valor.trim();
  const conteudo = limpo.startsWith('<') && limpo.endsWith('>') ? limpo.slice(1, -1) : limpo;
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(conteudo) || conteudo.length > 996) return null;
  const arroba = conteudo.indexOf('@');
  return `<${conteudo.slice(0, arroba)}@${conteudo.slice(arroba + 1).toLowerCase()}>`;
}

export function extrairMessageIds(valor: unknown): string[] {
  if (typeof valor !== 'string') return [];
  const partes = valor.match(/<[^<>]*>/g) ?? [valor];
  return [...new Set(partes.map(normalizarMessageId).filter((id): id is string => id !== null))];
}

export function montarHeadersResposta(messageId: unknown, references: unknown): { inReplyTo: string; references: string } | null {
  const pai = normalizarMessageId(messageId);
  if (!pai) return null;
  return { inReplyTo: pai, references: [...new Set([...extrairMessageIds(references), pai])].join(' ') };
}

export function headersDeMensagemGmail(payload: unknown): { messageId: string | null; references: string | null } {
  const headers = payload && typeof payload === 'object' && 'headers' in payload && Array.isArray(payload.headers)
    ? payload.headers : [];
  const valor = (nome: string): unknown => headers.find((h: unknown) => h && typeof h === 'object'
    && 'name' in h && typeof h.name === 'string' && h.name.toLowerCase() === nome)?.value;
  return { messageId: normalizarMessageId(valor('message-id')), references: extrairMessageIds(valor('references')).join(' ') || null };
}
