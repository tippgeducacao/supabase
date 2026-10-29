// sync-tiktok-ads — puxa CAMPANHAS + gasto DIÁRIO do TikTok Ads (Marketing API) e popula
// public.tiktok_campaigns / public.tiktok_insights (espelho do sync-google-ads).
// Deploy por git push (deploy-edges.yml), NUNCA Deploy do Dokploy.
//
// ⚠️ ESTA É A API DO TIKTOK **PARA ANÚNCIOS** (business-api.tiktok.com), que não tem nada a
// ver com a do perfil orgânico (open.tiktokapis.com, edge `tiktok-sync-metrics`). São dois
// apps, dois tokens e dois formatos de erro. Token de um devolve 40001 no outro.
//
// CREDENCIAL: nenhuma global. Cada linha ativa de `tiktok_ad_accounts` traz seu próprio
// `access_token` (header `Access-Token`) e `advertiser_id`. Quem grava essa linha é a edge
// `tiktok-ads-connect` (token colado à mão) ou `tiktok-ads-oauth-callback` (OAuth do portal).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { exigirAcesso, respostaAcessoNegado } from "../_shared/acesso.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

const API = "https://business-api.tiktok.com/open_api/v1.3";

// Conjunto cheio. Se a conta não liberar alguma (acontece por objetivo/permissão), o TikTok
// recusa o RELATÓRIO INTEIRO — por isso existe o CORE abaixo como segunda tentativa.
const METRICAS = [
  "spend", "impressions", "clicks", "ctr", "cpc", "cpm", "reach",
  "conversion", "cost_per_conversion", "video_play_actions",
  // ⚠️ ENGAJAMENTO. Campanha de objetivo ENGAGEMENT entrega 0 clique e 0 conversão por
  // natureza — sem estas, a tela mostrava verba de marca com tudo zerado, como se fosse
  // desperdício. Medido em 12/10: a "Interação com a comunidade" trouxe 2.102 seguidores
  // por R$ 654,67 (R$ 0,31 cada), e nada disso aparecia.
  "follows", "profile_visits", "likes", "comments", "shares", "engagements",
  "campaign_name", "objective_type",
];
const METRICAS_CORE = ["spend", "impressions", "clicks", "campaign_name"];

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const inteiro = (v: unknown): number => Math.round(num(v));
/** "2026-09-01 00:00:00" (hora do fuso da CONTA) → "2026-09-01" */
const soDia = (s: unknown): string | null => {
  const t = typeof s === "string" ? s.trim() : "";
  return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null;
};
const tsTikTok = (s: unknown): string | null => {
  const t = typeof s === "string" ? s.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}/.test(t)) return null;
  const d = new Date(t.replace(" ", "T") + (t.includes("Z") ? "" : "Z"));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

interface TTResp<T> { code?: number; message?: string; request_id?: string; data?: T }

/**
 * GET autenticado na Marketing API.
 * ⚠️ O TikTok responde **HTTP 200 mesmo quando recusa** — o que vale é `code` no corpo
 * (0 = ok). Confiar no status é o jeito clássico de gravar relatório vazio achando que deu certo.
 */
