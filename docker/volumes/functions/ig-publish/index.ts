import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = await req.json().catch(() => ({}));
    const mode = body.mode || "cron";
    const nowIso = new Date().toISOString();

    if (mode === "single" && body.post_id) {
      // CLAIM atômico: só publica se a linha ainda não está em publicação/publicada.
      // Evita publicação dupla quando o usuário clica "Publicar agora" e o cron
      // pega o mesmo post no mesmo segundo (ou em duplo-clique).
      const { data: claimed } = await supabase
        .from("ig_scheduled_posts")
        .update({ status: "publishing", updated_at: nowIso })
        .eq("id", body.post_id)
        .in("status", ["scheduled", "draft", "failed"])
        .select("*, ig_accounts(*)");

      const post = claimed?.[0];
      if (!post) {
        // Já reivindicado por outra execução (cron/clique) ou já publicado.
        return new Response(JSON.stringify({ skipped: true, reason: "já em publicação ou publicado" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

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
function parseUserTags(tagsStr: string | null, withCoords: boolean): string | undefined {
  if (!tagsStr?.trim()) return undefined;
  // Instagram aceita no máx. 20 marcações por foto.
  const usernames = tagsStr.split(",").map((t) => t.trim().replace(/^@/, "")).filter(Boolean).slice(0, 20);
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

function parseCollaborators(collabStr: string | null): string | undefined {
  if (!collabStr?.trim()) return undefined;
  const usernames = collabStr.split(",").map((t) => t.trim().replace(/^@/, "")).filter(Boolean).slice(0, 3);
  if (!usernames.length) return undefined;
  return usernames.join(",");
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
    const collaborators = parseCollaborators(post.collaborators);
    // user_tags é parseado DENTRO de cada builder (createSingleContainer/publishCarousel),
    // porque o formato depende do tipo de CADA mídia: foto de feed exige x/y, vídeo/REELS não.

    // PRÉ-VALIDAÇÃO da mídia ANTES de gastar processamento no Instagram: confirma que cada
    // URL existe (HTTP ok) e é do tipo certo (imagem/vídeo). Falha aqui vira uma mensagem
    // CLARA ("Mídia inacessível…/Formato inesperado…") em vez do "Invalid parameter" /
    // "Media processing failed" cru da Meta — o time entende que precisa reexportar/reanexar.
    await preflightMedia(post);

    let containerId: string;

    if (post.media_type === "CAROUSEL") {
      containerId = await publishCarousel(ig_user_id, access_token, post, collaborators);
    } else {
      containerId = await createSingleContainer(ig_user_id, access_token, post, collaborators);
    }

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

    await supabase
      .from("ig_scheduled_posts")
      .update({
        status: "published",
        published_at: new Date().toISOString(),
        ig_media_id: publishData.id,
        ig_container_id: containerId,
      })
      .eq("id", post.id);

    return { post_id: post.id, status: "published", ig_media_id: publishData.id };
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

function applyOptionalParams(params: URLSearchParams, userTags?: string, collaborators?: string) {
  if (userTags) params.set("user_tags", userTags);
  if (collaborators) params.set("collaborators", collaborators);
}

async function createSingleContainer(
  igUserId: string, accessToken: string, post: any,
  collaborators?: string
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
  const userTags = parseUserTags(post.user_tags, !isVideo);
  applyOptionalParams(params, userTags, collaborators);

  const res = await fetch(`${META_API}/${igUserId}/media`, { method: "POST", body: params });
  const data = await res.json();
  if (data.error) throw new Error(graphErrorMessage(data.error));
  return data.id;
}

async function publishCarousel(
  igUserId: string, accessToken: string, post: any,
  collaborators?: string
): Promise<string> {
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
    const itemUserTags = parseUserTags(post.user_tags, !isVideo);
    if (itemUserTags) params.set("user_tags", itemUserTags);

    const res = await fetch(`${META_API}/${igUserId}/media`, { method: "POST", body: params });
    const data = await res.json();
    if (data.error) throw new Error(`Carousel item error: ${graphErrorMessage(data.error)}`);
    childIds.push(data.id);

    if (isVideo) {
      await waitForContainer(data.id, accessToken);
    }
  }

  // Step 2: Create carousel container
  const carouselParams = new URLSearchParams({
    access_token: accessToken,
    media_type: "CAROUSEL",
    caption: post.caption || "",
    children: childIds.join(","),
  });

  if (collaborators) carouselParams.set("collaborators", collaborators);

  const res = await fetch(`${META_API}/${igUserId}/media`, { method: "POST", body: carouselParams });
  const data = await res.json();
  if (data.error) throw new Error(graphErrorMessage(data.error));
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
