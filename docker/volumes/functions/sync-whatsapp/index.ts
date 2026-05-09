import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const META_API = "https://graph.facebook.com/v21.0";

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
    const tsFrom = Math.floor(new Date(date_from).getTime() / 1000);
    const tsTo = Math.floor(new Date(date_to).getTime() / 1000);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: accounts, error: accErr } = await supabase
      .from("wa_accounts")
      .select("*")
      .eq("is_active", true);

    if (accErr) throw accErr;
    if (!accounts?.length) {
      return new Response(JSON.stringify({ message: "No active WhatsApp accounts" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results = await Promise.all(
      accounts.map(async (account) => {
        const { access_token, waba_id } = account;
        const h = { Authorization: `Bearer ${access_token}` };
        const accountResult: Record<string, unknown> = { waba_id, account_name: account.account_name };

        try {
          // 1. Templates
          const tplRes = await fetch(
            `${META_API}/${waba_id}/message_templates?fields=id,name,language,category,status,components&limit=200`,
            { headers: h }
          );
          const tplData = await tplRes.json();

          if (tplData.error) {
            const msg = tplData.error.message || "Unknown error";
            console.error(`[${account.account_name}] Templates error:`, msg);
            accountResult.error = msg;
            // Common: token expired (code 190) → mark for user to refresh
            if (tplData.error.code === 190) {
              accountResult.token_expired = true;
            }
            return accountResult;
          }

          const templateList: Array<{ id: string; name: string }> = [];
          if (tplData.data) {
            const templates = tplData.data.map((t: any) => {
              const bodyComp = t.components?.find((c: any) => c.type === "BODY");
              const headerComp = t.components?.find((c: any) => c.type === "HEADER");
              const footerComp = t.components?.find((c: any) => c.type === "FOOTER");
              const buttons = t.components?.filter((c: any) => c.type === "BUTTONS");
              templateList.push({ id: t.id, name: t.name });
              return {
                ad_account_id: waba_id,
                waba_id,
                template_name: t.name,
                template_id: t.id,
                language: t.language,
                category: t.category,
                status: t.status,
                body_text: bodyComp?.text || null,
                header_text: headerComp?.text || headerComp?.format || null,
                footer_text: footerComp?.text || null,
                buttons: buttons?.length ? buttons : null,
              };
            });
            const { error } = await supabase
              .from("wa_templates")
              .upsert(templates, { onConflict: "waba_id,template_name,language" });
            accountResult.templates = error ? { error: error.message } : { synced: templates.length };
          }

          // 2. Per-template Analytics via /template_analytics (returns SENT, DELIVERED, READ per template/day)
          // This is the ONLY endpoint that returns READ counts.
          // Build a map: template_id → name for quick lookup
          const idToName = new Map<string, string>();
          templateList.forEach((t) => idToName.set(t.id, t.name));

          // Aggregate per (template_name, date)
          const perTplAgg: Record<string, { sent: number; delivered: number; read: number; date: string; template_name: string }> = {};
          // Aggregate WABA-level per date (sum of all templates)
          const wabaDailyAgg: Record<string, { sent: number; delivered: number; read: number }> = {};

          if (templateList.length > 0) {
            const batchSize = 10; // Meta limit
            let templateAnalyticsErrors = 0;
            for (let i = 0; i < templateList.length; i += batchSize) {
              const batch = templateList.slice(i, i + batchSize);
              const idsParam = encodeURIComponent(`[${batch.map((t) => t.id).join(",")}]`);
              const metricsParam = encodeURIComponent(`["SENT","DELIVERED","READ"]`);
              const taUrl = `${META_API}/${waba_id}/template_analytics?start=${tsFrom}&end=${tsTo}&granularity=DAILY&metric_types=${metricsParam}&template_ids=${idsParam}`;
              try {
                const taRes = await fetch(taUrl, { headers: h });
                const taData = await taRes.json();
                if (taData?.error) {
                  templateAnalyticsErrors++;
                  console.warn(`[template_analytics batch ${i}] error:`, taData.error?.message);
                  continue;
                }
                const dataPoints = taData?.data?.[0]?.data_points || [];
                for (const dp of dataPoints) {
                  const tplName = idToName.get(String(dp.template_id));
                  if (!tplName) continue;
                  const startVal = dp.start;
                  const dateStr = startVal
                    ? new Date(typeof startVal === "number" ? startVal * 1000 : startVal).toISOString().split("T")[0]
                    : null;
                  if (!dateStr) continue;
                  const sent = Number(dp.sent || 0);
                  const delivered = Number(dp.delivered || 0);
                  const read = Number(dp.read || 0);

                  const key = `${tplName}__${dateStr}`;
                  if (!perTplAgg[key]) perTplAgg[key] = { sent: 0, delivered: 0, read: 0, date: dateStr, template_name: tplName };
                  perTplAgg[key].sent += sent;
                  perTplAgg[key].delivered += delivered;
                  perTplAgg[key].read += read;

                  if (!wabaDailyAgg[dateStr]) wabaDailyAgg[dateStr] = { sent: 0, delivered: 0, read: 0 };
                  wabaDailyAgg[dateStr].sent += sent;
                  wabaDailyAgg[dateStr].delivered += delivered;
                  wabaDailyAgg[dateStr].read += read;
                }
              } catch (err) {
                templateAnalyticsErrors++;
                console.error(`[template_analytics batch ${i}] failed:`, (err as Error).message);
              }
            }
            console.log(`[${account.account_name}] template_analytics: ${Object.keys(perTplAgg).length} rows, ${templateAnalyticsErrors} batch errors`);
          }

          // Build allAnalytics rows
          const allAnalytics: any[] = [];
          // WABA-level aggregate rows (template_name = null)
          for (const [dateStr, agg] of Object.entries(wabaDailyAgg)) {
            allAnalytics.push({
              waba_id,
              template_name: null,
              date: dateStr,
              sent: agg.sent,
              delivered: agg.delivered,
              read: agg.read,
              delivery_rate: agg.sent > 0 ? (agg.delivered / agg.sent) * 100 : 0,
              read_rate: agg.delivered > 0 ? (agg.read / agg.delivered) * 100 : 0,
              category: null,
              fetched_at: new Date().toISOString(),
            });
          }
          // Per-template rows
          for (const v of Object.values(perTplAgg)) {
            allAnalytics.push({
              waba_id,
              template_name: v.template_name,
              date: v.date,
              sent: v.sent,
              delivered: v.delivered,
              read: v.read,
              delivery_rate: v.sent > 0 ? (v.delivered / v.sent) * 100 : 0,
              read_rate: v.delivered > 0 ? (v.read / v.delivered) * 100 : 0,
              category: null,
              fetched_at: new Date().toISOString(),
            });
          }

          if (allAnalytics.length > 0) {
            // Batch upsert in chunks to avoid payload limits
            const upsertBatch = 500;
            let totalSynced = 0;
            for (let i = 0; i < allAnalytics.length; i += upsertBatch) {
              const chunk = allAnalytics.slice(i, i + upsertBatch);
              const { error } = await supabase
                .from("wa_analytics")
                .upsert(chunk, { onConflict: "waba_id,template_name,date" });
              if (error) {
                accountResult.analytics = { error: error.message, partial: totalSynced };
                break;
              }
              totalSynced += chunk.length;
            }
            if (!accountResult.analytics) accountResult.analytics = { synced: totalSynced };
          } else {
            accountResult.analytics = { status: "no_data" };
          }

          // 3. Conversations (cost data)
          let convSuccess = false;
          const convUrl = `${META_API}/${waba_id}?fields=conversation_analytics.start(${tsFrom}).end(${tsTo}).granularity(DAILY).dimensions(["CONVERSATION_TYPE"])`;
          const convRes = await fetch(convUrl, { headers: h });
          const convData = await convRes.json();

          if (!convData.error && convData.conversation_analytics?.data) {
            const conversations: any[] = [];
            for (const dp of convData.conversation_analytics.data) {
              if (dp.data_points) {
                for (const point of dp.data_points) {
                  conversations.push({
                    waba_id,
                    date: point.start ? new Date(typeof point.start === "number" ? point.start * 1000 : point.start).toISOString().split("T")[0] : date_from,
                    conversation_category: dp.dimension_key || null,
                    conversation_count: Number(point.conversation || 0),
                    cost: Number(point.cost || 0),
                    currency: point.currency || "BRL",
                    fetched_at: new Date().toISOString(),
                  });
                }
              }
            }
            if (conversations.length) {
              const { error } = await supabase
                .from("wa_conversations")
                .upsert(conversations, { onConflict: "waba_id,date,conversation_category" });
              accountResult.conversations = error ? { error: error.message } : { synced: conversations.length };
              convSuccess = true;
            }
          }

          if (!convSuccess) {
            accountResult.conversations = { status: "no_data", error: convData?.error?.message || null };
          }
        } catch (e) {
          accountResult.error = (e as Error).message;
        }

        return accountResult;
      })
    );

    // Surface expired tokens
    const expiredAccounts = results.filter((r: any) => r.token_expired).map((r: any) => r.account_name);

    return new Response(
      JSON.stringify({
        success: true,
        results,
        warnings: expiredAccounts.length > 0
          ? [`Tokens expirados (renovar no Meta Business): ${expiredAccounts.join(", ")}`]
          : undefined,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
