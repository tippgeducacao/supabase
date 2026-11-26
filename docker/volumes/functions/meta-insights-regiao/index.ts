// Gasto da Meta por ESTADO (26/11/2026) · alimenta o custo por reunião por região.
//
// Pedido do diretor: saber "qual região do Brasil está tendo mais reunião e qual é mais barata" em
// cada pós. O meta_insights guarda o gasto por campanha e dia, sem lugar. Esta edge pede à Insights
// API o mesmo gasto quebrado por estado (level=campaign, breakdowns=region, time_increment=1) e grava
// em meta_insights_regiao. A soma por campanha e dia bate com meta_insights (conferido 26/11/2026).
// A Meta não quebra gasto por cidade: cidade, no painel, é contagem de lead e reunião, não custo.
//
// Quem chama:
//   - o cron meta-insights-regiao-diario (06:40), com o segredo do cofre dos Públicos da Meta no
//     cabeçalho x-meta-publicos-cron (conferido por meta_publicos_validar_cron; não sai do banco);
//   - a chave de serviço exata;
//   - quem está logado e passa em meta_publicos_pode_gerenciar (Marketing ou diretoria).
//
// Corpo (JSON, tudo opcional):
//   {}                                         os últimos 7 dias (o padrão do cron)
//   { "desde": "2026-01-01", "ate": "2026-01-31" }   até 93 dias por chamada (histórico: mês a mês)
//   { "contas": ["1520818801666741"] }         só essas contas de meta_accounts
//
// Cada conta: lê todas as páginas; só depois de ler tudo grava (upsert) e apaga, no período, as
// linhas que a Meta não devolveu mais (fetched_at anterior a esta rodada). Se a leitura falha, a
// conta fica como estava. Token: o de meta_accounts, como o sync-meta-ads; não sai do servidor.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { exigirAcesso, respostaAcessoNegado } from "../_shared/acesso.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { contaSemPrefixo, linhasDaResposta, periodoDoCorpo, type LinhaMeta } from "./regras.ts";

const API = "https://graph.facebook.com/v26.0";
const LOTE = 1000;

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

type Conta = { ad_account_id: string; account_name: string | null; access_token: string | null };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, erro: "Método não permitido" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const segredoCron = req.headers.get("x-meta-publicos-cron");
  if (segredoCron) {
    const { data, error } = await admin.rpc("meta_publicos_validar_cron", { p_segredo: segredoCron });
    if (error || data !== true) return json({ ok: false, erro: "Não autorizado" }, 401);
  } else {
    try {
      await exigirAcesso(req, { servico: true, usuario: true, rpcPermissao: "meta_publicos_pode_gerenciar" });
    } catch (e) {
      return respostaAcessoNegado(e, corsHeaders);
    }
  }

  let corpo: { desde?: unknown; ate?: unknown; contas?: unknown } = {};
  try {
    corpo = await req.json();
  } catch {
    corpo = {};
  }

  let periodo;
  try {
    periodo = periodoDoCorpo(corpo, new Date());
  } catch (e) {
    return json({ ok: false, erro: e instanceof Error ? e.message : String(e) }, 400);
  }

  const filtroContas = Array.isArray(corpo.contas)
    ? corpo.contas.filter((c): c is string => typeof c === "string").map(contaSemPrefixo)
    : null;

  const { data: contasDb, error: errContas } = await admin
    .from("meta_accounts")
    .select("ad_account_id, account_name, access_token")
    .eq("is_active", true);
  if (errContas) return json({ ok: false, erro: errContas.message }, 500);

  const contas = ((contasDb ?? []) as Conta[]).filter(
    (c) => c.access_token && (!filtroContas || filtroContas.includes(contaSemPrefixo(c.ad_account_id))),
  );

  const marca = new Date().toISOString();
  const timeRange = encodeURIComponent(JSON.stringify({ since: periodo.desde, until: periodo.ate }));

  const resultados = await Promise.all(
    contas.map(async (c) => {
      const conta = contaSemPrefixo(c.ad_account_id);
      const resumo: Record<string, unknown> = { conta, nome: c.account_name };
      try {
        const brutas: LinhaMeta[] = [];
        let url: string | null =
          `${API}/act_${conta}/insights?level=campaign&breakdowns=region&time_increment=1` +
          `&fields=campaign_id,spend,impressions,clicks,actions&time_range=${timeRange}&limit=500`;
        while (url) {
          const r = await fetch(url, { headers: { Authorization: `Bearer ${c.access_token}` } });
          const pagina = (await r.json()) as { data?: LinhaMeta[]; paging?: { next?: string }; error?: { message?: string } };
          if (pagina.error) throw new Error(pagina.error.message ?? "Erro da Meta");
          if (pagina.data) brutas.push(...pagina.data);
          url = pagina.paging?.next ?? null;
        }

        const linhas = linhasDaResposta(brutas, conta, marca);
        for (let i = 0; i < linhas.length; i += LOTE) {
          const { error } = await admin
            .from("meta_insights_regiao")
            .upsert(linhas.slice(i, i + LOTE), { onConflict: "campaign_id,dia,regiao" });
          if (error) throw new Error(`Gravação: ${error.message}`);
        }
        // O que a Meta não devolveu mais neste período (campanha apagada, estado que zerou) sai.
        const { error: errApagar, count } = await admin
          .from("meta_insights_regiao")
          .delete({ count: "exact" })
          .eq("ad_account_id", conta)
          .gte("dia", periodo.desde)
          .lte("dia", periodo.ate)
          .lt("fetched_at", marca);
        if (errApagar) throw new Error(`Limpeza: ${errApagar.message}`);

        resumo.linhas = linhas.length;
        resumo.apagadas = count ?? 0;
        resumo.gasto = Math.round(linhas.reduce((s, l) => s + l.spend, 0) * 100) / 100;
      } catch (e) {
        resumo.erro = e instanceof Error ? e.message : String(e);
      }
      return resumo;
    }),
  );

  const erros = resultados.filter((r) => r.erro).length;
  return json({ ok: erros === 0, ...periodo, contas: resultados }, erros && erros === resultados.length ? 502 : 200);
});
