// Roteiro de conteúdo do perfil pessoal no WhatsApp do dono (pedido do Rafael, 12/10/2026).
// Todo dia às 7h o assistente manda o que gravar: a grade fixa da semana
// (assistente_roteiro_semanal), o que o marketing lançou no Planner Editorial para o perfil
// dele e 3 ideias escritas pela IA. No dia de aula da pós (terça, na pós de Bovinos), vem a
// aula da noite com quem dá a aula e a ementa; às 19h30, o lembrete do print do slide.
// A grade é a do doc "Planner de Conteúdo do Rafael" (claude.ai) que o marketing segue.
//
// Régua PURA: sem Deno, sem banco, sem rede (roda no vitest). O tick
// (roteiroConteudoTick.ts) busca os dados, chama a IA e envia.
import { limparSaidaIA } from "../_shared/limparSaidaIA.ts";

/** Roteiro do dia sai às 7h. Tick perdido (edge fora) ainda manda até 10h59; depois, não. */
export const HORA_ROTEIRO = 7;
export const HORA_LIMITE_ROTEIRO = 11;
/** Lembrete do print: 19h30 (a aula começa às 19h), até 21h59 — a aula acaba às 22h. */
export const MIN_AO_VIVO = 19 * 60 + 30;
export const MIN_LIMITE_AO_VIVO = 22 * 60;
/** Só aula que começa à noite ganha o lembrete das 19h30 (módulo de dia inteiro não). */
const INICIO_NOITE_MIN = 18 * 60;

const DIAS = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];

// Espelho de STATUS_LABELS / FORMAT_LABEL do Planner (src/components/marketing-portal/planner/).
const FORMATO: Record<string, string> = {
  feed: "Feed", carrossel: "Carrossel", reels: "Reels", story: "Story", email: "E-mail",
  disparo_wpp: "Disparo WPP", tiktok: "TikTok", linkedin: "LinkedIn", blog: "Blog", post: "Post",
};
const STATUS: Record<string, string> = {
  idea: "ideia", planning: "planejamento", to_do: "a fazer", in_progress: "em andamento",
  standby: "standby", adjustments: "ajustes", review_initial: "aprovação inicial",
  review_final: "aprovação final", scheduling: "aguardando agendamento", scheduled: "agendado",
  published: "publicado", finalized: "finalizado", error: "erro", calendar_month: "calendário do mês",
  curricular_class: "aula",
};

/**
 * Do currículo em tópicos do professor (ped_professores.curriculo_topicos), o que vale contar nos
 * stories, nesta ordem. "Titulação" fica de fora (já vai junto do nome) e título desconhecido
 * também: a "Formação" gerada às vezes repete o campo interno de recrutamento ("indicação ao
 * Programa de Pós-Graduação"), por isso ela é a última opção.
 */
const ORDEM_TOPICOS = ["atuação em campo", "nas aulas", "expertise prática", "especialidades", "diferencial", "formação"];

export interface ItemGrade {
  dia_semana: number; // 0 = domingo, igual ao extract(dow) do Postgres
  ordem: number;
  quando: string;
  o_que: string;
  formato: string | null;
  quem: string | null;
}
export interface CardPlanner { title: string | null; format: string | null; status: string | null }
export interface AulaDoDia {
  id: string;
  titulo: string;
  horario: string | null; // como vem de ped_aulas.horario ("19:00 - 22:00")
  curso: string;
  professor: string | null;
  titulacao: string | null;
  topicos: string[]; // já escolhidos (escolherTopicos)
  ementa: string | null;
}
export interface DadosRoteiro {
  apelido: string;
  ymd: string; // dia do roteiro, em Brasília
  itens: ItemGrade[]; // grade do dia, já filtrada e ordenada (itensDoDia)
  cards: CardPlanner[];
  /** O dono acompanha alguma pós (assistente_roteiro_config.pos_graduacao_ids não vazio)? */
  acompanhaAulas: boolean;
  aulasHoje: AulaDoDia[];
  aulasOntem: AulaDoDia[]; // só é buscada na quarta: é a base do carrossel técnico
}

export function diaDaSemana(ymd: string): number {
  return new Date(`${ymd}T12:00:00Z`).getUTCDay(); // meio-dia UTC: sem escorregar de dia pelo fuso
}

export function diaPorExtenso(ymd: string): string {
  const [, m, d] = ymd.split("-");
  return `${DIAS[diaDaSemana(ymd)]}, ${d}/${m}`;
}

export function itensDoDia(grade: ItemGrade[], ymd: string): ItemGrade[] {
  const dow = diaDaSemana(ymd);
  return grade.filter((i) => i.dia_semana === dow).sort((a, b) => a.ordem - b.ordem);
}

export const chaveRoteiro = (canon: string, ymd: string) => `roteiro:${canon}:${ymd}`;
export const chaveAoVivo = (canon: string, ymd: string) => `aovivo:${canon}:${ymd}`;

