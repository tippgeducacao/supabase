/**
 * MÓDULOS PRÁTICOS NO CRONOGRAMA: normalização e agrupamento, versão da EDGE.
 *
 * ⚠️ CÓPIA de src/services/pedagogico/praticosCronograma.ts (a edge não importa de src/).
 * A lógica é a mesma, linha a linha; a única diferença é o período vazio, que aqui sai "-"
 * em vez de travessão (texto que o aluno lê). Mudou a regra lá (agrupamento, ordem, horário
 * do dia, tarja)? Mude aqui na mesma tarefa, senão o PDF do WhatsApp e o PDF baixado no
 * Pedagógico e no comercial passam a mostrar coisas diferentes para a mesma turma.
 * O porquê de cada regra está documentado no arquivo do front e em docs/Pedagógico.md
 * ("Módulos práticos no cronograma do aluno e no PDF").
 *
 * Resumo do agrupamento (pedido do diretor em 31/08/2026): MÓDULO (pelo título, porque o
 * mesmo módulo é ofertado em várias praças) › PRAÇA (por modulo_id: cidade + período, o aluno
 * escolhe uma) › DIA (uma linha por dia; manhã e tarde viram "08:00 - 18:00"). Tudo em ordem
 * cronológica: `ped_curso_pratico_modulos.ordem` é NULL em 100% dos módulos.
 */

/** Linha crua devolvida pela RPC `ped_turma_praticos_cronograma`. */
export interface PraticoCronogramaRow {
  aula_id: string;
  modulo_id: string | null;
  modulo_titulo: string | null;
  cidade: string | null;
  data: string | null;
  horario: string | null;
  titulo: string | null;
  ementa: string | null;
  /** A sessão acontece ANTES do início da turma (herdada da pós) — o aluno não alcança. */
  antes_do_inicio: boolean | null;
}

export interface PraticoSessao {
  aulaId: string;
  moduloId: string;
  moduloTitulo: string;
  local: string;
  data: string;
  horario: string | null;
  ementa: string;
}

/**
 * Um dia da praça. Quando há DOIS turnos (manhã e tarde), o dia é apresentado como um
 * período único: "08:00 - 18:00", com as ementas dos dois turnos juntas.
 * Decisão do diretor (31/08/2026): "sempre coloque das 08:00 às 18:00, a programação da
 * turma não precisa deixar quebrado para 13 às 18, fica muito estranho".
 * As sessões originais ficam em `sessoes` para quem precisar do detalhe operacional.
 */
export interface PraticoDia {
  data: string;
  /** Período do dia inteiro, normalizado: do início mais cedo ao fim mais tarde. */
  horario: string | null;
  /** Ementas do dia, na ordem, sem repetir. */
  ementa: string;
  sessoes: PraticoSessao[];
}

/** Uma edição do módulo: cidade + período. O aluno escolhe UMA. */
export interface PraticoPraca {
  moduloId: string;
  local: string;
  /** "15 a 17/10/2026" ou "30/11 a 02/12/2026" */
  periodo: string;
  dias: PraticoDia[];
  totalSessoes: number;
}

/** O módulo que o aluno precisa fazer, com todas as praças em que ele é oferecido. */
export interface PraticoModulo {
  titulo: string;
  pracas: PraticoPraca[];
}

/** Tarja pedida pelo diretor — o prático é o presencial de quem contrata o semipresencial. */
export const TARJA_PRATICO_CURTA = "Semipresencial · opcional";
export const TARJA_PRATICO_LONGA =
  "Módulo presencial para alunos matriculados na modalidade SEMIPRESENCIAL. " +
  "Cada módulo é oferecido em várias cidades: escolha UMA praça por módulo, a mais " +
  "perto de você. As sessões não substituem nem contam como aula ao vivo da turma.";

