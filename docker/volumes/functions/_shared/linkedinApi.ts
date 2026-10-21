// Cliente do LinkedIn para PUBLICAR NO PERFIL PESSOAL (produto "Share on LinkedIn",
// escopo `w_member_social`) + login OpenID Connect para saber QUEM autorizou.
//
// Só `fetch` — nada de Deno aqui, para o vitest conseguir exercitar com um fetch falso.
// As regras puras (escape do texto, desfecho do POST, conferência das partes) moram em
// `linkedinPost.ts`.
//
// ⚠️ TRÊS hosts, e cada um tem seu formato:
//   • www.linkedin.com/oauth/v2/…  → autorização e troca do código (form-urlencoded)
//   • api.linkedin.com/v2/userinfo → quem é a pessoa (OpenID Connect, Bearer, sem versão)
//   • api.linkedin.com/rest/…      → imagens, vídeos e posts (Bearer + `LinkedIn-Version`
//                                    + `X-Restli-Protocol-Version: 2.0.0`)
//
// ⚠️ `LINKEDIN_VERSION` (YYYYMM) tem validade: cada versão é desligada ~1 ano depois de lançada
// (a 202511 sai do ar em 16/11/2026). Quando os posts começarem a falhar com "version … is not
// active" / 426, é aqui que se troca — e só aqui.
import { conferirPartes, type InstrucaoDeParte, mensagemDoLinkedIn } from "./linkedinPost.ts";

export const LINKEDIN_VERSION = "202610";
export const AUTORIZAR_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
const REST = "https://api.linkedin.com/rest";
/** `openid profile` = saber quem autorizou (nome e foto). `w_member_social` = publicar. */
export const ESCOPOS = "openid profile w_member_social";
/**
 * ⚠️ Tem de ser IDÊNTICO ao "Authorized redirect URL" cadastrado no app do LinkedIn (aba Auth).
 * Divergir de uma letra devolve "The redirect_uri does not match the registered value".
 */
export const CALLBACK_URI = "https://api.ppgeducacao.site/functions/v1/linkedin-oauth-callback";

type Fetch = typeof fetch;

export class ErroLinkedIn extends Error {
  constructor(mensagem: string, readonly status: number | null = null, readonly corpo: unknown = null) {
    super(mensagem);
  }
}

const cabecalhosRest = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  "LinkedIn-Version": LINKEDIN_VERSION,
  "X-Restli-Protocol-Version": "2.0.0",
  "Content-Type": "application/json",
});

async function lerCorpo(r: Response): Promise<unknown> {
  const texto = await r.text().catch(() => "");
  if (!texto) return null;
  try { return JSON.parse(texto); } catch { return texto; }
}

export function urlDeAutorizacao(clientId: string, redirectUri: string, state: string): string {
  const u = new URL(AUTORIZAR_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("scope", ESCOPOS);
  return u.toString();
}

export interface TokenLinkedIn { access_token: string; expires_in: number; scope: string | null }

/** Troca o `code` do retorno pelo token. O código vale uma vez só e por poucos minutos. */
export async function trocarCodigoPorToken(
  clientId: string, segredo: string, code: string, redirectUri: string, f: Fetch = fetch,
): Promise<TokenLinkedIn> {
  const corpo = new URLSearchParams({
    grant_type: "authorization_code", code, client_id: clientId, client_secret: segredo, redirect_uri: redirectUri,
  });
  const r = await f(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: corpo.toString(),
  });
  const j = await lerCorpo(r) as Record<string, unknown> | null;
  if (!r.ok || !j || typeof j.access_token !== "string") {
    throw new ErroLinkedIn(`O LinkedIn não trocou o código pelo acesso (${r.status}): ${mensagemDoLinkedIn(j) || "sem detalhe"}`, r.status, j);
  }
  return {
    access_token: j.access_token,
    // ⚠️ Sem refresh_token: no produto self-serve o acesso vive 60 dias (5.184.000 s) e acabou.
    expires_in: Number(j.expires_in) || 60 * 24 * 60 * 60,
    scope: typeof j.scope === "string" ? j.scope : null,
  };
}

export interface UsuarioLinkedIn { sub: string; nome: string | null; foto: string | null }

/**
 * QUEM autorizou. Lição paga no TikTok (12/10/2026): vale a conta LOGADA no navegador, não a
 * de quem gerou o link — e a resposta do token não diz nome nenhum. Sem esta pergunta, conectar
 * o LinkedIn errado é indistinguível de acertar.
 */
