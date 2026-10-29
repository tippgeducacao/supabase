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
//
// acesso: publico — webhook do AWS SNS; confere a assinatura (certificado sns.<região>.amazonaws.com) e o TopicArn da conta da PPG
//
// Tópico aceito (29/10/2026): o da conta AWS da PPG (110379261517, ver docs/E-mail e Caixas.md),
// o único em email_sns_assinaturas. Trocar/acrescentar tópico: SES_SNS_TOPIC_ARN no env das
// edges (lista separada por vírgula) — ela SUBSTITUI o padrão abaixo.
// A antiga chave SNS_SKIP_VERIFY (desligava a assinatura) saiu do código de produção.
const TOPICO_PADRAO = "arn:aws:sns:sa-east-1:110379261517:ppgvet-ses-eventos";
const TOPICOS_PERMITIDOS = (Deno.env.get("SES_SNS_TOPIC_ARN") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

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
      topicosPermitidos: TOPICOS_PERMITIDOS.length ? TOPICOS_PERMITIDOS : [TOPICO_PADRAO],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("webhooks-ses-events", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
