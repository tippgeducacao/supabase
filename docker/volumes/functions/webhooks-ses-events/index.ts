// Edge Function: webhooks-ses-events
// Ingestão dos eventos que o SES publica no SNS.
//
// Endpoint PÚBLICO (o SNS não manda JWT), então a autenticação é a ASSINATURA da
// mensagem, validada antes de qualquer uso do conteúdo. Como este endpoint alimenta a
// lista de supressão, sem isso qualquer um forjaria um `Bounce` e bloquearia a entrega
// para um endereço à escolha.
//
// Toda a lógica está em `handler.ts`, testável sem subir o Deno.serve; aqui fica só a
// injeção das dependências reais.
//
// Configuração: SES → Configuration Set → Event destination → SNS topic → HTTPS
//   https://api.ppgeducacao.site/functions/v1/webhooks-ses-events
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, tratarEventoSns } from "./handler.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    return await tratarEventoSns(req, {
      supabase,
      pularVerificacao: Deno.env.get("SNS_SKIP_VERIFY") === "true",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("webhooks-ses-events", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