/** O título da aula é "<módulo> — <cidade>"; a coluna de módulo não repete a cidade. */
function tituloSemCidade(titulo: string | null): string {
  if (!titulo) return "Módulo prático";
  const corte = titulo.split(/\s+[—–]\s+/)[0];
  return corte.trim() || titulo.trim();
}

/**
 * Chave canônica de texto: sem acento, sem caixa, sem espaço sobrando.
 *
 * A grafia da cidade chega suja do cadastro — "Amperé - PR" convivia com "Ampére - PR"
 * (3 contra 22 ofertas) e "Cacique Doble - RS " com espaço à direita. A migration
 * 20260831180000 limpou o que existia; esta chave garante que sujeira nova não volte a
 * partir a mesma praça em dois blocos.
 */
function chaveCanonica(s: string): string {
  return s.trim().toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

/**
 * Converte as linhas da RPC em sessões prontas para exibir, em ordem cronológica.
 *
 * `somenteAPartirDoInicioDaTurma`: descarta sessão anterior ao início da turma. A sessão
 * prática é compartilhada com todas as turmas da pós, então uma turma nova herda sessões
 * que já aconteceram (a 01/27 de Reprodução herda 12) — oferecer isso ao aluno é oferecer
 * data que ele não alcança. Superfícies do ALUNO passam `true`; o cronograma INTERNO,
 * não (o pedagógico precisa do histórico operacional).
 */
export function normalizarPraticos(
  rows: PraticoCronogramaRow[] | null | undefined,
  opts: { somenteAPartirDoInicioDaTurma?: boolean } = {},
): PraticoSessao[] {
  return (rows ?? [])
    .filter((r) => !!r.data)
    .filter((r) => !(opts.somenteAPartirDoInicioDaTurma && r.antes_do_inicio))
    .map((r) => {
      const moduloTitulo = (r.modulo_titulo ?? "").trim() || tituloSemCidade(r.titulo);
      const local = (r.cidade ?? "").trim() || "Local a confirmar";
      return {
        aulaId: r.aula_id,
        // a praça é o `modulo_id`; sem ele, cai no par título+cidade (nunca só no título)
        moduloId: r.modulo_id ?? `${chaveCanonica(moduloTitulo)}|${chaveCanonica(local)}`,
        moduloTitulo,
        local,
        data: r.data as string,
        horario: r.horario,
        ementa: (r.ementa ?? "").trim(),
      };
    })
    .sort((a, b) => a.data.localeCompare(b.data) || (a.horario ?? "").localeCompare(b.horario ?? ""));
}

/**
 * Horário é texto livre no cadastro e chega em 8 formatos ("08:00 - 18:00", "08h - 18h",
 * "8:00-18:00", "13h - 18h"...). Extrai os instantes na ordem em que aparecem; o primeiro
 * é o início e o último é o fim.
 */
const RE_HORA = /(\d{1,2})(?::(\d{2})|\s*h)/gi;

function faixaEmMinutos(horario: string): [number, number] | null {
  const marcos: number[] = [];
  for (const m of horario.matchAll(RE_HORA)) {
    const h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    if (h > 23 || min > 59) continue;
    marcos.push(h * 60 + min);
  }
  if (marcos.length === 0) return null;
  return [Math.min(...marcos), Math.max(...marcos)];
}

const hhmm = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/**
 * O período do DIA, unindo os turnos: manhã 08:00-12:00 + tarde 13:00-18:00 vira
 * "08:00 - 18:00". Também uniformiza os 8 formatos do cadastro num só.
 * Se nenhum horário for legível, devolve o texto original em vez de inventar.
 */
export function horarioDoDia(sessoes: PraticoSessao[]): string | null {
  const faixas = sessoes
    .map((s) => (s.horario ? faixaEmMinutos(s.horario) : null))
    .filter((f): f is [number, number] => f !== null);
  if (faixas.length === 0) return sessoes.find((s) => s.horario)?.horario ?? null;
  const inicio = Math.min(...faixas.map((f) => f[0]));
  const fim = Math.max(...faixas.map((f) => f[1]));
  return inicio === fim ? hhmm(inicio) : `${hhmm(inicio)} - ${hhmm(fim)}`;
}

/** As ementas do dia, na ordem e sem repetir, cada uma terminada em ponto. */
export function ementaDoDia(sessoes: PraticoSessao[]): string {
  const vistas = new Set<string>();
  const partes: string[] = [];
  sessoes.forEach((s) => {
    const e = s.ementa.trim();
    if (e && !vistas.has(e)) {
      vistas.add(e);
      partes.push(/[.;!?]$/.test(e) ? e : `${e}.`);
    }
  });
  return partes.join(" ");
}

function diaMes(iso: string) {
  const [, m, d] = iso.split("-");
  return { d, m };
}

/** "15 a 17/10/2026" quando é o mesmo mês; "30/11 a 02/12/2026" quando vira o mês. */
export function formatarPeriodo(datas: string[]): string {
  if (datas.length === 0) return "-";
  const ordenadas = [...datas].sort();
  const ini = ordenadas[0];
  const fim = ordenadas[ordenadas.length - 1];
  const a = diaMes(ini);
  const b = diaMes(fim);
  const anoFim = fim.slice(0, 4);
  if (ini === fim) return `${a.d}/${a.m}/${ini.slice(0, 4)}`;
  if (a.m === b.m && ini.slice(0, 4) === anoFim) return `${a.d} a ${b.d}/${b.m}/${anoFim}`;
  return `${a.d}/${a.m} a ${b.d}/${b.m}/${anoFim}`;
}

/**
 * Monta os blocos: módulo → praças → dias. Todos os níveis em ordem cronológica
 * (o módulo pela sua primeira data, a praça pela dela, os dias entre si).
 */
export function agruparPraticos(sessoes: PraticoSessao[]): PraticoModulo[] {
  // nível 2 primeiro: praças, por modulo_id
  const porPraca = new Map<string, PraticoSessao[]>();
  sessoes.forEach((s) => {
    if (!porPraca.has(s.moduloId)) porPraca.set(s.moduloId, []);
    porPraca.get(s.moduloId)!.push(s);
  });

  const pracas: PraticoPraca[] = Array.from(porPraca.values()).map((items) => {
    const porDia = new Map<string, PraticoSessao[]>();
    items.forEach((s) => {
      if (!porDia.has(s.data)) porDia.set(s.data, []);
      porDia.get(s.data)!.push(s);
    });
    return {
      moduloId: items[0].moduloId,
      local: items[0].local,
      periodo: formatarPeriodo(items.map((i) => i.data)),
      dias: Array.from(porDia.entries())
        .map(([data, ss]) => ({ data, horario: horarioDoDia(ss), ementa: ementaDoDia(ss), sessoes: ss }))
        .sort((a, b) => a.data.localeCompare(b.data)),
      totalSessoes: items.length,
    };
  });

  // nível 1: módulos, pelo TÍTULO canônico (une as praças do mesmo módulo)
  const porModulo = new Map<string, { titulo: string; pracas: PraticoPraca[] }>();
  pracas.forEach((p) => {
    const titulo = sessoes.find((s) => s.moduloId === p.moduloId)!.moduloTitulo;
    const chave = chaveCanonica(titulo);
    if (!porModulo.has(chave)) porModulo.set(chave, { titulo, pracas: [] });
    porModulo.get(chave)!.pracas.push(p);
  });

  const primeiraData = (p: PraticoPraca) => p.dias[0]?.data ?? "9999";
  return Array.from(porModulo.values())
    .map((m) => ({
      titulo: m.titulo,
      pracas: [...m.pracas].sort((a, b) => primeiraData(a).localeCompare(primeiraData(b))),
    }))
    .sort((a, b) => primeiraData(a.pracas[0]).localeCompare(primeiraData(b.pracas[0])));
}
