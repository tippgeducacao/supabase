// Avisos dos testes A/B no sino (aba Principal) · 19/11/2026, pedido do usuário.
//
// O cron das 8h (Brasília) chama esta edge. Ela busca os números como a aba Testes A/B (GA4 pela
// mesma consulta da `mkt-ga4-relatorio`, CRM pela RPC `mkt_analytics_crm`), monta o detalhe com a
// MESMA conta da tela (`_shared/testeAbDetalhe.ts`) e manda para `mkt_testes_ab_avisar`, que grava
// só o que ainda não avisou e entrega a quem está em `mkt_testes_ab_aviso_destinatarios`.
// Corpo opcional `{ "resumo": true }`: manda o resumo fora da segunda (aviso de exemplo, conferência).
// Ver docs/Marketing — Analytics.md → "Avisos no sino".

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { exigirAcesso, respostaAcessoNegado } from "../_shared/acesso.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { tokenDaContaDeServico } from "../_shared/googleContaServico.ts";
import type { RespostaCrm, RespostaGa4 } from "../_shared/mktAnalytics.ts";
import { montarDetalhe, type TesteAb } from "../_shared/testeAbDetalhe.ts";
import { consultarGa4, ESCOPO_GA4, validarPedido } from "../mkt-ga4-relatorio/ga4.ts";
import { avisosDoDia } from "./aviso.ts";

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

/** Hoje e o dia da semana no fuso de Brasília (a tela usa a data local de quem abre). */
function hojeEmSp(): { hoje: string; segunda: boolean } {
  const agora = new Date();
  const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(agora);
  const dia = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", weekday: "short" }).format(agora);
  return { hoje, segunda: dia === "Mon" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ erro: "Método não permitido" }, 405);

  try {
    await exigirAcesso(req, { servico: true });
  } catch (e) {
    return respostaAcessoNegado(e, corsHeaders);
  }

  const corpo = await req.json().catch(() => ({}));
  const { hoje, segunda } = hojeEmSp();
  const resumo = segunda || corpo?.resumo === true;

  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: testes, error: eTestes } = await supabase
      .from("mkt_testes_ab")
      .select("chave, nome, hipotese, situacao, versoes, paginas, inicio, fim, resultado, pesos, plano")
      .eq("situacao", "rodando");
    if (eTestes) throw eTestes;
    const lista = (testes ?? []) as TesteAb[];
    if (!lista.length) return json({ testes: 0, avisos: 0 });

    // Mesmo período da tela: do início do teste mais antigo até hoje.
    const inicio = lista.reduce((m, t) => (t.inicio < m ? t.inicio : m), hoje);
    const { data: saTexto, error: eSa } = await supabase.rpc("_get_google_datamanager_sa");
    if (eSa) throw eSa;
    if (typeof saTexto !== "string" || !saTexto) return json({ erro: "Sem a chave do Google no vault" }, 503);
    const token = await tokenDaContaDeServico(JSON.parse(saTexto), ESCOPO_GA4);
    const ga4 = (await consultarGa4(token, validarPedido({ inicio, fim: hoje, site: null, detalhe: true }))) as unknown as RespostaGa4;
    const { data: crm, error: eCrm } = await supabase.rpc("mkt_analytics_crm", { p_inicio: inicio, p_fim: hoje, p_site: null });
    if (eCrm) throw eCrm;

    const detalhes = new Map(lista.map((t) => [t.chave, montarDetalhe(t, ga4, crm as RespostaCrm, hoje)]));
    const avisos = avisosDoDia(lista, detalhes, resumo, hoje);
    const { data: gravados, error: eAviso } = await supabase.rpc("mkt_testes_ab_avisar", { p_avisos: avisos });
    if (eAviso) throw eAviso;
    return json({ testes: lista.length, avisos: avisos.length, novos: gravados });
  } catch (e) {
    // O detalhe fica só no log: erro de JSON.parse da chave pode trazer um pedaço dela.
    console.error("mkt-testes-ab-aviso:", (e as Error).message);
    return json({ erro: "Não deu para conferir os testes agora." }, 502);
  }
});
