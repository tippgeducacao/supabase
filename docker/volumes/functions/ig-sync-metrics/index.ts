import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const META_API = "https://graph.facebook.com/v21.0";

const normalizeNumber = (value: unknown): number => {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") return Number(value) || 0;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + normalizeNumber(item), 0);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).reduce(
      (sum: number, item) => sum + normalizeNumber(item),
      0,
    );
  }
  return 0;
};

const extractMetricTotal = (metric: any): number => {
  if (!metric) return 0;
  if (metric.total_value?.value !== undefined) return normalizeNumber(metric.total_value.value);
  if (Array.isArray(metric.values) && metric.values.length > 0) {
    return metric.values.reduce((sum: number, entry: any) => sum + normalizeNumber(entry?.value), 0);
  }
  if (metric.value !== undefined) return normalizeNumber(metric.value);
  return 0;
};

const isRecentWithinDays = (timestamp?: string, days = 30) => {
  if (!timestamp) return false;
  const time = new Date(timestamp).getTime();
  if (!Number.isFinite(time)) return false;
  return time >= Date.now() - days * 24 * 60 * 60 * 1000;
};

const getMediaMetricSets = (media: { media_type?: string; media_product_type?: string; permalink?: string }) => {
  const isReel =
    media.media_product_type === "REELS" ||
    media.media_type === "REEL" ||
    media.permalink?.includes("/reel/");

  if (isReel) {
    return [
      ["reach", "views", "saved", "shares"],
      ["reach", "views", "saved", "total_interactions"],
      ["reach", "saved", "shares"],
    ];
  }

  // v22.0+ removed "impressions" for media — use "views" instead
  return [
    ["reach", "views", "saved", "shares"],
    ["reach", "views", "saved", "total_interactions"],
    ["reach", "saved", "shares"],
    ["reach", "saved", "total_interactions"],
  ];
};

const fetchJson = async (url: string) => {
  const response = await fetch(url);
  return response.json();
};

async function fetchProfileMetric(
  igUserId: string,
  accessToken: string,
  metric: string,
  since: number,
  until: number,
) {
  const url = `${META_API}/${igUserId}/insights?metric=${metric}&metric_type=total_value&period=day&since=${since}&until=${until}&access_token=${accessToken}`;
  const json = await fetchJson(url);

  if (json.error) {
    console.log(`Profile metric ${metric} error: ${json.error.message} [code: ${json.error.code}]`);
    return 0;
  }

  const total = Array.isArray(json.data)
    ? json.data.reduce((sum: number, item: any) => sum + extractMetricTotal(item), 0)
    : 0;

  return total;
}

async function fetchMediaInsights(media: any, accessToken: string) {
  let best = { reach: 0, impressions: 0, saves: 0, shares: 0, interactionTotal: 0 };
  let lastError = "";

  for (const metrics of getMediaMetricSets(media)) {
    const url = `${META_API}/${media.id}/insights?metric=${metrics.join(",")}&access_token=${accessToken}`;
    const json = await fetchJson(url);

    if (json.error) {
      lastError = `${json.error.message} [code: ${json.error.code}]`;
      continue;
    }

    if (!Array.isArray(json.data) || json.data.length === 0) continue;

    const parsed = { reach: 0, impressions: 0, saves: 0, shares: 0, interactionTotal: 0 };

    for (const metric of json.data) {
      const value = extractMetricTotal(metric);
      if (metric.name === "reach") parsed.reach = value;
      if (metric.name === "impressions") parsed.impressions = value;
      if (metric.name === "views") parsed.impressions = Math.max(parsed.impressions, value);
      if (metric.name === "saved") parsed.saves = value;
      if (metric.name === "shares") parsed.shares = value;
      if (metric.name === "total_interactions") parsed.interactionTotal = value;
    }

    if (parsed.reach > 0 || parsed.impressions > 0 || parsed.interactionTotal > 0) {
      return parsed;
    }

    const parsedScore = parsed.reach + parsed.impressions + parsed.saves + parsed.shares + parsed.interactionTotal;
    const bestScore = best.reach + best.impressions + best.saves + best.shares + best.interactionTotal;
    if (parsedScore > bestScore) best = parsed;
  }

  return best;
}

