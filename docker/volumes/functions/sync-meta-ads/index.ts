import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const getErrorMessage = (err: unknown) => err instanceof Error ? err.message : String(err);

const META_API = "https://graph.facebook.com/v19.0";

function extractMetaSourceUrl(url?: string | null) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const embedded = parsed.searchParams.get("url");
    if (embedded && /facebook\.com\/ads\/image\//.test(decodeURIComponent(embedded))) {
      return decodeURIComponent(embedded);
    }
    if (/facebook\.com\/ads\/image\//.test(url)) {
      return url;
    }
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
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { date_from, date_to } = await req.json();
    if (!date_from || !date_to) {
      return new Response(JSON.stringify({ error: "Missing required fields: date_from, date_to" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: accounts, error: accErr } = await supabase
      .from("meta_accounts")
      .select("*")
      .eq("is_active", true);

    if (accErr) throw accErr;
    if (!accounts?.length) {
      return new Response(JSON.stringify({ message: "No active accounts" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results = await Promise.all(
      accounts.map(async (account) => {
        const { access_token, ad_account_id: rawId } = account;
        // Meta Graph API requires the act_ prefix on ad account IDs
        const ad_account_id = rawId.startsWith("act_") ? rawId : `act_${rawId}`;
        const db_account_id = rawId; // Keep original ID for database storage
        const h = { Authorization: `Bearer ${access_token}` };
        const accountResult: Record<string, unknown> = { ad_account_id: db_account_id, account_name: account.account_name };

        try {
          // 1. Campaigns
          const campRes = await fetch(
            `${META_API}/${ad_account_id}/campaigns?fields=id,name,status,objective,daily_budget,lifetime_budget,created_time,updated_time&limit=100`,
            { headers: h }
          );
          const campData = await campRes.json();
          console.log("Campaigns response keys:", Object.keys(campData), "count:", campData.data?.length || 0);
          if (campData.error) console.log("Campaigns error:", JSON.stringify(campData.error));
          if (campData.data) {
            const campaigns = campData.data.map((c: any) => ({
              id: c.id,
              ad_account_id: db_account_id,
              name: c.name,
              status: c.status,
              objective: c.objective,
              daily_budget: c.daily_budget ? Number(c.daily_budget) / 100 : null,
              lifetime_budget: c.lifetime_budget ? Number(c.lifetime_budget) / 100 : null,
              created_time: c.created_time,
              updated_time: c.updated_time,
              fetched_at: new Date().toISOString(),
            }));
            const { error } = await supabase
              .from("meta_campaigns")
              .upsert(campaigns, { onConflict: "id" });
            accountResult.campaigns = error ? { error: error.message } : { synced: campaigns.length };
          }

          // 2. Campaign Insights
          const timeRange = JSON.stringify({ since: date_from, until: date_to });
          const insRes = await fetch(
            `${META_API}/${ad_account_id}/insights?fields=campaign_id,spend,impressions,clicks,ctr,cpc,cpm,reach,frequency,actions,action_values&time_range=${encodeURIComponent(timeRange)}&time_increment=1&level=campaign&limit=500`,
            { headers: h }
          );
          const insData = await insRes.json();
          if (insData.error) console.log("Insights error:", JSON.stringify(insData.error));
          console.log("Insights count:", insData.data?.length || 0, "URL time_range:", timeRange);
          if (insData.data && insData.data.length > 0) {
            // Log all unique action types for debugging
            const allActionTypes = new Set<string>();
            insData.data.forEach((i: any) => {
              i.actions?.forEach((a: any) => allActionTypes.add(a.action_type));
            });
            console.log("All action types found:", JSON.stringify([...allActionTypes]));
            
            const insights = insData.data.map((i: any) => {
              // Find any lead-related action
              const leadAction = i.actions?.find((a: any) => 
                a.action_type.includes("lead") || a.action_type.includes("complete_registration") || a.action_type.includes("submit_application")
              );
              const purchaseAction = i.actions?.find((a: any) => a.action_type === "purchase");
              const purchaseValue = i.action_values?.find((a: any) => a.action_type === "purchase");
              const conversions = leadAction ? Number(leadAction.value) : (purchaseAction ? Number(purchaseAction.value) : 0);
              const convValue = purchaseValue ? Number(purchaseValue.value) : 0;
              const spend = Number(i.spend || 0);
              return {
                ad_account_id: db_account_id,
                campaign_id: i.campaign_id,
                date_start: i.date_start,
                date_stop: i.date_stop,
                spend,
                impressions: Number(i.impressions || 0),
                clicks: Number(i.clicks || 0),
                ctr: Number(i.ctr || 0),
                cpc: Number(i.cpc || 0),
                cpm: Number(i.cpm || 0),
                reach: Number(i.reach || 0),
                frequency: Number(i.frequency || 0),
                conversions,
                conversion_value: convValue,
                roas: spend > 0 ? convValue / spend : 0,
                fetched_at: new Date().toISOString(),
              };
            });
            const { error } = await supabase
              .from("meta_insights")
              .upsert(insights, { onConflict: "campaign_id,date_start" });
            accountResult.insights = error ? { error: error.message } : { synced: insights.length };
          }

          // 3. Fetch creatives directly for high-res images (with pagination)
          const allCreatives: any[] = [];
          let creativesUrl: string | null = `${META_API}/${ad_account_id}/adcreatives?fields=id,name,body,title,object_story_spec,thumbnail_url,image_url,image_hash&limit=200`;
          while (creativesUrl) {
            const currentCreativesUrl = creativesUrl;
            const creativesRes: Response = await fetch(currentCreativesUrl, { headers: h });
            const creativesData: any = await creativesRes.json();
            if (creativesData.data) allCreatives.push(...creativesData.data);
            creativesUrl = creativesData.paging?.next || null;
          }
          console.log("Total creatives fetched:", allCreatives.length);
          
          // Also fetch ads to get ad_id → creative_id mapping and campaign_id (with pagination)
          const allAds: any[] = [];
          let adsUrl: string | null = `${META_API}/${ad_account_id}/ads?fields=id,name,campaign_id,creative{id}&limit=500`;
          while (adsUrl) {
            const currentAdsUrl = adsUrl;
            const adsRes: Response = await fetch(currentAdsUrl, { headers: h });
            const adsData: any = await adsRes.json();
            if (adsData.data) allAds.push(...adsData.data);
            adsUrl = adsData.paging?.next || null;
          }
          console.log("Total ads fetched for mapping:", allAds.length);
          
          // Build creative_id → ad mapping
          const adMap: Record<string, { ad_id: string; ad_name: string; campaign_id: string }> = {};
          allAds.forEach((ad: any) => {
            if (ad.creative?.id) {
              adMap[ad.creative.id] = { ad_id: ad.id, ad_name: ad.name, campaign_id: ad.campaign_id };
            }
          });

          if (allCreatives.length > 0) {
            console.log("Sample creative image_url:", normalizeCreativeImageUrl(allCreatives[0]?.image_url) || "none");
            console.log("Sample creative thumbnail_url:", normalizeCreativeImageUrl(allCreatives[0]?.thumbnail_url)?.substring(0, 120) || "none");
            
            // For creatives without image_url, try fetching high-res via image_hash
            const creativesWithImages = await Promise.all(allCreatives.map(async (cr: any) => {
              let bestImage = normalizeCreativeImageUrl(cr.image_url) || null;
              const normalizedThumb = normalizeCreativeImageUrl(cr.thumbnail_url);
              
              // If no image_url but has image_hash, fetch full-res from ad account images
              if (!bestImage && cr.image_hash) {
                try {
                  const imgRes = await fetch(
                    `${META_API}/${ad_account_id}/adimages?hashes=["${cr.image_hash}"]&fields=url_128,url`,
                    { headers: h }
                  );
                  const imgData = await imgRes.json();
                  const imgObj = imgData.data?.images?.[cr.image_hash] || Object.values(imgData.data?.images || {})[0] as any;
                  if (imgObj) {
                    bestImage = normalizeCreativeImageUrl(imgObj.url) || normalizeCreativeImageUrl(imgObj.url_128) || null;
                  }
                } catch (e) {
                  console.log("Failed to fetch image for hash:", cr.image_hash, getErrorMessage(e));
                }
              }
              
              // Fallback to decoded source thumbnail or upgraded sized thumbnail
              if (!bestImage && normalizedThumb) {
                bestImage = normalizedThumb;
              }
              
              const adInfo = adMap[cr.id] || {};
              return {
                id: cr.id,
                ad_account_id: db_account_id,
                campaign_id: adInfo.campaign_id || null,
                ad_id: adInfo.ad_id || null,
                ad_name: adInfo.ad_name || cr.name,
                creative_type: cr.object_story_spec ? Object.keys(cr.object_story_spec)[0] : null,
                thumbnail_url: bestImage || normalizedThumb || cr.thumbnail_url,
                body: cr.body,
                title: cr.title,
                fetched_at: new Date().toISOString(),
              };
            }));
            
            const { error } = await supabase
              .from("meta_creatives")
              .upsert(creativesWithImages, { onConflict: "id" });
            accountResult.creatives = error ? { error: error.message } : { synced: creativesWithImages.length };
          }

          // 4. Ad-level insights for creatives (with pagination)
          const allAdInsights: any[] = [];
          let adInsUrl: string | null = `${META_API}/${ad_account_id}/insights?fields=ad_id,ad_name,spend,impressions,clicks,ctr,actions&time_range=${encodeURIComponent(timeRange)}&level=ad&limit=500`;
          while (adInsUrl) {
            const currentAdInsUrl = adInsUrl;
            const adInsRes: Response = await fetch(currentAdInsUrl, { headers: h });
            const adInsData: any = await adInsRes.json();
            if (adInsData.data) allAdInsights.push(...adInsData.data);
            adInsUrl = adInsData.paging?.next || null;
          }
          console.log("Total ad-level insights fetched:", allAdInsights.length);
          if (allAdInsights.length > 0) {
            for (const ai of allAdInsights) {
              const leadAction = ai.actions?.find((a: any) => 
                a.action_type === "lead" || a.action_type === "offsite_conversion.fb_pixel_lead" || a.action_type === "onsite_conversion.lead_grouped"
              );
              const purchaseAction = ai.actions?.find((a: any) => a.action_type === "purchase");
              const convCount = leadAction ? Number(leadAction.value) : (purchaseAction ? Number(purchaseAction.value) : 0);
              await supabase
                .from("meta_creatives")
                .update({
                  spend: Number(ai.spend || 0),
                  impressions: Number(ai.impressions || 0),
                  clicks: Number(ai.clicks || 0),
                  ctr: Number(ai.ctr || 0),
                  conversions: convCount,
                })
                .eq("ad_id", ai.ad_id);
            }
            accountResult.ad_insights = { synced: allAdInsights.length };
          }
        } catch (e) {
          accountResult.error = getErrorMessage(e);
        }

        return accountResult;
      })
    );

    return new Response(JSON.stringify({ success: true, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: getErrorMessage(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
