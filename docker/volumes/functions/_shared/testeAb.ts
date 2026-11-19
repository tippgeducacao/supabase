/**
 * Leitura de teste A/B no método do Optimizely: estatística sequencial (mSPRT, pode olhar todo dia),
 * Benjamini-Hochberg nas métricas secundárias e alerta de divisão torta (SRM).
 *
 * ⚠️ É a MESMA conta do `ab.mjs` da skill `teste-ab-site` (~/.claude/skills/teste-ab-site), que é a
 * oficial para encerrar teste; o teste deste arquivo usa os números de lá. Mudou um, mude o outro.
 */

export const ALFA = 0.1; // 90% de significância, o padrão do Optimizely.

/** Φ, aproximação de Zelen e Severo (erro < 1e-7). */
function fi(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

export interface Faltam {
  /** Pessoas que ainda faltam em CADA versão (estimativa). */
  pessoas: number;
  /** Semanas no ritmo atual; null quando não há ritmo para estimar. */
  semanas: number | null;
}

/**
 * "Faltam ~X pessoas por versão" pela PRÓPRIA conta sequencial (doc do Optimizely: calculadora de horizonte fixo "will
 * not give you an accurate estimate"). Supõe que as taxas de hoje se mantêm: é a pessoa em que a conta cruza 90% se nada
 * mudar (estimativa, muda quando a taxa muda). Diferença menor que 5% usa 5%: abaixo disso o nosso tráfego não mede.
 * Mesma conta do `faltamSequencial` do ab.mjs (skill teste-ab-site); o teste usa os números de lá.
 */
export function faltam(a: Braco, b: Braco, porDiaPorVersao: number): Faltam | null {
  const pa = a.conv / a.n, pb = b.conv / b.n;
  if (!(a.n > 0 && b.n > 0) || !(pa > 0)) return null;
  const rel = Math.abs((pb - pa) / pa) < 0.05 ? (pb >= pa ? 0.05 : -0.05) : (pb - pa) / pa;
  const cruza = (n: number) => sequencial({ n, conv: n * pa }, { n, conv: n * pa * (1 + rel) }).p < ALFA;
  let hi = 100;
  while (!cruza(hi) && hi < 1e7) hi *= 2;
  let lo = hi / 2;
  while (hi - lo > 1) {
    const m = Math.floor((lo + hi) / 2);
    if (cruza(m)) hi = m; else lo = m;
  }
  const pessoas = Math.max(0, hi - Math.min(a.n, b.n));
  return { pessoas, semanas: porDiaPorVersao > 0 ? Math.ceil(pessoas / porDiaPorVersao / 7) : null };
}

export interface Braco {
  /** Visitantes expostos (ou sessões, no teste antigo por URL). */
  n: number;
  /** Conversões. */
  conv: number;
}

export interface Comparacao {
  pa: number;
  pb: number;
  /** Efeito relativo da B sobre a A (0,1 = +10%). */
  rel: number;
  /** p-valor sempre válido (pode espiar). */
  p: number;
  /** Intervalo do efeito relativo, no mesmo nível. */
  ic: [number, number];
}

/**
 * mSPRT de Johari, Pekelis e Walsh com mistura normal N(0, τ²) sobre a diferença de taxas.
 * shortcut: τ = 25% da taxa da A (espera efeitos grandes); o Optimizely calibra τ pelo histórico,
 * trocar quando houver 10+ testes registrados (mesma nota do ab.mjs).
 */
export function sequencial(a: Braco, b: Braco, alfa = ALFA): Comparacao {
  const pa = a.conv / a.n, pb = b.conv / b.n, d = pb - pa;
  const pm = (a.conv + b.conv) / (a.n + b.n);
  const tau2 = (0.25 * Math.max(pa, 1 / a.n)) ** 2;
  const s2 = Math.max(pm * (1 - pm), 1e-9) * (1 / a.n + 1 / b.n);
  const lambda = Math.sqrt(s2 / (s2 + tau2)) * Math.exp((tau2 * d * d) / (2 * s2 * (s2 + tau2)));
  const s2ic = Math.max(pa * (1 - pa), 1e-9) / a.n + Math.max(pb * (1 - pb), 1e-9) / b.n;
  const meia = Math.sqrt(((s2ic * (s2ic + tau2)) / tau2) * Math.log((s2ic + tau2) / (s2ic * alfa * alfa)));
  return { pa, pb, rel: pa ? d / pa : NaN, p: Math.min(1, 1 / lambda), ic: [(d - meia) / pa, (d + meia) / pa] };
}

export interface Leitura extends Comparacao {
  /** Índice do dia em que a leitura recomeçou (o efeito saiu da faixa cruzada); null = nunca. */
  recomecou: number | null;
}

/**
 * A leitura que não volta atrás (doc do Optimizely: "running intersection of all previous confidence intervals" e "the
 * largest statistical significance value"). `serie` = um ponto por dia, ACUMULADO. Se o efeito de hoje sai da faixa
 * cruzada, a leitura recomeça daquele dia ("stats reset": sazonalidade ou mudança no meio). Mesma conta do
 * `acompanhar` do ab.mjs; o teste usa os números de lá.
 */
export function acompanhar(serie: { a: Braco; b: Braco }[], alfa = ALFA): Leitura | null {
  let ic: [number, number] | null = null, p = 1, recomecou: number | null = null, atual: Comparacao | null = null;
  serie.forEach((d, i) => {
    if (!(d.a.n > 0 && d.b.n > 0)) return;
    atual = sequencial(d.a, d.b, alfa);
    if (!Number.isFinite(atual.rel) || !Number.isFinite(atual.ic[0])) return;
    if (ic && (atual.rel < ic[0] || atual.rel > ic[1])) { ic = null; p = 1; recomecou = i; }
    ic = ic ? [Math.max(ic[0], atual.ic[0]), Math.min(ic[1], atual.ic[1])] : [atual.ic[0], atual.ic[1]];
    p = Math.min(p, atual.p);
  });
  const ultima = atual as Comparacao | null;
  return ultima && { ...ultima, p, ic: ic ?? ultima.ic, recomecou };
}

/** SRM: a divisão real foge do peso combinado? p < 0,001 = sorteio ou medição quebrados. */
export function srm(na: number, nb: number, pesoA = 0.5): number {
  const n = na + nb, z = (na - n * pesoA) / Math.sqrt(n * pesoA * (1 - pesoA));
  return 2 * (1 - fi(Math.abs(z)));
}

/** Benjamini-Hochberg: q-valores na ordem de entrada. */
export function bh(ps: number[]): number[] {
  const ordem = ps.map((p, i) => [p, i] as const).sort((x, y) => x[0] - y[0]);
  const q = Array<number>(ps.length);
  let min = 1;
  for (let r = ordem.length; r >= 1; r--) {
    min = Math.min(min, (ordem[r - 1][0] * ps.length) / r);
    q[ordem[r - 1][1]] = min;
  }
  return q;
}

export type Veredito = 'amostra-pequena' | 'cedo' | 'b-ganha' | 'b-perde' | 'sem-resposta';

/** Mínimo do ab.mjs: 100 expostos e 25 conversões em cada versão, e 7 dias de teste (uma semana inteira). */
export function veredito(a: Braco, b: Braco, q: number, rel: number, diasDeTeste = 7): Veredito {
  if (a.conv < 25 || b.conv < 25 || a.n < 100 || b.n < 100) return 'amostra-pequena';
  if (diasDeTeste < 7) return 'cedo';
  if (q < ALFA) return rel > 0 ? 'b-ganha' : 'b-perde';
  return 'sem-resposta';
}
