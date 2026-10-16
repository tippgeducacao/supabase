// Bot de comandos do WhatsApp "Monitor" (linha WHATSAPP - TI; pedido do usuário, 16/10/2026).
// Régua pura, testada no vitest: entender o comando e o período, achar a pessoa pelo nome, montar
// a linha da pessoa a partir das fontes da planilha de desempenho e escrever as respostas.
// Fila, banco e envio em botComandosTick.ts. Quem pode usar (só membros do grupo Setor TI, no
// privado) é decidido no wa-uazapi-webhook, antes de a mensagem chegar aqui.
import { linhasBloco, type BlocoComercial } from "./relatoriosGrupo.ts";

export interface Periodo { de: string; ate: string; rotulo: string }

/** Teto do período: as fontes da planilha têm 20 s de timeout; um ano inteiro não cabe. */
export const MAX_DIAS_PERIODO = 120;

const DIAS_CURTO = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

function dow(ymd: string): number {
  return new Date(`${ymd}T12:00:00Z`).getUTCDay(); // meio-dia UTC: sem escorregar de dia pelo fuso
}
function addDias(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function ddmm(ymd: string): string {
  const [, m, d] = ymd.split("-");
  return `${d}/${m}`;
}
function diaCurto(ymd: string): string {
  return `${DIAS_CURTO[dow(ymd)]} ${ddmm(ymd)}`;
}
function diasEntre(de: string, ate: string): number {
  return Math.round((Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / 86_400_000) + 1;
}

/** Minúsculas, sem acento, espaços simples — para comparar comando e nome. */
export function normalizar(s: string | null | undefined): string {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^\p{L}\p{N}/\s-]/gu, " ").replace(/\s+/g, " ").trim();
}

/** Quarta-feira da semana comercial (qua→ter) que contém o dia. */
export function inicioSemanaComercial(ymd: string): string {
  return addDias(ymd, -((dow(ymd) - 3 + 7) % 7));
}

/** "15/10" ou "15/10/2026" → AAAA-MM-DD (o ano, se omitido, é o de hoje). */
function lerData(s: string, hoje: string): string | null {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/);
  if (!m) return null;
  const ano = m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : hoje.slice(0, 4);
  const ymd = `${ano}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const d = new Date(`${ymd}T12:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === ymd ? ymd : null;
}

/**
 * O período do comando. Vazio = semana comercial (quarta até hoje), o padrão pedido pelo usuário.
 * Nunca passa de hoje. null = não reconheci, ou período impossível (começa no futuro, > 120 dias).
 */
export function interpretarPeriodo(texto: string, hoje: string): Periodo | null {
  const t = normalizar(texto);
  const semanaIni = inicioSemanaComercial(hoje);
  const mesIni = `${hoje.slice(0, 7)}-01`;
  if (t === "" || t === "semana" || t === "na semana" || t === "da semana" || t === "essa semana" || t === "esta semana") {
    return { de: semanaIni, ate: hoje, rotulo: `Semana comercial · ${diaCurto(semanaIni)} a ${diaCurto(hoje)}` };
  }
  if (t === "hoje") return { de: hoje, ate: hoje, rotulo: `Hoje · ${diaCurto(hoje)}` };
  if (t === "ontem") {
    const o = addDias(hoje, -1);
    return { de: o, ate: o, rotulo: `Ontem · ${diaCurto(o)}` };
  }
  if (t === "semana passada") {
    const de = addDias(semanaIni, -7);
    const ate = addDias(semanaIni, -1);
    return { de, ate, rotulo: `Semana passada · ${diaCurto(de)} a ${diaCurto(ate)}` };
  }
  if (t === "mes" || t === "no mes" || t === "do mes" || t === "esse mes" || t === "este mes") {
    return { de: mesIni, ate: hoje, rotulo: `Mês · ${ddmm(mesIni)} a ${ddmm(hoje)}` };
  }
  if (t === "mes passado") {
    const ate = addDias(mesIni, -1);
    const de = `${ate.slice(0, 7)}-01`;
    return { de, ate, rotulo: `Mês passado · ${ddmm(de)} a ${ddmm(ate)}` };
  }

  const faixa = t.match(/^(?:de )?(\S+)\s+(?:a|ate|-)\s+(\S+)$/);
  let de: string | null = null;
  let ate: string | null = null;
  if (faixa) {
    de = lerData(faixa[1], hoje);
    ate = lerData(faixa[2], hoje);
  } else {
    de = ate = lerData(t.replace(/^(dia|em|no) /, ""), hoje);
  }
  if (!de || !ate || de > hoje || ate < de) return null;
  if (ate > hoje) ate = hoje;
  if (diasEntre(de, ate) > MAX_DIAS_PERIODO) return null;
  return { de, ate, rotulo: de === ate ? diaCurto(de) : `${ddmm(de)} a ${ddmm(ate)}` };
}

