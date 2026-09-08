/**
 * Ajudantes de envio que NÃO dependem de provedor: formatação do "De:", tag segura,
 * chave de idempotência e o DESCADASTRO (assinatura HMAC do link de um clique).
 *
 * ⚠️ Isto morava em `_shared/resend.ts` — e quase foi apagado junto quando o Resend saiu
 * do sistema em 2026-09-08. Nada aqui tem a ver com Resend: o descadastro é obrigatório
 * em disparo de massa (Gmail e Outlook exigem `List-Unsubscribe` de quem manda volume) e
 * é o que alimenta a lista de supressão. Guardar utilitário genérico dentro do módulo de
 * um provedor é como se perde código ao remover esse provedor.
 */

/** Comparação de tempo constante — não vaza o segredo byte a byte. */
function igualSeguro(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Monta o cabeçalho From no formato "Nome <email>", com o nome codificado se tiver acento. */
export function formatarFrom(nome: string | null | undefined, email: string): string {
  if (!nome) return email;
  const precisaEncode = /[^\x20-\x7E]/.test(nome);
  const nomeSeguro = precisaEncode
    ? `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(nome)))}?=`
    : `"${nome.replace(/"/g, "")}"`;
  return `${nomeSeguro} <${email}>`;
}

/**
 * O Resend só aceita nome/valor ASCII em `tags` — um valor com acento faz a API
 * devolver 422 e o e-mail inteiro não sai. Sanitiza em vez de arriscar.
 */
export function tagSegura(valor: string): string {
  return valor.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 256);
}

/**
 * Chave de idempotência no formato <tipo-do-evento>/<id-da-entidade>.
 * Precisa ser ESTÁVEL entre tentativas do mesmo envio lógico — por isso deriva da
 * entidade (linha da fila, etapa do funil), nunca de timestamp ou uuid novo.
 */
export function chaveIdempotencia(tipo: string, id: string): string {
  return `${tipo}/${id}`.slice(0, 256);
}

// ---------------------------------------------------------------- descadastro

/**
 * Token de descadastro sem estado: HMAC do e-mail. Evita uma tabela de tokens e
 * funciona igual para campanha e transacional. O link só descadastra o e-mail que
 * ele assina — não dá para descadastrar terceiros adivinhando id.
 */
async function chaveHmac(): Promise<CryptoKey> {
  const segredo = Deno.env.get("EMAIL_UNSUB_SECRET") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(segredo),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function assinarDescadastro(email: string): Promise<string> {
  const chave = await chaveHmac();
  const assinatura = await crypto.subtle.sign(
    "HMAC",
    chave,
    new TextEncoder().encode(email.toLowerCase().trim()),
  );
  return [...new Uint8Array(assinatura)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

export async function conferirDescadastro(email: string, token: string): Promise<boolean> {
  return igualSeguro(await assinarDescadastro(email), token);
}

export async function linkDescadastro(baseUrl: string, email: string): Promise<string> {
  const token = await assinarDescadastro(email);
  return `${baseUrl}/functions/v1/email-descadastro?e=${encodeURIComponent(email)}&t=${token}`;
}
