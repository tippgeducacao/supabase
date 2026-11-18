// GA4 Data API (v1beta) para o Analytics do Portal Marketing: só leitura, propriedade
// "Sites PPGVET e PPG". Doc: developers.google.com/analytics/devguides/reporting/data/v1
// (batchRunReports aceita até 5 relatórios; o de experimento vai à parte porque a dimensão
// exp_variant_string pode não existir, e um erro derrubaria o lote inteiro).
// Sem Deno.* de propósito: roda no vitest e na prévia local (Node).

export const PROPRIEDADE_GA4 = "559939938";
export const ESCOPO_GA4 = "https://www.googleapis.com/auth/analytics.readonly";
const API = `https://analyticsdata.googleapis.com/v1beta/properties/${PROPRIEDADE_GA4}`;
const LEAD = "keyEvents:generate_lead";
/** % das PESSOAS com pelo menos um generate_lead (a taxa por pessoa, como no Optimizely). */
const TAXA_PESSOA = "userKeyEventRate:generate_lead";

/**
 * Sites que não são captação de aluno: contratação (saiu do GA4 em 16/11/2026) e fórum e curso
 * presencial (saíram em 18/11/2026). Ficam fora dos números e da lista mesmo no histórico.
 * O CRM tira os mesmos em mkt_analytics_crm (régua de candidato + host). Mudou aqui, mude lá.
 */
export const FORA_DO_ANALYTICS = [
  "professores.ppgvet.com.br",
  "centraldetalentos.ppgvet.com.br",
  "forum.ppgvet.com.br",
  "cursoampere.ppgvet.com.br",
];
const MAX_DIAS = 400;

export interface PedidoGa4 {
  inicio: string;
  fim: string;
  /** hostName exato (ex.: site.ppgvet.com.br); null = todos os sites. */
  site: string | null;
}

const ehData = (v: unknown): v is string =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

export function validarPedido(corpo: unknown): PedidoGa4 {
  const c = (corpo ?? {}) as Record<string, unknown>;
  if (!ehData(c.inicio) || !ehData(c.fim)) throw new Error("inicio e fim em AAAA-MM-DD");
  const dias = (Date.parse(c.fim) - Date.parse(c.inicio)) / 864e5;
  if (dias < 0 || dias > MAX_DIAS) throw new Error(`Período de 1 a ${MAX_DIAS + 1} dias`);
  const site = c.site == null || c.site === "" ? null : String(c.site).toLowerCase();
  if (site !== null && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(site)) throw new Error("site inválido");
  return { inicio: c.inicio, fim: c.fim, site };
}

/** Nome curto de cada campo do GA4 na resposta. */
const NOME: Record<string, string> = {
  date: "dia",
  sessionManualSource: "source",
  sessionManualMedium: "medium",
  sessionManualCampaignName: "campaign",
  sessionManualAdContent: "content",
  sessionManualTerm: "term",
  hostName: "host",
  sessionDefaultChannelGroup: "canal",
  landingPage: "pagina",
  "customEvent:exp_variant_string": "exp",
  sessions: "sessoes",
  totalUsers: "usuarios",
  [LEAD]: "leads",
  [TAXA_PESSOA]: "taxa_pessoa",
};

type Filtro = Record<string, unknown>;
const filtroCampo = (campo: string, valor: string): Filtro => ({
  filter: { fieldName: campo, stringFilter: { matchType: "EXACT", value: valor } },
});

/**
 * O período da comparação "↑↓ contra o anterior" (decisão do usuário, 18/11/2026). Dono único: o CRM usa as mesmas datas.
 * - Mês inteiro (1 ao último dia) → o mês inteiro antes (outubro → setembro).
 * - Começa no dia 1 sem fechar o mês (Este mês) → os mesmos dias do mês anterior (1–17/11 → 1–17/10; o dia que o mês
 *   anterior não tem para no último dia dele).
 * - O resto (7 dias, calendário) → o mesmo número de dias, logo antes.
 */