/** Minuto do dia (0..1439) → está na janela do roteiro da manhã? */
export const naJanelaRoteiro = (min: number) => min >= HORA_ROTEIRO * 60 && min < HORA_LIMITE_ROTEIRO * 60;
/** Minuto do dia → está na janela do lembrete do print? */
export const naJanelaAoVivo = (min: number) => min >= MIN_AO_VIVO && min < MIN_LIMITE_AO_VIVO;

export function escolherTopicos(topicos: unknown, max = 2): string[] {
  if (!Array.isArray(topicos)) return [];
  const peso = (t: any) => ORDEM_TOPICOS.indexOf(String(t?.titulo ?? "").trim().toLowerCase());
  return topicos
    .filter((t: any) => t && typeof t.texto === "string" && t.texto.trim() && peso(t) >= 0)
    .sort((a: any, b: any) => peso(a) - peso(b))
    .slice(0, max)
    .map((t: any) => String(t.texto).trim());
}

/** Corta no limite sem partir palavra no meio. */
export function encurtar(texto: string | null | undefined, max: number): string | null {
  const t = String(texto ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (t.length <= max) return t;
  const corte = t.slice(0, max);
  const espaco = corte.lastIndexOf(" ");
  return `${(espaco > max * 0.6 ? corte.slice(0, espaco) : corte).replace(/[\s,;:.]+$/, "")}…`;
}

/** "19:00 - 22:00" → "19h às 22h"; "19:30" → "19h30". Formato estranho volta como veio. */
export function horarioLegivel(h: string | null | undefined): string | null {
  const t = String(h ?? "").trim();
  if (!t) return null;
  const hm = (x: string) => {
    const [hh, mm] = x.split(":");
    return `${Number(hh)}h${mm && mm !== "00" ? mm : ""}`;
  };
  const faixa = t.match(/^(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})$/);
  if (faixa) return `${hm(faixa[1])} às ${hm(faixa[2])}`;
  if (/^\d{1,2}:\d{2}$/.test(t)) return hm(t);
  return t;
}

