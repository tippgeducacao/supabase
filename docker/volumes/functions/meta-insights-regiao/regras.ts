// Regras puras da edge meta-insights-regiao (testadas em regras.test.ts, sem rede).

/** Maior janela aceita numa chamada. A carga do histórico vai mês a mês. */
export const MAX_DIAS = 93;

/** Dias do período padrão do cron: hoje e os 6 anteriores (a Meta ainda acerta o gasto recente). */
export const DIAS_PADRAO = 7;

const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;

/** "YYYY-MM-DD" de uma data no fuso de São Paulo. */
export function diaEmSaoPaulo(d: Date): string {
  // en-CA formata como YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function somarDias(dia: string, n: number): string {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function diasEntre(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}

export type Periodo = { desde: string; ate: string };

/**
 * Período pedido no corpo, ou os últimos 7 dias. Lança Error com a frase para o usuário quando o
 * pedido não serve (data malformada, fim antes do início, janela maior que MAX_DIAS).
 */
export function periodoDoCorpo(corpo: { desde?: unknown; ate?: unknown }, agora: Date): Periodo {
  const hoje = diaEmSaoPaulo(agora);
  const desde = typeof corpo.desde === "string" ? corpo.desde : null;
  const ate = typeof corpo.ate === "string" ? corpo.ate : null;
  if (!desde && !ate) return { desde: somarDias(hoje, -(DIAS_PADRAO - 1)), ate: hoje };
  if (!desde || !ate || !RE_DATA.test(desde) || !RE_DATA.test(ate)) {
    throw new Error('Informe "desde" e "ate" no formato AAAA-MM-DD.');
  }
  if (Number.isNaN(Date.parse(desde)) || Number.isNaN(Date.parse(ate))) {
    throw new Error("Data inválida.");
  }
  if (ate < desde) throw new Error('"ate" é anterior a "desde".');
  if (diasEntre(desde, ate) + 1 > MAX_DIAS) {
    throw new Error(`No máximo ${MAX_DIAS} dias por chamada. Para o histórico, chame mês a mês.`);
  }
  return { desde, ate: ate > hoje ? hoje : ate };
}

type AcaoMeta = { action_type?: string; value?: string | number };
export type LinhaMeta = {
  campaign_id?: string;
  date_start?: string;
  region?: string;
  spend?: string | number;
  impressions?: string | number;
  clicks?: string | number;
  actions?: AcaoMeta[];
};

export type LinhaRegiao = {
  ad_account_id: string;
  campaign_id: string;
  dia: string;
  regiao: string;
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  fetched_at: string;
};

const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Leads da linha: a 1ª ação de lead, como o sync-meta-ads conta em meta_insights.conversions. */
export function leadsDasAcoes(acoes: AcaoMeta[] | undefined): number {
  const a = (acoes ?? []).find((x) => {
    const t = x.action_type ?? "";
    return t.includes("lead") || t.includes("complete_registration") || t.includes("submit_application");
  });
  return a ? Math.trunc(num(a.value)) : 0;
}

/**
 * Linhas da resposta da Insights API (level=campaign, breakdowns=region, time_increment=1) no formato
 * da tabela. Linha sem campanha, sem dia ou sem nada (gasto, impressão e clique zerados) não entra.
 * "region" ausente vira "Unknown", como a Meta chama o que não sabe localizar.
 * Chave repetida (campanha + dia + região) é somada numa linha só: o upsert recusa a mesma chave
 * duas vezes no mesmo lote.
 */
export function linhasDaResposta(dados: LinhaMeta[], conta: string, marca: string): LinhaRegiao[] {
  const porChave = new Map<string, LinhaRegiao>();
  for (const d of dados) {
    if (!d.campaign_id || !d.date_start) continue;
    const spend = num(d.spend);
    const impressions = Math.trunc(num(d.impressions));
    const clicks = Math.trunc(num(d.clicks));
    if (spend === 0 && impressions === 0 && clicks === 0) continue;
    const regiao = (d.region ?? "").trim() || "Unknown";
    const chave = `${d.campaign_id}|${d.date_start}|${regiao}`;
    const atual = porChave.get(chave);
    if (atual) {
      atual.spend += spend;
      atual.impressions += impressions;
      atual.clicks += clicks;
      atual.leads += leadsDasAcoes(d.actions);
      continue;
    }
    porChave.set(chave, {
      ad_account_id: conta,
      campaign_id: String(d.campaign_id),
      dia: d.date_start,
      regiao,
      spend,
      impressions,
      clicks,
      leads: leadsDasAcoes(d.actions),
      fetched_at: marca,
    });
  }
  return [...porChave.values()].map((l) => ({ ...l, spend: Math.round(l.spend * 100) / 100 }));
}

/** Id da conta sem o prefixo act_ (como meta_insights guarda). */
export const contaSemPrefixo = (id: string) => id.replace(/^act_/, "");
