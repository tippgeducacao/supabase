/**
 * Lista e detalhe dos testes A/B por sorteio (aba Testes A/B do Analytics), no jeito do Optimizely
 * (decisão do usuário, 18/11/2026; régua no plan.md e na skill teste-ab-site). Funções puras: a tela só desenha.
 *
 * - Confiável? = 3 checagens: 7 dias completos · 100 pessoas e 25 leads por versão · divisão certa (SRM, dia a dia).
 * - Antes das 3: só as conversões e "faltam ~X pessoas". Diferença, faixa e certeza só depois.
 * - Certeza que não volta atrás: `acompanhar` sobre a série ACUMULADA (pessoas do GA4 e leads do CRM até cada dia).
 * - Período de cada teste: do início até hoje (hoje ainda parcial). Os rótulos `PPG-<chave>-<versao>` só existem
 *   enquanto o teste roda, então buscar desde o início do teste mais antigo conta certo cada um.
 */
import type { ComparacaoAb, ContagemCrm, LinhaGa4, RespostaCrm, RespostaGa4 } from './mktAnalytics.ts';
import { testesPorSorteio } from './mktAnalytics.ts';
import { ALFA, acompanhar, srm, type Comparacao } from './testeAb.ts';

/** Cadastro de um teste A/B (tabela `mkt_testes_ab`, migration 20261118201659). Só leitura aqui. */
export interface TesteAb {
  chave: string;
  nome: string;
  hipotese: string;
  situacao: 'rodando' | 'encerrado';
  versoes: string[];
  /** URLs das páginas do teste; cada versão abre com `?ab=<chave>:<versao>`. */
  paginas: string[];
  inicio: string;
  fim: string | null;
  resultado: string | null;
  /** Peso de cada versão no sorteio (migration 20261119122756). */
  pesos: Record<string, number>;
  /** Plano do `ab.mjs plano` ao ligar: pessoas POR VERSÃO para ver `efeito`; null = sem plano. */
  plano: { efeito: number; base: number; pessoas: number; semanas: number } | null;
}

export const MIN_DIAS = 7;
export const MIN_PESSOAS = 100;
export const MIN_LEADS = 25;
/** A certeza que decide (90%, o padrão do Optimizely; ALFA de testeAb.ts). */
export const CERTEZA_ALVO = 1 - ALFA;
/** "Versão sem ninguém hoje" só acende quando a outra já teve gente (madrugada vazia não é alarme). */
const MIN_HOJE = 5;

export type Situacao = 'coletando' | 'pouco-dado' | 'b-ganha' | 'b-perde' | 'sem-resposta' | 'inconclusivo' | 'alerta';

export const ROTULO_SITUACAO: Record<Situacao, string> = {
  coletando: 'Coletando',
  'pouco-dado': 'Pouco dado ainda',
  'b-ganha': 'B ganha',
  'b-perde': 'B perde',
  'sem-resposta': 'Ainda não dá para saber',
  inconclusivo: 'Inconclusivo',
  alerta: 'Alerta',
};

const ROTULO_APARELHO: Record<string, string> = { desktop: 'Computador', mobile: 'Celular', tablet: 'Tablet', 'smart tv': 'TV' };

const DIA_MS = 864e5;
const utc = (ymd: string) => Date.parse(`${ymd}T00:00:00Z`);

/** Dias COMPLETOS de teste: do início até ontem (hoje ainda está correndo). */
export function diasCompletos(inicio: string, hoje: string): number {
  return Math.max(0, Math.round((utc(hoje) - utc(inicio)) / DIA_MS));
}

const diaSeguinte = (ymd: string) => new Date(utc(ymd) + DIA_MS).toISOString().slice(0, 10);

/** Dias completos de um teste (encerrado: até o fim, inclusive). */
export const diasDoTeste = (t: Pick<TesteAb, 'inicio' | 'fim'>, hoje: string) => diasCompletos(t.inicio, t.fim ? diaSeguinte(t.fim) : hoje);

export interface Checagens {
  dias: { ok: boolean; valor: number };
  minimo: { ok: boolean; pessoas: [number, number]; leads: [number, number] };
  /** Divisão sem SRM (p ≥ 0,001) em todos os dias; `pctA` = parte da A entre os expostos; `desde` = 1º dia torto. */
  divisao: { ok: boolean; pctA: number | null; pesoA: number; desde: string | null };
  todas: boolean;
}

