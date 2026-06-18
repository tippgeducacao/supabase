import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// Sincroniza métricas do TikTok (perfil + vídeos) de cada conta conectada.
// Espelha ig-sync-metrics. Roda por cron (e dá pra chamar na mão). Renova o token
// via refresh_token quando expira. Grava snapshot na conta + série diária + por vídeo.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const USERINFO_URL = "https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name,username,follower_count,following_count,likes_count,video_count";
const VIDEO_FIELDS = "id,title,video_description,duration,cover_image_url,share_url,view_count,like_count,comment_count,share_count,create_time";
const VIDEO_LIST_URL = `https://open.tiktokapis.com/v2/video/list/?fields=${VIDEO_FIELDS}`;

async function getConfig(supabase: ReturnType<typeof createClient>, chave: string): Promise<string | null> {
  const { data } = await supabase.from("ped_configuracoes").select("valor").eq("chave", chave).maybeSingle();
  return (data?.valor as string) || Deno.env.get(chave) || null;
}

// Garante um access_token válido; renova via refresh_token se faltar < 5 min.
async function ensureToken(supabase: any, account: any, clientKey: string, clientSecret: string): Promise<string | null> {
  const exp = account.token_expires_at ? new Date(account.token_expires_at).getTime() : 0;
  if (account.access_token && exp - Date.now() > 5 * 60 * 1000) return account.access_token;
  if (!account.refresh_token) return account.access_token || null;
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: account.refresh_token }),
  });
  const t = await resp.json();
  if (!resp.ok || t.error || !t.access_token) { console.error("refresh falhou:", JSON.stringify(t)); return account.access_token || null; }
  const now = Date.now();
  await supabase.from("tiktok_accounts").update({
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? account.refresh_token,
    token_expires_at: t.expires_in ? new Date(now + t.expires_in * 1000).toISOString() : null,
    refresh_expires_at: t.refresh_expires_in ? new Date(now + t.refresh_expires_in * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  }).eq("id", account.id);
  return t.access_token;
}

function diaBrasilia(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }); // YYYY-MM-DD
}

async function syncConta(supabase: any, account: any, clientKey: string, clientSecret: string) {
  const token = await ensureToken(supabase, account, clientKey, clientSecret);
  if (!token) return { account: account.username, ok: false, erro: "sem token" };

  // 1) Perfil + stats.
  const uResp = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${token}` } });
  const u = await uResp.json();
  if (!uResp.ok || u.error?.code && u.error.code !== "ok") {
    console.error("user/info erro:", JSON.stringify(u.error));
  }
  const user = u?.data?.user ?? {};
  const snap = {
    username: user.username ?? account.username,
    display_name: user.display_name ?? account.display_name,
    avatar_url: user.avatar_url ?? account.avatar_url,
    follower_count: user.follower_count ?? null,
    following_count: user.following_count ?? null,
    likes_count: user.likes_count ?? null,
    video_count: user.video_count ?? null,
    last_synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await supabase.from("tiktok_accounts").update(snap).eq("id", account.id);
  await supabase.from("tiktok_profile_metrics_daily").upsert({
    account_id: account.id, dia: diaBrasilia(),
    follower_count: snap.follower_count, following_count: snap.following_count,
    likes_count: snap.likes_count, video_count: snap.video_count,
    updated_at: new Date().toISOString(),
  }, { onConflict: "account_id,dia" });

  // 2) Lista de vídeos (com métricas).
  let videosSalvos = 0;
  try {
    const vResp = await fetch(VIDEO_LIST_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ max_count: 20 }),
    });
    const v = await vResp.json();
    const videos: any[] = v?.data?.videos ?? [];
    for (const vid of videos) {
      await supabase.from("tiktok_video_metrics").upsert({
        account_id: account.id,
        video_id: String(vid.id),
        title: vid.title ?? null,
        descricao: vid.video_description ?? null,
        cover_image_url: vid.cover_image_url ?? null,
        share_url: vid.share_url ?? null,
        duration: vid.duration ?? null,
        view_count: vid.view_count ?? null,
        like_count: vid.like_count ?? null,
        comment_count: vid.comment_count ?? null,
        share_count: vid.share_count ?? null,
        create_time: vid.create_time ? new Date(vid.create_time * 1000).toISOString() : null,
        synced_at: new Date().toISOString(),
      }, { onConflict: "account_id,video_id" });
      videosSalvos++;
    }
  } catch (e) { console.error("video/list erro:", e); }

  return { account: snap.username, ok: true, follower_count: snap.follower_count, likes_count: snap.likes_count, video_count: snap.video_count, videos: videosSalvos };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const clientKey = await getConfig(supabase, "TIKTOK_CLIENT_KEY");
    const clientSecret = await getConfig(supabase, "TIKTOK_CLIENT_SECRET");
    if (!clientKey || !clientSecret) return json({ error: "Credenciais do TikTok não configuradas." }, 500);

    let accountId: string | null = null;
    try { accountId = (await req.json())?.account_id ?? null; } catch { /* sem body */ }

    let q = supabase.from("tiktok_accounts").select("*").eq("ativo", true);
    if (accountId) q = q.eq("id", accountId);
    const { data: accounts, error } = await q;
    if (error) return json({ error: error.message }, 500);
    if (!accounts?.length) return json({ ok: true, message: "Nenhuma conta TikTok conectada.", resultados: [] });

    const resultados = [];
    for (const acc of accounts) resultados.push(await syncConta(supabase, acc, clientKey, clientSecret));
    return json({ ok: true, contas: accounts.length, resultados });
  } catch (e) {
    console.error("tiktok-sync-metrics:", e);
    return json({ error: String(e) }, 500);
  }
});
