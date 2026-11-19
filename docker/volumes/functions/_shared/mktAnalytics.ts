/**
 * Analytics do Portal Marketing: junta o GA4 (edge `mkt-ga4-relatorio`) com o CRM (RPC `mkt_analytics_crm`),
 * em funções puras. A tela só desenha.
 */
import { ALFA, faltam, sequencial, srm, veredito, type Braco, type Comparacao, type Faltam, type Veredito } from './testeAb.ts';

// ---------------------------------------------------------------- formatos que chegam

export type LinhaGa4 = Record<string, string | number>;

export interface ResumoGa4 {
  sessoes: number;
  usuarios: number;
  /** generate_lead enviados (a mesma pessoa pode mandar duas vezes). */
  leads: number;
  /** Pessoas com pelo menos um generate_lead. */
  pessoas_lead: number;
  /** Pessoas que começaram um formulário (form_start). Ausente na edge de antes de 19/11/2026. */
  comecou?: number;
}

export interface RespostaGa4 {
  resumo: ResumoGa4;
  resumo_anterior: ResumoGa4;
  periodo_anterior: { inicio: string; fim: string };
  por_dia_anterior: LinhaGa4[];
  por_dia: LinhaGa4[];
  por_utm: LinhaGa4[];
  por_pagina: LinhaGa4[];
  /** form_start por página de entrada (aba Páginas, 19/11); ausente = edge de antes. */
  comecou_por_pagina?: LinhaGa4[];
  por_canal: LinhaGa4[];
  sites: LinhaGa4[];
  cortado: { por_utm: boolean; por_pagina: boolean };
  experimentos: LinhaGa4[] | null;
  aviso_experimentos: string | null;
  /** Só no pedido com `detalhe` (página de detalhe do teste); null = não pedido ou o GA4 falhou. */
  /** Aba Testes A/B: quem viu cada versão do início até cada dia (`acumulado`), por página, por aparelho e hoje; o form_start por versão. */
  experimentos_detalhe?: { acumulado: LinhaGa4[]; por_pagina: LinhaGa4[]; por_aparelho: LinhaGa4[]; form_start: LinhaGa4[]; hoje: LinhaGa4[] } | null;
}

export interface ContagemCrm {
  leads: number;
  qualificados: number;
  reunioes: number;
  matriculas: number;
}

export interface RespostaCrm {
  por_utm: (ContagemCrm & Record<CampoUtm, string | null>)[];
  por_dia: (ContagemCrm & { dia: string })[];
  por_pagina: (ContagemCrm & { host: string | null; slug: string | null })[];
  experimentos: (ContagemCrm & { exp: string })[];
  /** Leads do teste por dia de chegada (migration 20261118205414). */
  experimentos_dia?: { exp: string; dia: string; leads: number; qualificados: number }[];
  /** Leads do teste por página (`slug` de crm_pagina_slug, ex.: "pos-sa"). */
  experimentos_pagina?: (ContagemCrm & { exp: string; slug: string | null })[];
  /** Saúde do teste: leads das páginas do cadastro desde o 1º lead com versão, e quantos chegaram sem ela. */
  experimentos_sem_versao?: { chave: string; leads: number; sem_versao: number }[];
  /** Leads que não vieram dos sites que o GA4 mede (planilha, Meta, GreatPages…), só em "todos os sites". */
  fora_dos_sites: (ContagemCrm & { origem: string })[];
}

// ---------------------------------------------------------------- linha juntada

export interface Linha extends ContagemCrm {
  /** Pessoas (usuários do GA4). */
  pessoas: number;
  /** Pessoas que enviaram formulário no GA4 (generate_lead), cada uma contada uma vez. */
  leadsGa4: number;
}

const zero = (): Linha => ({ pessoas: 0, leadsGa4: 0, leads: 0, qualificados: 0, reunioes: 0, matriculas: 0 });

