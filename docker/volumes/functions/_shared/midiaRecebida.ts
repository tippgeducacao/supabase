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

/**
 * Buckets PRIVADOS que as edges precisam baixar ou repassar (30/10/2026): mídia recebida,
 * `whatsapp-anexos` (fases 3-4: enviados, figurinhas, cabeçalhos de template, PDFs — o link
 * público gravado continua sendo o identificador; quem baixa ou repassa à Meta/Uazapi assina
 * antes), e os dois buckets do Gestor. Espelho de `BUCKETS_PRIVADOS` em src/lib/storage/linkPrivado.ts.
 */
export const BUCKETS_PRIVADOS = ["whatsapp-recebidos", "whatsapp-anexos", "gt-doc-assets", "gt-chat-media"] as const;

const RE_OBJETO = /^https?:\/\/[^/?#]+\/storage\/v1\/object\/(?:sign|public|authenticated)\/([^/]+)\/([^?#]+)/i;

export class MidiaInvalida extends Error {
  constructor() { super("Endereço de mídia não permitido."); }
}

const temControleOuBarraInvertida = (valor: string) =>
  [...valor].some((c) => c === "\\" || c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

/** Antes de new URL: o parser normaliza /../ e esconderia a tentativa (pentest, 31/10). */
export function caminhoSeguro(caminho: string): boolean {
  if (!caminho || caminho.startsWith("/") || temControleOuBarraInvertida(caminho)) return false;
  let examinado = caminho;
  for (let i = 0; i < 5; i++) {
    if (examinado.split("/").some((p) => p === "." || p === "..") || temControleOuBarraInvertida(examinado)) return false;
    if (!/%[0-9a-f]{2}/i.test(examinado)) return true;
    try {
      const proximo = decodeURIComponent(examinado);
      if (proximo === examinado) return true;
      examinado = proximo;
    } catch { return false; }
  }
  return false;
}

function origensStorage(): Set<string> {
  const env = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env;
  const valores = ["https://api.ppgeducacao.site", "http://kong:8000", "http://supabase-kong:8000",
    env?.get("SUPABASE_URL"), env?.get("PUBLIC_SUPABASE_URL"), env?.get("SUPABASE_PUBLIC_URL")];
  return new Set(valores.flatMap((v) => { try { return v ? [new URL(v).origin] : []; } catch { return []; } }));
}

/** Reconhece somente nosso Storage, mantendo o caminho bruto até validar a travessia. */
export function objetoDoStorage(url: string | null | undefined): ObjetoPrivado | null {
  if (typeof url !== "string") return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (!origensStorage().has(u.origin)) return null;
  if (u.username || u.password || temControleOuBarraInvertida(url)) throw new MidiaInvalida();
  const m = url.match(RE_OBJETO);
  if (!m) {
    if (u.pathname.startsWith("/storage/")) throw new MidiaInvalida();
    return null;
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(m[1]) || !caminhoSeguro(m[2])) throw new MidiaInvalida();
  let caminho: string;
  try { caminho = decodeURIComponent(m[2]); } catch { throw new MidiaInvalida(); }
  if (!caminhoSeguro(caminho)) throw new MidiaInvalida();
  return { bucket: m[1], caminho };
}

export interface ObjetoPrivado {
  bucket: string;
  caminho: string;
}

/** `{ bucket, caminho }` se o link aponta para um dos buckets privados; senão null. */
export function objetoPrivado(url: string | null | undefined): ObjetoPrivado | null {
  const o = objetoDoStorage(url);
  return o && (BUCKETS_PRIVADOS as readonly string[]).includes(o.bucket) ? o : null;
}

/** Caminho do objeto no bucket de mídia RECEBIDA, ou null se o link não é de lá. */
export function caminhoRecebido(url: string | null | undefined): string | null {
  const o = objetoPrivado(url);
  return o && o.bucket === BUCKET_RECEBIDOS ? o.caminho : null;
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

/** Gera um link assinado para um objeto de qualquer bucket privado (POST /storage/v1/object/sign/...). */
export async function assinarObjeto(bucket: string, caminho: string, validadeS: number, deps: DepsAssinatura): Promise<string> {
  if (!(BUCKETS_PRIVADOS as readonly string[]).includes(bucket) || !caminhoSeguro(caminho)) throw new MidiaInvalida();
  const base = deps.base.replace(/\/$/, "");
  const r = await (deps.fetchImpl ?? fetch)(`${base}/storage/v1/object/sign/${bucket}/${codificarCaminho(caminho)}`, {
    method: "POST",
    headers: { apikey: deps.chave, Authorization: `Bearer ${deps.chave}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: validadeS }),
  });
  if (!r.ok) throw new Error(`assinar ${bucket}: HTTP ${r.status}`);
  const j = (await r.json()) as { signedURL?: string };
  if (!j?.signedURL) throw new Error(`assinar ${bucket}: resposta sem signedURL`);
  return `${base}/storage/v1${j.signedURL}`;
}

/** Atalho histórico: link assinado para o bucket de mídia recebida. */
export function assinarCaminho(caminho: string, validadeS: number, deps: DepsAssinatura): Promise<string> {
  return assinarObjeto(BUCKET_RECEBIDOS, caminho, validadeS, deps);
}

/**
 * O link é de bucket privado e NÃO dá para baixar com folga? Link público gravado (sem token)
 * de bucket privado ⇒ sim; link assinado vencendo em menos de `folgaMs` ⇒ sim.
 */
export function precisaAssinar(url: string | null | undefined, agoraMs = Date.now(), folgaMs = 2 * 60_000): boolean {
  if (!url || !objetoPrivado(url)) return false;
  const exp = expiracaoDoLink(url);
  return exp === null || exp * 1000 - agoraMs < folgaMs;
}

function depsDoAmbiente(): DepsAssinatura | null {
  const env = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env;
  const base = env?.get("SUPABASE_URL");
  const chave = env?.get("SUPABASE_SERVICE_ROLE_KEY");
  return base && chave ? { base, chave } : null;
}

/**
 * Link que dá para baixar AGORA (ou para a Meta/Uazapi baixarem em seguida). Link de fora
 * (CDN da Meta, bucket público nosso) volta igual; link de bucket PRIVADO — público gravado ou
 * assinado perto de vencer — ganha um assinado novo de 10 minutos pela service role. Na falha
 * devolve o original — quem baixa reporta o erro HTTP como sempre reportou.
 *
 * ⚠️ Use só para BAIXAR/REPASSAR: o que se grava na mensagem continua sendo o link original
 * (identificador do arquivo); link assinado gravado vence.
 */
export async function urlBaixavel(url: string, deps: DepsAssinatura | null = depsDoAmbiente(), validadeS = 600): Promise<string> {
  if (!precisaAssinar(url) || !deps) return url;
  const o = objetoPrivado(url)!;
  // Falha de assinatura não vira tentativa de baixar o link original (fail-closed).
  return await assinarObjeto(o.bucket, o.caminho, validadeS, deps);
}

function hostPublico(): string {
  const env = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env;
  return env?.get("PUBLIC_SUPABASE_URL") || "https://api.ppgeducacao.site";
}

/** URL interna do Kong (a que a edge enxerga) → host público, que Meta, Uazapi e navegador alcançam. */
export function paraHostPublico(url: string, publico = hostPublico()): string {
  return url.replace(/^https?:\/\/(?:supabase-)?kong:8000/i, publico);
}

/**
 * Link para ENTREGAR A TERCEIROS (Meta por `link`, Uazapi, navegador do lead): assinado como
 * `urlBaixavel` E com o host público. ⚠️ `urlBaixavel` sozinho devolve o host interno
 * (`kong:8000`), que só a própria edge alcança — a linha Web falhou com "failed to fetch URL"
 * em 30/10/2026 por causa disso.
 */
export async function urlParaTerceiros(url: string, deps: DepsAssinatura | null = depsDoAmbiente(), validadeS = 600): Promise<string> {
  return paraHostPublico(await urlBaixavel(url, deps, validadeS));
}
