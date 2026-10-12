// Cliente da ACCOUNTS API do TikTok (business-api.tiktok.com) — publicação de vídeo no
// perfil. Isolado de propósito: quando a primeira chamada real acontecer, o conserto mora
// AQUI e o worker não muda.
//
// ✅ CONTRATO CONFIRMADO em 12/10/2026 por uma publicação REAL (privada) no @ppgvet_oficial,
// com a URL de teste que o TikTok libera sem verificação de domínio. O ciclo inteiro, medido:
//   publicar  → {code:0, data:{share_id:"v_pub_url~v2.769585…"}}
//   status    → {code:0, data:{status:"PROCESSING_DOWNLOAD"}}  …e ~30 s depois…
//   status    → {code:0, data:{status:"PUBLISH_COMPLETE"}}     (sem id do post)
// Nada aqui é mais palpite. Se um campo mudar, foi o TikTok que mudou.
//
// ⚠️ Para vídeo NOSSO falta a propriedade da URL estar verificada — e NÃO é um widget de
// tela: no portal de Business isso é API (`ROTAS_PROPRIEDADE`, mais abaixo). Enquanto
// `ppgeducacao.site` não estiver com property_status 1, publicar devolve erro de ownership.
//
// ⚠️ O endpoint de publicar tem limite de taxa curto: uma dúzia de chamadas seguidas devolve
// `40000 The API rate limit exceeded`. O worker publica no máximo 3 por rodada.
//
// ⚠️ NÃO confundir com as outras duas APIs de TikTok da casa:
//   • Marketing API (mesmo domínio, header Access-Token por ADVERTISER) = gasto de campanha.
//   • Display API (open.tiktokapis.com, Bearer) = perfil pelo app antigo, preso no Sandbox.

const API = "https://business-api.tiktok.com/open_api/v1.3";

/**
 * Token do TITULAR DO PERFIL — host e formato diferentes do `API` acima, e é o host que
 * vale TANTO para a troca do código QUANTO para a renovação (as duas já foram erradas aqui).
 */
const OAUTH_PERFIL = "https://open.tiktokapis.com/v2/oauth/token/";

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
  // ⚠️ NÃO existe aqui uma rota de token: o token do titular do perfil (troca E renovação)
  // mora em `OAUTH_PERFIL`, em outro host. Havia um `token: "/tt_user/oauth2/token/"` nesta
  // lista, e é justamente o endpoint que este arquivo prova duas vezes que NÃO serve — ele
  // ignora o grant_type e pede `auth_code`. Ninguém o usava; ficava só esperando alguém
  // confiar nele e perder outro dia.
} as const;

/**
 * VERIFICAÇÃO DE PROPRIEDADE DA URL — e aqui mora a parte que mais custou achar.
 *
 * O TikTok só baixa vídeo de domínio/prefixo verificado (`url_ownership_unverified`). No
 * portal ANTIGO (developers.tiktok.com) isso é um widget "URL properties" na tela. No portal
 * de BUSINESS (business-api.tiktok.com), onde vive o nosso app de publicação, **não existe
 * widget nenhum** — a verificação virou API. Procurar na tela é perder a tarde: as seções do
 * app lá são só Basic Information, Authorization, Sandbox Ad Account e Allowlist Management
 * (conferido clicando, em 12/10/2026).
 *
 * ⚠️ A credencial destas rotas é a DO APP (`app_id` + `secret` no corpo/query), NÃO o
 * `Access-Token` da conta e nem `advertiser_id`. Por isso elas não passam pelo `chamar()`
 * acima. Secret errado devolve `40101`; app de outro portal devolve `40113`.
 *
 * `add` devolve a `signature` para pôr no DNS (property_type 1 = domínio) e `property_status`
 * 0=pendente, 1=verificado, 2=falhou. Domínio verificado vale para os SUBDOMÍNIOS também, e a
 * prova é por DNS — não passa por HTTP, logo não depende de nada da Cloudflare.
 *
 * Corpo do `add` (descoberto iterando nos 40002): o domínio vai ANINHADO em
 * `url_property_meta: { property_type: 1, url: "ppgeducacao.site" }`.
 */