export function periodoAnterior(p: PedidoGa4): { inicio: string; fim: string } {
  const dia = 864e5;
  const ini = new Date(`${p.inicio}T00:00:00Z`), fim = new Date(`${p.fim}T00:00:00Z`);
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const ultimoDia = (ano: number, mes: number) => new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
  const mesmoMes = ini.getUTCFullYear() === fim.getUTCFullYear() && ini.getUTCMonth() === fim.getUTCMonth();
  if (ini.getUTCDate() === 1 && mesmoMes) {
    const ano = ini.getUTCFullYear(), mes = ini.getUTCMonth() - 1;
    const fimDoMes = fim.getUTCDate() === ultimoDia(ini.getUTCFullYear(), ini.getUTCMonth());
    const ate = fimDoMes ? ultimoDia(ano, mes) : Math.min(fim.getUTCDate(), ultimoDia(ano, mes));
    return { inicio: ymd(new Date(Date.UTC(ano, mes, 1))), fim: ymd(new Date(Date.UTC(ano, mes, ate))) };
  }
  return { inicio: ymd(new Date(ini.getTime() - (fim.getTime() - ini.getTime()) - dia)), fim: ymd(new Date(ini.getTime() - dia)) };
}

export function montarRelatorios(p: PedidoGa4) {
  const dateRanges = [{ startDate: p.inicio, endDate: p.fim }];
  const ant = periodoAnterior(p);
  const dateRangesAnt = [{ startDate: ant.inicio, endDate: ant.fim }];
  const semForaDoAnalytics: Filtro = { notExpression: { filter: { fieldName: "hostName", inListFilter: { values: FORA_DO_ANALYTICS } } } };
  const doSite = p.site ? filtroCampo("hostName", p.site) : semForaDoAnalytics;
  const m = (...nomes: string[]) => nomes.map((name) => ({ name }));
  const porSessoes = [{ metric: { metricName: "sessions" }, desc: true }];
  const lote = {
    requests: [
      { dateRanges, metrics: m("sessions", "totalUsers", LEAD, TAXA_PESSOA), dimensionFilter: doSite },
      {
        dateRanges,
        dimensions: m("date"),
        metrics: m("sessions", "totalUsers", LEAD, TAXA_PESSOA),
        dimensionFilter: doSite,
        orderBys: [{ dimension: { dimensionName: "date" } }],
        limit: 1000,
      },
      {
        dateRanges,
        // sessionManual*: só o que veio da UTM do link (o resto é "(not set)"), o mesmo que o CRM guarda.
        dimensions: m("sessionManualSource", "sessionManualMedium", "sessionManualCampaignName", "sessionManualAdContent", "sessionManualTerm"),
        metrics: m("sessions", "totalUsers", LEAD, TAXA_PESSOA),
        dimensionFilter: doSite,
        orderBys: porSessoes,
        limit: 2000,
      },
      { dateRanges, dimensions: m("hostName", "landingPage"), metrics: m("sessions", "totalUsers", LEAD, TAXA_PESSOA), dimensionFilter: doSite, orderBys: porSessoes, limit: 2000 },
      { dateRanges, dimensions: m("sessionDefaultChannelGroup"), metrics: m("sessions", "totalUsers", LEAD, TAXA_PESSOA), dimensionFilter: doSite, orderBys: porSessoes },
    ],
  };
  // O período anterior: só o total e o dia a dia, para a comparação e a linha fraca do gráfico.
  const anterior = {
    requests: [lote.requests[0], lote.requests[1]].map((r) => ({ ...r, dateRanges: dateRangesAnt })),
  };
  const doEvento = filtroCampo("eventName", "experience_impression");
  const experimentos = {
    dateRanges,
    dimensions: m("customEvent:exp_variant_string"),
    metrics: m("totalUsers"),
    dimensionFilter: { andGroup: { expressions: [doEvento, doSite] } },
    limit: 1000,
  };
  // Os sites que o GA4 vê no período, sem o filtro do site escolhido (é a lista do seletor), mas sem os de fora.
  const sites = { dateRanges, dimensions: m("hostName"), metrics: m("sessions"), dimensionFilter: semForaDoAnalytics, orderBys: porSessoes, limit: 200 };
  return { lote, anterior, experimentos, sites };
}

interface RelatorioGa4 {
  dimensionHeaders?: { name: string }[];
  metricHeaders?: { name: string }[];
  /** Relatório sem dimensão (o total) vem sem dimensionValues. */
  rows?: { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] }[];
  rowCount?: number;
}

export type LinhaGa4 = Record<string, string | number>;

