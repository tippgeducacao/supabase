import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { AcessoNegado, exigirAcesso, respostaAcessoNegado } from "../_shared/acesso.ts";

import { autorizarPublicacao } from "./autorizacao.ts";
import {
  SUBCODE_CONTA_INACESSIVEL, avisoDeContasDeFora, contasRecusadas, semAsContas, separarContas,
} from "./contas.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const META_API = "https://graph.facebook.com/v21.0";

const getErrorMessage = (err: unknown) => err instanceof Error ? err.message : String(err);

// Extrai a mensagem MAIS ÚTIL do erro da Graph API. `message` costuma ser genérico
// ("Invalid parameter"); é `error_user_title`/`error_user_msg` que trazem o motivo real
// (ex.: "Faltam posições de marcação de usuário para a imagem"). Inclui o subcode p/ rastreio.
function graphErrorMessage(error: any): string {
  if (!error) return "Erro desconhecido do Instagram";
  const partes = [error.error_user_title, error.error_user_msg].filter(Boolean);
  const base = partes.length ? partes.join(" — ") : (error.message || "Erro do Instagram");
  return error.error_subcode ? `${base} (subcode ${error.error_subcode})` : base;
}

// Erro devolvido pela Graph API, com o subcode à mão: é ele que diz se dá para tentar de novo sem uma
// das contas marcadas (2207018 = perfil privado ou que não existe).
class ErroDaGraph extends Error {
  readonly subcode: number | null;
  constructor(erro: any, prefixo = "") {
    super(prefixo + graphErrorMessage(erro));
    this.subcode = Number(erro?.error_subcode) || null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  // Publicar agora (colaborador logado, só modo single) ou cron (chave de serviço).
  let quem: Awaited<ReturnType<typeof exigirAcesso>>;
  try { quem = await exigirAcesso(req, { usuario: true, servico: true }); }
  catch (e) { return respostaAcessoNegado(e, corsHeaders); }

  const porUsuario = quem.tipo === "usuario";
  const comoUsuario = quem.tipo === "usuario" ? createClient(
    Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: `Bearer ${quem.token}` } }, auth: { persistSession: false } },
  ) : null;

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = await req.json().catch(() => ({}));
    const mode = body.mode || "cron";
    const nowIso = new Date().toISOString();

    // Colaborador só usa o "Publicar agora" (single com post_id); rodar a fila é do cron.
    if (porUsuario && !(mode === "single" && body.post_id)) {
      return new Response(JSON.stringify({ error: "Acesso restrito ao sistema." }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (mode === "single" && body.post_id) {
      if (typeof body.post_id !== "string") return new Response(JSON.stringify({ error: "post_id inválido" }), { status: 400, headers: corsHeaders });
      if (quem.tipo === "usuario") await autorizarPublicacao(comoUsuario, quem.usuarioId, body.post_id);
      // CLAIM atômico: só publica se a linha ainda não está em publicação/publicada.
      // Evita publicação dupla quando o usuário clica "Publicar agora" e o cron
      // pega o mesmo post no mesmo segundo (ou em duplo-clique).
      const { data: claimed, error: erroClaim } = await (comoUsuario ?? supabase)
        .from("ig_scheduled_posts")
        .update({ status: "publishing", updated_at: nowIso })
        .eq("id", body.post_id)
        // Pelo clique só sai post 'scheduled' (o "Publicar agora" grava assim); rascunho e
        // falha não saem por id solto (29/10/2026).
        .in("status", porUsuario ? ["scheduled"] : ["scheduled", "draft", "failed"])
        .select("id");
      if (erroClaim) throw new AcessoNegado(erroClaim.code === "42501" ? 403 : 503, "Não foi possível autorizar a publicação.");

      if (!claimed?.[0]) {
        // Já reivindicado por outra execução (cron/clique) ou já publicado.
        return new Response(JSON.stringify({ skipped: true, reason: "já em publicação ou publicado" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Credencial da Meta só é lida depois do claim autorizado pela sessão/RLS.
      const { data: post, error: erroPost } = await supabase.from("ig_scheduled_posts")
        .select("*, ig_accounts(*)").eq("id", claimed[0].id).single();
      if (erroPost || !post) throw new Error("Não foi possível carregar a publicação autorizada.");
      const result = await publishPost(supabase, post, post.ig_accounts);
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Cron mode — CLAIM atômico + LIMITADO por execução (resiliência).
    // - CLAIM atômico (status -> 'publishing') evita publicação duplicada (Reels saindo 2-3x):
    //   um Reels segura até ~150s no waitForContainer; sem o claim a execução do minuto
    //   seguinte pegava o MESMO post e republicava.
    // - LIMITE por rodada (MAX_PER_RUN): processa poucos por execução p/ a função terminar
    //   rápido e não ser morta no meio pelo limite de tempo / saturação do host. O resto é
    //   pego nas próximas rodadas (cron roda a cada minuto). SKIP LOCKED + incremento de
    //   publish_attempts ficam na RPC ig_claim_due_posts.
    const MAX_PER_RUN = 3;
    const MAX_ATTEMPTS = 3;
    // Orçamento de tempo da rodada. Mídia pesada (REELS/vídeo) segura ~150s no
    // waitForContainer; processar 2-3 numa única execução estourava o limite da função na
    // VPS e ela morria no meio (posts ficavam "Publicação interrompida — confira no Instagram").
    // Processamos o que couber no orçamento e DEVOLVEMOS o resto à fila (sem queimar tentativa,
    // via ig_release_posts) — a próxima rodada do cron (a cada minuto) pega o restante. Na
    // prática isto limita a ~1 mídia pesada por rodada sem deixar nada preso.
    const TIME_BUDGET_MS = 110_000;

    const { data: claimed } = await supabase.rpc("ig_claim_due_posts", { p_limit: MAX_PER_RUN, p_max_attempts: MAX_ATTEMPTS });
    let posts: any[] = claimed || [];
    if (posts.length) {
      // a RPC não traz o join da conta; recarrega com ig_accounts(*) pelos ids reivindicados.
      const ids = posts.map((p: any) => p.id);
      const { data: withAcc } = await supabase
        .from("ig_scheduled_posts")
        .select("*, ig_accounts(*)")
        .in("id", ids);
      posts = withAcc || posts;
    }

    const startedAt = Date.now();
    const results = [];
    const leftover: string[] = [];
    for (const post of posts) {
      // Sempre processa pelo menos 1 (results.length>0 garante avanço). A partir daí, se o
      // orçamento estourou, devolve o resto à fila em vez de arriscar a função morrer no meio.
      if (results.length > 0 && Date.now() - startedAt > TIME_BUDGET_MS) {
        leftover.push(post.id);
        continue;
      }
      const result = await publishPost(supabase, post, post.ig_accounts);
      results.push(result);
    }
    if (leftover.length) {
      await supabase.rpc("ig_release_posts", { p_ids: leftover });
    }

    // Vigia de posts presos em 'publishing' há mais de 15 min (uma execução anterior morreu
    // no meio). 15 min >> 150s máx de processamento, então nunca pega algo legitimamente em
    // andamento. Decide pelo container:
    //  (a) container_id NULO = nunca chegou a publicar no Instagram (não postou) e ainda tem
    //      tentativas -> RECOLOCA NA FILA sozinho (auto-retry seguro, não duplica).
    //  (b) container_id preenchido (pode ter postado) OU tentativas esgotadas -> marca ERRO
    //      p/ revisão humana, evitando publicar 2×.
    // A ORDEM importa: (a) roda ANTES de (b). O que (a) recoloca já saiu de 'publishing',
    // então escapa do fail-geral de (b); o que sobrar em 'publishing' (container preenchido
    // ou tentativas esgotadas) cai em (b). Os dois branches juntos esgotam os presos.
    const staleCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    await supabase
      .from("ig_scheduled_posts")
      .update({ status: "scheduled", updated_at: nowIso })
      .eq("status", "publishing")
      .lt("updated_at", staleCutoff)
      .is("ig_container_id", null)
      .lt("publish_attempts", MAX_ATTEMPTS);
    await supabase
      .from("ig_scheduled_posts")
      .update({ status: "failed", error_message: "Publicação interrompida — confira no Instagram antes de reenviar" })
      .eq("status", "publishing")
      .lt("updated_at", staleCutoff);

    return new Response(JSON.stringify({ success: true, processed: results.length, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    if (err instanceof AcessoNegado) return respostaAcessoNegado(err, corsHeaders);
    return new Response(JSON.stringify({ error: getErrorMessage(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// Posições x/y determinísticas e distintas p/ N marcações. Foto de FEED (IMAGE e itens de
// imagem de carrossel) EXIGE x/y em cada user_tag — sem elas a Graph recusa com
// "Invalid parameter" (subcode 2207063: "Faltam posições de marcação de usuário para a imagem").
// A UI não deixa o usuário posicionar, então distribuímos numa grade dentro da imagem.
function tagPositions(n: number): { x: number; y: number }[] {
  if (n <= 1) return [{ x: 0.5, y: 0.5 }];
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const clamp = (v: number) => Math.min(0.95, Math.max(0.05, +v.toFixed(3)));
  return Array.from({ length: n }, (_, i) => ({
    x: clamp(((i % cols) + 0.5) / cols),
    y: clamp((Math.floor(i / cols) + 0.5) / rows),
  }));
}

// withCoords=true para foto de feed (x/y obrigatórios); false para vídeo/REELS (só username).
// `usernames` já vem separado e cortado no teto (separarContas + slice em publishPost).
function parseUserTags(usernames: string[], withCoords: boolean): string | undefined {
  if (!usernames.length) return undefined;
  if (withCoords) {
    const pos = tagPositions(usernames.length);
    // Format: [{username:'user1',x:0.5,y:0.5}, ...]
    const tags = usernames.map((u, i) => `{username:'${u}',x:${pos[i].x},y:${pos[i].y}}`);
    return `[${tags.join(",")}]`;
  }
  // Vídeo/REELS: só o username. Format: [{username:'user1'},{username:'user2'}]
  const tags = usernames.map((u) => `{username:'${u}'}`);
  return `[${tags.join(",")}]`;
}

function parseCollaborators(usernames: string[]): string | undefined {
  return usernames.length ? usernames.join(",") : undefined;
}

// Nome curto do arquivo p/ a mensagem de erro não despejar a URL gigante.
function shortMediaName(url: string): string {
  try { return new URL(url).pathname.split("/").pop() || url; } catch { return url.slice(0, 60); }
}

// HEAD na mídia; se o servidor não aceitar HEAD (405/501), tenta um GET mínimo (Range).
async function headMedia(url: string): Promise<Response> {
  let res = await fetch(url, { method: "HEAD" });
  if (res.status === 405 || res.status === 501) {
    res = await fetch(url, { method: "GET", headers: { Range: "bytes=0-0" } });
  }
  return res;
}

// Pré-validação de UMA mídia: existe (HTTP ok) e é do tipo esperado (image/* ou video/*).
// Content-type genérico do storage (octet-stream) NÃO barra — a Meta decide o resto.
async function assertMediaReachable(url: string, kind: "image" | "video") {
  if (!url) throw new Error(`Post sem mídia (URL vazia) — reanexe o arquivo.`);
  let res: Response;
  try {
    res = await headMedia(url);
  } catch {
    throw new Error(`Mídia inacessível (falha de rede ao buscar o arquivo): ${shortMediaName(url)}`);
  }
  if (!res.ok) {
    throw new Error(`Mídia inacessível (HTTP ${res.status}) — confira se o arquivo ainda existe: ${shortMediaName(url)}`);
  }
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const generico = ct === "application/octet-stream" || ct === "binary/octet-stream";
  if (ct && !generico && !ct.startsWith(`${kind}/`)) {
    const esperado = kind === "image" ? "imagem" : "vídeo";
    throw new Error(`Formato de mídia inesperado (${ct}) — esperava ${esperado}: ${shortMediaName(url)}`);
  }
}

// Pré-validação do post inteiro (todas as mídias) antes de criar qualquer container.
async function preflightMedia(post: any) {
  if (post.media_type === "CAROUSEL") {
    let urls: string[];
    try { urls = JSON.parse(post.media_url); } catch { throw new Error("URLs do carrossel inválidas (não é uma lista JSON)"); }
    if (!Array.isArray(urls) || urls.length < 2 || urls.length > 10) throw new Error("Carrossel precisa de 2 a 10 itens");
    for (const u of urls) {
      const isVideo = /\.(mp4|mov|avi|webm)(\?|$)/i.test(u);
      await assertMediaReachable(u, isVideo ? "video" : "image");
    }
  } else {
    const kind = (post.media_type === "VIDEO" || post.media_type === "REELS") ? "video" : "image";
    await assertMediaReachable(post.media_url, kind);
  }
}

async function publishPost(supabase: any, post: any, account: any) {
  try {
    const { ig_user_id, access_token } = account;
    // Teto da Meta: 20 marcações por mídia e 3 colaboradores (a tela avisa quando passa).
    // user_tags é MONTADO dentro de cada builder, porque o formato depende do tipo de CADA mídia:
    // foto de feed exige x/y, vídeo/REELS não.
    const marcacoesPedidas = separarContas(post.user_tags).slice(0, 20);
    const colaboradoresPedidos = separarContas(post.collaborators).slice(0, 3);

    // PRÉ-VALIDAÇÃO da mídia ANTES de gastar processamento no Instagram: confirma que cada
    // URL existe (HTTP ok) e é do tipo certo (imagem/vídeo). Falha aqui vira uma mensagem
    // CLARA ("Mídia inacessível…/Formato inesperado…") em vez do "Invalid parameter" /
    // "Media processing failed" cru da Meta — o time entende que precisa reexportar/reanexar.
    await preflightMedia(post);

    // Conta PRIVADA ou que NÃO EXISTE em "Marcar Perfis"/"Collab" (subcode 2207018) derrubava o post
    // inteiro — 8 posts parados em Erro de 23/09 a 26/11/2026. Pedido do diretor (26/11/2026): publicar
    // mesmo assim e avisar quem ficou de fora. Então tira a conta recusada e cria o container de novo.
    // Seguro: é a CRIAÇÃO do container que falhou, nada foi ao ar. Termina sempre: cada volta tira ao
    // menos uma conta, e sem conta nenhuma o erro deixa de ser de conta e sobe.
    let marcacoes = marcacoesPedidas;
    let colaboradores = colaboradoresPedidos;
    const deFora: string[] = [];
    let itensDoCarrossel: { marcacoes: string; ids: string[] } | null = null;
    let containerId: string | null = null;

    while (!containerId) {
      try {
        if (post.media_type === "CAROUSEL") {
          // As marcações vão em cada ITEM; o collab, no container-pai. Recusa só do collab reaproveita
          // os itens já criados, em vez de subir as mídias (e esperar os vídeos) de novo.
          const chave = marcacoes.join(",");
          if (!itensDoCarrossel || itensDoCarrossel.marcacoes !== chave) {
            itensDoCarrossel = { marcacoes: chave, ids: await createCarouselItems(ig_user_id, access_token, post, marcacoes) };
          }
          containerId = await createCarouselContainer(ig_user_id, access_token, post, itensDoCarrossel.ids, colaboradores);
        } else {
          containerId = await createSingleContainer(ig_user_id, access_token, post, marcacoes, colaboradores);
        }
      } catch (err) {
        const contas = separarContas([...marcacoes, ...colaboradores].join(","));
        if (!(err instanceof ErroDaGraph) || err.subcode !== SUBCODE_CONTA_INACESSIVEL || !contas.length) throw err;
        const recusadas = contasRecusadas(err.message, contas);
        console.warn(`[ig-publish] ${post.id}: a Meta recusou ${recusadas.map((c) => `@${c}`).join(", ")}; tentando sem.`);
        deFora.push(...recusadas);
        marcacoes = semAsContas(marcacoes, recusadas);
        colaboradores = semAsContas(colaboradores, recusadas);
      }
    }
    const aviso = avisoDeContasDeFora(deFora, marcacoesPedidas, colaboradoresPedidos);

    // Aguarda o container ficar FINISHED antes de publicar — vale para TODOS os tipos,
    // INCLUSIVE carrossel (o container-pai também processa). Chamar media_publish cedo
    // demais (antes do Instagram baixar/processar a mídia) retorna "Media ID is not available".
    await waitForContainer(containerId, access_token);

    // Marca o container no banco ANTES de publicar. A partir daqui, se a função for
    // interrompida, o vigia NÃO recoloca na fila sozinho (pode já ter saído no Instagram)
    // -> vai p/ revisão humana, evitando publicação duplicada. Enquanto container_id for
    // nulo (não chegou aqui), o auto-retry é seguro.
    await supabase
      .from("ig_scheduled_posts")
      .update({ ig_container_id: containerId, updated_at: new Date().toISOString() })
      .eq("id", post.id);

    // Publish
    const publishRes = await fetch(`${META_API}/${ig_user_id}/media_publish`, {
      method: "POST",
      body: new URLSearchParams({ access_token, creation_id: containerId }),
    });
    const publishData = await publishRes.json();

    if (publishData.error) throw new Error(graphErrorMessage(publishData.error));

    const publicado = {
      status: "published",
      published_at: new Date().toISOString(),
      ig_media_id: publishData.id,
      ig_container_id: containerId,
    };
    // aviso_publicacao vai SEMPRE (NULL quando saiu completo): um Reenviar não pode herdar o aviso velho.
    const { error: erroAoGravar } = await supabase
      .from("ig_scheduled_posts")
      .update({ ...publicado, aviso_publicacao: aviso })
      .eq("id", post.id);
    if (erroAoGravar) {
      // O post JÁ ESTÁ NO AR: gravar 'published' é o que impede um Reenviar de publicar 2×. Grava sem o
      // aviso, se for ele o problema (coluna fora do cache do PostgREST, por exemplo).
      console.error(`[ig-publish] ${post.id}: publicado, mas a gravação com aviso falhou: ${erroAoGravar.message}`);
      await supabase.from("ig_scheduled_posts").update(publicado).eq("id", post.id);
    }

    if (aviso) await avisarContasDeFora(supabase, post, aviso);

    return { post_id: post.id, status: "published", ig_media_id: publishData.id, ...(aviso ? { aviso } : {}) };
  } catch (err) {
    const errorMessage = getErrorMessage(err);
    // updated_at = âncora do backoff do retry automático (ig_claim_due_posts re-tenta após
    // 3min*tentativas). Sem isto o backoff usaria o updated_at do claim e poderia re-tentar cedo.
    await supabase
      .from("ig_scheduled_posts")
      .update({ status: "failed", error_message: errorMessage, updated_at: new Date().toISOString() })
      .eq("id", post.id);

    return { post_id: post.id, status: "failed", error: errorMessage };
  }
}

// Post que saiu SEM alguma conta recusada pela Meta: avisa no sino quem agendou + a lista de quem recebe
// os avisos de post (`marketing_post_aviso_destinatarios`) — a mesma gente que o vigia
// `marketing_avisar_posts_com_erro` chama quando o post NÃO sai. Sem WhatsApp: o post saiu, não é urgência.
// Nunca derruba a publicação: o post já está no ar.
async function avisarContasDeFora(supabase: any, post: any, aviso: string) {
  try {
    const { data: lista, error: erroLista } = await supabase.from("marketing_post_aviso_destinatarios").select("user_id");
    if (erroLista) console.error(`[ig-publish] ${post.id}: lista de avisos indisponível: ${erroLista.message}`);
    const destinatarios = [...new Set([post.user_id, ...(lista ?? []).map((d: any) => d.user_id)].filter(Boolean))];
    const perfil = post.ig_accounts?.username ? `@${post.ig_accounts.username}` : "Instagram";
    const quando = post.scheduled_at
      ? new Intl.DateTimeFormat("pt-BR", {
        timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
      }).format(new Date(post.scheduled_at))
      : null;
    for (const user_id of destinatarios) {
      // Um por vez: user_id é FK de auth.users, e um destinatário que não existe mais não pode calar os outros.
      const { error } = await supabase.from("gt_notifications").insert({
        user_id,
        type: "post_publicado_sem_marcacao",
        title: `Post publicado sem marcação: ${perfil}`,
        body: `${quando ? `Agendado para ${quando}. ` : ""}${aviso}`,
        link: "/portal-marketing/agendar",
        reference_type: "marketing_post_agendado",
        reference_id: post.id,
        category: "primary",
      });
      if (error) console.error(`[ig-publish] ${post.id}: aviso de conta recusada não gravado para ${user_id}: ${error.message}`);
    }
  } catch (e) {
    console.error(`[ig-publish] ${post.id}: aviso de conta recusada falhou: ${getErrorMessage(e)}`);
  }
}

function applyOptionalParams(params: URLSearchParams, userTags?: string, collaborators?: string) {
  if (userTags) params.set("user_tags", userTags);
  if (collaborators) params.set("collaborators", collaborators);
}

async function createSingleContainer(
  igUserId: string, accessToken: string, post: any,
  marcacoes: string[], colaboradores: string[],
): Promise<string> {
  const params = new URLSearchParams({
    access_token: accessToken,
    caption: post.caption || "",
  });

  const isVideo = post.media_type === "VIDEO" || post.media_type === "REELS";
  if (isVideo) {
    params.set("media_type", post.media_type);
    params.set("video_url", post.media_url);
  } else {
    params.set("image_url", post.media_url);
  }

  // Foto de feed exige x/y nas marcações; vídeo/REELS usa só o username.
  const userTags = parseUserTags(marcacoes, !isVideo);
  applyOptionalParams(params, userTags, parseCollaborators(colaboradores));

  const res = await fetch(`${META_API}/${igUserId}/media`, { method: "POST", body: params });
  const data = await res.json();
  if (data.error) throw new ErroDaGraph(data.error);
  return data.id;
}

// Carrossel, etapa 1: um container por item, com as marcações. Devolve os ids na ordem das mídias.
async function createCarouselItems(
  igUserId: string, accessToken: string, post: any,
  marcacoes: string[],
): Promise<string[]> {
  let mediaUrls: string[];
  try {
    mediaUrls = JSON.parse(post.media_url);
  } catch {
    throw new Error("Invalid carousel media URLs");
  }

  if (mediaUrls.length < 2 || mediaUrls.length > 10) {
    throw new Error("Carousel needs 2-10 items");
  }

  // Step 1: Create individual item containers
  const childIds: string[] = [];
  for (const url of mediaUrls) {
    const isVideo = /\.(mp4|mov|avi|webm)(\?|$)/i.test(url);
    const params = new URLSearchParams({
      access_token: accessToken,
      is_carousel_item: "true",
    });

    if (isVideo) {
      params.set("media_type", "VIDEO");
      params.set("video_url", url);
    } else {
      params.set("image_url", url);
    }

    // user_tags também valem nos itens do carrossel — item de imagem exige x/y, item de vídeo não.
    const itemUserTags = parseUserTags(marcacoes, !isVideo);
    if (itemUserTags) params.set("user_tags", itemUserTags);

    const res = await fetch(`${META_API}/${igUserId}/media`, { method: "POST", body: params });
    const data = await res.json();
    if (data.error) throw new ErroDaGraph(data.error, "Carousel item error: ");
    childIds.push(data.id);

    if (isVideo) {
      await waitForContainer(data.id, accessToken);
    }
  }
  return childIds;
}

// Carrossel, etapa 2: o container-pai, com a legenda e o collab.
async function createCarouselContainer(
  igUserId: string, accessToken: string, post: any,
  childIds: string[], colaboradores: string[],
): Promise<string> {
  const carouselParams = new URLSearchParams({
    access_token: accessToken,
    media_type: "CAROUSEL",
    caption: post.caption || "",
    children: childIds.join(","),
  });

  const collaborators = parseCollaborators(colaboradores);
  if (collaborators) carouselParams.set("collaborators", collaborators);

  const res = await fetch(`${META_API}/${igUserId}/media`, { method: "POST", body: carouselParams });
  const data = await res.json();
  if (data.error) throw new ErroDaGraph(data.error);
  return data.id;
}

async function waitForContainer(containerId: string, accessToken: string) {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    // `status` traz o detalhe do erro do Instagram (formato/codec/duração do vídeo etc.);
    // sem ele a falha vira só "Media processing failed" e ninguém sabe o motivo.
    const res = await fetch(`${META_API}/${containerId}?fields=status_code,status&access_token=${accessToken}`);
    const data = await res.json();
    if (data.status_code === "FINISHED") return;
    if (data.status_code === "ERROR") {
      throw new Error(`Instagram recusou a mídia: ${data.status || "verifique formato/duração do vídeo"}`);
    }
  }
  throw new Error("Tempo esgotado processando a mídia no Instagram (vídeo muito grande ou longo?)");
}
