/**
 * RFC822 cru → o MESMO formato que `_shared/gmail.ts` devolve.
 *
 * Esta equivalência é o que sustenta a paridade entre os dois motores: se o parser
 * IMAP devolve o mesmo shape do parser do Gmail, a gravação em `email_threads` /
 * `email_mensagens` fica idêntica e a Inbox não precisa saber quem é quem.
 *
 * O `postal-mime` é INJETÁVEL e só é importado sob demanda — mesma razão do
 * `emailProviders/ses.ts`: `import` estático de `npm:` o Deno resolve, mas o vitest
 * não, e o módulo deixaria de ser testável.
 */

export interface EnderecoParseado {
  email: string;
  name: string;
}

export interface AnexoParseado {
  filename: string;
  mimeType: string;
  size: number;
  conteudo: Uint8Array;
}

export interface MensagemParseada {
  headers: Record<string, string>;
  messageId: string;
  inReplyTo: string;
  references: string;
  assunto: string;
  de: EnderecoParseado;
  para: EnderecoParseado[];
  cc: EnderecoParseado[];
  data: string | null;
  html: string;
  text: string;
  anexos: AnexoParseado[];
}

/** Superfície mínima do postal-mime que usamos. */
export interface ParserMimeLike {
  (bruto: Uint8Array): Promise<Record<string, unknown>>;
}

function endereco(bruto: unknown): EnderecoParseado {
  const o = (bruto ?? {}) as { address?: string; name?: string };
  return { email: (o.address ?? "").trim().toLowerCase(), name: (o.name ?? "").trim() };
}

function enderecos(bruto: unknown): EnderecoParseado[] {
  if (!Array.isArray(bruto)) return [];
  return bruto.map(endereco).filter((e) => e.email);
}

function paraBytes(conteudo: unknown): Uint8Array {
  if (conteudo instanceof Uint8Array) return conteudo;
  if (conteudo instanceof ArrayBuffer) return new Uint8Array(conteudo);
  if (typeof conteudo === "string") return new TextEncoder().encode(conteudo);
  return new Uint8Array(0);
}

/**
 * Mesmo fallback do `parsePayload` do Gmail: e-mail só-texto vira `<pre>` com escape.
 * Copiado de propósito — se as duas implementações divergirem, a mesma mensagem
 * passa a renderizar diferente conforme o motor, que é exatamente o que a paridade
 * existe para impedir.
 */
export function textoParaHtml(texto: string): string {
  const escapado = texto.replace(
    /[<>&]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string),
  );
  return `<pre style="white-space:pre-wrap;font-family:inherit;margin:0">${escapado}</pre>`;
}

/**
 * Chave de thread a partir dos cabeçalhos de encadeamento.
 *
 * IMAP não tem "thread id" como o Gmail — quem encadeia é `References`, cuja PRIMEIRA
 * entrada é a raiz da conversa. `In-Reply-To` é a queda quando `References` não veio
 * (cliente antigo), e o próprio `Message-ID` é o caso da mensagem que inicia a thread.
 */
export function chaveDaThread(m: {
  references?: string;
  inReplyTo?: string;
  messageId?: string;
}): string {
  const refs = (m.references ?? "").match(/<[^>]+>/g);
  if (refs?.length) return refs[0];
  const emResposta = (m.inReplyTo ?? "").match(/<[^>]+>/);
  if (emResposta) return emResposta[0];
  return (m.messageId ?? "").trim();
}

async function parserPadrao(bruto: Uint8Array): Promise<Record<string, unknown>> {
  const mod = await import("npm:postal-mime@2");
  const PostalMime = (mod as { default?: unknown }).default ?? mod;
  return await (PostalMime as { parse: (b: Uint8Array) => Promise<Record<string, unknown>> })
    .parse(bruto);
}

export async function parsearMensagem(
  bruto: Uint8Array,
  parser: ParserMimeLike = parserPadrao,
): Promise<MensagemParseada> {
  const cru = await parser(bruto);

  const headers: Record<string, string> = {};
  for (const h of (cru.headers as Array<{ key?: string; value?: string }>) ?? []) {
    if (h?.key) headers[h.key.toLowerCase()] = h.value ?? "";
  }

  const text = String(cru.text ?? "");
  const html = String(cru.html ?? "") || (text ? textoParaHtml(text) : "");

  const anexos: AnexoParseado[] = [];
  for (const a of (cru.attachments as Array<Record<string, unknown>>) ?? []) {
    const conteudo = paraBytes(a.content);
    anexos.push({
      filename: String(a.filename ?? "anexo"),
      mimeType: String(a.mimeType ?? "application/octet-stream"),
      size: conteudo.length,
      conteudo,
    });
  }

  return {
    headers,
    messageId: String(cru.messageId ?? headers["message-id"] ?? "").trim(),
    inReplyTo: String(cru.inReplyTo ?? headers["in-reply-to"] ?? "").trim(),
    references: String(cru.references ?? headers["references"] ?? "").trim(),
    assunto: String(cru.subject ?? ""),
    de: endereco(cru.from),
    para: enderecos(cru.to),
    cc: enderecos(cru.cc),
    data: cru.date ? new Date(String(cru.date)).toISOString() : null,
    html,
    text,
    anexos,
  };
}

/** Resumo curto para a coluna `snippet`, no espírito do que o Gmail devolve. */
export function resumo(texto: string, html: string, limite = 200): string {
  const base = texto || html.replace(/<[^>]+>/g, " ");
  return base.replace(/\s+/g, " ").trim().slice(0, limite);
}
