import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const {
      form_entry_id, status, data_assinatura_contrato, data_aprovacao,
      pontuacao_esperada, pontuacao_validada, enviado_em, turma, abertura,
      observacoes, aluno, curso, vendedor, sdr,
    } = body;

    if (!form_entry_id) {
      return new Response(
        JSON.stringify({ error: "form_entry_id is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    let aluno_id: string | null = null;

    // Upsert aluno if present
    if (aluno && aluno.id) {
      const { error: alunoError } = await supabase.from("alunos").upsert(
        {
          id: aluno.id,
          nome: aluno.nome,
          email: aluno.email ?? null,
          telefone: aluno.telefone ?? null,
          crmv: aluno.crmv ?? null,
          data_matricula: aluno.data_matricula ?? null,
        },
        { onConflict: "id" }
      );

      if (alunoError) {
        console.error("Aluno upsert error:", alunoError);
        return new Response(
          JSON.stringify({ error: "Failed to upsert aluno" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      aluno_id = aluno.id;
    }

    // Upsert matricula
    const { error: matError } = await supabase.from("matriculas").upsert(
      {
        form_entry_id,
        aluno_id,
        status: status ?? null,
        data_assinatura_contrato: data_assinatura_contrato ?? null,
        data_aprovacao: data_aprovacao ?? null,
        pontuacao_esperada: pontuacao_esperada ?? null,
        pontuacao_validada: pontuacao_validada ?? null,
        enviado_em: enviado_em ?? null,
        turma: turma ?? null,
        abertura: abertura ?? null,
        observacoes: observacoes ?? null,
        curso_id: curso?.id ?? null,
        curso_nome: curso?.nome ?? null,
        curso_modalidade: curso?.modalidade ?? null,
        vendedor_id: vendedor?.id ?? null,
        vendedor_nome: vendedor?.nome ?? null,
        sdr_id: sdr?.id ?? null,
        sdr_nome: sdr?.nome ?? null,
      },
      { onConflict: "form_entry_id" }
    );

    if (matError) {
      console.error("Matricula upsert error:", matError);
      return new Response(
        JSON.stringify({ error: "Failed to upsert matricula" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Webhook error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