export async function buscarUsuario(token: string, f: Fetch = fetch): Promise<UsuarioLinkedIn> {
  const r = await f(USERINFO_URL, { headers: { Authorization: `Bearer ${token}` } });
  const j = await lerCorpo(r) as Record<string, unknown> | null;
  if (!r.ok || !j || typeof j.sub !== "string" || !j.sub) {
    throw new ErroLinkedIn(`Não consegui saber quem autorizou (${r.status}): ${mensagemDoLinkedIn(j) || "sem detalhe"}`, r.status, j);
  }
  const nome = typeof j.name === "string" && j.name.trim()
    ? j.name.trim()
    : [j.given_name, j.family_name].filter((v) => typeof v === "string" && v).join(" ") || null;
  return { sub: j.sub, nome, foto: typeof j.picture === "string" ? j.picture : null };
}

/** Imagem: inicializa o envio (owner = a pessoa), sobe os bytes, devolve `urn:li:image:…`. */
export async function subirImagem(
  token: string, autor: string, bytes: Uint8Array, contentType: string, f: Fetch = fetch,
): Promise<string> {
  const ini = await f(`${REST}/images?action=initializeUpload`, {
    method: "POST",
    headers: cabecalhosRest(token),
    body: JSON.stringify({ initializeUploadRequest: { owner: autor } }),
  });
  const j = await lerCorpo(ini) as { value?: { uploadUrl?: string; image?: string } } | null;
  const uploadUrl = j?.value?.uploadUrl;
  const urn = j?.value?.image;
  if (!ini.ok || !uploadUrl || !urn) {
    throw new ErroLinkedIn(`O LinkedIn não abriu o envio da imagem (${ini.status}): ${mensagemDoLinkedIn(j) || "sem detalhe"}`, ini.status, j);
  }
  const up = await f(uploadUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType },
    body: bytes,
  });
  if (!up.ok) {
    const c = await lerCorpo(up);
    throw new ErroLinkedIn(`O LinkedIn recusou os bytes da imagem (${up.status}): ${mensagemDoLinkedIn(c) || "sem detalhe"}`, up.status, c);
  }
  return urn;
}

/**
 * Lê exatamente `n` bytes de um leitor de fluxo, guardando a sobra para a próxima parte.
 * É o que deixa subir um vídeo de 500 MB com ~8 MB de memória: a parte de 4 MB do LinkedIn não
 * casa com o tamanho dos pedaços que a rede entrega.
 */
export function leitorEmPartes(leitor: ReadableStreamDefaultReader<Uint8Array>) {
  let sobra: Uint8Array = new Uint8Array(0);
  return async (n: number): Promise<Uint8Array> => {
    const saida = new Uint8Array(n);
    let cheio = 0;
    if (sobra.length) {
      const usar = Math.min(n, sobra.length);
      saida.set(sobra.subarray(0, usar), 0);
      cheio = usar;
      sobra = sobra.subarray(usar);
    }
    while (cheio < n) {
      const { done, value } = await leitor.read();
      if (done || !value) break;
      const usar = Math.min(n - cheio, value.length);
      saida.set(value.subarray(0, usar), cheio);
      cheio += usar;
      if (usar < value.length) sobra = value.subarray(usar);
    }
    if (cheio < n) throw new ErroLinkedIn(`o arquivo de vídeo acabou antes da hora (${cheio} de ${n} bytes nesta parte)`);
    return saida;
  };
}

async function putComRetentativa(url: string, corpo: Uint8Array, f: Fetch): Promise<string> {
  let ultimo: unknown = null;
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      const r = await f(url, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: corpo });
      if (r.ok) {
        const etag = r.headers.get("etag") || r.headers.get("ETag");
        if (!etag) throw new ErroLinkedIn("o LinkedIn aceitou a parte do vídeo mas não devolveu o ETag");
        await r.body?.cancel().catch(() => {});
        return etag;
      }
      const c = await lerCorpo(r);
      ultimo = new ErroLinkedIn(`parte do vídeo recusada (${r.status}): ${mensagemDoLinkedIn(c) || "sem detalhe"}`, r.status, c);
      if (r.status < 500 && r.status !== 429) break; // 4xx de verdade: repetir não resolve
    } catch (e) {
      ultimo = e;
    }
    await new Promise((res) => setTimeout(res, 800 * tentativa));
  }
  throw ultimo instanceof Error ? ultimo : new ErroLinkedIn(String(ultimo));
}

/**
 * Vídeo: inicializa com o tamanho, sobe parte por parte (4 MB, na ordem das instruções),
 * finaliza com os ETags. `corpo` é o fluxo do arquivo, lido uma vez só.
 */