async function syncAccount(supabase: any, account: any) {
  const { ig_user_id, access_token, id: accountId } = account;
  const now = Math.floor(Date.now() / 1000);
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60;

  const accountUpdate: Record<string, any> = {};
  const recentPostTotals = { reach: 0, impressions: 0, likes: 0, comments: 0, saves: 0, shares: 0, engaged: 0 };

  // 1. Profile basic info
  const profileData = await fetchJson(
    `${META_API}/${ig_user_id}?fields=followers_count,follows_count,media_count,username,profile_picture_url&access_token=${access_token}`,
  );

  if (!profileData.error) {
    accountUpdate.followers_count = profileData.followers_count || 0;
    accountUpdate.follows_count = profileData.follows_count || 0;
    accountUpdate.media_count = profileData.media_count || 0;
    accountUpdate.username = profileData.username;
    accountUpdate.profile_picture_url = profileData.profile_picture_url;
  } else {
    console.log(`[${account.account_name}] Profile error: ${profileData.error.message}`);
    return { account: account.account_name, error: profileData.error.message };
  }

  // 2. Profile metrics — v22+ removed "impressions", use "views" instead
  const profileMetrics = [
    { api: "reach", field: "reach" },
    { api: "views", field: "impressions" },
    { api: "profile_views", field: "profile_views" },
    { api: "accounts_engaged", field: "accounts_engaged" },
    { api: "likes", field: "total_likes" },
    { api: "comments", field: "total_comments" },
    { api: "shares", field: "total_shares" },
    { api: "saves", field: "total_saves" },
  ];

  // Fetch profile metrics in parallel
  const metricResults = await Promise.all(
    profileMetrics.map(async (metric) => {
      try {
        return { field: metric.field, value: await fetchProfileMetric(ig_user_id, access_token, metric.api, thirtyDaysAgo, now) };
      } catch {
        return { field: metric.field, value: 0 };
      }
    }),
  );
  for (const r of metricResults) accountUpdate[r.field] = r.value;

  // 2b. Store daily metrics snapshot in ig_profile_metrics_daily
  const today = new Date().toISOString().split("T")[0];
  try {
    await supabase.from("ig_profile_metrics_daily").upsert({
      account_id: accountId,
      metric_date: today,
      reach: accountUpdate.reach || 0,
      impressions: accountUpdate.impressions || 0,
      profile_views: accountUpdate.profile_views || 0,
      accounts_engaged: accountUpdate.accounts_engaged || 0,
      total_likes: accountUpdate.total_likes || 0,
      total_comments: accountUpdate.total_comments || 0,
      total_shares: accountUpdate.total_shares || 0,
      total_saves: accountUpdate.total_saves || 0,
      fetched_at: new Date().toISOString(),
    }, { onConflict: "account_id,metric_date" });
    console.log(`[${account.account_name}] Daily metrics saved for ${today}`);
  } catch (err) {
    console.log(`[${account.account_name}] Daily metrics save error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Media posts (limit 50)
  const mediaData = await fetchJson(
    `${META_API}/${ig_user_id}/media?fields=id,caption,media_type,media_product_type,media_url,thumbnail_url,timestamp,permalink,like_count,comments_count&limit=50&access_token=${access_token}`,
  );

  let postsSynced = 0;
  const posts = mediaData.data || [];

  // Process posts in batches of 5 to avoid rate limits but still parallelize
  for (let i = 0; i < posts.length; i += 5) {
    const batch = posts.slice(i, i + 5);
    await Promise.all(
      batch.map(async (media: any) => {
        try {
          const insights = await fetchMediaInsights(media, access_token);
          const likes = media.like_count || 0;
          const comments = media.comments_count || 0;
          const interactionTotal = insights.interactionTotal || likes + comments + insights.saves + insights.shares;
          const exposureBase = insights.impressions || insights.reach;

          if (isRecentWithinDays(media.timestamp, 30)) {
            recentPostTotals.reach += insights.reach;
            recentPostTotals.impressions += insights.impressions;
            recentPostTotals.likes += likes;
            recentPostTotals.comments += comments;
            recentPostTotals.saves += insights.saves;
            recentPostTotals.shares += insights.shares;
            recentPostTotals.engaged += interactionTotal;
          }

          const { data: matchingPost } = await supabase
            .from("ig_scheduled_posts")
            .select("id")
            .eq("ig_media_id", media.id)
            .maybeSingle();

          await supabase.from("ig_post_metrics").upsert(
            {
              ig_media_id: media.id,
              account_id: accountId,
              post_id: matchingPost?.id || null,
              likes,
              comments,
              shares: insights.shares,
              saves: insights.saves,
              reach: insights.reach,
              impressions: insights.impressions,
              permalink: media.permalink,
              thumbnail_url: media.thumbnail_url || media.media_url,
              caption: media.caption?.substring(0, 500),
              media_type: media.media_type,
              timestamp: media.timestamp,
              engagement_rate: exposureBase > 0 ? (interactionTotal / exposureBase) * 100 : 0,
              fetched_at: new Date().toISOString(),
            },
            { onConflict: "ig_media_id,account_id" },
          );

          postsSynced++;
        } catch (error) {
          console.log(`[${account.account_name}] Post ${media.id} error: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    );
  }

  // Fallback: if profile-level metrics came back 0, use post totals
  if (!accountUpdate.impressions && recentPostTotals.impressions > 0) accountUpdate.impressions = recentPostTotals.impressions;
  if (!accountUpdate.total_likes && recentPostTotals.likes > 0) accountUpdate.total_likes = recentPostTotals.likes;
  if (!accountUpdate.total_comments && recentPostTotals.comments > 0) accountUpdate.total_comments = recentPostTotals.comments;
  if (!accountUpdate.total_saves && recentPostTotals.saves > 0) accountUpdate.total_saves = recentPostTotals.saves;
  if (!accountUpdate.total_shares && recentPostTotals.shares > 0) accountUpdate.total_shares = recentPostTotals.shares;
  if (!accountUpdate.accounts_engaged && recentPostTotals.engaged > 0) accountUpdate.accounts_engaged = recentPostTotals.engaged;

  // Update account
  if (Object.keys(accountUpdate).length > 0) {
    accountUpdate.updated_at = new Date().toISOString();
    const { error: accountUpdateError } = await supabase
      .from("ig_accounts")
      .update(accountUpdate)
      .eq("id", accountId);

    if (accountUpdateError) {
      console.log(`[${account.account_name}] Account update error: ${accountUpdateError.message}`);
    }
  }

  // 4. Stories
  let storiesSynced = 0;
  try {
    const storiesData = await fetchJson(
      `${META_API}/${ig_user_id}/stories?fields=id,media_type,media_url,timestamp,permalink&access_token=${access_token}`,
    );

    for (const story of storiesData.data || []) {
      try {
        const storyMetricSets = [
          ["reach", "views", "replies", "total_interactions"],
          ["reach", "views", "replies"],
          ["reach", "views"],
        ];

        const storyInsights = { reach: 0, views: 0, replies: 0, navigation: 0, exits: 0, profile_visits: 0, total_interactions: 0 };

        for (const metrics of storyMetricSets) {
          const url = `${META_API}/${story.id}/insights?metric=${metrics.join(",")}&access_token=${access_token}`;
          const json = await fetchJson(url);

          if (json.error) continue;

          if (Array.isArray(json.data)) {
            for (const metric of json.data) {
              const value = extractMetricTotal(metric);
              if (metric.name === "reach") storyInsights.reach = value;
              if (metric.name === "views") storyInsights.views = value;
              if (metric.name === "replies") storyInsights.replies = value;
              if (metric.name === "navigation") storyInsights.navigation = value;
              if (metric.name === "exits") storyInsights.exits = value;
              if (metric.name === "profile_visits") storyInsights.profile_visits = value;
              if (metric.name === "total_interactions") storyInsights.total_interactions = value;
            }
            if (storyInsights.reach > 0 || storyInsights.views > 0) break;
          }
        }

        const expiresAt = story.timestamp
          ? new Date(new Date(story.timestamp).getTime() + 24 * 60 * 60 * 1000).toISOString()
          : null;

        await supabase.from("ig_story_metrics").upsert(
          {
            ig_media_id: story.id,
            account_id: accountId,
            media_url: story.media_url,
            media_type: story.media_type,
            reach: storyInsights.reach,
            views: storyInsights.views,
            replies: storyInsights.replies,
            profile_visits: storyInsights.profile_visits,
            navigation: storyInsights.navigation,
            total_interactions: storyInsights.total_interactions,
            exits: storyInsights.exits,
            timestamp: story.timestamp,
            expires_at: expiresAt,
            fetched_at: new Date().toISOString(),
          },
          { onConflict: "ig_media_id,account_id" },
        );

        storiesSynced++;
      } catch (error) {
        console.log(`[${account.account_name}] Story ${story.id} error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    console.log(`[${account.account_name}] Stories fetch error: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(`[${account.account_name}] Done: ${postsSynced} posts, ${storiesSynced} stories, followers=${accountUpdate.followers_count}`);

  return {
    account: account.account_name || accountId,
    posts_synced: postsSynced,
    stories_synced: storiesSynced,
    profile_updated: !profileData.error,
    followers: accountUpdate.followers_count,
    reach_30d: accountUpdate.reach,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json().catch(() => ({}));
    const accountId = body.account_id;

    let accountsQuery = supabase.from("ig_accounts").select("*").eq("is_active", true);
    if (accountId) accountsQuery = accountsQuery.eq("id", accountId);

    const { data: accounts, error: accountsError } = await accountsQuery;
    if (accountsError) throw accountsError;

    console.log(`Starting sync for ${accounts?.length || 0} accounts`);

    // Process ALL accounts in parallel to avoid timeout
    const results = await Promise.all(
      (accounts || []).map((account) => syncAccount(supabase, account)),
    );

    return new Response(JSON.stringify({ success: true, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    console.error(`Sync error: ${message}`);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
