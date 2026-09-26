// Cliente da ACCOUNTS API do TikTok (business-api.tiktok.com) — publicação de vídeo no
// perfil. Isolado de propósito: quando a primeira chamada real acontecer, o conserto mora
// AQUI e o worker não muda.
//
// Os CAMINHOS foram conferidos em 25/09/2026 na lista de endpoints que o portal mostra no
// escopo "TikTok accounts". O FORMATO do corpo e da resposta segue sem confirmação — a
// documentação é SPA e volta vazia no fetch, e os proxies de leitura devolvem só o menu.
//
// ⚠️ NÃO confundir com as outras duas APIs de TikTok da casa:
//   • Marketing API (mesmo domínio, header Access-Token por ADVERTISER) = gasto de campanha.
//   • Display API (open.tiktokapis.com, Bearer) = perfil pelo app antigo, preso no Sandbox.

const API = "https://business-api.tiktok.com/open_api/v1.3";

/**
 * Caminhos CONFERIDOS em 25/09/2026 contra a lista de endpoints que o próprio portal mostra
 * no escopo "TikTok accounts" (tela de criação do app) — não são mais suposição.
 * ⚠️ `statusPublicacao` era o meu palpite `/business/video/publish/status/` e está ERRADO:
 * o caminho real é `/business/publish/status/`, sem o `video`. Publicação é assíncrona, então
 * esse era justamente o endpoint que decidiria se um post virou "publicado" — errá-lo deixaria
 * todo post preso em "processando" para sempre.
 * O que a mesma lista revelou e ainda não usamos: `/business/photo/publish/` (dá para publicar
 * FOTO, não só vídeo) e `/business/video/settings/`.
 */
export const ROTAS = {
  publicarVideo: "/business/video/publish/",
  statusPublicacao: "/business/publish/status/",
  infoConta: "/business/get/",
  listaVideos: "/business/video/list/",
  token: "/tt_user/oauth2/token/",
} as const;

export interface RespostaTikTok<T> {
  code?: number;
  message?: string;
  request_id?: string;
  data?: T;
}

export const erroDe = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * ⚠️ A API devolve **HTTP 200 mesmo quando recusa** — quem manda é o `code` do corpo
 * (0 = ok). Ler o status é o jeito clássico de gravar "publicado" em cima de uma recusa.
 */
async function chamar<T>(
  caminho: string,
  token: string,
  corpo?: Record<string, unknown>,
  params?: Record<string, string>,
): Promise<T> {
  const url = new URL(`${API}${caminho}`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);

  const resp = await fetch(url.toString(), {
    method: corpo ? "POST" : "GET",
    headers: { "Access-Token": token, "Content-Type": "application/json" },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });

  const texto = await resp.text();
  let json: RespostaTikTok<T>;
  try {
    json = JSON.parse(texto);
  } catch {
    throw new Error(`Resposta não-JSON do TikTok (${resp.status}): ${texto.slice(0, 200)}`);
  }
  if (json.code !== 0) {
    throw new Error(`TikTok recusou ${caminho} (code ${json.code}): ${json.message || "sem mensagem"}`);
  }
  return (json.data ?? {}) as T;
}

/**
 * Renova o access token da CONTA.
 * ⚠️ O token da conta vive ~1 DIA (o refresh, ~1 ano). Por isso a renovação acontece no
 * momento do DISPARO, nunca no do agendamento: post marcado para daqui a duas semanas
 * teria token vencido muito antes de a hora chegar.
 */
export async function renovarToken(
  appId: string,
  secret: string,
  refreshToken: string,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number; refresh_expires_in?: number }> {
  const resp = await fetch(`${API}${ROTAS.token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: appId,
      client_secret: secret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const json = await resp.json().catch(() => ({}));
  const dados = json?.data ?? json;
  if (json?.code !== 0 && !dados?.access_token) {
    throw new Error(`Falha ao renovar o token da conta (code ${json?.code ?? "?"}): ${json?.message || "sem mensagem"}`);
  }
  return dados;
}

/**
 * Troca o código da autorização do DONO DO PERFIL por token.
 *
 * ⚠️ É outro fluxo do de anúncios: lá o anunciante autoriza uma conta de ADS e o endpoint é
 * `/oauth2/access_token/` (sem `grant_type`); aqui quem autoriza é o titular do PERFIL e o
 * endpoint é `/tt_user/oauth2/token/`, que SEGUE o padrão OAuth com `grant_type`. Misturar
 * os dois é o erro natural — os nomes são quase iguais e os contratos, não.
 */
export async function trocarCodigoPorToken(
  appId: string,
  secret: string,
  authCode: string,
  redirectUri: string,
): Promise<Record<string, string | number | string[]>> {
  const resp = await fetch(`${API}${ROTAS.token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: appId,
      client_secret: secret,
      grant_type: "authorization_code",
      auth_code: authCode,
      code: authCode,          // os exemplos do TikTok divergem no nome; mandar os dois é inofensivo
      redirect_uri: redirectUri,
    }),
  });
  const json = await resp.json().catch(() => ({}));
  const dados = json?.data ?? json;
  if (json?.code !== 0 && !dados?.access_token) {
    throw new Error(`O TikTok recusou a troca do código (code ${json?.code ?? "?"}): ${json?.message || "sem mensagem"}`);
  }
  return dados;
}

