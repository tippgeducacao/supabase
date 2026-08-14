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

    const {
      template_id, destinatario_email, variaveis,
      // Conteúdo AVULSO (construtor visual): permite testar um e-mail que ainda não
      // foi salvo como template. Antes só existia o caminho por `template_id`, e testar
      // obrigava a montar → salvar → fechar → achar na lista → enviar.
      assunto, corpo_html, corpo_texto, remetente_id,
    } = await req.json();

    const temAvulso = Boolean(corpo_html);
    if (!destinatario_email || (!template_id && !temAvulso)) {
      return new Response(JSON.stringify({ error: "destinatario_email e (template_id ou corpo_html) obrigatórios" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    /**
     * `email-send` exige remetente. No caminho do template ele sai do próprio template;
     * no avulso, quem chama pode informar — e, se não informar, cai no primeiro
     * remetente ATIVO. Escolher um default é melhor que recusar o teste: o objetivo
     * aqui é ver o e-mail renderizado num cliente real, não exercitar o roteamento.
     */
    let remetenteAvulso: string | null = remetente_id ?? null;
    if (temAvulso && !remetenteAvulso) {
      const { data: rem } = await supabaseAdmin
        .from("email_remetentes")
        .select("id")
        .eq("ativo", true)
        .order("criado_em", { ascending: true })
        .limit(1)
        .maybeSingle();
      remetenteAvulso = rem?.id ?? null;
      if (!remetenteAvulso) {
        return new Response(JSON.stringify({ error: "Nenhum remetente ativo para enviar o teste. Cadastre um em Remetentes." }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
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
        // No avulso não vai `template_id`: o corpo já está pronto e o `email-send`
        // usaria o template para SOBRESCREVER o html recebido.
        ...(temAvulso
          ? { assunto, corpo_html, corpo_texto, remetente_id: remetenteAvulso }
          : { template_id }),
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
