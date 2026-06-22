import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const META_API = "https://graph.facebook.com/v21.0";

const getErrorMessage = (err: unknown) => err instanceof Error ? err.message : String(err);

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

    // Cron mode — CLAIM atômico evita publicação duplicada (bug do Reels saindo 2-3x).
    // O cron roda a cada minuto; um Reels fica até ~150s no waitForContainer enquanto
    // o Instagram processa o vídeo. Antes, a linha continuava 'scheduled' esse tempo todo,
    // então a execução do minuto seguinte pegava o MESMO post e publicava de novo.
    // Agora a linha vira 'publishing' de forma atômica: a próxima execução recebe zero
    // linhas para ela e não republica.
    const { data: posts } = await supabase
      .from("ig_scheduled_posts")
      .update({ status: "publishing", updated_at: nowIso })
      .eq("status", "scheduled")
      .lte("scheduled_at", nowIso)
      .select("*, ig_accounts(*)");

    const results = [];
    for (const post of posts || []) {
      const result = await publishPost(supabase, post, post.ig_accounts);
      results.push(result);
    }

    // Recupera posts presos em 'publishing' há mais de 15 min (uma execução anterior
    // morreu no meio). NÃO republica — marca como falha p/ revisão manual, evitando
    // duplicar algo que pode já ter saído no Instagram. 15 min >> 150s máx de processamento,
    // então nunca pega uma publicação ainda legitimamente em andamento.
    const staleCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
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

function parseUserTags(tagsStr: string | null): string | undefined {
  if (!tagsStr?.trim()) return undefined;
  const usernames = tagsStr.split(",").map((t) => t.trim().replace(/^@/, "")).filter(Boolean);
  if (!usernames.length) return undefined;
  // Format: [{username:'user1'},{username:'user2'}]
  const tags = usernames.map((u) => `{username:'${u}'}`);
  return `[${tags.join(",")}]`;
}

function parseCollaborators(collabStr: string | null): string | undefined {
  if (!collabStr?.trim()) return undefined;
  const usernames = collabStr.split(",").map((t) => t.trim().replace(/^@/, "")).filter(Boolean).slice(0, 3);
  if (!usernames.length) return undefined;
  return usernames.join(",");
}

async function publishPost(supabase: any, post: any, account: any) {
  try {
    const { ig_user_id, access_token } = account;
    const userTags = parseUserTags(post.user_tags);
    const collaborators = parseCollaborators(post.collaborators);

    let containerId: string;

    if (post.media_type === "CAROUSEL") {
      containerId = await publishCarousel(ig_user_id, access_token, post, userTags, collaborators);
    } else {
      containerId = await createSingleContainer(ig_user_id, access_token, post, userTags, collaborators);

      // Aguarda o container ficar FINISHED antes de publicar — vale para TODOS os tipos.
      // Imagem também precisa: chamar media_publish cedo demais (antes do Instagram
      // baixar/processar a mídia) retorna "Media ID is not available".
      await waitForContainer(containerId, access_token);
    }

    // Publish
    const publishRes = await fetch(`${META_API}/${ig_user_id}/media_publish`, {
      method: "POST",
      body: new URLSearchParams({ access_token, creation_id: containerId }),
    });
    const publishData = await publishRes.json();

    if (publishData.error) throw new Error(publishData.error.message);

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
    await supabase
      .from("ig_scheduled_posts")
      .update({ status: "failed", error_message: errorMessage })
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
  userTags?: string, collaborators?: string
): Promise<string> {
  const params = new URLSearchParams({
    access_token: accessToken,
    caption: post.caption || "",
  });

  if (post.media_type === "VIDEO" || post.media_type === "REELS") {
    params.set("media_type", post.media_type);
    params.set("video_url", post.media_url);
  } else {
    params.set("image_url", post.media_url);
  }

  applyOptionalParams(params, userTags, collaborators);

  const res = await fetch(`${META_API}/${igUserId}/media`, { method: "POST", body: params });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.id;
}

async function publishCarousel(
  igUserId: string, accessToken: string, post: any,
  userTags?: string, collaborators?: string
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

    // user_tags can be set on individual carousel items too
    if (userTags) params.set("user_tags", userTags);

    const res = await fetch(`${META_API}/${igUserId}/media`, { method: "POST", body: params });
    const data = await res.json();
    if (data.error) throw new Error(`Carousel item error: ${data.error.message}`);
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
  if (data.error) throw new Error(data.error.message);
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
