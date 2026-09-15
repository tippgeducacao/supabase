// O cron usa o envio comum, incluindo supressão e idempotência.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { processarCampanha } from "./handler.ts";
import { autenticarDispatcher } from "./autenticacao.ts";
import { respostaOpcoesCampanhas } from "../_shared/emailCampanhasCapacidades.ts";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return respostaOpcoesCampanhas(corsHeaders);
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Método não permitido." }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const chave = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const cliente = createClient(url, chave);
    if (!await autenticarDispatcher(req, cliente, chave)) return new Response(JSON.stringify({ error: "Não autorizado." }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    const { data: campanhas, error } = await cliente.from("email_campanhas").select("*")
      .in("status", ["agendada", "enviando"]).or(`agendada_para.is.null,agendada_para.lte.${new Date().toISOString()}`).order("agendada_para").limit(5);
    if (error) throw new Error("Não foi possível consultar as campanhas agendadas.");
    const resultados = [];
    for (const campanha of campanhas ?? []) {
      try {
        resultados.push({ id: campanha.id, ok: true, ...await processarCampanha(cliente, campanha, { url, chave }) });
      } catch (erro) {
        const mensagem = erro instanceof Error ? erro.message : "Falha ao processar campanha.";
        await cliente.from("email_campanhas").update({ ultimo_erro: mensagem }).eq("id", campanha.id);
        resultados.push({ id: campanha.id, ok: false, error: mensagem });
      }
    }
    // O diagnóstico detalhado fica no registro autenticado da campanha.
    return new Response(JSON.stringify({ ok: resultados.every(r => r.ok), processadas: resultados.length }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (erro) {
    return new Response(JSON.stringify({ error: "Falha ao processar campanhas." }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
