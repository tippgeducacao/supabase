import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SOURCE_URL = "https://iogotqysdouakzthmdqt.supabase.co";
const SOURCE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlvZ290cXlzZG91YWt6dGhtZHF0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTIxNTMyOTQsImV4cCI6MjA2NzcyOTI5NH0.r3BB9EsNz3B1EL4CJsftnuZftdlWswKNl8ULmTJvi_g";

async function fetchAllPaginated(client: any, table: string, filters?: (q: any) => any) {
  const PAGE = 1000;
  const all: any[] = [];
  let from = 0;
  while (true) {
    let q = client.from(table).select("*").range(from, from + PAGE - 1);
    if (filters) q = filters(q);
    const { data, error } = await q;
    if (error) throw new Error(`Fetch ${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...data);
    from += PAGE;
    if (data.length < PAGE) break;
  }
  return all;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const step = body.step || "all";

    const destUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const dest = createClient(destUrl, serviceRoleKey);
    const source = createClient(SOURCE_URL, SOURCE_ANON_KEY);

    if (step === "fetch_source") {
      // Just fetch and return counts + total from source
      const sourceLanc = await fetchAllPaginated(source, "fin_lancamentos", (q: any) =>
        q.eq("tipo", "despesa")
      );
      const total = sourceLanc.reduce((s: number, l: any) => s + (l.valor || 0), 0);
      return new Response(JSON.stringify({ count: sourceLanc.length, totalValor: total }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (step === "cleanup") {
      // Delete rateios then despesa lancamentos
      await dest.from("fin_lancamento_rateios").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      await dest.from("fin_lancamentos").delete().eq("tipo", "despesa");
      return new Response(JSON.stringify({ done: "cleanup" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (step === "import_lancamentos") {
      const offset = body.offset || 0;
      const limit = body.limit || 500;

      // Fetch a page of source lancamentos
      const { data: sourceBatch, error: fetchErr } = await source
        .from("fin_lancamentos")
        .select("*")
        .eq("tipo", "despesa")
        .order("id", { ascending: true })
        .range(offset, offset + limit - 1);

      if (fetchErr) throw new Error(fetchErr.message);
      if (!sourceBatch || sourceBatch.length === 0) {
        return new Response(JSON.stringify({ inserted: 0, done: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Insert preserving original IDs
      const rows = sourceBatch.map((l: any) => {
        const { created_at, updated_at, ...rest } = l;
        return rest;
      });

      const { data, error } = await dest.from("fin_lancamentos").insert(rows).select("id");
      if (error) throw new Error(error.message);

      return new Response(JSON.stringify({
        inserted: data?.length || 0,
        offset,
        fetched: sourceBatch.length,
        done: sourceBatch.length < limit,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (step === "import_rateios") {
      const offset = body.offset || 0;
      const limit = body.limit || 500;

      const { data: sourceBatch, error: fetchErr } = await source
        .from("fin_lancamento_rateios")
        .select("*")
        .order("created_at", { ascending: true })
        .range(offset, offset + limit - 1);

      if (fetchErr) throw new Error(fetchErr.message);
      if (!sourceBatch || sourceBatch.length === 0) {
        return new Response(JSON.stringify({ inserted: 0, done: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const rows = sourceBatch.map((r: any) => {
        const { id, created_at, ...rest } = r;
        return rest;
      });

      const { error } = await dest.from("fin_lancamento_rateios").insert(rows);
      if (error) throw new Error(error.message);

      return new Response(JSON.stringify({
        inserted: rows.length,
        offset,
        fetched: sourceBatch.length,
        done: sourceBatch.length < limit,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (step === "verify") {
      const destLanc = await fetchAllPaginated(dest, "fin_lancamentos", (q: any) => q.eq("tipo", "despesa"));
      const destTotal = destLanc.reduce((s: number, l: any) => s + (l.valor || 0), 0);
      return new Response(JSON.stringify({ count: destLanc.length, totalValor: destTotal }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown step" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
