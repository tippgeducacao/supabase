// Relatórios no GRUPO de WhatsApp (pedido do usuário, 15/10/2026). Régua pura, testada no
// vitest; banco e envio em relatoriosGrupoTick.ts.
//
//   Comercial  segunda a sábado às 08:00: comparecidas, sem resultado marcado e vendas de ONTEM
//              (na segunda, do fim de semana) e da semana comercial (qua→ter) até ontem.
//              Domingo não sai.
//   TI         uma mensagem com o relato de todo mundo, quando o último que devia envia — ou ao
//              meio-dia, com quem enviou e quem faltou.

/** Janela do comercial em Brasília: sai às 08:00; se o tick falhar, tenta até 11:59. */
export const HORA_COMERCIAL_INI = 8;
export const HORA_COMERCIAL_FIM = 12;

/** Ao meio-dia o feedback do TI sai mesmo com gente faltando (provavelmente faltou no trabalho). */
export const HORA_FECHA_TI = 12;

/** O WhatsApp corta a mensagem em 65.536 caracteres; sobra folga para o rodapé. */
export const TETO_MENSAGEM = 60_000;

const DIAS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const DIAS_CURTO = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

function dow(ymd: string): number {
  return new Date(`${ymd}T12:00:00Z`).getUTCDay(); // meio-dia UTC: sem escorregar de dia pelo fuso
}
function ddmm(ymd: string): string {
  const [, m, d] = ymd.split("-");
  return `${d}/${m}`;
}
function diaCurto(ymd: string): string {
  return `${DIAS_CURTO[dow(ymd)]} ${ddmm(ymd)}`;
}
export function diaPorExtenso(ymd: string): string {
  const nome = DIAS[dow(ymd)];
  return `${nome[0].toUpperCase()}${nome.slice(1)}, ${ddmm(ymd)}`;
}
function addDias(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function naJanelaComercial(horaSP: number): boolean {
  return horaSP >= HORA_COMERCIAL_INI && horaSP < HORA_COMERCIAL_FIM;
}

/**
 * O período do relatório comercial que sai `hoje`. Domingo não sai (null). Segunda fala de sábado
 * + domingo: sem o relatório de domingo, o sábado — dia de trabalho do comercial — nunca
 * apareceria sozinho. Os outros dias falam de ontem.
 */
export function periodoComercial(hoje: string): { ini: string; fim: string } | null {
  const d = dow(hoje);
  if (d === 0) return null;
  const fim = addDias(hoje, -1);
  return { ini: d === 1 ? addDias(hoje, -2) : fim, fim };
}

// ── Comercial ────────────────────────────────────────────────────────────────

/** Um período, já lido de placar_comercial_bloco + torre_sistema_pendencias. */
export interface BlocoComercial {
  comparecidas: number;
  semResultado: number;
  vendas: number;
  vendasPos: number;
  vendasRapidas: number; // curso livre + módulo prático
}

/** placar_comercial_bloco (jsonb) + torre_sistema_pendencias (jsonb) → bloco. */
export function lerBloco(placar: any, pendencias: any): BlocoComercial {
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    comparecidas: n(placar?.reunioes_comparecidas),
    semResultado: n(pendencias?.sem_resultado),
    vendas: n(placar?.matriculas),
    vendasPos: n(placar?.matriculas_pos),
    vendasRapidas: n(placar?.matriculas_rapidas),
  };
}

function linhasBloco(b: BlocoComercial): string[] {
  const quebra = b.vendasRapidas > 0
    ? ` (${b.vendasPos} pós · ${b.vendasRapidas} curso/módulo)`
    : "";
  return [
    `✅ Reuniões comparecidas: *${b.comparecidas}*`,
    `⏳ Reuniões sem resultado marcado: *${b.semResultado}*`,
    `💰 Vendas: *${b.vendas}*${quebra}`,
  ];
}

/**
 * `periodo` = o de periodoComercial; `semanaIni` = a quarta da semana comercial que contém o fim
 * do período. Na quarta de manhã ontem é terça: a semana sai FECHADA.
 */
export function textoComercial(
  periodo: { ini: string; fim: string }, semanaIni: string, dia: BlocoComercial, semana: BlocoComercial,
): string {
  const semanaFim = addDias(semanaIni, 6);
  const fechada = periodo.fim === semanaFim;
  const situacao = fechada ? "semana fechada" : "parcial, até ontem";
  const umDia = periodo.ini === periodo.fim;
  return [
    umDia ? "📊 *Comercial — resumo de ontem*" : "📊 *Comercial — resumo do fim de semana*",
    "",
    umDia
      ? `*${diaPorExtenso(periodo.fim)}*`
      : `*${diaPorExtenso(periodo.ini)} e ${diaPorExtenso(periodo.fim).toLowerCase()}*`,
    ...linhasBloco(dia),
    "",
    `📅 *Semana comercial* · ${diaCurto(semanaIni)} a ${diaCurto(semanaFim)} (${situacao})`,
    ...linhasBloco(semana),
  ].join("\n");
}

