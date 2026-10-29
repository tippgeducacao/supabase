// Mídia RECEBIDA (de lead, aluno, candidato) em bucket PRIVADO — 29/10/2026.
//
// Até 29/10 toda mídia de conversa ia para o bucket PÚBLICO `whatsapp-anexos`: quem tivesse o
// link baixava sem login, para sempre (achado da validação de 28-29/10). A mídia recebida nova
// passa a ir para `whatsapp-recebidos` (privado) e o que fica gravado em `anexos[].url` é um link
// ASSINADO de 7 dias (+ `bucket`/`caminho`). Quem usa a mídia em minutos (João, transcrição,
// webchat) segue com um link que funciona; quem chega depois de vencer pede um link novo aqui
// (edge) ou em src/lib/whatsapp/midiaRecebida.ts (front).
//
// Sem import por URL: carrega no vitest. As dependências (base, chave, fetch) entram por parâmetro.

export const BUCKET_RECEBIDOS = "whatsapp-recebidos";
/** Validade do link gravado na mensagem. */
export const VALIDADE_LINK_GRAVADO_S = 7 * 24 * 60 * 60;

const RE_OBJETO = /\/storage\/v1\/object\/(?:sign|public|authenticated)\/whatsapp-recebidos\/([^?#]+)/;

/** Caminho do objeto no bucket privado, ou null se o link não é de lá. */
export function caminhoRecebido(url: string | null | undefined): string | null {
  const m = typeof url === "string" ? url.match(RE_OBJETO) : null;
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** `exp` (segundos) do token do link assinado, ou null. Só lê; quem confere é o storage. */
export function expiracaoDoLink(url: string): number | null {
  try {
    const token = new URL(url).searchParams.get("token");
    const parte = token?.split(".")[1];
    if (!parte) return null;
    const json = JSON.parse(atob(parte.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof json?.exp === "number" ? json.exp : null;
  } catch {
    return null;
  }
}

/** O link precisa ser renovado (é do bucket privado e vence em menos de `folgaMs`)? */
export function precisaRenovar(url: string | null | undefined, agoraMs = Date.now(), folgaMs = 10 * 60_000): boolean {
  if (!url || !caminhoRecebido(url)) return false;
  const exp = expiracaoDoLink(url);
  return exp === null || exp * 1000 - agoraMs < folgaMs;
}

function codificarCaminho(caminho: string): string {
  return caminho.split("/").map(encodeURIComponent).join("/");
}

export interface DepsAssinatura {
  base: string;          // SUPABASE_URL (interno na edge)
  chave: string;         // service role
  fetchImpl?: typeof fetch;
}

/** Gera um link assinado para um objeto do bucket privado (POST /storage/v1/object/sign/...). */
export async function assinarCaminho(caminho: string, validadeS: number, deps: DepsAssinatura): Promise<string> {
  const base = deps.base.replace(/\/$/, "");
  const r = await (deps.fetchImpl ?? fetch)(`${base}/storage/v1/object/sign/${BUCKET_RECEBIDOS}/${codificarCaminho(caminho)}`, {
    method: "POST",
    headers: { apikey: deps.chave, Authorization: `Bearer ${deps.chave}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: validadeS }),
  });
  if (!r.ok) throw new Error(`assinar mídia recebida: HTTP ${r.status}`);
  const j = (await r.json()) as { signedURL?: string };
  if (!j?.signedURL) throw new Error("assinar mídia recebida: resposta sem signedURL");
  return `${base}/storage/v1${j.signedURL}`;
}

function depsDoAmbiente(): DepsAssinatura | null {
  const env = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env;
  const base = env?.get("SUPABASE_URL");
  const chave = env?.get("SUPABASE_SERVICE_ROLE_KEY");
  return base && chave ? { base, chave } : null;
}

/**
 * Link que dá para baixar AGORA. Link público de hoje (bucket antigo, CDN da Meta) volta igual;
 * link assinado do bucket privado perto de vencer ganha um novo de 10 minutos. Na falha devolve o
 * original — quem baixa reporta o erro HTTP como sempre reportou.
 */
export async function urlBaixavel(url: string, deps: DepsAssinatura | null = depsDoAmbiente()): Promise<string> {
  if (!precisaRenovar(url, Date.now(), 2 * 60_000) || !deps) return url;
  try {
    return await assinarCaminho(caminhoRecebido(url)!, 600, deps);
  } catch {
    return url;
  }
}
