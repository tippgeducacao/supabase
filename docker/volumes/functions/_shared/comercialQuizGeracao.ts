// Regras PURAS da geração automática do quiz dos Materiais de Venda (10/11/2026).
// A edge comercial-quiz-gerar usa isto; sem rede, testável no vitest
// (comercialQuizGeracao.test.ts). Por quê e como: docs/Portal Comercial.md → "Quiz".
//
// Régua do usuário (10/11/2026, tarde): banco de 150 objetivas + 20 descritivas por pós; cada
// tentativa sorteia 35 objetivas + 5 descritivas = 40. Vale para TODAS as pós — a edge também
// completa os quizzes feitos à mão, só ACRESCENTANDO (nunca altera nem desliga pergunta existente).

/** Objetivas sorteadas por tentativa (comercial_quiz_config.perguntas_por_tentativa). */
export const MC_POR_TENTATIVA = 35;
/** Descritivas sorteadas por tentativa (comercial_quiz_config.descritivas_por_tentativa). */
export const DESC_POR_TENTATIVA = 5;
/** Alvo do banco de objetivas. */
export const ALVO_MC = 150;
/** Alvo do banco de descritivas. */
export const ALVO_DESC = 20;
/** Teto de lotes: ficha curta não rende o banco sem repetir; para em vez de gastar IA para sempre. */
export const MAX_LOTES = 25;
/** Ficha com menos que isso (sem os campos visuais) é casca — a IA inventaria. */
export const MIN_FICHA_CHARS = 3_000;
/** Rodada "gerando" mais velha que isso morreu no meio (deploy, queda) e pode ser retomada. */
export const TRAVA_MINUTOS = 15;

/** A certa pode ser no máximo 15% maior que a maior errada. */
export const FOLGA_TAMANHO_CERTA = 1.15;

export const CATEGORIAS =["Produto", "Módulos", "Professores", "Dores", "Script", "Fechamento"] as const;
export type Categoria = (typeof CATEGORIAS)[number];

export type StatusGeracao = "gerando" | "parcial" | "pronto" | "sem_conteudo" | "erro";

export interface ConfigQuiz {
  origem: "manual" | "automatico";
  ativo: boolean;
  geracao_status: StatusGeracao | null;
  geracao_tentada_em: string | null;
  geracao_lotes: number;
  ativado_auto_em: string | null;
}

export interface Candidato {
  programId: string;
  slug: string;
  nome: string;
  fichaAtualizadaEm: string | null;
  config: ConfigQuiz | null;
}

const MIN = 60_000;

/** Pode rodar um lote nesta pós agora? (null = pode; senão, o motivo). */
export function motivoParaPular(c: Candidato, agora: Date, forcado = false): string | null {
  const cfg = c.config;
  if (!cfg) return null;
  const t = cfg.geracao_tentada_em ? new Date(cfg.geracao_tentada_em).getTime() : 0;
  const idade = agora.getTime() - t;
  if (cfg.geracao_status === "gerando" && idade < TRAVA_MINUTOS * MIN) return "já tem uma rodada em curso";
  if (forcado) return null;
  const ficha = c.fichaAtualizadaEm ? new Date(c.fichaAtualizadaEm).getTime() : 0;
  switch (cfg.geracao_status) {
    case "pronto":
      return "quiz pronto";
    case "sem_conteudo":
      // Ficha mudou desde a última tentativa, ou 1 dia depois (aulas/professores do Pedagógico).
      if (ficha > t || idade >= 24 * 60 * MIN) return null;
      return "ficha de venda ainda sem conteúdo";
    case "erro":
      // Esgotou os lotes (ficha curta): só volta quando a ficha mudar. A edge zera os lotes.
      if (cfg.geracao_lotes >= MAX_LOTES) return ficha > t ? null : "ficha não rendeu; espera a ficha mudar";
      return idade >= 60 * MIN ? null : "falhou há menos de 1 h";
    default:
      return null;
  }
}

