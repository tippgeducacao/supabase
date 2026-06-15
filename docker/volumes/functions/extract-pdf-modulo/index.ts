import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { filename } = await req.json().catch(() => ({}));
    // STUB: real implementation will OCR the PDF and extract aulas (nome + ementa).
    return new Response(
      JSON.stringify({
        ok: true,
        stub: true,
        filename,
        aulas: [],
        message: "PDF module extraction not yet implemented. This is a stub.",
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