export interface PublicacaoIniciada {
  /** Protocolo do TikTok. Receber isto NÃO é "publicado" — a publicação é ASSÍNCRONA. */
  publish_id: string;
}

/**
 * Manda publicar. Devolve o PROTOCOLO, não a confirmação.
 * ⚠️ `video_url` tem de ser https, pública, sem redirecionamento e de domínio VERIFICADO
 * no portal — o preflight do worker cobre os três primeiros; o quarto é configuração.
 */
export async function publicarVideo(
  token: string,
  businessId: string,
  videoUrl: string,
  legenda: string,
): Promise<PublicacaoIniciada> {
  const dados = await chamar<Record<string, string>>(ROTAS.publicarVideo, token, {
    business_id: businessId,
    video_url: videoUrl,
    post_info: { caption: legenda ?? "" },
  });
  const id = dados.publish_id || dados.share_id || dados.id;
  if (!id) throw new Error("O TikTok aceitou mas não devolveu protocolo de publicação.");
  return { publish_id: String(id) };
}

export type SituacaoPublicacao = "processando" | "publicado" | "falhou";

export interface StatusPublicacao {
  situacao: SituacaoPublicacao;
  post_id?: string;
  motivo?: string;
}

/** Consulta o desfecho de um protocolo. É isto — e não o 200 do publicar — que autoriza marcar "publicado". */
export async function consultarStatus(
  token: string,
  businessId: string,
  publishId: string,
): Promise<StatusPublicacao> {
  const dados = await chamar<Record<string, string>>(ROTAS.statusPublicacao, token, undefined, {
    business_id: businessId,
    publish_id: publishId,
  });
  const bruto = String(dados.status ?? dados.publish_status ?? "").toUpperCase();
  if (["PUBLISH_COMPLETE", "PUBLISHED", "SUCCESS"].includes(bruto)) {
    return { situacao: "publicado", post_id: dados.post_id || dados.item_id || undefined };
  }
  if (["FAILED", "PUBLISH_FAILED", "ERROR"].includes(bruto)) {
    return { situacao: "falhou", motivo: dados.fail_reason || dados.error_message || bruto };
  }
  return { situacao: "processando" };
}

/**
 * Preflight ESTRITO da URL do vídeo.
 * ⚠️ O `assertMediaReachable` do `ig-publish` NÃO serve aqui: ele aceita qualquer `res.ok`
 * e o fetch do Deno segue redirecionamento em silêncio — e o TikTok recusa 3xx. URL
 * assinada de Storage costuma redirecionar, então isso reprovaria na hora errada, já com
 * o post marcado para sair.
 */
export async function conferirUrlDoVideo(url: string): Promise<void> {
  if (!url) throw new Error("Post sem vídeo (URL vazia) — reanexe o arquivo.");
  if (!url.startsWith("https://")) throw new Error("A URL do vídeo precisa ser https — o TikTok recusa http.");

  let resp: Response;
  try {
    resp = await fetch(url, { method: "HEAD", redirect: "manual" });
  } catch {
    throw new Error("Vídeo inacessível (falha de rede ao buscar o arquivo).");
  }
  if (resp.status >= 300 && resp.status < 400) {
    throw new Error(
      `A URL do vídeo redireciona (HTTP ${resp.status}) e o TikTok recusa redirecionamento. ` +
      "Use o link direto do arquivo, não uma URL assinada ou encurtada.",
    );
  }
  if (!resp.ok) throw new Error(`Vídeo inacessível (HTTP ${resp.status}) — confira se o arquivo ainda existe.`);

  const tipo = (resp.headers.get("content-type") || "").toLowerCase();
  const generico = tipo === "application/octet-stream" || tipo === "binary/octet-stream";
  if (tipo && !generico && !tipo.startsWith("video/")) {
    throw new Error(`O arquivo não é vídeo (${tipo}) — o TikTok publica vídeo nesta rota.`);
  }
}
