// sync-google-ads — puxa CAMPANHAS + gasto DIÁRIO do Google Ads e popula
// public.google_campaigns / public.google_insights (espelho do sync-meta-ads).
// Deploy por git push (deploy-edges.yml), NUNCA Deploy do Dokploy.
//
// ⚠️ PRECISA de credenciais (env do edge-runtime, via Dokploy):
//   GOOGLE_ADS_DEVELOPER_TOKEN   (developer token aprovado no Google Ads API Center)
//   GOOGLE_ADS_CLIENT_ID         (OAuth2 client — app com escopo adwords)
//   GOOGLE_ADS_CLIENT_SECRET
//   GOOGLE_ADS_API_VERSION       (opcional; default v18)
// E, por conta, uma linha em public.google_accounts com:
//   customer_id (só dígitos), refresh_token, login_customer_id (MCC, se houver), is_active=true
//
// Cada conta ativa: troca o refresh_token por um access_token e roda uma GAQL
// que traz campanha + métricas por dia; grava spend = cost_micros ÷ 1e6.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ⚠️ Versão da API do Google Ads. O Google descontinua versões antigas (~1x/ano) →
// versão fora de suporte devolve 404 (página HTML), não erro JSON. Mantenha atual.
// Override sem deploy: env GOOGLE_ADS_API_VERSION no edge-runtime (Dokploy).
const API_VERSION = Deno.env.get("GOOGLE_ADS_API_VERSION") || "v24";
const ADS_BASE = `https://googleads.googleapis.com/${API_VERSION}`;

// digits-only (customer_id vem às vezes como 123-456-7890)
const onlyDigits = (s: string) => (s || "").replace(/\D/g, "");

async function accessTokenFromRefresh(refreshToken: string, clientId: string, clientSecret: string): Promise<string> {
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) {
    throw new Error(`OAuth refresh falhou (${resp.status}): ${data.error_description || data.error || "sem access_token"}`);
  }
  return data.access_token as string;
}

interface AdsRow {
  campaign?: { id?: string; name?: string; status?: string; advertisingChannelType?: string };
  segments?: { date?: string };
  metrics?: { costMicros?: string; impressions?: string; clicks?: string; conversions?: number; conversionsValue?: number };
}

async function queryGAQL(
  customerId: string,
  loginCustomerId: string | null,
  accessToken: string,
  developerToken: string,
  gaql: string
): Promise<AdsRow[]> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": developerToken,
    "Content-Type": "application/json",
  };
  if (loginCustomerId) headers["login-customer-id"] = onlyDigits(loginCustomerId);

  const resp = await fetch(`${ADS_BASE}/customers/${customerId}/googleAds:searchStream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: gaql }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`GAQL falhou (${resp.status}) conta ${customerId}: ${text.slice(0, 500)}`);
  // searchStream devolve um ARRAY de chunks: [{ results: [...] }, { results: [...] }]
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Resposta GAQL não-JSON conta ${customerId}: ${text.slice(0, 200)}`);
  }
  const chunks = Array.isArray(parsed) ? parsed : [parsed];
  const rows: AdsRow[] = [];
  for (const c of chunks) {
    const results = (c as { results?: AdsRow[] })?.results;
    if (Array.isArray(results)) rows.push(...results);
  }
  return rows;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    // default = últimos 30 dias (fuso America/Sao_Paulo)
    const hojeSP = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const date_to = body.date_to || iso(hojeSP);
    const date_from = body.date_from || iso(new Date(hojeSP.getTime() - 30 * 86400000));

    const developerToken = Deno.env.get("GOOGLE_ADS_DEVELOPER_TOKEN");
    const clientId = Deno.env.get("GOOGLE_ADS_CLIENT_ID");
    const clientSecret = Deno.env.get("GOOGLE_ADS_CLIENT_SECRET");
    if (!developerToken || !clientId || !clientSecret) {
      return json(
        { error: "Faltam secrets: GOOGLE_ADS_DEVELOPER_TOKEN / GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET no edge-runtime." },
        400
      );
    }

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: accounts, error: accErr } = await supabase
      .from("google_accounts")
      .select("*")
      .eq("is_active", true);
    if (accErr) throw accErr;
    if (!accounts?.length) return json({ ok: true, aviso: "Nenhuma google_accounts ativa. Cadastre customer_id + refresh_token.", contas: 0 });

    const gaql = `
      SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
             segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks,
             metrics.conversions, metrics.conversions_value
      FROM campaign
      WHERE segments.date BETWEEN '${date_from}' AND '${date_to}'
    `.trim();

    const resumo: Record<string, unknown>[] = [];

    for (const acc of accounts as Record<string, string>[]) {
      const customerId = onlyDigits(acc.customer_id);
      try {
        if (!acc.refresh_token) throw new Error("conta sem refresh_token");
        const accessToken = await accessTokenFromRefresh(acc.refresh_token, clientId, clientSecret);
        const rows = await queryGAQL(customerId, acc.login_customer_id || null, accessToken, developerToken, gaql);

        // campanhas (dedup por id) + insights (por campaign×dia)
        const campMap = new Map<string, Record<string, unknown>>();
        const insMap = new Map<string, Record<string, unknown>>();
        for (const r of rows) {
          const cid = r.campaign?.id;
          const dia = r.segments?.date;
          if (!cid) continue;
          if (!campMap.has(cid)) {
            campMap.set(cid, {
              id: cid,
              customer_id: customerId,
              name: r.campaign?.name ?? null,
              status: r.campaign?.status ?? null,
              channel_type: r.campaign?.advertisingChannelType ?? null,
              fetched_at: new Date().toISOString(),
            });
          }
          if (!dia) continue;
          const key = `${cid}|${dia}`;
          insMap.set(key, {
            customer_id: customerId,
            campaign_id: cid,
            date_start: dia,
            spend: Number(r.metrics?.costMicros ?? 0) / 1e6,
            impressions: Number(r.metrics?.impressions ?? 0),
            clicks: Number(r.metrics?.clicks ?? 0),
            conversions: Number(r.metrics?.conversions ?? 0),
            conversion_value: Number(r.metrics?.conversionsValue ?? 0),
            fetched_at: new Date().toISOString(),
          });
        }

        const campaigns = [...campMap.values()];
        const insights = [...insMap.values()];
        if (campaigns.length) {
          const { error } = await supabase.from("google_campaigns").upsert(campaigns, { onConflict: "id" });
          if (error) throw error;
        }
        if (insights.length) {
          const { error } = await supabase
            .from("google_insights")
            .upsert(insights, { onConflict: "customer_id,campaign_id,date_start" });
          if (error) throw error;
        }
        resumo.push({ conta: customerId, campanhas: campaigns.length, dias_x_campanha: insights.length, ok: true });
      } catch (e) {
        resumo.push({ conta: customerId, ok: false, erro: err(e) });
      }
    }

    return json({ ok: true, periodo: { date_from, date_to }, contas: accounts.length, resumo });
  } catch (e) {
    return json({ error: err(e) }, 500);
  }
});
