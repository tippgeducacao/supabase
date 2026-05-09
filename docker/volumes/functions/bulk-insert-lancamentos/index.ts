import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const { lancamentos } = await req.json();

    if (!Array.isArray(lancamentos) || lancamentos.length === 0) {
      return new Response(JSON.stringify({ error: "No data provided" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const BATCH_SIZE = 500;
    let inserted = 0;
    let errors: string[] = [];

    for (let i = 0; i < lancamentos.length; i += BATCH_SIZE) {
      const batch = lancamentos.slice(i, i + BATCH_SIZE);
      const { data, error } = await supabase
        .from("fin_lancamentos")
        .insert(batch)
        .select("id");

      if (error) {
        errors.push(`Batch ${Math.floor(i / BATCH_SIZE)}: ${error.message}`);
      } else {
        inserted += (data?.length || 0);
      }
    }

    return new Response(
      JSON.stringify({ inserted, errors, total: lancamentos.length }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