export type Comando =
  | { tipo: "menu" }
  | { tipo: "resumo"; nome: string; periodo: Periodo }
  | { tipo: "resumo_sem_nome" }
  | { tipo: "comercial"; periodo: Periodo }
  | { tipo: "pendentes" }
  | { tipo: "periodo_invalido"; texto: string }
  | { tipo: "desconhecido" };

const MENU = new Set(["", "menu", "ajuda", "help", "comandos", "oi", "ola", "bom dia", "boa tarde", "boa noite", "inicio", "start", "?"]);

export function interpretarComando(texto: string, hoje: string): Comando {
  const t = normalizar(texto).replace(/^[/!]+/, "");
  if (MENU.has(t)) return { tipo: "menu" };

  const palavras = t.split(" ");
  const [cabeca, ...resto] = palavras;

  if (cabeca === "resumo" || cabeca === "pessoa") {
    // "resumo da Aline mês": o nome é o começo, o período é o MAIOR final que vira período. O
    // laço sempre termina (sufixo vazio = semana): um período digitado errado vira parte do nome e
    // a resposta é "não achei", que mostra o que foi lido.
    const args = resto[0] === "da" || resto[0] === "do" || resto[0] === "de" ? resto.slice(1) : resto;
    if (!args.length) return { tipo: "resumo_sem_nome" };
    for (let i = 1; i <= args.length; i++) {
      const periodo = interpretarPeriodo(args.slice(i).join(" "), hoje);
      if (periodo) return { tipo: "resumo", nome: args.slice(0, i).join(" "), periodo };
    }
    return { tipo: "periodo_invalido", texto: args.join(" ") };
  }

  if (cabeca === "comercial" || cabeca === "relatorio" || cabeca === "time") {
    const periodo = interpretarPeriodo(resto.join(" "), hoje);
    return periodo ? { tipo: "comercial", periodo } : { tipo: "periodo_invalido", texto: resto.join(" ") };
  }

  if (cabeca === "pendentes" || cabeca === "pendente") return { tipo: "pendentes" };
  return { tipo: "desconhecido" };
}

// ── A pessoa ─────────────────────────────────────────────────────────────────

export interface PessoaComercial { id: string; nome: string; user_type: string }

export type Busca =
  | { tipo: "ok"; pessoa: PessoaComercial }
  | { tipo: "nenhuma" }
  | { tipo: "varias"; opcoes: PessoaComercial[] };

/**
 * Cada palavra digitada tem de ser o começo de uma palavra do nome ("ped flo" acha Pedro Flores).
 * Entre vários, vence quem casa as palavras INTEIRAS ("ana" fica com Ana, não com Anabela); empate
 * = pergunta de volta, nunca chuta.
 */
export function encontrarPessoa(pessoas: PessoaComercial[], consulta: string): Busca {
  const q = normalizar(consulta).split(" ").filter(Boolean);
  if (!q.length) return { tipo: "nenhuma" };
  const pontuadas = pessoas
    .map((p) => {
      const palavras = normalizar(p.nome).split(" ");
      const casa = q.every((t) => palavras.some((w) => w.startsWith(t)));
      const inteiras = q.filter((t) => palavras.includes(t)).length;
      const exato = normalizar(p.nome) === q.join(" ");
      return { p, casa, pontos: (exato ? 100 : 0) + inteiras };
    })
    .filter((x) => x.casa)
    .sort((a, b) => b.pontos - a.pontos);
  if (!pontuadas.length) return { tipo: "nenhuma" };
  if (pontuadas.length === 1 || pontuadas[0].pontos > pontuadas[1].pontos) return { tipo: "ok", pessoa: pontuadas[0].p };
  const topo = pontuadas.filter((x) => x.pontos === pontuadas[0].pontos);
  return { tipo: "varias", opcoes: topo.slice(0, 8).map((x) => x.p) };
}

/** Os números de uma pessoa no período — as mesmas colunas da planilha de desempenho. */
export interface LinhaPessoa {
  nome: string;
  papel: "vendedor" | "sdr";
  leads: number;
  agendamentos: number;
  comparecimentos: number;
  naoCompareceram: number;
  matriculas: number;
  interacoes: number | null;
  interacoesComLead: number | null;
  leadsInteragidos: number | null;
  ligacaoSegundos: number | null;
  indicacoes: number | null;
  organicos: number | null;
}

