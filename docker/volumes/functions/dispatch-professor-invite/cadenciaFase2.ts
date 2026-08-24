/**
 * Régua PURA da fase 2 do convite ao professor: 30 → 7 → 1 → dia da aula.
 *
 * Está fora do `index.ts` de propósito — é aritmética de calendário, não depende do
 * runtime Deno nem do Supabase, e por isso pode ser testada de verdade pelo vitest da
 * raiz (`supabase/functions/**` já entra no `include` do vitest.config.ts).
 *
 * Extraída em 17/08/2026, depois de um erro de arredondamento aqui dentro ter deixado
 * 33 convites de aulas futuras sem NENHUM lembrete — sem erro, sem alarme, com a Fila
 * mostrando "ENVIADO E CONFIRMADO" o tempo todo. Ver docs/Pedagógico.md.
 */

export const TZ = "America/Sao_Paulo";

/** "YYYY-MM-DD" → Date ao meio-dia em SP (evita drift de fuso ao formatar). */
export function dateOnlyToDate(d: string): Date {
  return new Date(`${d}T12:00:00-03:00`);
}

/** Data civil de HOJE em São Paulo, no formato "YYYY-MM-DD". */
export function hojeSpYmd(agora: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(agora);
}

function ymdParaDiasEpoch(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Math.floor(Date.UTC(y, (m ?? 1) - 1, d ?? 1) / (24 * 3600 * 1000));
}

/**
 * Dias inteiros entre HOJE e a data da aula, contados por DATA CIVIL em SP — a mesma
 * conta que o banco faz em `ped_convite_marco_fase2` (`p_data - current_date`). Os dois
 * PRECISAM concordar, senão o marco gravado pelo banco e o lido pela edge divergem.
 *
 * ⚠️ Era `ceil((meio-dia da aula − agora) / 24h)`, e o arredondamento devolvia UM DIA A
 * MAIS no próprio dia do marco: no dia D−30, às 09h, dava 31. Como 31 > 30, o motor
 * concluía que o marco de 30d ainda era o PRÓXIMO, caía no antigo atalho "próximo igual
 * ao atual → vai pro dia da aula" e queimava 7d e 1d de uma vez só.
 */
export function daysUntilAula(dataYmd: string, hojeYmd: string = hojeSpYmd()): number {
  return ymdParaDiasEpoch(dataYmd) - ymdParaDiasEpoch(hojeYmd);
}

