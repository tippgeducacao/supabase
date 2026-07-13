import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// Catálogo COMPLETO de anúncios (tabela meta_ads) — TODOS os status, não só ativos.
// Alimenta o dashboard "Melhores Criativos": o lead traz utm_content = {{ad.name}} e
// utm_term = {{adset.name}}; aqui a gente traz da conta de anúncios o status
// ativo/pausado/arquivado + o adset de cada anúncio pra cruzar com vendas.
// LEVE de propósito (sem creative/thumbnail — isso é do sync-meta-creatives): só
// campos de metadata, 200 por página, seguindo paging.next SEMPRE (lição do
// sync-meta-ads que ficava 10 dias atrasado sem paginação). Orçamento de tempo
// pra nunca morrer por wall-clock — se estourar, continua na próxima rodada.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const getErrorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const META_API = "https://graph.facebook.com/v19.0";
const BUDGET_MS = Number(Deno.env.get("SYNC_META_ADS_CATALOG_BUDGET_MS") || 100_000);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const startedAt = Date.now();
  try {
    const body = await req.json().catch(() => ({}));
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

    const results: Record<string, unknown>[] = [];
    for (const account of accounts) {
      const { access_token, ad_account_id: rawId } = account;
      const ad_account_id = rawId.startsWith("act_") ? rawId : `act_${rawId}`;
      const db_account_id = rawId;
      const h = { Authorization: `Bearer ${access_token}` };
      const r: Record<string, unknown> = { ad_account_id: db_account_id, account_name: account.account_name, synced: 0 };

      try {
        let url: string | null =
          `${META_API}/${ad_account_id}/ads?fields=id,name,adset{id,name},campaign_id,effective_status,created_time,updated_time&limit=200`;
        while (url) {
          if (Date.now() - startedAt > BUDGET_MS) { r.truncated = true; break; }
          const res: Response = await fetch(url, { headers: h });
          const data: any = await res.json();
          if (data.error) { r.error = data.error.message; break; }
          const rows = (data.data || []).map((ad: any) => ({
            id: ad.id,
            ad_account_id: db_account_id,
            campaign_id: ad.campaign_id || null,
            adset_id: ad.adset?.id || null,
            adset_name: ad.adset?.name || null,
            name: ad.name || null,
            effective_status: ad.effective_status || null,
            created_time: ad.created_time || null,
            updated_time: ad.updated_time || null,
            fetched_at: new Date().toISOString(),
          }));
          if (rows.length) {
            const { error } = await supabase.from("meta_ads").upsert(rows, { onConflict: "id" });
            if (error) console.log("meta_ads upsert error:", error.message);
            else r.synced = (r.synced as number) + rows.length;
          }
          url = data.paging?.next || null;
        }
      } catch (e) {
        r.error = getErrorMessage(e);
      }
      results.push(r);
    }

    return new Response(JSON.stringify({ success: true, elapsed_ms: Date.now() - startedAt, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: getErrorMessage(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