const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const numOuNull = (v: unknown): number | null => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * bot_comercial_fontes_pessoa → linha. Espelho de planilhaVendedores.ts (leitura "o que aconteceu
 * no período": leads do funil; reuniões, comparecidas e vendas da atividade pela data do fato) e
 * de planilhaSdrs.ts (leads de metricas_leads_recebidos_v2; o resto de metricas_sdrs_atividade_v2).
 * Mudou a planilha → mude aqui.
 */
export function linhaDasFontes(f: any, pessoaId: string): LinhaPessoa {
  const papel: "vendedor" | "sdr" = f?.papel === "sdr" ? "sdr" : "vendedor";
  const acha = (lista: any, chave: string) => (Array.isArray(lista) ? lista.find((e: any) => e?.[chave] === pessoaId) : null);
  const extras = acha(f?.atividade?.linhas, papel === "sdr" ? "sdr_id" : "vendedor_id");
  let base: Pick<LinhaPessoa, "leads" | "agendamentos" | "comparecimentos" | "naoCompareceram" | "matriculas">;
  if (papel === "vendedor") {
    const chegada = acha(f?.funil?.vendedores, "id");
    const atv = acha(f?.funil?.atividade?.vendedores, "id");
    base = {
      leads: num(chegada?.leads),
      agendamentos: num(atv?.reunioes),
      comparecimentos: num(atv?.compareceram),
      naoCompareceram: num(atv?.nao_compareceram),
      matriculas: num(atv?.convertidas),
    };
  } else {
    const rec = acha(f?.recebidos?.linhas, "usuario_id");
    base = {
      leads: num(rec?.leads_recebidos),
      agendamentos: num(extras?.agendamentos),
      comparecimentos: num(extras?.comparecimentos),
      naoCompareceram: num(extras?.nao_compareceram),
      matriculas: num(extras?.matriculas),
    };
  }
  return {
    nome: String(f?.nome ?? ""),
    papel,
    ...base,
    interacoes: numOuNull(extras?.mensagens_humanas_enviadas),
    interacoesComLead: numOuNull(extras?.mensagens_com_lead),
    leadsInteragidos: numOuNull(extras?.leads_contatados_whatsapp),
    ligacaoSegundos: numOuNull(extras?.tempo_conversa_segundos),
    indicacoes: numOuNull(extras?.indicacoes_cadastradas),
    organicos: numOuNull(extras?.organicos_cadastrados),
  };
}

// ── Os textos ────────────────────────────────────────────────────────────────

/** 2 casas sempre (regra 5 do CLAUDE.md), vírgula decimal. */
export function dec2(n: number): string {
  return n.toFixed(2).replace(".", ",");
}
function pct(n: number, d: number): string {
  return d > 0 ? `${dec2((n / d) * 100)}%` : "—";
}
function duracao(seg: number): string {
  const min = Math.round(seg / 60);
  const h = Math.floor(min / 60);
  return h ? `${h}h ${String(min % 60).padStart(2, "0")}min` : `${min}min`;
}
function reais(v: number): string {
  return `R$ ${v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, "#").replace(".", ",").replace(/#/g, ".")}`;
}

export function textoMenu(): string {
  return [
    "🤖 *Monitor PPGVET — comandos*",
    "",
    "👤 *resumo <nome>* [período]",
    "Funil de uma pessoa do comercial: leads recebidos, reuniões, comparecidas, vendas, as taxas e as interações no WhatsApp.",
    "",
    "📊 *comercial* [período]",
    "O time todo: reuniões comparecidas, sem resultado marcado, vendas e pendentes.",
    "",
    "🕓 *pendentes*",
    "Vendas esperando a aprovação da secretaria agora.",
    "",
    "❓ *menu* — esta lista",
    "",
    "*Períodos:* hoje · ontem · semana (padrão: de quarta até hoje) · semana passada · mês · mês passado · 15/10 · 01/10 a 15/10",
    "",
    "Exemplos: _resumo Aline_ · _resumo Pedro mês_ · _comercial ontem_",
  ].join("\n");
}

export function textoResumoPessoa(l: LinhaPessoa, p: Periodo): string {
  const avaliadas = l.comparecimentos + l.naoCompareceram;
  const linhas = [
    `👤 *${l.nome}* · ${l.papel === "sdr" ? "SDR" : "Vendedor(a)"}`,
    `📅 ${p.rotulo}`,
    "",
    `📥 Leads recebidos: *${l.leads}*`,
    `📆 Reuniões ${l.papel === "sdr" ? "marcadas" : "agendadas"}: *${l.agendamentos}*`,
    `✅ Reuniões comparecidas: *${l.comparecimentos}*`,
    `❌ Não compareceram: *${l.naoCompareceram}*`,
    `💰 Vendas: *${l.matriculas}*`,
    "",
    "📊 *Taxas*",
    `• Vendas ÷ leads: *${pct(l.matriculas, l.leads)}*`,
    `• Vendas ÷ comparecidas: *${pct(l.matriculas, l.comparecimentos)}*`,
    `• Comparecimento: *${pct(l.comparecimentos, avaliadas)}* _(das reuniões que já têm resultado)_`,
    `• Comparecidas ÷ leads: *${pct(l.comparecimentos, l.leads)}*`,
    `• Reuniões ÷ leads: *${pct(l.agendamentos, l.leads)}*`,
    "",
  ];
  if (l.interacoes === null) {
    linhas.push("💬 Interações no WhatsApp: —");
  } else {
    const media = l.interacoesComLead !== null && (l.leadsInteragidos ?? 0) > 0
      ? ` · média *${dec2(l.interacoesComLead / l.leadsInteragidos!)}* por lead (${l.leadsInteragidos} leads)`
      : "";
    linhas.push(`💬 Interações no WhatsApp: *${l.interacoes}*${media}`);
  }
  linhas.push(`📞 Tempo em ligação (3C): ${l.ligacaoSegundos === null ? "—" : `*${duracao(l.ligacaoSegundos)}*`}`);
  if (l.indicacoes !== null || l.organicos !== null) {
    linhas.push(`🤝 Captações: *${l.indicacoes ?? 0}* indicações · *${l.organicos ?? 0}* orgânicos`);
  }
  linhas.push("", "_Mesma conta da planilha de desempenho (Métricas do Time): reuniões e vendas pela data do fato, leads pela carteira atual. Vendas podem passar das comparecidas (venda de reunião antiga)._");
  return linhas.join("\n");
}

export function textoComercialPeriodo(p: Periodo, b: BlocoComercial): string {
  return [`📊 *Comercial*`, `📅 ${p.rotulo}`, "", ...linhasBloco(b)].join("\n");
}

/** assist_vendas_pendentes de todas as datas: o que espera aprovação agora. */
export function textoPendentes(j: any): string {
  const q = j?.quebra ?? {};
  const partes = [
    num(q?.pos?.qtd) ? `${num(q.pos.qtd)} pós` : null,
    num(q?.cursos?.qtd) ? `${num(q.cursos.qtd)} curso livre` : null,
    num(q?.modulos?.qtd) ? `${num(q.modulos.qtd)} módulo prático` : null,
  ].filter(Boolean);
  const qtd = num(j?.qtd);
  if (!qtd) return "🕓 *Vendas pendentes agora:* nenhuma. Tudo aprovado. ✅";
  return [
    `🕓 *Vendas pendentes agora:* *${qtd}*${partes.length ? ` (${partes.join(" · ")})` : ""}`,
    `💵 Valor em contrato: *${reais(num(j?.faturamento))}*`,
    "_Esperando a aprovação da secretaria; ainda não contam como venda._",
  ].join("\n");
}

export function textoNaoAchei(nome: string): string {
  return `Não achei ninguém do comercial chamado *${nome}* (procuro vendedores e SDRs ativos). Tente o primeiro nome ou nome e sobrenome.`;
}

export function textoVarias(opcoes: PessoaComercial[]): string {
  return [`Achei mais de uma pessoa. Qual delas?`, ...opcoes.map((o) => `• ${o.nome}`), "", "Mande o nome completo, ex.: _resumo " + opcoes[0].nome + "_"].join("\n");
}

export const TEXTO_PERIODO_INVALIDO =
  "Não entendi o período. Use: hoje · ontem · semana · semana passada · mês · mês passado · 15/10 · 01/10 a 15/10 (até 120 dias, nunca no futuro).";

export const TEXTO_RESUMO_SEM_NOME = "De quem? Mande *resumo* e o nome, ex.: _resumo Aline_ ou _resumo Aline mês_.";

export const TEXTO_SO_TEXTO = "Por enquanto eu só entendo mensagem de texto. Mande *menu* para ver os comandos.";
