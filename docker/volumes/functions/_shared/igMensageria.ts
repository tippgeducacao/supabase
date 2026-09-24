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
export async function enviarTextoIg(
  token: string,
  igsid: string,
  texto: string,
  f: typeof fetch = fetch,
): Promise<ResultadoEnvioIg> {
  try {
    const r = await f(`${IG_GRAPH_URL}/me/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: igsid }, message: { text: texto } }),
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
