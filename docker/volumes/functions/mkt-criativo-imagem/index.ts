import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { resolverImagemCriativo, bytesParaDataUrl } from "../_shared/metaCreativeImage.ts";

// Resolve a imagem GRANDE de um criativo do Meta Ads para o preview + download do
// dashboard "Melhores Criativos". Busca FRESCO na Graph API (a thumbnail guardada
// expira). Chamado via supabase.functions.invoke (com auth), devolve JSON com a
// imagem em data URL — assim o <img> e o download não esbarram em CORS/CSP/expiração.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const getErr = (e: unknown) => (e instanceof Error ? e.message : String(e));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const creativeId: string | null = body?.creative_id || null;
    if (!creativeId) {
      return new Response(JSON.stringify({ error: "creative_id é obrigatório" }), {
        status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const img = await resolverImagemCriativo(sb, creativeId);
    if (!img) {
      // 422 (não 502) para o front tratar como "imagem indisponível" sem alarde
      return new Response(JSON.stringify({ error: "Imagem indisponível para este criativo." }), {
        status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ image: bytesParaDataUrl(img), content_type: img.contentType }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: getErr(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
