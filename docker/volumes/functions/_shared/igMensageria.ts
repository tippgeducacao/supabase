// Envio de DM pelo Instagram (Instagram API with Instagram Login — graph.instagram.com).
// O token é o "Instagram User access token" da conta (ig_contas_secrets): dura 60 dias
// e morre também quando alguém troca a senha da conta (erro 190). Ver
// docs/Instagram (IA + Chat).md.
//
// Só texto por enquanto. A API aceita imagem, áudio, vídeo e PDF por URL, mas nada no
// sistema manda mídia pelo direct ainda.

export const IG_GRAPH_URL = "https://graph.instagram.com/v23.0";
/** Limite da Meta: "Message text must be UTF-8 and be 1000 bytes or less." */
export const IG_TEXTO_MAX_BYTES = 1000;

const encoder = new TextEncoder();
export function bytesUtf8(texto: string): number {
  return encoder.encode(texto).length;
}

/**
 * Quebra o texto em pedaços de até `max` bytes UTF-8 — o limite é em BYTES, e acento e
 * emoji ocupam de 2 a 4. Prefere cortar no último espaço; nunca corta um caractere
 * no meio (percorre por code point, não por unidade UTF-16).
 */
export function dividirPorBytes(texto: string, max = IG_TEXTO_MAX_BYTES): string[] {
  let resto = String(texto ?? "").trim();
  const partes: string[] = [];
  while (resto) {
    if (bytesUtf8(resto) <= max) {
      partes.push(resto);
      break;
    }
    const caracteres = Array.from(resto);
    let bytes = 0;
    let fim = 0;
    for (; fim < caracteres.length; fim++) {
      const b = bytesUtf8(caracteres[fim]);
      if (bytes + b > max) break;
      bytes += b;
    }
    let corte = caracteres.slice(0, Math.max(fim, 1)).join("");
    const espaco = Math.max(corte.lastIndexOf(" "), corte.lastIndexOf("\n"));
    // Só volta até o espaço se ele não jogar fora mais da metade do pedaço.
    if (espaco > corte.length / 2) corte = corte.slice(0, espaco);
    partes.push(corte.trim());
    resto = resto.slice(corte.length).trim();
  }
  return partes.filter(Boolean);
}

export type ErroEnvioIg = { status: number; code?: number; subcode?: number; message: string };
export type ResultadoEnvioIg = { ok: true; mid: string } | { ok: false; erro: ErroEnvioIg };

/** Manda UM texto (até 1000 bytes — quebre antes com `dividirPorBytes`). */
export function enviarTextoIg(
  token: string,
  igsid: string,
  texto: string,
  f: typeof fetch = fetch,
): Promise<ResultadoEnvioIg> {
  return postarMensagemIg(token, "me", { id: igsid }, texto, f);
}

/**
 * RESPOSTA PRIVADA a um comentário (12/11/2026, comentário de live): a DM vai para quem
 * comentou, endereçada pelo `comment_id` — é o único jeito de escrever para quem ainda não
 * mandou DM. Regras da Meta (Private Replies): UMA mensagem por comentário; comentário de
 * LIVE só enquanto a transmissão está no ar; não abre a janela de 24h (só a resposta da
 * pessoa abre).
 *
 * Endereço: a documentação mostra /<IG_ID>/messages, mas a 1ª tentativa de verdade (12/11/2026,
 * live no ar, comentário de 34 min antes) voltou HTTP 500 "An unknown error has occurred"
 * (code 1) por ele. A DM comum, que funciona em produção, vai por /me/messages — então é
 * por ele que a resposta privada tenta primeiro; se a Meta devolver o erro genérico e
 * houver o id da conta, tenta UMA vez pelo endereço documentado.
 */
export async function enviarRespostaPrivadaIg(
  token: string,
  commentId: string,
  texto: string,
  igUserId: string | null = null,
  f: typeof fetch = fetch,
): Promise<ResultadoEnvioIg> {
  const primeira = await postarMensagemIg(token, "me", { comment_id: commentId }, texto, f);
  if (primeira.ok || !igUserId || !ehErroGenericoDaMeta(primeira.erro)) return primeira;
  const segunda = await postarMensagemIg(token, igUserId, { comment_id: commentId }, texto, f);
  if (segunda.ok) return segunda;
  // As duas falharam: o erro que vale é o mais específico (o genérico não diz nada).
  return ehErroGenericoDaMeta(segunda.erro) ? primeira : segunda;
}

/** "An unknown error has occurred" (code 1/2, HTTP 5xx): a Meta não disse o motivo. */
export function ehErroGenericoDaMeta(erro: ErroEnvioIg): boolean {
  return erro.status >= 500 || erro.code === 1 || erro.code === 2;
}

async function postarMensagemIg(
  token: string,
  dono: string,
  recipient: { id: string } | { comment_id: string },
  texto: string,
  f: typeof fetch,
): Promise<ResultadoEnvioIg> {
  try {
    const r = await f(`${IG_GRAPH_URL}/${dono}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ recipient, message: { text: texto } }),
      signal: AbortSignal.timeout(15_000),
    });
    // deno-lint-ignore no-explicit-any
    const b: any = await r.json().catch(() => ({}));
    if (r.ok && typeof b?.message_id === "string" && b.message_id) return { ok: true, mid: b.message_id };
    return {
      ok: false,
      erro: {
        status: r.status,
        code: typeof b?.error?.code === "number" ? b.error.code : undefined,
        subcode: typeof b?.error?.error_subcode === "number" ? b.error.error_subcode : undefined,
        message: String(b?.error?.message ?? (r.ok ? "resposta sem message_id" : `HTTP ${r.status}`)).slice(0, 300),
      },
    };
  } catch (e) {
    return { ok: false, erro: { status: 0, message: (e instanceof Error ? e.message : String(e)).slice(0, 300) } };
  }
}

/** Token morto (expirou ou a senha mudou): nada adianta até reconectar a conta. */
export function ehTokenInvalido(erro: ErroEnvioIg): boolean {
  return erro.code === 190;
}
