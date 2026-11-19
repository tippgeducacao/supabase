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
 * Exceção: o site de teste `ppgteste` (11 visitas até 10/11/2026) nunca teve lead, então só sai daqui.
 */
export const FORA_DO_ANALYTICS = [
  "professores.ppgvet.com.br",
  "centraldetalentos.ppgvet.com.br",
  "forum.ppgvet.com.br",
  "cursoampere.ppgvet.com.br",
  "ppgteste.ppgvet.com.br",
];

/** Visitas de verificação feitas por nós (utm_source=teste_claude, 21 a 27/10/2026): nunca contam (pedido de 19/11/2026). */
export const ORIGENS_DE_TESTE = ["teste_claude"];
const MAX_DIAS = 400;

export interface PedidoGa4 {
  inicio: string;
  fim: string;
  /** hostName exato (ex.: site.ppgvet.com.br); null = todos os sites. */
  site: string | null;
  /** Aba Testes A/B: traz também quem viu cada versão acumulado por dia, por página, por aparelho e hoje, e o form_start por versão. */
  detalhe?: boolean;
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
  return { inicio: c.inicio, fim: c.fim, site, detalhe: c.detalhe === true };
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
  pagePath: "caminho",
  deviceCategory: "aparelho",
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
  const semTeste: Filtro = { notExpression: { filter: { fieldName: "sessionManualSource", inListFilter: { values: ORIGENS_DE_TESTE } } } };
  const semForaDoAnalytics: Filtro = {
    andGroup: { expressions: [{ notExpression: { filter: { fieldName: "hostName", inListFilter: { values: FORA_DO_ANALYTICS } } } }, semTeste] },
  };
  const doSite: Filtro = p.site ? { andGroup: { expressions: [filtroCampo("hostName", p.site), semTeste] } } : semForaDoAnalytics;
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
  // Quem começou um formulário (form_start; não é evento-chave, então vai em relatório à parte), nos dois períodos.
  const comecou = (dr: typeof dateRanges) => ({
    dateRanges: dr,
    metrics: m("totalUsers"),
    dimensionFilter: { andGroup: { expressions: [filtroCampo("eventName", "form_start"), doSite] } },
  });
  // O período anterior: só o total e o dia a dia, para a comparação e a linha fraca do gráfico; e o form_start dos dois.
  const anterior = {
    requests: [...[lote.requests[0], lote.requests[1]].map((r) => ({ ...r, dateRanges: dateRangesAnt })), comecou(dateRanges), comecou(dateRangesAnt)],
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
  // Detalhe do teste (só a aba Testes A/B pede: cada relatório gasta cota da propriedade).
  // form_start por versão: a tag do GTM lê exp_variant_string do dataLayer, que guarda o último valor
  // (variável v2), então o form_start da página em teste sai com a versão vista. Só nas páginas de pós,
  // para não contar o valor que sobra depois de navegar para fora do teste.
  const naPos: Filtro = { filter: { fieldName: "pagePath", stringFilter: { matchType: "FULL_REGEXP", value: "^/pos-[a-z0-9]+/?$" } } };
  const dias = p.detalhe ? pontosAcumulados(p.inicio, p.fim) : [];
  const detalheTeste = p.detalhe
    ? {
        extras: {
          requests: [
            { ...experimentos, dimensions: m("customEvent:exp_variant_string", "pagePath") },
            { ...experimentos, dimensions: m("customEvent:exp_variant_string", "deviceCategory") },
            {
              dateRanges,
              dimensions: m("customEvent:exp_variant_string"),
              metrics: m("totalUsers"),
              dimensionFilter: { andGroup: { expressions: [filtroCampo("eventName", "form_start"), naPos, doSite] } },
              limit: 1000,
            },
            // Hoje: "versão sem ninguém hoje" (saúde do teste).
            { ...experimentos, dateRanges: [{ startDate: p.fim, endDate: p.fim }] },
          ],
        },
        // Pessoa não se soma de um dia para o outro no GA4: cada ponto acumulado é uma consulta do início até
        // aquele dia (como o `ab.mjs ga4`), 5 por lote (limite do batchRunReports).
        acumulado: lotes(dias.map((dia) => ({ ...experimentos, dateRanges: [{ startDate: p.inicio, endDate: dia }] })), 5),
        dias,
      }
    : null;
  return { lote, anterior, experimentos, sites, detalheTeste };
}

/**
 * Os dias da série acumulada, do início ao fim. shortcut: no máximo 30 pontos (teste longo pula dias, sempre com o
 * último), para não passar de 6 chamadas ao GA4 por abertura da aba; mais pontos se a cota sobrar.
 */
export function pontosAcumulados(inicio: string, fim: string, max = 30): string[] {
  const dias: string[] = [];
  for (let t = Date.parse(`${inicio}T00:00:00Z`); t <= Date.parse(`${fim}T00:00:00Z`); t += 864e5) dias.push(new Date(t).toISOString().slice(0, 10));
  const passo = Math.ceil(dias.length / max);
  return passo <= 1 ? dias : dias.filter((_, i) => (dias.length - 1 - i) % passo === 0);
}

const lotes = <T>(itens: T[], n: number) => Array.from({ length: Math.ceil(itens.length / n) }, (_, i) => ({ requests: itens.slice(i * n, i * n + n) }));

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
  /** Pessoas que começaram um formulário (form_start). */
  comecou: number;
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
  /**
   * Só com `detalhe`: quem viu cada versão do início até cada dia (`acumulado`, com `dia`), por página, por aparelho e hoje,
   * e quem começou o formulário. null = não pedido ou o GA4 falhou.
   */
  experimentos_detalhe: {
    acumulado: LinhaGa4[]; por_pagina: LinhaGa4[]; por_aparelho: LinhaGa4[]; form_start: LinhaGa4[]; hoje: LinhaGa4[];
  } | null;
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
  const { lote, anterior, experimentos, sites, detalheTeste } = montarRelatorios(p);
  const [l, a, e, s, d] = await Promise.all([
    post(token, "batchRunReports", lote),
    post(token, "batchRunReports", anterior),
    post(token, "runReport", experimentos).catch((err: Error) => err),
    post(token, "runReport", sites),
    detalheTeste ? detalhar(token, detalheTeste).catch((err: Error) => err) : Promise.resolve(null),
  ]);
  const [resumo, porDia, porUtm, porPagina, porCanal] = (l.reports ?? []) as RelatorioGa4[];
  const [resumoAnt, porDiaAnt, comecouAtual, comecouAnt] = (a.reports ?? []) as RelatorioGa4[];
  const total = (r: RelatorioGa4 | undefined, c: RelatorioGa4 | undefined): Resumo => {
    const t = linhas(r ?? {})[0] ?? {};
    return {
      sessoes: Number(t.sessoes ?? 0), usuarios: Number(t.usuarios ?? 0), leads: Number(t.leads ?? 0), pessoas_lead: Number(t.pessoas_lead ?? 0),
      comecou: Number(linhas(c ?? {})[0]?.usuarios ?? 0),
    };
  };
  const semDimensao = e instanceof Error && e.message.includes("exp_variant_string");
  return {
    resumo: total(resumo, comecouAtual),
    resumo_anterior: total(resumoAnt, comecouAnt),
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
    experimentos_detalhe: d instanceof Error ? null : d,
  };
}

/** O detalhe do teste: os extras num lote e a série acumulada em lotes seguidos (sem estourar as chamadas simultâneas do GA4). */
async function detalhar(token: string, d: NonNullable<ReturnType<typeof montarRelatorios>["detalheTeste"]>): Promise<RespostaGa4["experimentos_detalhe"]> {
  const serie = async () => {
    const out: LinhaGa4[] = [];
    for (const [i, lote] of d.acumulado.entries()) {
      const r = await post(token, "batchRunReports", lote);
      ((r.reports ?? []) as RelatorioGa4[]).forEach((rep, j) => out.push(...linhas(rep).map((l) => ({ ...l, dia: d.dias[i * 5 + j] }))));
    }
    return out;
  };
  const [extras, acumulado] = await Promise.all([post(token, "batchRunReports", d.extras), serie()]);
  const [pagina, aparelho, form, hoje] = (extras.reports ?? []) as RelatorioGa4[];
  return { acumulado, por_pagina: linhas(pagina ?? {}), por_aparelho: linhas(aparelho ?? {}), form_start: linhas(form ?? {}), hoje: linhas(hoje ?? {}) };
}