export async function subirVideo(
  token: string, autor: string, tamanho: number, corpo: ReadableStream<Uint8Array>, f: Fetch = fetch,
): Promise<string> {
  const ini = await f(`${REST}/videos?action=initializeUpload`, {
    method: "POST",
    headers: cabecalhosRest(token),
    body: JSON.stringify({
      initializeUploadRequest: { owner: autor, fileSizeBytes: tamanho, uploadCaptions: false, uploadThumbnail: false },
    }),
  });
  const j = await lerCorpo(ini) as {
    value?: { video?: string; uploadToken?: string; uploadInstructions?: InstrucaoDeParte[] };
  } | null;
  const urn = j?.value?.video;
  const instrucoes = j?.value?.uploadInstructions ?? [];
  if (!ini.ok || !urn) {
    throw new ErroLinkedIn(`O LinkedIn não abriu o envio do vídeo (${ini.status}): ${mensagemDoLinkedIn(j) || "sem detalhe"}`, ini.status, j);
  }
  const torto = conferirPartes(instrucoes, tamanho);
  if (torto) throw new ErroLinkedIn(`Envio do vídeo cancelado: ${torto}.`);

  const ler = leitorEmPartes(corpo.getReader());
  const etags: string[] = [];
  for (const parte of instrucoes) {
    const bytes = await ler(parte.lastByte - parte.firstByte + 1);
    etags.push(await putComRetentativa(parte.uploadUrl, bytes, f));
  }

  const fim = await f(`${REST}/videos?action=finalizeUpload`, {
    method: "POST",
    headers: cabecalhosRest(token),
    body: JSON.stringify({
      finalizeUploadRequest: { video: urn, uploadToken: j?.value?.uploadToken ?? "", uploadedPartIds: etags },
    }),
  });
  if (!fim.ok) {
    const c = await lerCorpo(fim);
    throw new ErroLinkedIn(`O LinkedIn não fechou o envio do vídeo (${fim.status}): ${mensagemDoLinkedIn(c) || "sem detalhe"}`, fim.status, c);
  }
  await fim.body?.cancel().catch(() => {});
  return urn;
}

/**
 * Espera o vídeo ficar AVAILABLE, até `limiteMs`. Devolve a última situação vista.
 * ⚠️ Com só `w_member_social` o LinkedIn pode negar a LEITURA do ativo (a doc das imagens diz
 * isso com todas as letras: o escopo é "write-only"). Nesse caso volta "sem_leitura" e quem
 * decide é o próprio POST do post: se o vídeo não estiver pronto, ele recusa com 4xx e o
 * worker tenta de novo na rodada seguinte, reaproveitando a URN já enviada.
 */
export async function esperarVideo(
  token: string, urn: string, limiteMs: number, f: Fetch = fetch, pausaMs = 3000,
): Promise<"AVAILABLE" | "PROCESSING_FAILED" | "processando" | "sem_leitura"> {
  const fim = Date.now() + Math.max(0, limiteMs);
  do {
    const r = await f(`${REST}/videos/${encodeURIComponent(urn)}`, { headers: cabecalhosRest(token) });
    if (r.status === 403 || r.status === 401) { await r.body?.cancel().catch(() => {}); return "sem_leitura"; }
    const j = await lerCorpo(r) as { status?: string } | null;
    if (j?.status === "AVAILABLE") return "AVAILABLE";
    if (j?.status === "PROCESSING_FAILED") return "PROCESSING_FAILED";
    if (Date.now() + pausaMs > fim) break;
    await new Promise((res) => setTimeout(res, pausaMs));
  } while (Date.now() < fim);
  return "processando";
}

export type ConteudoDoPost =
  | { tipo: "texto" }
  | { tipo: "imagem"; urns: [string] }
  | { tipo: "multi_imagem"; urns: string[] }
  | { tipo: "video"; urns: [string] };

/** Corpo do POST /rest/posts para um membro. `textoEscapado` já passou por `escaparTextoLinkedIn`. */
export function corpoDoPost(autor: string, textoEscapado: string, conteudo: ConteudoDoPost): Record<string, unknown> {
  const base: Record<string, unknown> = {
    author: autor,
    commentary: textoEscapado,
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
  if (conteudo.tipo === "imagem" || conteudo.tipo === "video") base.content = { media: { id: conteudo.urns[0] } };
  if (conteudo.tipo === "multi_imagem") base.content = { multiImage: { images: conteudo.urns.map((id) => ({ id })) } };
  return base;
}

/**
 * Cria o post. NÃO lança: devolve status, URN e corpo, para o worker decidir com
 * `desfechoDoPost` (a diferença entre "recusou" e "não sei" é o que evita post duplicado).
 * `status: null` = a chamada nem voltou (rede/timeout) — e aí o post PODE ter sido criado.
 */
export async function criarPost(
  token: string, corpo: Record<string, unknown>, f: Fetch = fetch,
): Promise<{ status: number | null; urn: string | null; corpo: unknown }> {
  try {
    const r = await f(`${REST}/posts`, { method: "POST", headers: cabecalhosRest(token), body: JSON.stringify(corpo) });
    const urn = r.headers.get("x-restli-id") || r.headers.get("X-RestLi-Id");
    return { status: r.status, urn: urn || null, corpo: await lerCorpo(r) };
  } catch (e) {
    return { status: null, urn: null, corpo: e instanceof Error ? e.message : String(e) };
  }
}