export const ROTAS_PROPRIEDADE = {
  listar: "/business/property/list/",     // GET  ?app_id=&secret=
  adicionar: "/business/property/add/",   // POST { app_id, secret, url_property_meta }
  verificar: "/business/property/verify/",
  remover: "/business/property/delete/",
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
 *
 * ⚠️ MESMO host errado da troca do código, pela terceira vez — medido em 12/10/2026 com um
 * refresh token PROPOSITALMENTE INVÁLIDO. O que estava aqui (`business-api…/tt_user/oauth2/token/`
 * em JSON, com `client_id`) nem olha o `grant_type`: responde
 * `40002 auth_code: Missing data for required field` — é endpoint de TROCA de código, não de
 * renovação, e jamais renovaria nada. O host certo é o mesmo de onde o token saiu e entendeu o
 * pedido na hora: `invalid_grant · Refresh token is invalid or expired`.
 * Como o token vive 1 dia, isso derrubaria a publicação 24 h depois de conectar o perfil —
 * silenciosamente, já com posts agendados na fila.
 */
export async function renovarToken(
  appId: string,
  secret: string,
  refreshToken: string,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number; refresh_expires_in?: number }> {
  const resp = await fetch(OAUTH_PERFIL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cache-Control": "no-cache",
    },
    body: new URLSearchParams({
      client_key: appId,
      client_secret: secret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const json = await resp.json().catch(() => ({}));
  if (!json?.access_token) {
    const motivo = json?.error_description || json?.error || json?.message || `HTTP ${resp.status}`;
    throw new Error(`Falha ao renovar o token da conta: ${motivo}`);
  }
  return json;
}

/**
 * Troca o código da autorização do DONO DO PERFIL por token.
 *
 * ⚠️ ESTE FLUXO NÃO É O DA MARKETING API, e eu errei isso por dois dias. A URL que o portal
 * gera para o titular do perfil é `www.tiktok.com/v2/auth/authorize?client_key=…` com escopos
 * `video.publish`/`user.info.basic` — ou seja, é o fluxo do Login Kit, e o token sai de
 * `open.tiktokapis.com/v2/oauth/token/`, em **form-urlencoded**, com `client_key` e `code`.
 * Eu mandava para `business-api…/tt_user/oauth2/token/` em JSON com `auth_code`.
 *
 * ⚠️ E o erro que isso devolvia era **`40131 Authorization code is expired`** — medido em
 * 12/10/2026 enviando um código PROPOSITALMENTE INVÁLIDO: aquele endpoint responde "expirado"
 * para qualquer código que não reconhece. Eu li a mensagem ao pé da letra, culpei o relógio e
 * mandei o diretor correr contra um prazo de 10 minutos que não tinha nada a ver. Mensagem de
 * erro de terceiro não é diagnóstico: o teste com entrada inválida é.
 *
 * É o MESMO host do callback antigo do perfil orgânico (`tiktok-oauth-callback`), que já fazia
 * assim desde 15/06. A resposta vem com os campos no topo, sem envelope `data`.
 */
export async function trocarCodigoPorToken(
  appId: string,
  secret: string,
  authCode: string,
  redirectUri: string,
): Promise<Record<string, string | number | string[]>> {
  const resp = await fetch(OAUTH_PERFIL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cache-Control": "no-cache",
    },
    body: new URLSearchParams({
      client_key: appId,
      client_secret: secret,
      code: authCode,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  const json = await resp.json().catch(() => ({}));
  if (!json?.access_token) {
    const motivo = json?.error_description || json?.error || json?.message || `HTTP ${resp.status}`;
    throw new Error(`O TikTok recusou a troca do código: ${motivo}`);
  }
  return json;
}

export interface PerfilConectado {
  open_id: string;
  username: string;
  display_name: string;
  avatar_url: string;
  follower_count: number;
}

/**
 * Lê QUEM é o perfil que acabou de autorizar.
 *
 * ⚠️ Isto não é enfeite: a resposta do token NÃO traz nome nenhum, e sem nome a página de
 * sucesso dizia só "o perfil já pode receber os posts". Em 12/10/2026 a autorização pegou a
 * conta vazia que é dona do app no portal (0 seguidores) em vez de @ppgvet_oficial, e a tela
 * comemorou igual — o erro só apareceu quando eu fui conferir o banco. Quem autoriza está
 * logado em ALGUMA conta no navegador, e é essa que vai; então a tela tem de dizer o `@` e o
 * número de seguidores, porque é o único jeito de a pessoa ver na hora que foi a conta errada.
 *
 * Host de propósito diferente do resto do arquivo: `user.info.*` responde em
 * `open.tiktokapis.com` com `Bearer` (conferido em 12/10/2026 com o token real).
 */
export async function buscarPerfil(token: string): Promise<PerfilConectado | null> {
  const campos = "open_id,union_id,display_name,username,avatar_url,follower_count";
  try {
    const resp = await fetch(`https://open.tiktokapis.com/v2/user/info/?fields=${encodeURIComponent(campos)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await resp.json().catch(() => ({}));
    const u = json?.data?.user;
    if (!u) return null;
    return {
      open_id: String(u.open_id ?? ""),
      username: String(u.username ?? ""),
      display_name: String(u.display_name ?? ""),
      avatar_url: String(u.avatar_url ?? ""),
      follower_count: Number(u.follower_count ?? 0),
    };
  } catch {
    // Perder o nome não pode derrubar a conexão — o token já é válido a esta altura.
    return null;
  }
}

/**
 * Quem pode ver o post. ⚠️ MANDAR ISTO É OBRIGATÓRIO NA PRÁTICA: a função publicava sem
 * `privacy_level` e ficava à mercê do padrão do TikTok, que não está documentado — num perfil
 * de 18 mil seguidores, "descobrir o padrão na prática" é publicar errado para todos eles.
 * Confirmado em 12/10/2026 por A/B: `privacy_level: "XPTO"` é recusado com "The request post
 * info is empty or incorrect", e `SELF_ONLY` passa — ou seja, o campo existe e é validado.
 */
export type Privacidade = "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "SELF_ONLY";

export interface PublicacaoIniciada {
  /**
   * Protocolo do TikTok. Receber isto NÃO é "publicado" — a publicação é ASSÍNCRONA.
   * Na resposta real ele chega como `share_id`; aqui dentro o nome é `publish_id` porque é
   * assim que o endpoint de status o pede.
   */
  publish_id: string;
}

/**
 * Manda publicar. Devolve o PROTOCOLO, não a confirmação.
 *
 * ✅ CONFIRMADO em 12/10/2026 com uma publicação real (privada, `privacy_level: "SELF_ONLY"`,
 * usando a URL de teste que o TikTok libera sem verificação de domínio): a resposta vem
 * `{code:0, data:{ share_id: "v_pub_url~v2.<números>" }}` — o campo é **`share_id`**, NÃO
 * `publish_id`. Por isso os três nomes continuam aceitos abaixo; tirar `share_id` quebra tudo.
 * ⚠️ `video_url` tem de ser https, pública, sem redirecionamento e de domínio VERIFICADO
 * no portal — o preflight do worker cobre os três primeiros; o quarto é configuração.
 */
export async function publicarVideo(
  token: string,
  businessId: string,
  videoUrl: string,
  legenda: string,
  privacidade: Privacidade = "PUBLIC_TO_EVERYONE",
): Promise<PublicacaoIniciada> {
  const dados = await chamar<Record<string, string>>(ROTAS.publicarVideo, token, {
    business_id: businessId,
    video_url: videoUrl,
    // ⚠️ Os dois booleanos são OBRIGATÓRIOS — descobertos em 12/10/2026 iterando nos
    // `40002 … Missing data for required field` do próprio endpoint. Sem eles o post nem sai.
    // São as declarações de conteúdo comercial do TikTok, e o que elas significam:
    //   • is_brand_organic  → o post promove a SUA marca (põe o selo "conteúdo promocional").
    //   • is_branded_content → parceria PAGA com terceiro (não é o nosso caso).
    // Ficam `false` porque é assim que o time publica na mão hoje; virar `true` muda o que o
    // seguidor vê. Se um dia o post for de parceria paga, isto tem de vir do card.
    post_info: {
      caption: legenda ?? "",
      is_brand_organic: false,
      is_branded_content: false,
      // Explícito de propósito — ver o comentário de `Privacidade`. O padrão da função é
      // público porque é o que o Planner quer; teste de fumaça passa "SELF_ONLY".
      privacy_level: privacidade,
    },
  });
  const id = dados.publish_id || dados.share_id || dados.id;
  if (!id) throw new Error("O TikTok aceitou mas não devolveu protocolo de publicação.");
  return { publish_id: String(id) };
}

export type SituacaoPublicacao = "processando" | "publicado" | "falhou";

/** Estados intermediários conhecidos. `PROCESSING_DOWNLOAD` foi visto numa publicação real. */
const PROCESSANDO = [
  "PROCESSING_DOWNLOAD", "PROCESSING_UPLOAD", "PROCESSING", "PENDING", "DOWNLOADING",
];

export interface StatusPublicacao {
  situacao: SituacaoPublicacao;
  post_id?: string;
  motivo?: string;
}

/**
 * Consulta o desfecho de um protocolo. É isto — e não o 200 do publicar — que autoriza marcar
 * "publicado".
 *
 * ⚠️ MEDIDO em 12/10/2026: com um `publish_id` INVENTADO este endpoint devolve
 * **`code: 0` com `data: {}`** — sucesso vazio, não erro. Ou seja, "não conheço esse
 * protocolo" e "ainda estou processando" chegam aqui IDÊNTICOS, e por isso o fallback é
 * `processando` e quem tira post preso da fila é o watchdog do worker, nunca esta função.
 * (O caminho `/business/video/publish/status/`, com "video", dá 404 — o certo é sem.)
 *
 * ⚠️ Os NOMES DOS CAMPOS de um status real seguem desconhecidos: `data` só vem preenchido
 * depois de uma publicação que o TikTok aceitou, e isso ainda não aconteceu (falta verificar
 * o domínio da URL do vídeo). Por isso aceitamos vários nomes candidatos E registramos o
 * payload cru quando ele não casa com nenhum: o primeiro post de verdade vira a fonte, em vez
 * de continuar palpite. Não troque esse log por silêncio antes de ele ter respondido uma vez.
 */
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
    // ⚠️ O desfecho real NÃO traz id do post (medido: `data` só tem `status`). Então não
    // existe link para o post publicado — não prometa isso na tela.
    return { situacao: "publicado", post_id: dados.post_id || dados.item_id || undefined };
  }
  if (["FAILED", "PUBLISH_FAILED", "ERROR"].includes(bruto)) {
    return { situacao: "falhou", motivo: dados.fail_reason || dados.error_message || bruto };
  }
  // Valores de "ainda andando" JÁ VISTOS numa publicação real: PROCESSING_DOWNLOAD (o TikTok
  // está baixando o vídeo da nossa URL). Ficam aqui para o log abaixo só gritar com formato
  // de verdade desconhecido, em vez de gritar a cada rodada normal.
  if (PROCESSANDO.includes(bruto)) return { situacao: "processando" };
  if (Object.keys(dados).length > 0) {
    console.log(
      `[tiktok] FORMATO DO STATUS ainda não mapeado — publish_id=${publishId} payload=` +
      JSON.stringify(dados).slice(0, 500),
    );
  }
  return { situacao: "processando" };
}

/**
 * Confere o `/robots.txt` do host que serve o vídeo.
 *
 * ⚠️ ISTO CUSTOU UMA TARDE EM 12/10/2026, e o sintoma não aponta para a causa em nada.
 * O `api.ppgeducacao.site` (Kong do Supabase) devolvia **401 em `/robots.txt`**, e pela
 * norma de robots (RFC 9309) um crawler que recebe 401/403 no robots deve tratar o host
 * INTEIRO como proibido. Resultado: o TikTok aceitava o publicar, devolvia protocolo, e
 * depois ficava eternamente em `PROCESSING_DOWNLOAD` — **sem nunca buscar o arquivo**. Nada
 * aparecia como bloqueio no Cloudflare (ele nem pedia o vídeo), o arquivo estava perfeito
 * (1080x1350, 30 fps, H.264) e a URL respondia 200. Provado por experimento controlado: o
 * MESMO vídeo servido por um host com robots permissivo publicou em 75 s.
 *
 * A cura foi uma Redirect Rule na Cloudflare mandando `api.ppgeducacao.site/robots.txt` para
 * o robots do site (que é `User-agent: * / Allow: /`). Esta função existe para o dia em que
 * alguém apagar essa regra: em vez de 70 minutos de post pendurado e um "Publicação
 * interrompida" sem explicação, o erro aparece ANTES do envio e diz o que fazer.
 *
 * Falha de rede aqui NÃO bloqueia: o robots ser inalcançável por timeout não é o mesmo que
 * ser proibido, e um falso negativo pararia publicação que funciona.
 */
async function conferirRobotsDoHost(urlDoVideo: string): Promise<void> {
  let host: string;
  try {
    host = new URL(urlDoVideo).origin;
  } catch {
    throw new Error(`URL de vídeo inválida: ${urlDoVideo.slice(0, 120)}`);
  }
  let status: number;
  try {
    const r = await fetch(`${host}/robots.txt`, { redirect: "follow" });
    status = r.status;
  } catch {
    return; // inalcançável ≠ proibido
  }
  if (status === 401 || status === 403) {
    throw new Error(
      `O /robots.txt de ${host} responde ${status}, e por isso o TikTok trata o host inteiro ` +
      "como proibido: ele aceita o envio e nunca baixa o vídeo (fica preso em " +
      "PROCESSING_DOWNLOAD). Conserto: a Redirect Rule da Cloudflare que manda " +
      "/robots.txt para o robots do site foi removida ou parou de casar — recrie-a.",
    );
  }
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

  await conferirRobotsDoHost(url);

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