/** Próxima pós da fila: as que nunca rodaram primeiro, depois a tentada há mais tempo. */
export function escolherPrograma(cands: Candidato[], agora: Date): Candidato | null {
  const aptos = cands.filter((c) => motivoParaPular(c, agora) === null);
  aptos.sort((a, b) => {
    const ta = a.config?.geracao_tentada_em ? new Date(a.config.geracao_tentada_em).getTime() : -1;
    const tb = b.config?.geracao_tentada_em ? new Date(b.config.geracao_tentada_em).getTime() : -1;
    return ta - tb || a.programId.localeCompare(b.programId);
  });
  return aptos[0] ?? null;
}

const CAMPOS_VISUAIS = new Set(["accentBg", "areaColor", "areaIcon", "links", "id"]);

/** A ficha sem os campos que são só aparência (cor, ícone, links). */
export function fichaSemVisual(program: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(program ?? {})) {
    if (CAMPOS_VISUAIS.has(k)) continue;
    if (v === null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out;
}

export function normalizarTexto(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface QuestaoIA {
  pergunta: string;
  opcoes: string[];
  correta: number;
  explicacao: string;
  categoria: string;
}

export interface QuestaoPronta {
  question: string;
  category: Categoria;
  options: { id: string; text: string }[];
  correct_option_id: string;
  explanation: string;
}

const LETRAS = ["a", "b", "c", "d"];

/**
 * Valida o que a IA devolveu e embaralha as alternativas (modelo tende a pôr a certa sempre no
 * mesmo lugar). Descarta: != 4 alternativas, alternativa repetida, gabarito fora do intervalo,
 * pergunta curta, pergunta que já existe no banco (ou repetida no mesmo lote).
 */
export function normalizarQuestoes(
  brutas: QuestaoIA[],
  existentes: string[],
  embaralhar: <T>(xs: T[]) => T[],
): QuestaoPronta[] {
  const vistas = new Set(existentes.map(normalizarTexto));
  const out: QuestaoPronta[] = [];
  for (const q of brutas ?? []) {
    const pergunta = String(q?.pergunta ?? "").trim();
    const opcoes = (q?.opcoes ?? []).map((o) => String(o).trim());
    if (pergunta.length < 10) continue;
    if (opcoes.length !== 4 || opcoes.some((o) => !o)) continue;
    if (new Set(opcoes.map(normalizarTexto)).size !== 4) continue;
    if (!Number.isInteger(q.correta) || q.correta < 0 || q.correta > 3) continue;
    // Certa visivelmente mais longa que todas as erradas = acerta-se no chute "pela maior"
    // (1º lote de 10/11: 9 de 41 passavam de 15%, mesmo com o prompt pedindo tamanhos iguais).
    const maiorErrada = Math.max(...opcoes.filter((_, i) => i !== q.correta).map((o) => o.length));
    if (opcoes[q.correta].length > maiorErrada * FOLGA_TAMANHO_CERTA) continue;
    const chave = normalizarTexto(pergunta);
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    const certa = opcoes[q.correta];
    const mistura = embaralhar(opcoes);
    const categoria = (CATEGORIAS as readonly string[]).includes(q.categoria) ? (q.categoria as Categoria) : "Produto";
    out.push({
      question: pergunta,
      category: categoria,
      options: mistura.map((text, i) => ({ id: LETRAS[i], text })),
      correct_option_id: LETRAS[mistura.indexOf(certa)],
      explanation: String(q.explicacao ?? "").trim(),
    });
  }
  return out;
}

/**
 * Conferência às cegas: outra chamada respondeu cada pergunta SEM o gabarito, só com o material.
 * Fica só a que ela acertou. -1 (nenhuma/mais de uma defensável) ou resposta diferente = fora.
 * `respostas` vem indexado pela posição da pergunta no lote (campo n, 1-based).
 */
export function aprovadasNaCega(
  questoes: QuestaoPronta[],
  respostas: { n: number; alternativa: string }[],
): { aprovadas: QuestaoPronta[]; reprovadas: number } {
  const porN = new Map<number, string>();
  for (const r of respostas ?? []) porN.set(Number(r.n), String(r.alternativa ?? "").trim().toLowerCase());
  const aprovadas = questoes.filter((q, i) => porN.get(i + 1) === q.correct_option_id);
  return { aprovadas, reprovadas: questoes.length - aprovadas.length };
}

export type TipoLote = "multiple-choice" | "descriptive";

/** O que gerar agora: primeiro o mínimo de objetivas, depois as descritivas, depois o resto. */
export function proximoTipo(mc: number, desc: number): TipoLote | null {
  if (mc < MC_POR_TENTATIVA) return "multiple-choice";
  if (desc < ALVO_DESC) return "descriptive";
  if (mc < ALVO_MC) return "multiple-choice";
  return null;
}

/** Depois de um lote: status novo e se a aba "Quiz" deve ligar agora. */
export function estadoDepoisDoLote(
  mc: number,
  desc: number,
  lotes: number,
  ativadoAutoEm: string | null,
): { status: StatusGeracao; ligar: boolean; erro: string | null } {
  // Liga uma vez só: se o admin desligar depois, a edge não religa. (Quiz feito à mão: a
  // edge não toca em `ativo` — quem decide é o chamador.)
  const prova = mc >= MC_POR_TENTATIVA && desc >= DESC_POR_TENTATIVA;
  const ligar = prova && !ativadoAutoEm;
  if (mc >= ALVO_MC && desc >= ALVO_DESC) return { status: "pronto", ligar, erro: null };
  if (lotes >= MAX_LOTES) {
    return prova
      ? { status: "pronto", ligar, erro: `Parou em ${mc} objetivas e ${desc} descritivas: a ficha não rendeu mais sem repetir.` }
      : { status: "erro", ligar: false, erro: `Só ${mc} objetivas e ${desc} descritivas em ${lotes} lotes: a ficha é curta demais.` };
  }
  return { status: "parcial", ligar, erro: null };
}

/** Quantas pedir neste lote (com folga para as que caem na conferência). */
export function tamanhoDoLote(tipo: TipoLote, ativas: number): number {
  if (tipo === "descriptive") return Math.max(3, Math.min(12, ALVO_DESC - ativas + 3));
  return Math.max(5, Math.min(20, ALVO_MC - ativas + 5));
}

export interface DescritivaIA {
  pergunta: string;
  resposta_esperada: string;
  categoria: string;
}

export interface DescritivaPronta {
  question: string;
  category: Categoria;
  guideline: string;
}

/** Valida as descritivas da IA: pergunta e resposta esperada com corpo, sem repetir o banco. */
export function normalizarDescritivas(brutas: DescritivaIA[], existentes: string[]): DescritivaPronta[] {
  const vistas = new Set(existentes.map(normalizarTexto));
  const out: DescritivaPronta[] = [];
  for (const q of brutas ?? []) {
    const pergunta = String(q?.pergunta ?? "").trim();
    const guideline = String(q?.resposta_esperada ?? "").trim();
    if (pergunta.length < 30 || guideline.length < 80) continue;
    const chave = normalizarTexto(pergunta);
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    const categoria = (CATEGORIAS as readonly string[]).includes(q.categoria) ? (q.categoria as Categoria) : "Script";
    out.push({ question: pergunta, category: categoria, guideline });
  }
  return out;
}

/**
 * Juiz das descritivas: outra chamada leu cada pergunta + resposta esperada contra o material.
 * Fica só a que ela aprovou (tudo que a resposta esperada afirma está no material e a pergunta é
 * respondível com ele). `vereditos` indexado pela posição no lote (n, 1-based).
 */
export function aprovadasNoJuiz<T>(
  itens: T[],
  vereditos: { n: number; aprovada: boolean }[],
): { aprovadas: T[]; reprovadas: number } {
  const ok = new Set((vereditos ?? []).filter((v) => v?.aprovada === true).map((v) => Number(v.n)));
  const aprovadas = itens.filter((_, i) => ok.has(i + 1));
  return { aprovadas, reprovadas: itens.length - aprovadas.length };
}
