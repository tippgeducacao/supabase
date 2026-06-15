import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { turma_id } = await req.json();
    if (!turma_id) {
      return new Response(JSON.stringify({ error: "turma_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // STUB: real implementation will fetch ped_aula_turmas + ped_aulas, render PDF and upload to storage.
    return new Response(
      JSON.stringify({
        ok: true,
        stub: true,
        turma_id,
        message: "PDF generation not yet implemented. This is a stub.",
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const err = e as Error;
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