export function checagens(c: ComparacaoAb | null, dias: number, pesoA = 0.5, tortoDesde: string | null = null): Checagens {
  const pessoas: [number, number] = c ? c.expostos : [0, 0];
  const leads: [number, number] = c ? [c.a.leads, c.b.leads] : [0, 0];
  const total = pessoas[0] + pessoas[1];
  const dOk = dias >= MIN_DIAS;
  const mOk = Math.min(...pessoas) >= MIN_PESSOAS && Math.min(...leads) >= MIN_LEADS;
  const sOk = !tortoDesde && (!c || c.pSrm === null || c.pSrm >= 0.001);
  return {
    dias: { ok: dOk, valor: dias },
    minimo: { ok: mOk, pessoas, leads },
    divisao: { ok: sOk, pctA: total > 0 ? pessoas[0] / total : null, pesoA, desde: tortoDesde },
    todas: dOk && mOk && sOk,
  };
}

/**
 * A situação do teste. `leitura` = a que não volta atrás (sem série, a de hoje). Inconclusivo: encerrado sem resposta,
 * ou já passou das pessoas do plano sem resposta (o "faltam" pede mais do que o plano previa).
 */
export function situacao(
  c: ComparacaoAb | null, ch: Checagens, encerrado: boolean,
  leitura: Pick<Comparacao, 'p' | 'rel'> | null = c?.lead ?? null, plano: TesteAb['plano'] = null,
): Situacao {
  if (!c || c.expostos[0] + c.expostos[1] === 0) return encerrado ? 'inconclusivo' : 'coletando';
  if (c.avisos.length || !ch.divisao.ok) return 'alerta';
  if (!ch.todas) return encerrado ? 'inconclusivo' : 'pouco-dado';
  if (leitura && leitura.p < ALFA) return leitura.rel > 0 ? 'b-ganha' : 'b-perde';
  if (encerrado || (plano && Math.min(...c.expostos) >= plano.pessoas)) return 'inconclusivo';
  return 'sem-resposta';
}

/**
 * O progresso da lista: antes das 3 checagens, quanto do mínimo já tem (o que falta mais pesa: dias,
 * pessoas ou leads); depois, a certeza. Nunca "visitas contra meta fixa".
 */
export function progresso(ch: Checagens, certeza: number | null): { tipo: 'minimo' | 'certeza'; valor: number } {
  if (!ch.todas || certeza === null) {
    const v = Math.min(
      ch.dias.valor / MIN_DIAS,
      Math.min(...ch.minimo.pessoas) / MIN_PESSOAS,
      Math.min(...ch.minimo.leads) / MIN_LEADS,
    );
    return { tipo: 'minimo', valor: Math.max(0, Math.min(1, v)) };
  }
  return { tipo: 'certeza', valor: Math.max(0, Math.min(1, certeza)) };
}

export interface VersaoDetalhe extends ContagemCrm {
  versao: string;
  pessoas: number;
  /** Pessoas que começaram o formulário (form_start com a versão); null = o GA4 não trouxe. */
  comecou: number | null;
  /** Leads (CRM) ÷ pessoas: a que decide. */
  conversao: number | null;
}

/** Um ponto da série: do início do teste até `dia`. */
export interface DiaAb {
  dia: string;
  /** Conversão ACUMULADA por versão (leads do CRM ÷ pessoas do GA4 até o dia); null sem pessoas. */
  conversao: Record<string, number | null>;
}

export interface PosAb {
  pos: string;
  pessoas: Record<string, number>;
  leads: Record<string, number>;
  conversao: Record<string, number | null>;
}

export interface AparelhoAb {
  aparelho: string;
  pessoas: Record<string, number>;
}

export interface Saude {
  /** Leads das páginas do teste desde o 1º lead com versão; null = o CRM não trouxe. */
  semVersao: { leads: number; sem: number } | null;
  /** Pessoas de hoje por versão; null = o GA4 não trouxe. */
  hoje: Record<string, number> | null;
  /** Versões sem ninguém hoje enquanto a outra já teve gente. */
  semNinguemHoje: string[];
}

export interface DetalheAb {
  comparacao: ComparacaoAb | null;
  versoes: VersaoDetalhe[];
  checagens: Checagens;
  situacao: Situacao;
  /** A leitura que vale (a que não volta atrás quando há série; senão a de hoje). */
  leitura: (Comparacao & { recomecou: string | null }) | null;
  /** 1 − p da leitura; null antes das 3 checagens. */
  certeza: number | null;
  progresso: { tipo: 'minimo' | 'certeza'; valor: number };
  avisos: string[];
  saude: Saude;
  porDia: DiaAb[];
  porPos: PosAb[];
  porAparelho: AparelhoAb[];
}

