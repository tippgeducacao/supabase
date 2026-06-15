// Edge Function: email-webhook
// Recebe callbacks do Resend (delivered, opened, clicked, bounced, complained, etc.)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, svix-id, svix-timestamp, svix-signature",
};

const TIPO_PARA_STATUS: Record<string, string> = {
  "email.sent": "enviado",
  "email.delivered": "entregue",
  "email.opened": "aberto",
  "email.clicked": "clicado",
  "email.bounced": "bounce",
  "email.complained": "spam",
  "email.delivery_delayed": "enviado",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json();
    const tipo: string = body.type ?? "";
    const emailId: string | undefined = body.data?.email_id ?? body.data?.id;

    if (!emailId) {
      return new Response(JSON.stringify({ ok: true, ignored: "sem email_id" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const novoStatus = TIPO_PARA_STATUS[tipo];
    const update: Record<string, unknown> = {};
    if (novoStatus) update.status = novoStatus;

    if (tipo === "email.delivered") update.entregue_em = new Date().toISOString();
    if (tipo === "email.opened") {
      update.aberto_em = new Date().toISOString();
      // Increment via RPC seria ideal, mas faremos read-modify-write simples
      const { data: cur } = await supabase
        .from("emails_enviados").select("aberto_count").eq("resend_email_id", emailId).maybeSingle();
      update.aberto_count = (cur?.aberto_count ?? 0) + 1;
    }
    if (tipo === "email.clicked") {
      const { data: cur } = await supabase
        .from("emails_enviados").select("clicado_count").eq("resend_email_id", emailId).maybeSingle();
      update.clicado_count = (cur?.clicado_count ?? 0) + 1;
    }

    if (Object.keys(update).length > 0) {
      await supabase.from("emails_enviados").update(update).eq("resend_email_id", emailId);
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "erro";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
