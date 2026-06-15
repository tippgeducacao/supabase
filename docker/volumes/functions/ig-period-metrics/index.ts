import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const META_API = "https://graph.facebook.com/v21.0";

// Retorna o ALCANCE DEDUPLICADO, VISUALIZAÇÕES e demais métricas de conta do Instagram
// para o PERÍODO exato pedido (bate com o Painel Profissional), além dos NOVOS
// SEGUIDORES (follower_count somado). Tudo ao vivo na Graph API — não depende dos
// snapshots diários (que guardavam o total de 30 dias e inflavam a soma na tela).

const normalizeNumber = (value: unknown): number => {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") return Number(value) || 0;
  if (Array.isArray(value)) return value.reduce((s: number, i) => s + normalizeNumber(i), 0);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).reduce((s: number, i) => s + normalizeNumber(i), 0);
  }
  return 0;
};

const extractTotal = (metric: any): number => {
  if (!metric) return 0;
  if (metric.total_value?.value !== undefined) return normalizeNumber(metric.total_value.value);
  if (Array.isArray(metric.values) && metric.values.length > 0) {
    return metric.values.reduce((s: number, e: any) => s + normalizeNumber(e?.value), 0);
  }
  if (metric.value !== undefined) return normalizeNumber(metric.value);
  return 0;
};

// Métricas de conta que aceitam metric_type=total_value (period=day, máx. 30 dias)
async function fetchTotalValue(
  igUserId: string, token: string, metric: string, since: number, until: number,
): Promise<number | null> {
  try {
    const url = `${META_API}/${igUserId}/insights?metric=${metric}&metric_type=total_value&period=day&since=${since}&until=${until}&access_token=${token}`;
    const json = await (await fetch(url)).json();
    if (json.error) {
      console.log(`metric ${metric} error: ${json.error.message} [${json.error.code}]`);
      return null;
    }
    return Array.isArray(json.data) ? json.data.reduce((s: number, it: any) => s + extractTotal(it), 0) : 0;
  } catch (_) {
    return null;
  }
}

// follower_count NÃO aceita total_value — vem série diária; soma = novos seguidores no período
async function fetchNewFollowers(
  igUserId: string, token: string, since: number, until: number,
): Promise<number | null> {
  try {
    const url = `${META_API}/${igUserId}/insights?metric=follower_count&period=day&since=${since}&until=${until}&access_token=${token}`;
    const json = await (await fetch(url)).json();
    if (json.error) return null;
    const vals = json.data?.[0]?.values || [];
    return vals.reduce((s: number, v: any) => s + (Number(v?.value) || 0), 0);
  } catch (_) {
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { since, until, account_ids } = await req.json() as {
      since: string; until: string; account_ids?: string[];
    };
    if (!since || !until) {
      return new Response(JSON.stringify({ error: "since e until são obrigatórios (YYYY-MM-DD)" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const untilTs = Math.floor(new Date(`${until}T23:59:59Z`).getTime() / 1000);
    let sinceTs = Math.floor(new Date(`${since}T00:00:00Z`).getTime() / 1000);
    // Limite da API p/ insights de conta com total_value: 30 dias.
    if (untilTs - sinceTs > 30 * 86400) sinceTs = untilTs - 30 * 86400;

    let q = supabase.from("ig_accounts").select("id, ig_user_id, access_token, followers_count").eq("is_active", true);
    if (Array.isArray(account_ids) && account_ids.length) q = q.in("id", account_ids);
    const { data: accounts, error } = await q;
    if (error) throw error;

    const todayStr = new Date(new Date().getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10); // ~Brasília

    // Seguidores no snapshot diário mais recente até a data informada (inclusive)
    const followersAtOrBefore = async (accountId: string, date: string): Promise<number | null> => {
      const { data } = await supabase
        .from("ig_profile_metrics_daily")
        .select("followers_count")
        .eq("account_id", accountId)
        .lte("metric_date", date)
        .not("followers_count", "is", null)
        .order("metric_date", { ascending: false })
        .limit(1);
      return (data && data[0]?.followers_count != null) ? Number(data[0].followers_count) : null;
    };

    const METRICS: [string, string][] = [
      ["reach", "reach"],
      ["views", "views"],
      ["profile_views", "profile_views"],
      ["accounts_engaged", "accounts_engaged"],
      ["likes", "likes"],
      ["comments", "comments"],
      ["shares", "shares"],
      ["saves", "saves"],
    ];

    const result = await Promise.all((accounts || []).map(async (a: any) => {
      const out: any = { id: a.id };
      if (!a.ig_user_id || !a.access_token) return out;
      const totals = await Promise.all(
        METRICS.map(async ([api, field]) => [field, await fetchTotalValue(a.ig_user_id, a.access_token, api, sinceTs, untilTs)] as const),
      );
      for (const [field, val] of totals) out[field] = val;

      // Novos seguidores LÍQUIDOS = seguidores(fim) − seguidores(início), via histórico
      // diário (bate com o Painel Profissional). Enquanto não há histórico no início do
      // período, cai no BRUTO (follower_count somado), que conta só ganhos.
      const startF = await followersAtOrBefore(a.id, since);
      const endF = until >= todayStr ? (a.followers_count ?? null) : await followersAtOrBefore(a.id, until);
      if (startF != null && endF != null) {
        out.new_followers = endF - startF;
        out.new_followers_source = "liquido";
      } else {
        out.new_followers = await fetchNewFollowers(a.ig_user_id, a.access_token, sinceTs, untilTs);
        out.new_followers_source = "bruto";
      }
      return out;
    }));

    return new Response(JSON.stringify({ accounts: result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Erro" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