/**
 * shortcut: pessoas somadas entre linhas (canal, UTM agrupada) contam duas vezes quem entrou por duas
 * origens no período; o erro é pequeno numa semana. Trocar por uma consulta ao GA4 por agrupamento se incomodar.
 */
function somarGa4(l: Linha, g: LinhaGa4) {
  l.pessoas += Number(g.usuarios ?? 0);
  l.leadsGa4 += Number(g.pessoas_lead ?? 0);
}
function somarCrm(l: Linha, c: ContagemCrm) {
  l.leads += c.leads;
  l.qualificados += c.qualificados;
  l.reunioes += c.reunioes;
  l.matriculas += c.matriculas;
}

/** "(not set)", "(none)", vazio → null; o resto em minúsculo (o CRM guarda minúsculo). */
export function valorUtm(v: unknown): string | null {
  const s = String(v ?? '').trim().toLowerCase();
  return !s || /^\(.*\)$/.test(s) ? null : s;
}

/** Taxa em %, 2 casas na tela; sem denominador, null (a tela mostra "—"). */
export const taxa = (num: number, den: number): number | null => (den > 0 ? (100 * num) / den : null);

// ---------------------------------------------------------------- sites do seletor

/** Nome curto dos sites principais; os outros aparecem pelo endereço. */
const NOME_DO_SITE: Record<string, string> = {
  'site.ppgvet.com.br': 'PPGVET',
  'escoladeespecializacao.ppgvet.com.br': 'Escola',
  'site.ppgeducacao.com.br': 'PPG',
  'blog.ppgvet.com.br': 'Blog',
  'links.ppgvet.com.br': 'Links (linktree)',
};

export interface OpcaoSite {
  host: string;
  rotulo: string;
}

/**
 * Os sites que o GA4 viu no período, do mais visitado ao menos. Fica fora o que não é site no ar
 * (máquina local, prévia da Vercel). O site escolhido entra mesmo sem visita, para o seletor não ficar vazio.
 */