const escapar = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Versão do rótulo `PPG-<chave>-<versao>` desta chave; null se for de outro teste (chave que é prefixo de outra). */
export function versaoDoRotulo(chave: string, rotulo: unknown): string | null {
  const m = new RegExp(`^PPG-${escapar(chave)}-([a-z0-9]+)$`, 'i').exec(String(rotulo ?? '').trim());
  return m ? m[1].toLowerCase() : null;
}

const taxa = (conv: number, n: number) => (n > 0 ? conv / n : null);
const sigla = (caminho: unknown) => /^\/?pos-([a-z0-9]+)/i.exec(String(caminho ?? ''))?.[1]?.toLowerCase() ?? null;
const data = (ymd: string) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`;

/** Soma `usuarios` (ou o campo pedido) das linhas desta chave, por versão. */
function porVersao<T>(chave: string, linhas: T[] | undefined, valor: (l: T) => number, exp: (l: T) => unknown, filtro: (l: T) => boolean = () => true) {
  const out: Record<string, number> = {};
  for (const l of linhas ?? []) {
    const v = versaoDoRotulo(chave, exp(l));
    if (v && filtro(l)) out[v] = (out[v] ?? 0) + valor(l);
  }
  return out;
}

export function montarDetalhe(
  teste: Pick<TesteAb, 'chave' | 'versoes' | 'inicio' | 'fim' | 'situacao'> & Partial<Pick<TesteAb, 'pesos' | 'plano'>>,
  ga4: RespostaGa4 | undefined,
  crm: RespostaCrm | undefined,
  hoje: string,
): DetalheAb {
  const { chave, versoes: vs } = teste;
  const [A, B] = vs;
  const ate = teste.fim ?? hoje;
  const dias = diasDoTeste(teste, hoje);
  const pesoA = teste.pesos?.[A] ?? 0.5;
  const encerrado = teste.situacao === 'encerrado';
  const comparacao = testesPorSorteio(ga4?.experimentos ?? [], crm?.experimentos ?? [], Math.max(1, dias), { [chave]: dias }, { [chave]: pesoA })
    .find((c) => c.nome === chave) ?? null;
  const det = ga4?.experimentos_detalhe ?? null;
  const usuarios = (l: LinhaGa4) => Number(l.usuarios ?? 0);
  const expDe = <T extends { exp?: unknown }>(l: T) => l.exp;

  // Série acumulada: os dias que a edge trouxe (pessoas do início até o dia) + os leads do CRM até o dia.
  const pontos = [...new Set((det?.acumulado ?? []).map((l) => String(l.dia)))].filter((d) => d >= teste.inicio && d <= ate).sort();
  const serie = pontos.map((dia) => ({
    dia,
    n: porVersao(chave, det?.acumulado, usuarios, expDe, (l) => l.dia === dia),
    conv: porVersao(chave, crm?.experimentos_dia, (l) => l.leads, expDe, (l) => l.dia <= dia),
  }));
  const braco = (d: (typeof serie)[number], v: string) => ({ n: d.n[v] ?? 0, conv: d.conv[v] ?? 0 });
  const acomp = A && B && serie.length ? acompanhar(serie.map((d) => ({ a: braco(d, A), b: braco(d, B) }))) : null;
  const leitura = acomp
    ? { ...acomp, recomecou: acomp.recomecou === null ? null : serie[acomp.recomecou].dia }
    : comparacao ? { ...comparacao.lead, recomecou: null } : null;
  const torto = A && B ? serie.find((d) => (d.n[A] ?? 0) + (d.n[B] ?? 0) > 0 && srm(d.n[A] ?? 0, d.n[B] ?? 0, pesoA) < 0.001) : undefined;

  const ch = checagens(comparacao, dias, pesoA, torto?.dia ?? null);
  const certeza = ch.todas && leitura ? 1 - leitura.p : null;
  const avisos = (comparacao?.avisos ?? []).filter((x) => !(torto && x.startsWith('Divisão torta')));
  if (torto) {
    avisos.unshift(`Divisão torta desde ${data(torto.dia)}: ${torto.n[A] ?? 0} × ${torto.n[B] ?? 0} não bate com o sorteio. Parar e achar a causa antes de ler qualquer número.`);
  }
  if (leitura?.recomecou) avisos.push(`A leitura recomeçou em ${data(leitura.recomecou)}: o efeito saiu da faixa (mudança no meio ou época diferente).`);

  // Campo ausente = edge de antes (sem o detalhe novo): null, não zero.
  const form = det?.form_start ? porVersao(chave, det.form_start, usuarios, expDe) : null;
  const versoes: VersaoDetalhe[] = vs.map((v) => {
    const lado = comparacao ? (v === comparacao.versaoA ? comparacao.a : v === comparacao.versaoB ? comparacao.b : null) : null;
    const pessoas = comparacao ? (v === comparacao.versaoA ? comparacao.expostos[0] : comparacao.expostos[1]) : 0;
    const c = lado ?? { leads: 0, qualificados: 0, reunioes: 0, matriculas: 0 };
    return {
      versao: v, pessoas, comecou: form ? form[v] ?? 0 : null,
      leads: c.leads, qualificados: c.qualificados, reunioes: c.reunioes, matriculas: c.matriculas,
      conversao: taxa(c.leads, pessoas),
    };
  });

  const porDia: DiaAb[] = serie.map((d) => ({
    dia: d.dia,
    conversao: Object.fromEntries(vs.map((v) => [v, taxa(d.conv[v] ?? 0, d.n[v] ?? 0)])),
  }));

  const pos = new Map<string, PosAb>();
  const linhaPos = (s: string) => {
    if (!pos.has(s)) pos.set(s, { pos: s, pessoas: {}, leads: {}, conversao: {} });
    return pos.get(s)!;
  };
  for (const l of det?.por_pagina ?? []) {
    const v = versaoDoRotulo(chave, l.exp), s = sigla(l.caminho);
    if (v && s) linhaPos(s).pessoas[v] = (linhaPos(s).pessoas[v] ?? 0) + usuarios(l);
  }
  for (const l of crm?.experimentos_pagina ?? []) {
    const v = versaoDoRotulo(chave, l.exp), s = sigla(l.slug);
    if (v && s) linhaPos(s).leads[v] = (linhaPos(s).leads[v] ?? 0) + l.leads;
  }
  const total = (p: Record<string, number>) => Object.values(p).reduce((a, b) => a + b, 0);
  const porPos = [...pos.values()]
    .map((p) => ({ ...p, conversao: Object.fromEntries(vs.map((v) => [v, taxa(p.leads[v] ?? 0, p.pessoas[v] ?? 0)])) }))
    .sort((x, y) => total(y.pessoas) - total(x.pessoas) || x.pos.localeCompare(y.pos));

  const aparelhos = new Map<string, AparelhoAb>();
  for (const l of det?.por_aparelho ?? []) {
    const v = versaoDoRotulo(chave, l.exp);
    if (!v) continue;
    const nome = ROTULO_APARELHO[String(l.aparelho ?? '').toLowerCase()] ?? String(l.aparelho ?? 'Outro');
    if (!aparelhos.has(nome)) aparelhos.set(nome, { aparelho: nome, pessoas: {} });
    const a = aparelhos.get(nome)!;
    a.pessoas[v] = (a.pessoas[v] ?? 0) + usuarios(l);
  }
  const porAparelho = [...aparelhos.values()].sort((x, y) => total(y.pessoas) - total(x.pessoas));

  const sv = crm?.experimentos_sem_versao?.find((x) => x.chave === chave);
  const deHoje = det?.hoje ? porVersao(chave, det.hoje, usuarios, expDe) : null;
  const maxHoje = deHoje ? Math.max(0, ...vs.map((v) => deHoje[v] ?? 0)) : 0;
  const saude: Saude = {
    semVersao: crm?.experimentos_sem_versao ? { leads: sv?.leads ?? 0, sem: sv?.sem_versao ?? 0 } : null,
    hoje: deHoje && Object.fromEntries(vs.map((v) => [v, deHoje[v] ?? 0])),
    semNinguemHoje: deHoje && !encerrado && maxHoje >= MIN_HOJE ? vs.filter((v) => (deHoje[v] ?? 0) === 0) : [],
  };

  return {
    comparacao, versoes, checagens: ch, leitura, certeza, avisos, saude, porDia, porPos, porAparelho,
    situacao: situacao(comparacao, ch, encerrado, leitura, teste.plano ?? null),
    progresso: progresso(ch, certeza),
  };
}
