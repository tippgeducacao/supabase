// GA4 → Analytics do Portal Marketing (Gestão › Analytics) · 18/11/2026.
//
// Só leitura: sessões, usuários e lead do formulário (generate_lead) no total, por dia, por UTM
// e por página de entrada, e quem viu cada versão dos testes A/B (experience_impression). O lado
// do CRM (lead confirmado, reunião, matrícula) vem da RPC mkt_analytics_crm, direto do front.
//
// Quem pode chamar: colaborador logado com mkt_analytics_pode() (Marketing ou diretoria), a
// mesma regra da RPC. Credencial: a chave da conta de serviço que já está no vault
// ('google_datamanager_sa', gsc-claude@claudecode-512217, leitora da propriedade GA4).
// Ver docs/Marketing — Analytics.md.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { exigirAcesso, respostaAcessoNegado } from "../_shared/acesso.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { tokenDaContaDeServico } from "../_shared/googleContaServico.ts";
import { consultarGa4, ESCOPO_GA4, validarPedido } from "./ga4.ts";
import { guardadoNoBanco } from "./guardado.ts";

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ erro: "Método não permitido" }, 405);

  try {
    await exigirAcesso(req, { usuario: true, rpcPermissao: "mkt_analytics_pode" });
  } catch (e) {
    return respostaAcessoNegado(e, corsHeaders);
  }

  let pedido;
  try {
    pedido = validarPedido(await req.json().catch(() => null));
  } catch (e) {
    return json({ erro: (e as Error).message }, 400);
  }

  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: saTexto, error } = await supabase.rpc("_get_google_datamanager_sa");
    if (error) throw error;
    if (typeof saTexto !== "string" || !saTexto) return json({ erro: "Sem a chave do Google no vault" }, 503);
    const token = await tokenDaContaDeServico(JSON.parse(saTexto), ESCOPO_GA4);
    return json(await consultarGa4(token, pedido, guardadoNoBanco(supabase)));
  } catch (e) {
    // O detalhe fica só no log: erro de JSON.parse da chave pode trazer um pedaço dela.
    console.error("mkt-ga4-relatorio:", (e as Error).message);
    return json({ erro: "O GA4 não respondeu. Tente de novo em alguns minutos." }, 502);
  }
});