/** "YYYY-MM-DD" menos N dias, em ISO. */
export function dateMinusDays(dataYmd: string, days: number): string {
  const d = dateOnlyToDate(dataYmd);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

/**
 * "HH:MM" a partir do que estiver escrito na célula de horário.
 *
 * A migration 20260527171000 padronizou o campo em "HH:MM-HH:MM", mas o cadastro é texto
 * livre e a base tem de tudo: "8h", "13h", "19h00", "19:00 às 22:00", "8:00". A régua
 * antiga exigia exatamente 5 caracteres e caía no fallback das 19:00 — "8h" virava aula
 * da noite (link 10h depois de começar) — e, pior, "19h00" TEM 5 caracteres e passava
 * direto, produzindo `2026-08-17T19h00:00-03:00`: Invalid Date, `NaN` na conta do marco e
 * RangeError ao gravar o ISO, derrubando o convite pra escalação manual.
 */
function parseHora(bruto: string | null | undefined, fallback: string): string {
  const m = (bruto ?? "").trim().match(/^(\d{1,2})\s*[:h]?\s*(\d{2})?/i);
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  if (!Number.isFinite(h) || h > 23 || min > 59) return fallback;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** Separa "19:00-22:00", "19:00 às 22:00", "19:00 – 22:00" nos dois blocos. */
function partesHorario(horario: string | null): string[] {
  return (horario ?? "").split(/[-–—]|\bàs\b/i).map((p) => p.trim()).filter(Boolean);
}

/** Início da aula em ISO. Fallback: 19:00 (padrão das aulas ao vivo). */
export function buildAulaStartIso(dataYmd: string, horario: string | null): string {
  const partes = partesHorario(horario);
  return `${dataYmd}T${parseHora(partes[0], "19:00")}:00-03:00`;
}

/** Fim da aula em ISO. Fallback: 22:00 (padrão das aulas noturnas). */
export function buildAulaEndIso(dataYmd: string, horario: string | null): string {
  const partes = partesHorario(horario);
  const fim = partes.length >= 2 ? partes[partes.length - 1] : null;
  return `${dataYmd}T${parseHora(fim, "22:00")}:00-03:00`;
}

// Régua da fase 2, em ordem. O toque de 14 dias foi REMOVIDO do fluxo em 2026-07-16.
export const ESCADA_FASE2 = [
  { status: "fase2_reconfirmacao_30d", dias: 30, marco: "lembrete_30d" },
  { status: "fase2_reconfirmacao_7d", dias: 7, marco: "lembrete_7d" },
  { status: "fase2_lembrete_1d", dias: 1, marco: "lembrete_1d" },
] as const;

// Em que degrau da escada cada status ESTÁ. O 14d aposentado ocupa o degrau do 30d:
// quem parou nele já gastou a reconfirmação longa, e o próximo passo é o de 7d.
//
// O degrau 3 não vive em ESCADA_FASE2 porque não é medido em DIAS e sim em HORA do
// próprio dia da aula (10:00) — o loop de degraus não sabe compará-lo. Ele existe aqui
// para a regra "o próximo é sempre estritamente abaixo do atual" continuar valendo:
// quem já recebeu o toque da manhã não pode voltar pra ele.
export const DEGRAU_FASE2: Record<string, number> = {
  fase2_reconfirmacao_30d: 0,
  fase2_reconfirmacao_14d: 0,
  fase2_reconfirmacao_7d: 1,
  fase2_lembrete_1d: 2,
  dia_aula_manha_enviado: 3,
};

const DEGRAU_MANHA = 3;

export type SmartSkipResult = {
  status:
    | "fase2_reconfirmacao_30d"
    | "fase2_reconfirmacao_14d"
    | "fase2_reconfirmacao_7d"
    | "fase2_lembrete_1d"
    | "dia_aula_manha_enviado"
    | "dia_aula_link_enviado"
    | "pos_aula_realizada";
  proxima_acao_em: string;
  dias: number;
  marco: string;
};

/**
 * Quando o link da sala deve sair: **1h antes** de a aula começar.
 *
 * ⚠️ Esta hora NÃO é livre — ela é uma promessa escrita em três templates aprovados na
 * Meta. O do próprio link diz *"sua aula {{2}} começa em 1h ({{3}})"*, e os de 7d e 1d
 * dizem *"o link da sala será enviado 1h antes do início"*. Antecipar o disparo sem trocar
 * o corpo transforma o texto em mentira — o professor leria "começa em 1h" ao meio-dia,
 * para uma aula das 19h.
 *
 * Em 18/08/2026 o marco chegou a ser movido para o meio-dia (pedido do Rafael, por
 * segurança: 7h de folga em vez de 1h) e foi revertido no mesmo dia ao se perceber a
 * promessa nos templates. A antecipação volta à mesa quando a Meta aprovar os textos
 * novos — aí muda AQUI e no `ELSE` de `ped_convite_marco_fase2`, juntos.
 *
 * O horário nunca foi a causa da falha: o problema era o cron de 1x/dia às 09h, que jamais
 * alcançava esse marco. Rodando de 30 em 30 min, 1h antes é entregue sem drama.
 */
export function marcoLinkDoDia(aula: { data: string; horario: string | null }): string {
  const inicio = new Date(buildAulaStartIso(aula.data, aula.horario)).getTime();
  return new Date(inicio - 60 * 60 * 1000).toISOString();
}

/** Hora do toque da manhã no dia da aula (decisão do Rafael, 24/08/2026). */
export const HORA_TOQUE_MANHA = "10:00";

/**
 * Antes desta hora de início, a aula NÃO recebe o toque da manhã.
 *
 * O toque das 10h existe para dar ao professor um aviso com folga — tempo de se organizar
 * e de mandar o material antes da aula. Numa aula que começa 08:00 (prático) ele chegaria
 * com a aula já em andamento, e numa que começa 11:00 chegaria colado no link de 1h antes,
 * dois toques quase juntos. O corte às 12:00 garante pelo menos 2h de folga real; abaixo
 * dele o professor recebe só o link, 1h antes, como sempre foi.
 */
const INICIO_MINIMO_PARA_TOQUE_MANHA = "12:00";

/** A aula começa tarde o bastante para o toque das 10h fazer sentido? */
export function aulaTemToqueDeManha(aula: { data: string; horario: string | null }): boolean {
  const inicio = new Date(buildAulaStartIso(aula.data, aula.horario)).getTime();
  const corte = new Date(`${aula.data}T${INICIO_MINIMO_PARA_TOQUE_MANHA}:00-03:00`).getTime();
  return Number.isFinite(inicio) && inicio >= corte;
}

/**
 * Quando o aviso da manhã deve sair: **10:00 do dia da aula**, hora fixa.
 *
 * Fixa, e não relativa ao início: o valor dele é chegar cedo, quando o professor ainda tem
 * o dia inteiro pela frente para separar os slides. Uma hora relativa (ex. 9h antes)
 * espalharia o aviso por horários estranhos conforme o horário de cada aula.
 *
 * ⚠️ 10:00 está DENTRO da janela do cron (07h–20h30 SP). Mudar esta hora para fora da
 * janela faz o marco nunca vencer — foi exatamente assim que o link do dia ficou mudo até
 * 17/08/2026. Ver `docs/Pedagógico.md`.
 */
export function marcoManhaDoDia(aula: { data: string; horario: string | null }): string {
  return new Date(`${aula.data}T${HORA_TOQUE_MANHA}:00-03:00`).toISOString();
}

/**
 * Próximo marco da fase 2 para esta aula.
 *
 * `statusAtual` é o degrau em que o convite está AGORA: o próximo tem que ser
 * estritamente ABAIXO dele, senão o motor fica em looping no mesmo lembrete.
 *
 * ⚠️ Antes essa função não recebia o status e escolhia o degrau só pela distância. Quem
 * chamava tinha um "se o próximo é igual ao atual, força dia_aula_link_enviado" como
 * anti-loop — e era esse atalho que QUEIMAVA a cadência: bastava a conta de dias dar um
 * a mais (dava, ver `daysUntilAula`) para o motor pular de um lembrete de 30d direto pro
 * dia da aula, sem nunca mandar 7d nem 1d. Agora o anti-loop é estrutural: a busca começa
 * no degrau seguinte, então nunca repete.
 */
export function pickNextFase2Marco(
  aula: { data: string; horario: string | null },
  statusAtual?: string | null,
  hojeYmd: string = hojeSpYmd(),
  agora: Date = new Date(),
): SmartSkipResult {
  const dias = daysUntilAula(aula.data, hojeYmd);
  const degrauAtual = statusAtual ? DEGRAU_FASE2[statusAtual] : undefined;
  const desde = degrauAtual === undefined ? 0 : degrauAtual + 1;

  for (let i = desde; i < ESCADA_FASE2.length; i++) {
    const deg = ESCADA_FASE2[i];
    // `>` e não `>=`: com a aula exatamente na distância do degrau, o marco seria HOJE e
    // o professor levaria dois toques no mesmo dia. Nesse caso desce mais um degrau.
    if (dias > deg.dias) {
      return {
        status: deg.status,
        proxima_acao_em: dateMinusDays(aula.data, deg.dias),
        dias,
        marco: deg.marco,
      };
    }
  }

  // Acabaram os lembretes contados em dias. Antes do link, o aviso da manhã do dia da
  // aula — só se ainda estiver no FUTURO. Sem essa checagem, um convite confirmado às 14h
  // do próprio dia receberia às 14h um "bom dia, hoje tem aula" com marco vencido às 10h.
  if (degrauAtual === undefined || degrauAtual < DEGRAU_MANHA) {
    const manha = marcoManhaDoDia(aula);
    if (aulaTemToqueDeManha(aula) && new Date(manha).getTime() > agora.getTime()) {
      return {
        status: "dia_aula_manha_enviado",
        proxima_acao_em: manha,
        dias,
        marco: "dia_aula_manha",
      };
    }
  }

  // Nenhum lembrete cabe mais: o que resta é o link, 1h antes de começar.
  return {
    status: "dia_aula_link_enviado",
    proxima_acao_em: marcoLinkDoDia(aula),
    dias,
    marco: "dia_aula_link",
  };
}
