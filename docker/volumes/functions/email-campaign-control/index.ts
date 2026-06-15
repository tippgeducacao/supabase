// Edge Function: email-campaign-control
// Pausa, retoma, ou cancela uma campanha.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const auth = req.headers.get("Authorization");
    if (!auth) return new Response(JSON.stringify({ error: "auth required" }), { status: 401, headers: corsHeaders });
    const { data: { user } } = await supabase.auth.getUser(auth.replace("Bearer ", ""));
    if (!user) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: corsHeaders });

    const { action, campanha_id } = await req.json();
    if (!["pausar", "retomar", "cancelar"].includes(action) || !campanha_id) {
      return new Response(JSON.stringify({ error: "params" }), { status: 400, headers: corsHeaders });
    }

    const mapStatus: Record<string, string> = { pausar: "pausada", retomar: "enviando", cancelar: "cancelada" };
    const patch: any = { status: mapStatus[action] };
    if (action === "cancelar") patch.concluida_em = new Date().toISOString();

    const { error } = await supabase.from("email_campanhas").update(patch).eq("id", campanha_id);
    if (error) throw error;

    return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