export function sitesDoSeletor(ga4: LinhaGa4[], atual: string | null): OpcaoSite[] {
  const hosts = ga4
    .map((l) => String(l.host ?? '').toLowerCase())
    .filter((h) => h && !/^(localhost|127\.|\[?::1)|\.vercel\.app$/.test(h));
  if (atual && !hosts.includes(atual)) hosts.push(atual);
  return [...new Set(hosts)].map((host) => ({ host, rotulo: NOME_DO_SITE[host] ? `${NOME_DO_SITE[host]} (${host})` : host }));
}

// ---------------------------------------------------------------- por UTM

export const CAMPOS_UTM = ['source', 'medium', 'campaign', 'content', 'term'] as const;
export type CampoUtm = (typeof CAMPOS_UTM)[number];

export type AgrupamentoUtm = 'origem' | 'fonte' | 'meio' | 'campanha' | 'conteudo' | 'termo' | 'tudo';
export const AGRUPAMENTOS_UTM: Record<AgrupamentoUtm, readonly CampoUtm[]> = {
  origem: ['source', 'medium'],
  fonte: ['source'],
  meio: ['medium'],
  campanha: ['campaign'],
  conteudo: ['content'],
  termo: ['term'],
  tudo: CAMPOS_UTM,
};

/** O padrão das UTMs se confere na tela Links com UTM (decisão do usuário, 18/11/2026); aqui só os números. */
export interface LinhaUtm extends Linha {
  chave: Partial<Record<CampoUtm, string | null>>;
}

/**
 * Linha que o CRM não tem como ver: o GA4 marca busca orgânica e indicação de outro site pelo referrer
 * (meio `organic`/`referral`), sem UTM no link, e o lead dessas visitas cai em "sem UTM" no CRM.
 * Sem lead do CRM na linha, a tela mostra "—" em vez de 0 (pedido do usuário, 19/11/2026).
 */
export const semUtmNoCrm = (l: Pick<LinhaUtm, 'chave' | 'leads'>) => l.leads === 0 && ['organic', 'referral'].includes(l.chave.medium ?? '');

/** Página que entra na lista enxuta: 5 pessoas ou mais, ou com algum lead (o resto é robô e página velha). */
export const MIN_PESSOAS_PAGINA = 5;
export const paginaRelevante = (p: Linha) => p.pessoas >= MIN_PESSOAS_PAGINA || p.leads > 0 || p.leadsGa4 > 0;

export function juntarUtm(ga4: LinhaGa4[], crm: RespostaCrm['por_utm'], por: AgrupamentoUtm): LinhaUtm[] {
  const campos = AGRUPAMENTOS_UTM[por];
  const mapa = new Map<string, LinhaUtm>();
  const pegar = (valores: Partial<Record<CampoUtm, unknown>>) => {
    const chave = Object.fromEntries(campos.map((k) => [k, valorUtm(valores[k])]));
    const id = campos.map((k) => chave[k] ?? '∅').join('|');
    let l = mapa.get(id);
    if (!l) mapa.set(id, (l = { ...zero(), chave }));
    return l;
  };
  for (const g of ga4) somarGa4(pegar(g), g);
  for (const c of crm) somarCrm(pegar(c), c);
  return [...mapa.values()].sort((a, b) => b.pessoas - a.pessoas || b.leads - a.leads);
}

// ---------------------------------------------------------------- por página

/**
 * Espelho de `public.crm_pagina_slug` (o banco): a página é o último pedaço do caminho; a home de um
 * subdomínio nosso é o subdomínio ("site", "escoladeespecializacao").
 * ⚠️ NÃO é o `normalizePageSlug` do front, que hoje diverge do banco (home vira null). Mudou o SQL, mude aqui.
 */
export function slugDaPagina(p: string | null | undefined): string | null {
  const s = (p ?? '').replace(/^https?:\/\//i, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  let out: string;
  if (!s.includes('/') && /^[a-z0-9-]+\.ppg(vet|educacao)\.com\.br$/i.test(s) && !['www', 'app', 'sistema', 'sistemappgvet'].includes(s.split('.')[0].toLowerCase())) {
    out = s.split('.')[0];
  } else if (s.includes('/')) {
    out = s.replace(/^.*\//, '').replace(/\.[a-z0-9]+$/i, '');
  } else out = s;
  return out.toLowerCase() || null;
}

const semWww = (h: string | null | undefined) => (h ? h.toLowerCase().replace(/^www\./, '') : null);

export interface LinhaPagina extends Linha {
  host: string | null;
  slug: string | null;
  /** Caminho como o GA4 mostra (o primeiro visto), para o link. */
  caminho: string | null;
  /** Visitas que entraram pela página (com a rejeição medida) e, delas, as não engajadas (bounceRate × visitas, para somar endereços da mesma página). */
  sessoes: number;
  rejeitadas: number;
  /** Pessoas que entraram pela página e começaram um formulário na visita (form_start). */
  comecou: number;
}

/** Rejeição em % (visitas não engajadas ÷ visitas); sem visita, null. */
export const rejeicao = (p: Pick<LinhaPagina, 'sessoes' | 'rejeitadas'>) => taxa(p.rejeitadas, p.sessoes);

export function juntarPaginas(ga4: LinhaGa4[], crm: RespostaCrm['por_pagina'], comecou: LinhaGa4[] = []): LinhaPagina[] {
  const mapa = new Map<string, LinhaPagina>();
  const pegar = (host: string | null, slug: string | null, caminho: string | null) => {
    const id = `${host ?? ''}|${slug ?? ''}`;
    let l = mapa.get(id);
    if (!l) mapa.set(id, (l = { ...zero(), host, slug, caminho, sessoes: 0, rejeitadas: 0, comecou: 0 }));
    if (!l.caminho && caminho) l.caminho = caminho;
    return l;
  };
  for (const g of ga4) {
    const host = semWww(String(g.host ?? ''));
    const caminho = String(g.pagina ?? '');
    if (caminho === '(not set)') continue;
    const l = pegar(host, slugDaPagina(`${host}${caminho}`), caminho);
    somarGa4(l, g);
    // Sem `rejeicao` (edge de antes) a visita não entra na conta: a tela mostra "—", não 0%.
    if (g.rejeicao !== undefined) {
      l.sessoes += Number(g.sessoes ?? 0);
      l.rejeitadas += Number(g.sessoes ?? 0) * Number(g.rejeicao);
    }
  }
  for (const g of comecou) {
    const host = semWww(String(g.host ?? ''));
    const caminho = String(g.pagina ?? '');
    if (caminho === '(not set)') continue;
    pegar(host, slugDaPagina(`${host}${caminho}`), caminho).comecou += Number(g.usuarios ?? 0);
  }
  for (const c of crm) somarCrm(pegar(semWww(c.host), c.slug, null), c);
  return [...mapa.values()].sort((a, b) => b.pessoas - a.pessoas || b.leads - a.leads);
}

// ---------------------------------------------------------------- por dia

export interface LinhaDia extends Linha {
  dia: string;
}

/** Todos os dias do período, inclusive os zerados (o gráfico não pula dia). */
export function juntarDias(inicio: string, fim: string, ga4: LinhaGa4[], crm: RespostaCrm['por_dia']): LinhaDia[] {
  const mapa = new Map<string, LinhaDia>();
  for (let d = new Date(`${inicio}T12:00:00Z`); d <= new Date(`${fim}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    const dia = d.toISOString().slice(0, 10);
    mapa.set(dia, { ...zero(), dia });
  }
  for (const g of ga4) {
    const l = mapa.get(String(g.dia));
    if (l) somarGa4(l, g);
  }
  for (const c of crm) {
    const l = mapa.get(c.dia);
    if (l) somarCrm(l, c);
  }
  return [...mapa.values()];
}

/** O dia a dia atual com o do período anterior ao lado, alinhados pela posição (1º dia com 1º dia). */
export function comAnterior(dias: LinhaDia[], anteriores: LinhaDia[]) {
  return dias.map((d, i) => {
    const a = anteriores[i];
    return {
      ...d,
      taxa: taxa(d.leads, d.pessoas),
      taxaGa4: taxa(d.leadsGa4, d.pessoas),
      ant_pessoas: a ? a.pessoas : null,
      ant_leads: a ? a.leads : null,
      ant_taxa: a ? taxa(a.leads, a.pessoas) : null,
    };
  });
}

/** Variação em % contra o período anterior; null quando não há base (sem dado antes, ou zero). */
export const variacao = (atual: number, anterior: number | null | undefined): number | null =>
  anterior ? (100 * (atual - anterior)) / anterior : null;

export interface Etapa {
  nome: string;
  valor: number;
  /** O mesmo número no período anterior; null quando não há dado (o GA4 só tem dado desde 21/10/2026). */
  anterior: number | null;
}

/** O funil da Visão geral: pessoas → começou o formulário (GA4) → leads → qualificados → reunião → matrícula (CRM). */
export function funil(ga4: ResumoGa4, crm: ContagemCrm, ga4Ant: ResumoGa4 | null, crmAnt: ContagemCrm | null): Etapa[] {
  const g = ga4Ant && ga4Ant.usuarios > 0 ? ga4Ant : null;
  return [
    { nome: 'Pessoas', valor: ga4.usuarios, anterior: g ? g.usuarios : null },
    { nome: 'Começou o formulário', valor: ga4.comecou ?? 0, anterior: g ? g.comecou ?? null : null },
    { nome: 'Leads', valor: crm.leads, anterior: crmAnt ? crmAnt.leads : null },
    { nome: 'Qualificados', valor: crm.qualificados, anterior: crmAnt ? crmAnt.qualificados : null },
    { nome: 'Reunião realizada', valor: crm.reunioes, anterior: crmAnt ? crmAnt.reunioes : null },
    { nome: 'Matrícula', valor: crm.matriculas, anterior: crmAnt ? crmAnt.matriculas : null },
  ];
}

/**
 * Quem começou o formulário e não mandou (as duas contas do GA4: form_start − generate_lead, por pessoa).
 * Nunca abaixo de zero: formulário que manda sem disparar o form_start daria desistência negativa.
 */
export function desistencia(ga4: ResumoGa4): { pessoas: number; taxa: number | null } {
  const comecou = ga4.comecou ?? 0;
  const pessoas = Math.max(0, comecou - ga4.pessoas_lead);
  return { pessoas, taxa: comecou > 0 ? (100 * pessoas) / comecou : null };
}

export const totalCrm = (dias: RespostaCrm['por_dia']): ContagemCrm =>
  dias.reduce((t, c) => ({
    leads: t.leads + c.leads,
    qualificados: t.qualificados + c.qualificados,
    reunioes: t.reunioes + c.reunioes,
    matriculas: t.matriculas + c.matriculas,
  }), { leads: 0, qualificados: 0, reunioes: 0, matriculas: 0 });

// ---------------------------------------------------------------- testes A/B

export interface ComparacaoAb {
  /** Rótulo da linha: a pós (teste antigo) ou a chave do teste. */
  nome: string;
  versaoA: string;
  versaoB: string;
  a: Linha;
  b: Linha;
  /** Pessoas que viram cada versão (experience_impression no GA4). */
  expostos: [number, number];
  /** Lead confirmado no CRM ÷ expostos (sessões no teste antigo). */
  lead: Comparacao & { veredito: Veredito; q: number };
  /** Lead qualificado: a GUARDA (a B não pode trazer lead pior). */
  qualificado: Comparacao & { veredito: Veredito; q: number };
  matricula: Comparacao & { veredito: Veredito; q: number };
  /** p do SRM (divisão torta); < 0,001 = parar. */
  pSrm: number | null;
  /** "Faltam ~X pessoas" enquanto a primária não tem resposta; null quando já tem (ganha ou perde). */
  faltam: Faltam | null;
  avisos: string[];
}

/**
 * `dias` = dias do período (ritmo do "faltam"); `diasDeTeste` = dias desde o início do teste no cadastro (regra dos 7 dias).
 * Guarda (qualificado) avaliada SOZINHA e matrícula só o número (doc do Optimizely lida em 18/11: monitoramento não
 * divide o alarme; conversão que demora não se lê com o teste rodando). Mesma regra do `ler` do ab.mjs.
 */
function comparar(nome: string, versaoA: string, versaoB: string, a: Linha, b: Linha, expostos: (l: Linha) => number, comSrm: boolean, dias: number, diasDeTeste: number, pesoA = 0.5): ComparacaoAb {
  const n = (l: Linha, conv: number): Braco => ({ n: expostos(l), conv });
  const lead = sequencial(n(a, a.leads), n(b, b.leads));
  const qual = sequencial(n(a, a.qualificados), n(b, b.qualificados));
  const mat = sequencial(n(a, a.matriculas), n(b, b.matriculas));
  const avisos: string[] = [];
  const pSrm = comSrm ? srm(expostos(a), expostos(b), pesoA) : null;
  if (pSrm !== null && pSrm < 0.001) avisos.push(`Divisão torta: ${expostos(a)} × ${expostos(b)} não bate com o sorteio (${Math.round(100 * pesoA)}/${Math.round(100 * (1 - pesoA))}). Parar e achar a causa antes de ler qualquer número.`);
  // A guarda manda parar mesmo antes dos 7 dias: proteger o lead bom não espera a semana fechar.
  const vQual = veredito(n(a, a.qualificados), n(b, b.qualificados), qual.p, qual.rel);
  if (vQual === 'b-perde') avisos.push('Lead qualificado piorou na B: parar o teste.');
  const vLead = veredito(n(a, a.leads), n(b, b.leads), lead.p, lead.rel, diasDeTeste);
  const porDia = dias > 0 ? Math.min(expostos(a), expostos(b)) / dias : 0;
  return {
    nome, versaoA, versaoB, a, b, pSrm, avisos, expostos: [expostos(a), expostos(b)],
    faltam: vLead === 'b-ganha' || vLead === 'b-perde' ? null : faltam(n(a, a.leads), n(b, b.leads), porDia),
    lead: { ...lead, q: lead.p, veredito: vLead },
    qualificado: { ...qual, q: qual.p, veredito: vQual },
    // Só o número: a matrícula se lê 30 dias depois do fim do teste.
    matricula: { ...mat, q: mat.p, veredito: 'sem-resposta' },
  };
}

/**
 * Os testes por sorteio: `PPG-<chave>-<versao>` no GA4 (quem viu) e no CRM (o lead). A controle é a versão "a".
 * `dias` = dias do período, para o ritmo do "faltam ~X"; `diasDeTeste` = dias desde o início de cada teste (cadastro),
 * para a regra dos 7 dias. Sem cadastro, conta o período. `pesoA` = peso da controle no sorteio (cadastro; sem ele, 50%).
 */
export function testesPorSorteio(ga4: LinhaGa4[], crm: RespostaCrm['experimentos'], dias = 0, diasDeTeste: Record<string, number> = {}, pesoA: Record<string, number> = {}): ComparacaoAb[] {
  const testes = new Map<string, Map<string, Linha & { usuarios: number }>>();
  const pegar = (exp: string) => {
    const m = /^PPG-(.+)-([a-z0-9]+)$/i.exec(exp.trim());
    if (!m) return null;
    const [, chave, versao] = m;
    if (!testes.has(chave)) testes.set(chave, new Map());
    const vs = testes.get(chave)!;
    if (!vs.has(versao.toLowerCase())) vs.set(versao.toLowerCase(), { ...zero(), usuarios: 0 });
    return vs.get(versao.toLowerCase())!;
  };
  for (const g of ga4) {
    const l = pegar(String(g.exp ?? ''));
    if (l) l.usuarios += Number(g.usuarios ?? 0);
  }
  for (const c of crm) {
    const l = pegar(c.exp);
    if (l) somarCrm(l, c);
  }
  const out: ComparacaoAb[] = [];
  for (const [chave, vs] of [...testes].sort(([x], [y]) => x.localeCompare(y))) {
    const nomes = [...vs.keys()].sort();
    const controle = nomes.includes('a') ? 'a' : nomes[0];
    for (const v of nomes.filter((n) => n !== controle)) {
      out.push(comparar(chave, controle, v, vs.get(controle)!, vs.get(v)!, (l) => (l as Linha & { usuarios: number }).usuarios, true, dias, diasDeTeste[chave] ?? dias, pesoA[chave]));
    }
  }
  return out;
}

// ---------------------------------------------------------------- ordenação das tabelas

export type Valor = number | string | null;

/** Ordena uma cópia pela coluna; vazio (null, "—") sempre no fim, nas duas direções. Texto em ordem do português. */
export function ordenar<T>(linhas: T[], valor: (l: T) => Valor, desc: boolean): T[] {
  return [...linhas].sort((x, y) => {
    const a = valor(x), b = valor(y);
    if (a === null || a === '') return b === null || b === '' ? 0 : 1;
    if (b === null || b === '') return -1;
    const c = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), 'pt-BR');
    return desc ? -c : c;
  });
}

export { ALFA };

/**
 * Link que abre a versão de um teste sem sortear e sem contar exposição (`?ab=` do `experimentos.ts`
 * dos sites). Mantém a query que a página já tiver.
 */
export function linkDaVersao(pagina: string, chave: string, versao: string): string {
  const u = new URL(pagina);
  u.searchParams.set('ab', `${chave}:${versao}`);
  return u.toString().replace('%3A', ':');
}