// ── Feedback do TI ───────────────────────────────────────────────────────────

/** Uma linha de feedback_ti_consolidado_dia. */
export interface RelatoTi {
  nome: string;
  dia_util: boolean;
  dispensado_motivo: string | null;
  registrado: boolean;
  descricao: string | null;
  andamento: string | null;
  anexos: number;
}

/**
 * Conta no time do dia = dia útil e sem dispensa (bloqueio de agenda, férias, conta nova). A RPC
 * só preenche a dispensa de quem NÃO enviou: dispensado que mandou mesmo assim conta como enviado.
 */
function deve(r: RelatoTi): boolean {
  return r.dia_util && !r.dispensado_motivo;
}

/**
 * O time inteiro enviou? Só em dia útil, com ao menos uma pessoa que devia, e todas elas com o
 * relato registrado. Quem foi dispensado não segura a mensagem.
 */
export function timeTiCompleto(linhas: RelatoTi[]): boolean {
  const devem = linhas.filter(deve);
  return devem.length > 0 && devem.every((r) => r.registrado);
}

/**
 * Sai agora? Assim que o time inteiro enviou, ou — com gente faltando — a partir do meio-dia de
 * um dia de trabalho do TI. O "hoje é dia de trabalho" importa: no domingo o dia cobrado ainda é
 * o sábado e ninguém abre o sistema; fechar ao meio-dia de domingo mandaria "ninguém enviou" e
 * gastaria o envio que só deve acontecer na segunda.
 */
export function deveEnviarTi(linhas: RelatoTi[], horaSP: number, hojeEhDiaDeTrabalhoTi: boolean): boolean {
  if (timeTiCompleto(linhas)) return true;
  return linhas.some(deve) && horaSP >= HORA_FECHA_TI && hojeEhDiaDeTrabalhoTi;
}

/** Os códigos de feedback_ti_dispensa. */
const MOTIVO_DISPENSA: Record<string, string> = {
  bloqueio: "agenda bloqueada ou férias",
  conta_nova: "ainda não tinha conta",
};

/** Limpa o texto livre: tira espaços das pontas e junta 3+ quebras de linha em uma linha em branco. */
function limparTexto(t: string | null): string {
  return String(t ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function textoFeedbackTi(dia: string, linhas: RelatoTi[]): string {
  const enviaram = linhas.filter((r) => r.dia_util && r.registrado);
  const dispensados = linhas.filter((r) => !r.registrado && r.dispensado_motivo);
  const faltaram = linhas.filter((r) => deve(r) && !r.registrado);
  const total = linhas.filter(deve).length;

  const partes: string[] = [
    `🖥️ *Feedback do TI — ${diaPorExtenso(dia)}*`,
    !faltaram.length
      ? `Todo o time enviou (${enviaram.length} de ${total}).`
      : enviaram.length
        ? `*${enviaram.length} de ${total}* enviaram até o meio-dia.`
        : `Ninguém enviou até o meio-dia (0 de ${total}).`,
  ];
  for (const r of enviaram) {
    partes.push("", `👤 *${r.nome}*`, "✅ *FEITO*", limparTexto(r.descricao) || "—");
    const andamento = limparTexto(r.andamento);
    if (andamento) partes.push("", "🔄 *EM ANDAMENTO · VAI FAZER*", andamento);
    if (r.anexos > 0) partes.push(`📎 ${r.anexos} ${r.anexos === 1 ? "anexo" : "anexos"} na tela Feedback do TI`);
  }
  if (faltaram.length) {
    partes.push("", `⏳ *Não enviou:* ${faltaram.map((r) => r.nome).join(" · ")}`);
  }
  if (dispensados.length) {
    const motivo = (m: string | null) => MOTIVO_DISPENSA[m ?? ""] ?? m;
    partes.push("", `_Dispensado: ${dispensados.map((r) => `${r.nome} (${motivo(r.dispensado_motivo)})`).join(" · ")}_`);
  }

  const texto = partes.join("\n");
  if (texto.length <= TETO_MENSAGEM) return texto;
  return `${texto.slice(0, TETO_MENSAGEM)}…\n\n_(continua na tela Feedback do TI)_`;
}