async function ttGet<T>(caminho: string, params: Record<string, string>, token: string): Promise<T> {
  const url = new URL(`${API}${caminho}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: { "Access-Token": token, "Content-Type": "application/json" },
  });
  const texto = await resp.text();
  let corpo: TTResp<T>;
  try {
    corpo = JSON.parse(texto);
  } catch {
    throw new Error(`Resposta não-JSON do TikTok (${resp.status}): ${texto.slice(0, 200)}`);
  }
  if (corpo.code !== 0) {
    throw new Error(`TikTok recusou ${caminho} (code ${corpo.code}): ${corpo.message || "sem mensagem"}`);
  }
  return (corpo.data ?? {}) as T;
}

/** Janelas de no máximo `dias` — o relatório do TikTok não aceita intervalo longo de uma vez. */
function janelas(de: string, ate: string, dias = 30): Array<{ de: string; ate: string }> {
  const out: Array<{ de: string; ate: string }> = [];
  const fim = new Date(`${ate}T00:00:00Z`).getTime();
  let ini = new Date(`${de}T00:00:00Z`).getTime();
  if (!Number.isFinite(ini) || !Number.isFinite(fim) || ini > fim) return out;
  while (ini <= fim) {
    const f = Math.min(ini + (dias - 1) * 86400000, fim);
    out.push({ de: new Date(ini).toISOString().slice(0, 10), ate: new Date(f).toISOString().slice(0, 10) });
    ini = f + 86400000;
  }
  return out;
}

interface CampanhaTT {
  campaign_id?: string; campaign_name?: string; objective_type?: string;
  operation_status?: string; secondary_status?: string;
  budget?: number; budget_mode?: string; create_time?: string; modify_time?: string;
}

async function puxarCampanhas(advertiserId: string, token: string): Promise<CampanhaTT[]> {
  const todas: CampanhaTT[] = [];
  for (let page = 1; page <= 20; page++) {
    const d = await ttGet<{ list?: CampanhaTT[]; page_info?: { total_page?: number } }>(
      "/campaign/get/",
      { advertiser_id: advertiserId, page: String(page), page_size: "100" },
      token,
    );
    const lista = d.list ?? [];
    todas.push(...lista);
    if (lista.length === 0 || page >= (d.page_info?.total_page ?? 1)) break;
  }
  return todas;
}

interface LinhaRelatorio {
  dimensions?: Record<string, string>;
  metrics?: Record<string, unknown>;
}

async function puxarRelatorio(
  advertiserId: string, token: string, de: string, ate: string,
): Promise<LinhaRelatorio[]> {
  const linhas: LinhaRelatorio[] = [];
  let metricas = METRICAS;

  for (let page = 1; page <= 50; page++) {
    const params = () => ({
      advertiser_id: advertiserId,
      report_type: "BASIC",
      service_type: "AUCTION",
      data_level: "AUCTION_CAMPAIGN",
      dimensions: JSON.stringify(["campaign_id", "stat_time_day"]),
      metrics: JSON.stringify(metricas),
      start_date: de,
      end_date: ate,
      page: String(page),
      page_size: "1000",
    });

    let d: { list?: LinhaRelatorio[]; page_info?: { total_page?: number } };
    try {
      d = await ttGet("/report/integrated/get/", params(), token);
    } catch (e) {
      // Métrica não liberada derruba o relatório inteiro. Cai para o mínimo e segue com o
      // que importa (gasto), em vez de devolver o período vazio.
      if (metricas !== METRICAS_CORE && /metric|dimension|40002|permission/i.test(err(e))) {
        console.warn(`[sync-tiktok-ads] métricas completas recusadas (${err(e)}). Tentando o conjunto mínimo.`);
        metricas = METRICAS_CORE;
        d = await ttGet("/report/integrated/get/", params(), token);
      } else {
        throw e;
      }
    }

    const lista = d.list ?? [];
    linhas.push(...lista);
    if (lista.length === 0 || page >= (d.page_info?.total_page ?? 1)) break;
  }
  return linhas;
}

async function sincronizarConta(
  supabase: ReturnType<typeof createClient>,
  conta: Record<string, string>,
  de: string, ate: string,
) {
  const advertiserId = String(conta.advertiser_id);
  const token = String(conta.access_token || "");
  if (!token) throw new Error("conta sem access_token");

  // Nome/moeda/fuso da conta — o `spend` vem na MOEDA DELA, então a tela precisa saber qual é.
  try {
    const info = await ttGet<{ list?: Array<Record<string, string>> }>(
      "/advertiser/info/",
      { advertiser_ids: JSON.stringify([advertiserId]), fields: JSON.stringify(["name", "currency", "timezone"]) },
      token,
    );
    const a = info.list?.[0];
    if (a) {
      await supabase.from("tiktok_ad_accounts").update({
        advertiser_name: a.name ?? conta.advertiser_name ?? null,
        currency: a.currency ?? conta.currency ?? null,
        timezone: a.timezone ?? conta.timezone ?? null,
        updated_at: new Date().toISOString(),
      }).eq("id", conta.id);
    }
  } catch (e) {
    console.warn(`[sync-tiktok-ads] advertiser/info falhou (${advertiserId}):`, err(e));
  }

  // 1) Campanhas (metadado).
  const campanhas = await puxarCampanhas(advertiserId, token);
  const linhasCamp = campanhas
    .filter((c) => c.campaign_id)
    .map((c) => ({
      id: String(c.campaign_id),
      advertiser_id: advertiserId,
      name: c.campaign_name ?? null,
      objective_type: c.objective_type ?? null,
      status: c.operation_status ?? c.secondary_status ?? null,
      budget: c.budget ?? null,
      budget_mode: c.budget_mode ?? null,
      create_time: tsTikTok(c.create_time),
      modify_time: tsTikTok(c.modify_time),
      fetched_at: new Date().toISOString(),
    }));
  if (linhasCamp.length) {
    const { error } = await supabase.from("tiktok_campaigns").upsert(linhasCamp, { onConflict: "id" });
    if (error) throw error;
  }

  // 2) Gasto por campanha × dia.
  const porChave = new Map<string, Record<string, unknown>>();
  const nomePorCampanha = new Map<string, string>();
  const objetivoPorCampanha = new Map<string, string>();

  for (const j of janelas(de, ate, 30)) {
    for (const linha of await puxarRelatorio(advertiserId, token, j.de, j.ate)) {
      const campaignId = linha.dimensions?.campaign_id;
      const dia = soDia(linha.dimensions?.stat_time_day);
      if (!campaignId || !dia) continue;
      const m = linha.metrics ?? {};

      const nome = typeof m.campaign_name === "string" ? m.campaign_name : "";
      if (nome) nomePorCampanha.set(campaignId, nome);
      const obj = typeof m.objective_type === "string" ? m.objective_type : "";
      if (obj) objetivoPorCampanha.set(campaignId, obj);

      porChave.set(`${campaignId}|${dia}`, {
        advertiser_id: advertiserId,
        campaign_id: campaignId,
        date_start: dia,
        spend: num(m.spend),
        impressions: inteiro(m.impressions),
        clicks: inteiro(m.clicks),
        ctr: m.ctr === undefined ? null : num(m.ctr),
        cpc: m.cpc === undefined ? null : num(m.cpc),
        cpm: m.cpm === undefined ? null : num(m.cpm),
        reach: m.reach === undefined ? null : inteiro(m.reach),
        conversions: num(m.conversion),
        cost_per_conversion: m.cost_per_conversion === undefined ? null : num(m.cost_per_conversion),
        video_views: m.video_play_actions === undefined ? null : inteiro(m.video_play_actions),
        follows: m.follows === undefined ? null : inteiro(m.follows),
        profile_visits: m.profile_visits === undefined ? null : inteiro(m.profile_visits),
        likes: m.likes === undefined ? null : inteiro(m.likes),
        comments: m.comments === undefined ? null : inteiro(m.comments),
        shares: m.shares === undefined ? null : inteiro(m.shares),
        engagements: m.engagements === undefined ? null : inteiro(m.engagements),
        fetched_at: new Date().toISOString(),
      });
    }
  }

  const insights = [...porChave.values()];
  if (insights.length) {
    // Em lotes: 30 dias × muitas campanhas passa fácil do que cabe num upsert só.
    for (let i = 0; i < insights.length; i += 500) {
      const { error } = await supabase
        .from("tiktok_insights")
        .upsert(insights.slice(i, i + 500), { onConflict: "advertiser_id,campaign_id,date_start" });
      if (error) throw error;
    }
  }

  // Campanha que aparece no relatório mas não veio em /campaign/get/ (apagada, por exemplo)
  // ficaria sem nome na tela. O relatório já trouxe o nome — aproveita.
  const faltando = [...nomePorCampanha.keys()].filter((id) => !linhasCamp.some((c) => c.id === id));
  if (faltando.length) {
    const { error } = await supabase.from("tiktok_campaigns").upsert(
      faltando.map((id) => ({
        id,
        advertiser_id: advertiserId,
        name: nomePorCampanha.get(id) ?? null,
        objective_type: objetivoPorCampanha.get(id) ?? null,
        fetched_at: new Date().toISOString(),
      })),
      { onConflict: "id" },
    );
    if (error) throw error;
  }

  return { campanhas: linhasCamp.length + faltando.length, dias_x_campanha: insights.length };
}

/**
 * ALCANCE DO PERÍODO, ao vivo (modo "alcance", 20/10/2026). O `reach` gravado em
 * `tiktok_insights` é por campanha × DIA, e alcance NÃO soma: quem viu o anúncio em 10 dias
 * conta 10 vezes. Em 01–20/10/2026 a soma deu 203.081 contra 125.517 pessoas que o próprio
 * TikTok informava nas duas contas. Sem `stat_time_day` o relatório aceita o período inteiro
 * (testado com 293 dias) e devolve pessoas únicas por conta — o mesmo desenho do
 * `ig-period-metrics` do Instagram, que tinha o mesmo defeito. Somente leitura: não grava nada.
 * ⚠️ Pessoas únicas valem POR CONTA: o TikTok não cruza contas, então com duas contas entregando
 * o total é a soma das duas (quem viu anúncio das duas conta duas vezes) — a tela diz isso.
 */
async function alcanceDoPeriodo(contas: Record<string, string>[], de: string, ate: string) {
  const porConta: Array<{ conta: string; alcance: number; impressoes: number; ok: boolean; erro?: string }> = [];
  for (const conta of contas) {
    const advertiserId = String(conta.advertiser_id);
    try {
      const d = await ttGet<{ list?: LinhaRelatorio[] }>(
        "/report/integrated/get/",
        {
          advertiser_id: advertiserId,
          report_type: "BASIC",
          data_level: "AUCTION_ADVERTISER",
          dimensions: JSON.stringify(["advertiser_id"]),
          metrics: JSON.stringify(["reach", "impressions"]),
          start_date: de,
          end_date: ate,
          page_size: "10",
        },
        String(conta.access_token || ""),
      );
      const m = d.list?.[0]?.metrics ?? {};
      porConta.push({ conta: advertiserId, alcance: inteiro(m.reach), impressoes: inteiro(m.impressions), ok: true });
    } catch (e) {
      porConta.push({ conta: advertiserId, alcance: 0, impressoes: 0, ok: false, erro: err(e) });
    }
  }
  const comEntrega = porConta.filter((c) => c.ok && c.impressoes > 0);
  return {
    // Uma conta que falhou deixa o total MENOR que o real sem avisar: a tela só mostra com ok.
    ok: porConta.every((c) => c.ok),
    periodo: { date_from: de, date_to: ate },
    alcance: comEntrega.reduce((s, c) => s + c.alcance, 0),
    contas_com_entrega: comEntrega.length,
    por_conta: porConta,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  // Tela TikTok Ads (colaborador logado) ou cron (chave de serviço): usa os tokens das contas TikTok.
  try { await exigirAcesso(req, { usuario: true, servico: true }); }
  catch (e) { return respostaAcessoNegado(e, corsHeaders); }

  try {
    const body = await req.json().catch(() => ({}));
    const hojeSP = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const date_to = body.date_to || iso(hojeSP);
    const date_from = body.date_from || iso(new Date(hojeSP.getTime() - 30 * 86400000));

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    if (body.modo === "alcance") {
      // Leitura sob demanda da tela TikTok Ads (o token das contas é usado para falar com o
      // TikTok). Quem chama já foi conferido no exigirAcesso do topo.
      const dia = /^\d{4}-\d{2}-\d{2}$/;
      if (!dia.test(String(body.date_from || "")) || !dia.test(String(body.date_to || "")) || body.date_from > body.date_to) {
        return json({ error: "Informe date_from e date_to (AAAA-MM-DD), com o início antes do fim." }, 400);
      }
      const { data: contasAlc, error: contasAlcErr } = await supabase
        .from("tiktok_ad_accounts").select("advertiser_id, access_token").eq("ativo", true);
      if (contasAlcErr) throw contasAlcErr;
      return json(await alcanceDoPeriodo((contasAlc ?? []) as Record<string, string>[], body.date_from, body.date_to));
    }

    let q = supabase.from("tiktok_ad_accounts").select("*").eq("ativo", true);
    if (body.advertiser_id) q = q.eq("advertiser_id", String(body.advertiser_id));
    const { data: contas, error: contasErr } = await q;
    if (contasErr) throw contasErr;
    if (!contas?.length) {
      return json({
        ok: true,
        aviso: "Nenhuma conta do TikTok Ads conectada. Conecte em Portal Marketing → Meta Ads → aba TikTok.",
        contas: 0,
        resumo: [],
      });
    }

    const resumo: Record<string, unknown>[] = [];
    for (const conta of contas as Record<string, string>[]) {
      try {
        const r = await sincronizarConta(supabase, conta, date_from, date_to);
        await supabase.from("tiktok_ad_accounts").update({
          ultima_sync_at: new Date().toISOString(), ultimo_erro: null, updated_at: new Date().toISOString(),
        }).eq("id", conta.id);
        resumo.push({ conta: conta.advertiser_id, ok: true, ...r });
      } catch (e) {
        const msg = err(e);
        console.error(`[sync-tiktok-ads] conta ${conta.advertiser_id}:`, msg);
        await supabase.from("tiktok_ad_accounts").update({
          ultimo_erro: msg.slice(0, 500), updated_at: new Date().toISOString(),
        }).eq("id", conta.id);
        resumo.push({ conta: conta.advertiser_id, ok: false, erro: msg });
      }
    }

    return json({ ok: true, periodo: { date_from, date_to }, contas: contas.length, resumo });
  } catch (e) {
    console.error("[sync-tiktok-ads]", e);
    return json({ error: err(e) }, 500);
  }
});
