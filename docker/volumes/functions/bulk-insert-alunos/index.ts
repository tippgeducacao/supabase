import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js/cors";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      serviceKey
    );

    // Gate de autorização — roda com service_role, sem verify_jwt, e faz INSERT em massa
    // em fin_alunos, passando por cima da RLS. Não tem chamador no front; desde 26/11/2026
    // aceita SÓ a própria service_role (antes qualquer conta logada, ex. um vendedor,
    // inseria alunos à vontade). (Apagar a pasta não removeria a function da VPS — o deploy
    // usa docker cp, que não apaga; por isso o gate, que protege via git push.)
    const authToken = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const autorizado = !!authToken && authToken === serviceKey;
    if (!autorizado) {
      return new Response(
        JSON.stringify({ error: "não autorizado" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { alunos } = await req.json();

    if (!Array.isArray(alunos) || alunos.length === 0) {
      return new Response(
        JSON.stringify({ error: "No alunos provided" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const batchSize = 500;
    let inserted = 0;

    for (let i = 0; i < alunos.length; i += batchSize) {
      const batch = alunos.slice(i, i + batchSize);
      const { error } = await supabase.from("fin_alunos").insert(batch);
      if (error) {
        console.error(`Batch ${i / batchSize} error:`, error);
        return new Response(
          JSON.stringify({ error: error.message, batch: i / batchSize }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      inserted += batch.length;
    }

    return new Response(
      JSON.stringify({ success: true, inserted }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