/** Minuto do dia em que a aula começa; null se o horário não tem hora legível. */
export function inicioEmMinutos(h: string | null | undefined): number | null {
  const m = String(h ?? "").trim().match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Aulas que começam à noite (as que ganham o lembrete do print às 19h30). */
export function aulasDaNoite(aulas: AulaDoDia[]): AulaDoDia[] {
  return aulas.filter((a) => {
    const ini = inicioEmMinutos(a.horario);
    return ini !== null && ini >= INICIO_NOITE_MIN && ini < MIN_LIMITE_AO_VIVO;
  });
}

function linhaItem(i: ItemGrade): string {
  const extra = [i.formato, i.quem].filter(Boolean).join(" · ");
  return `• *${i.quando}:* ${i.o_que}${extra ? ` _(${extra})_` : ""}`;
}

function quemDaAula(a: AulaDoDia): string | null {
  if (!a.professor) return null;
  return a.titulacao ? `${a.professor}, ${a.titulacao.trim().toLowerCase()}` : a.professor;
}

function blocoAulaDeHoje(a: AulaDoDia): string {
  const cab = [a.curso, horarioLegivel(a.horario)].filter(Boolean).join(", ");
  const linhas = [`*Aula de hoje* (${cab})`, a.titulo];
  const quem = quemDaAula(a);
  if (quem) linhas.push(`Com ${quem}`);
  for (const t of a.topicos) linhas.push(`• ${t}`);
  const ementa = encurtar(a.ementa, 280);
  if (ementa) linhas.push(`_Ementa:_ ${ementa}`);
  linhas.push("Nos stories: marque o @, agradeça pela parceria e reposte na @aacademiadapecuaria.");
  return linhas.join("\n");
}

function linhaAulaDeOntem(a: AulaDoDia): string {
  const quem = a.professor ? `, com ${a.professor}` : "";
  return `*Carrossel de hoje:* sai da aula de ontem, ${a.titulo}${quem}. Fecha com a chamada para a pós e o "comente RESUMO".`;
}

function blocoPlanner(cards: CardPlanner[]): string {
  if (!cards.length) return "*No Planner:* nada lançado para o seu perfil hoje.";
  const linhas = cards.slice(0, 8).map((c) => {
    const formato = FORMATO[String(c.format ?? "")] ?? (c.format || "Post");
    const status = STATUS[String(c.status ?? "")] ?? c.status;
    return `• ${formato}: ${(c.title || "sem título").trim()}${status ? ` (${status})` : ""}`;
  });
  return ["*No Planner para hoje*", ...linhas].join("\n");
}

/** A mensagem das 7h. `ideias` null = a IA não respondeu (a grade sai mesmo assim). */
export function textoRoteiro(d: DadosRoteiro, ideias: string | null): string {
  const partes = [`☀️ Bom dia${d.apelido ? `, ${d.apelido}` : ""}! Seu roteiro de hoje, ${diaPorExtenso(d.ymd)}:`];
  if (d.itens.length) partes.push(["*O que gravar hoje*", ...d.itens.map(linhaItem)].join("\n"));
  for (const a of d.aulasHoje) partes.push(blocoAulaDeHoje(a));
  if (d.acompanhaAulas && diaDaSemana(d.ymd) === 2 && !d.aulasHoje.length) {
    partes.push("*Aula de hoje:* não achei aula da pós no cronograma de hoje.");
  }
  for (const a of d.aulasOntem.slice(0, 1)) if (diaDaSemana(d.ymd) === 3) partes.push(linhaAulaDeOntem(a));
  partes.push(blocoPlanner(d.cards));
  partes.push(ideias
    ? `*Ideias do dia*\n${ideias}`
    : "_As ideias do dia não vieram desta vez. Me peça aqui que eu escrevo._");
  return partes.join("\n\n");
}

/** O lembrete das 19h30, só no dia de aula à noite. */
export function textoAoVivo(apelido: string, aula: AulaDoDia): string {
  const quem = aula.professor ? `, com ${aula.professor}` : "";
  return `🎥 ${apelido ? `${apelido}, a` : "A"} aula começou: *${aula.titulo}*${quem}. Hora do print de um slide nos stories, com a chamada para a pós.`;
}

/** System + pedido das ideias. O contexto vai inteiro: o modelo só pode usar o que está aqui. */
export function promptIdeias(d: DadosRoteiro): { system: string; user: string } {
  const system =
`Você é o estrategista de conteúdo do perfil pessoal de Rafael Costa, um dos donos da PPGVET (pós-graduação para médicos veterinários e zootecnistas, sede em Ampére/PR).
Os perfis de Rafael (Instagram @raafaelcostta, TikTok e LinkedIn) existem para gerar alcance, gerar confiança na PPGVET e levar o conteúdo técnico da pós de Bovinos.
Temas fixos, além da grade: pessoas, comportamento humano e comunicação, e como isso pesa no resultado profissional; cases de empresas, principalmente de marketing; insights de livros.

Escreva exatamente 3 ideias do que gravar ou postar HOJE, ancoradas na grade do dia e no contexto.
Formato, para WhatsApp: "1." + um título curto em *negrito*; na linha de baixo, 1 ou 2 frases de roteiro com o gancho da abertura e o que mostrar ou falar.
Regras: português do Brasil, frases curtas, jeito de quem fala de verdade. Sem travessão, sem hashtag, sem emoji. Não invente fato sobre professor, aluno ou número da empresa: use só o que está no contexto. Responda só com as 3 ideias, sem introdução nem fecho.`;

  const linhas = [`Hoje: ${diaPorExtenso(d.ymd)}.`];
  linhas.push(d.itens.length
    ? `Grade do dia:\n${d.itens.map((i) => `- ${i.quando}: ${i.o_que}${i.formato ? ` (${i.formato})` : ""}`).join("\n")}`
    : "Grade do dia: nada fixo.");
  for (const a of d.aulasHoje) {
    linhas.push([
      `Aula da pós hoje à noite (${a.curso}): ${a.titulo}.`,
      a.professor ? `Quem dá a aula: ${quemDaAula(a)}.` : null,
      a.topicos.length ? `Currículo: ${a.topicos.join(" ")}` : null,
      a.ementa ? `Ementa: ${encurtar(a.ementa, 600)}` : null,
    ].filter(Boolean).join("\n"));
  }
  if (diaDaSemana(d.ymd) === 3) {
    for (const a of d.aulasOntem.slice(0, 1)) {
      linhas.push(`Aula de ontem (base do carrossel técnico de hoje): ${a.titulo}${a.professor ? `, com ${a.professor}` : ""}.${a.ementa ? ` Ementa: ${encurtar(a.ementa, 600)}` : ""}`);
    }
  }
  if (d.cards.length) {
    linhas.push(`Já planejado pelo marketing para hoje:\n${d.cards.slice(0, 8).map((c) => `- ${FORMATO[String(c.format ?? "")] ?? c.format ?? "Post"}: ${c.title ?? "sem título"}`).join("\n")}`);
  }
  return { system, user: linhas.join("\n\n") };
}

/**
 * Saída da IA → texto de WhatsApp: tira moldura e travessão, troca **negrito** por *negrito*.
 * As ideias começam em "1.": o que vier antes é conversa com o operador ("Aqui estão as 3
 * ideias:"), que o limparSaidaIA deixa passar por ser estreito de propósito.
 */
export function limparIdeias(bruto: string | null | undefined): string | null {
  let t = limparSaidaIA(String(bruto ?? ""));
  const linhas = t.split("\n");
  const primeira = linhas.findIndex((l) => /^\s*\*{0,2}1[.)]\s/.test(l));
  if (primeira > 0) t = linhas.slice(primeira).join("\n");
  t = t.replace(/\*\*(.+?)\*\*/g, "*$1*").replace(/^#+\s*/gm, "").trim();
  if (!t) return null;
  return t.length > 1800 ? `${t.slice(0, 1800).replace(/\s+\S*$/, "")}…` : t;
}
