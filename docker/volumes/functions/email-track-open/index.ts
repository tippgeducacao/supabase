// Edge Function: email-track-open
// Pixel 1x1 - registra abertura de email de campanha.
// GET /email-track-open?envio_id=uuid
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const PIXEL = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), c => c.charCodeAt(0));

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const envioId = url.searchParams.get("envio_id");
    if (envioId) {
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data: envio } = await supabase
        .from("email_campanhas_envios")
        .select("id, campanha_id, aberto_em")
        .eq("id", envioId).maybeSingle();
      if (envio && !envio.aberto_em) {
        await supabase.from("email_campanhas_envios").update({
          status: "aberto", aberto_em: new Date().toISOString(),
        }).eq("id", envio.id);
        const { data: c } = await supabase.from("email_campanhas").select("abertos").eq("id", envio.campanha_id).single();
        await supabase.from("email_campanhas").update({ abertos: (c?.abertos ?? 0) + 1 }).eq("id", envio.campanha_id);
      }
    }
  } catch { /* swallow */ }
  return new Response(PIXEL, {
    headers: { "Content-Type": "image/gif", "Cache-Control": "no-cache, no-store, must-revalidate" },
  });
});