/** Linhas do GA4 com nome curto; data vira AAAA-MM-DD e métrica vira número. */
export function linhas(r: RelatorioGa4): LinhaGa4[] {
  const dims = (r.dimensionHeaders ?? []).map((h) => NOME[h.name] ?? h.name);
  const mets = (r.metricHeaders ?? []).map((h) => NOME[h.name] ?? h.name);
  return (r.rows ?? []).map((row) => {
    const o: LinhaGa4 = {};
    (row.dimensionValues ?? []).forEach((v, i) => {
      o[dims[i]] = dims[i] === "dia" ? `${v.value.slice(0, 4)}-${v.value.slice(4, 6)}-${v.value.slice(6, 8)}` : v.value;
    });
    (row.metricValues ?? []).forEach((v, i) => (o[mets[i]] = Number(v.value)));
    // Pessoas que viraram lead: a taxa por pessoa × as pessoas da linha (o GA4 não dá a contagem pronta).
    if (typeof o.taxa_pessoa === "number" && typeof o.usuarios === "number") o.pessoas_lead = Math.round(o.taxa_pessoa * o.usuarios);
    return o;
  });
}

export interface Resumo {
  sessoes: number;
  usuarios: number;
  /** generate_lead enviados (a mesma pessoa pode mandar duas vezes). */
  leads: number;
  /** Pessoas com pelo menos um generate_lead. */
  pessoas_lead: number;
}

export interface RespostaGa4 {
  resumo: Resumo;
  /** O mesmo, no período de mesmo tamanho logo antes (`periodo_anterior`; o CRM usa as mesmas datas). */
  resumo_anterior: Resumo;
  periodo_anterior: { inicio: string; fim: string };
  por_dia_anterior: LinhaGa4[];
  por_dia: LinhaGa4[];
  por_utm: LinhaGa4[];
  por_pagina: LinhaGa4[];
  /** Agrupamento padrão de canais do GA4 (orgânico, pago, direto…). */
  por_canal: LinhaGa4[];
  /** hostName × sessões no período, sem o filtro de site (lista do seletor). */
  sites: LinhaGa4[];
  /** Mais linhas do que o limite: a tabela mostra só as de mais sessões. */
  cortado: { por_utm: boolean; por_pagina: boolean };
  /** null quando o GA4 não tem a dimensão exp_variant_string (ver aviso_experimentos). */
  experimentos: LinhaGa4[] | null;
  aviso_experimentos: string | null;
}

async function post(token: string, metodo: string, corpo: unknown) {
  const resp = await fetch(`${API}:${metodo}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  });
  const r = await resp.json().catch(() => ({}));
  if (!resp.ok || r.error) throw new Error(r.error?.message ?? `GA4 HTTP ${resp.status}`);
  return r;
}

export async function consultarGa4(token: string, p: PedidoGa4): Promise<RespostaGa4> {
  const { lote, anterior, experimentos, sites } = montarRelatorios(p);
  const [l, a, e, s] = await Promise.all([
    post(token, "batchRunReports", lote),
    post(token, "batchRunReports", anterior),
    post(token, "runReport", experimentos).catch((err: Error) => err),
    post(token, "runReport", sites),
  ]);
  const [resumo, porDia, porUtm, porPagina, porCanal] = (l.reports ?? []) as RelatorioGa4[];
  const [resumoAnt, porDiaAnt] = (a.reports ?? []) as RelatorioGa4[];
  const total = (r?: RelatorioGa4): Resumo => {
    const t = linhas(r ?? {})[0] ?? {};
    return { sessoes: Number(t.sessoes ?? 0), usuarios: Number(t.usuarios ?? 0), leads: Number(t.leads ?? 0), pessoas_lead: Number(t.pessoas_lead ?? 0) };
  };
  const semDimensao = e instanceof Error && e.message.includes("exp_variant_string");
  return {
    resumo: total(resumo),
    resumo_anterior: total(resumoAnt),
    periodo_anterior: periodoAnterior(p),
    por_dia_anterior: linhas(porDiaAnt ?? {}),
    por_dia: linhas(porDia ?? {}),
    por_utm: linhas(porUtm ?? {}),
    por_pagina: linhas(porPagina ?? {}),
    por_canal: linhas(porCanal ?? {}),
    sites: linhas(s),
    cortado: { por_utm: (porUtm?.rowCount ?? 0) > 2000, por_pagina: (porPagina?.rowCount ?? 0) > 2000 },
    experimentos: e instanceof Error ? null : linhas(e),
    aviso_experimentos: e instanceof Error
      ? semDimensao
        ? "Falta a dimensão personalizada exp_variant_string no GA4: sem ela não dá para contar quem viu cada versão."
        : `O GA4 não respondeu sobre os testes: ${e.message}`
      : null,
  };
}
