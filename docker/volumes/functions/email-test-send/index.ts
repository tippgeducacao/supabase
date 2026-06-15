// Edge Function: email-test-send
// Renderiza um template com dados fictícios e envia para um destinatário arbitrário.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { template_id, destinatario_email, variaveis } = await req.json();
    if (!template_id || !destinatario_email) {
      return new Response(JSON.stringify({ error: "template_id e destinatario_email obrigatórios" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Variáveis fake default
    const varsFake = {
      nome_aluno: "João da Silva (TESTE)",
      curso: "Pós-Graduação em Clínica Médica de Pequenos Animais",
      modalidade: "EAD",
      instituicao_parceira: "PPGVET",
      nome_atendente: "Secretaria Acadêmica",
      link_portal: "https://portal.ppgeducacao.com.br",
      docs_faltantes: "<ul><li>Termo de Aceite de Orientação</li><li>Ficha de Cadastro do Orientador</li></ul>",
      observacoes: "Observações de teste.",
      ...(variaveis ?? {}),
    };

    // Chama email-send internamente
    const resp = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/email-send`, {
      method: "POST",
      headers: {
        Authorization: req.headers.get("Authorization") ?? `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        template_id,
        destinatario_email,
        destinatario_nome: "Destinatário de teste",
        variaveis: varsFake,
        contexto_tipo: "teste",
      }),
    });
    const data = await resp.json();
    return new Response(JSON.stringify(data), {
      status: resp.status, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "erro";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
