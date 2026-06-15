import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// Sincronização DEDICADA dos criativos do Meta Ads — foco nos ANÚNCIOS ATIVOS.
// Antes (sync-meta-ads) os criativos morriam por wall-clock porque a função também fazia
// os insights de campanha (milhares de linhas) e puxava TODOS os criativos (a maioria
// inativa, ~1200 por conta). Aqui buscamos só os anúncios ATIVOS — poucos — com o criativo
// embutido (thumbnail fresco), em paralelo por conta e com upsert por página. Rápido e
// confiável (resolve o caso da BM ppgvet que não atualizava).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const getErrorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const META_API = "https://graph.facebook.com/v19.0";

function extractMetaSourceUrl(url?: string | null) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const embedded = parsed.searchParams.get("url");
    if (embedded && /facebook\.com\/ads\/image\//.test(decodeURIComponent(embedded))) {
      return decodeURIComponent(embedded);
    }
    if (/facebook\.com\/ads\/image\//.test(url)) return url;
  } catch {
    return null;
  }
  return null;
}

function normalizeCreativeImageUrl(url?: string | null) {
  if (!url) return null;
  const sourceUrl = extractMetaSourceUrl(url);
  if (sourceUrl) return sourceUrl;
  return url
    .replace(/p64x64/g, "p1200x1200")
    .replace(/p128x128/g, "p1200x1200")
    .replace(/p320x320/g, "p1200x1200");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const today = new Date();
    const date_to = body?.date_to || today.toISOString().slice(0, 10);
    const date_from = body?.date_from ||
      new Date(today.getTime() - 30 * 86400 * 1000).toISOString().slice(0, 10);
    const onlyAccount: string | null = body?.ad_account_id || null;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let accQuery = supabase.from("meta_accounts").select("*").eq("is_active", true);
    if (onlyAccount) accQuery = accQuery.eq("ad_account_id", onlyAccount);
    const { data: accounts, error: accErr } = await accQuery;
    if (accErr) throw accErr;
    if (!accounts?.length) {
      return new Response(JSON.stringify({ message: "No active accounts" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Contas em PARALELO (são poucas) — cada uma é leve agora.
    const results = await Promise.all(accounts.map(async (account) => {
      const { access_token, ad_account_id: rawId } = account;
      const ad_account_id = rawId.startsWith("act_") ? rawId : `act_${rawId}`;
      const db_account_id = rawId;
      const h = { Authorization: `Bearer ${access_token}` };
      const r: Record<string, unknown> = { ad_account_id: db_account_id, account_name: account.account_name };

      try {
        // Anúncios ATIVOS com o criativo embutido (thumbnail fresco). effective_status
        // limita aos que estão de fato rodando → volume pequeno e confiável.
        let synced = 0;
        const activeAdIds: string[] = [];
        // ⚠️ effective_status só aceita valores válidos no filtro; "LIMITED" NÃO é válido
        // (a API retorna 400 "Status do grupo de anúncios inválido"). Use só "ACTIVE".
        let url: string | null =
          `${META_API}/${ad_account_id}/ads?fields=id,name,campaign_id,effective_status,` +
          `creative{id,name,body,title,object_story_spec,thumbnail_url,image_url}` +
          `&effective_status=["ACTIVE"]&limit=100`;
        while (url) {
          const res: Response = await fetch(url, { headers: h });
          const data: any = await res.json();
          if (data.error) { r.error = data.error.message; break; }
          const ads = data.data || [];
          const rows = ads
            .filter((ad: any) => ad.creative?.id)
            .map((ad: any) => {
              const cr = ad.creative;
              const img = normalizeCreativeImageUrl(cr.image_url) || normalizeCreativeImageUrl(cr.thumbnail_url) || cr.thumbnail_url || null;
              activeAdIds.push(ad.id);
              return {
                id: cr.id,
                ad_account_id: db_account_id,
                campaign_id: ad.campaign_id || null,
                ad_id: ad.id,
                ad_name: ad.name || cr.name,
                creative_type: cr.object_story_spec ? Object.keys(cr.object_story_spec)[0] : null,
                thumbnail_url: img,
                body: cr.body,
                title: cr.title,
                effective_status: ad.effective_status || "ACTIVE",
                fetched_at: new Date().toISOString(),
              };
            });
          if (rows.length) {
            const { error } = await supabase.from("meta_creatives").upsert(rows, { onConflict: "id" });
            if (!error) synced += rows.length;
            else console.log("creatives upsert error:", error.message);
          }
          url = data.paging?.next || null;
        }
        r.creatives = { synced };

        // Métricas por anúncio (depois dos thumbnails). Se estourar aqui, os thumbs já estão salvos.
        const timeRange = JSON.stringify({ since: date_from, until: date_to });
        const byAd: Record<string, any> = {};
        let adInsUrl: string | null = `${META_API}/${ad_account_id}/insights?fields=ad_id,spend,impressions,clicks,ctr,actions&time_range=${encodeURIComponent(timeRange)}&level=ad&limit=500`;
        while (adInsUrl) {
          const res: Response = await fetch(adInsUrl, { headers: h });
          const data: any = await res.json();
          if (data.error) break;
          for (const ai of data.data || []) byAd[ai.ad_id] = ai;
          adInsUrl = data.paging?.next || null;
        }
        let metricsUpdated = 0;
        for (const ai of Object.values(byAd) as any[]) {
          const leadAction = ai.actions?.find((a: any) =>
            a.action_type === "lead" || a.action_type === "offsite_conversion.fb_pixel_lead" || a.action_type === "onsite_conversion.lead_grouped");
          const purchaseAction = ai.actions?.find((a: any) => a.action_type === "purchase");
          const convCount = leadAction ? Number(leadAction.value) : (purchaseAction ? Number(purchaseAction.value) : 0);
          const { error } = await supabase.from("meta_creatives").update({
            spend: Number(ai.spend || 0),
            impressions: Number(ai.impressions || 0),
            clicks: Number(ai.clicks || 0),
            ctr: Number(ai.ctr || 0),
            conversions: convCount,
          }).eq("ad_id", ai.ad_id);
          if (!error) metricsUpdated++;
        }
        r.metrics = { updated: metricsUpdated };
      } catch (e) {
        r.error = getErrorMessage(e);
      }
      return r;
    }));

    return new Response(JSON.stringify({ success: true, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: getErrorMessage(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
