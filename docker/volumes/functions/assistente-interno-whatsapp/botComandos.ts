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
const MESES = ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const MESES_ROTULO = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];

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
  // "setembro" / "setembro 2025": mês pelo nome. Sem ano, o último que já começou.
  const mesNome = t.match(/^(?:em |de |no mes de )?([a-z]+)(?: de)?(?: (\d{4}))?$/);
  const idxMes = mesNome ? MESES.indexOf(mesNome[1]) : -1;
  if (mesNome && idxMes >= 0) {
    let ano = mesNome[2] ? Number(mesNome[2]) : Number(hoje.slice(0, 4));
    const mm = String(idxMes + 1).padStart(2, "0");
    if (!mesNome[2] && `${ano}-${mm}-01` > hoje) ano -= 1;
    const de = `${ano}-${mm}-01`;
    if (de > hoje) return null;
    const fimMes = addDias(`${idxMes === 11 ? ano + 1 : ano}-${String(((idxMes + 1) % 12) + 1).padStart(2, "0")}-01`, -1);
    const ate = fimMes > hoje ? hoje : fimMes;
    return { de, ate, rotulo: `${MESES_ROTULO[idxMes]}/${ano} · ${ddmm(de)} a ${ddmm(ate)}` };
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
  | { tipo: "pos"; nome: string; periodo: Periodo }
  | { tipo: "pos_sem_nome" }
  | { tipo: "comercial"; periodo: Periodo }
  | { tipo: "ranking"; periodo: Periodo }
  | { tipo: "faturamento"; periodo: Periodo }
  | { tipo: "cac"; periodo: Periodo }
  | { tipo: "pendentes" }
  | { tipo: "periodo_invalido"; texto: string }
  | { tipo: "desconhecido" };

const MENU = new Set(["", "menu", "ajuda", "help", "comandos", "oi", "ola", "bom dia", "boa tarde", "boa noite", "inicio", "start", "?"]);

/**
 * "Aline mês" / "da Ana Paula 01/10 a 15/10": o nome é o começo, o período é o MAIOR final que
 * vira período. Sempre acha (sufixo vazio = semana): um período digitado errado vira parte do nome
 * e a resposta é "não achei", que mostra o que foi lido.
 */
function nomeEPeriodo(args: string[], hoje: string): { nome: string; periodo: Periodo } | null {
  const a = args[0] === "da" || args[0] === "do" || args[0] === "de" ? args.slice(1) : args;
  for (let i = 1; i <= a.length; i++) {
    const periodo = interpretarPeriodo(a.slice(i).join(" "), hoje);
    if (periodo) return { nome: a.slice(0, i).join(" "), periodo };
  }
  return null;
}

export function interpretarComando(texto: string, hoje: string): Comando {
  const t = normalizar(texto).replace(/^[/!]+/, "");
  if (MENU.has(t)) return { tipo: "menu" };

  const [cabeca, ...resto] = t.split(" ");
  const periodoDoResto = (tipo: "comercial" | "ranking" | "faturamento"): Comando => {
    const periodo = interpretarPeriodo(resto.join(" "), hoje);
    return periodo ? { tipo, periodo } : { tipo: "periodo_invalido", texto: resto.join(" ") };
  };

  if (cabeca === "resumo" || cabeca === "pessoa") {
    if (!resto.length) return { tipo: "resumo_sem_nome" };
    const r = nomeEPeriodo(resto, hoje);
    return r ? { tipo: "resumo", ...r } : { tipo: "periodo_invalido", texto: resto.join(" ") };
  }
  if (cabeca === "pos" || cabeca === "curso") {
    if (!resto.length) return { tipo: "pos_sem_nome" };
    const r = nomeEPeriodo(resto, hoje);
    return r ? { tipo: "pos", ...r } : { tipo: "periodo_invalido", texto: resto.join(" ") };
  }
  if (cabeca === "comercial" || cabeca === "relatorio" || cabeca === "time") return periodoDoResto("comercial");
  if (cabeca === "ranking") return periodoDoResto("ranking");
  if (cabeca === "faturamento" || cabeca === "receita") return periodoDoResto("faturamento");
  if (cabeca === "cac") {
    // O CAC é MENSAL (salário não se divide por semana): sem período, o mês corrente.
    const periodo = interpretarPeriodo(resto.length ? resto.join(" ") : "mes", hoje);
    return periodo ? { tipo: "cac", periodo } : { tipo: "periodo_invalido", texto: resto.join(" ") };
  }
  if (cabeca === "pendentes" || cabeca === "pendente") return { tipo: "pendentes" };
  return { tipo: "desconhecido" };
}

// ── Achar pelo nome (pessoa ou pós) ──────────────────────────────────────────

export interface PessoaComercial { id: string; nome: string; user_type: string }

export type Busca<T> =
  | { tipo: "ok"; item: T }
  | { tipo: "nenhuma" }
  | { tipo: "varias"; opcoes: T[] };

/**
 * Cada palavra digitada tem de ser o começo de uma palavra do nome ("ped flo" acha Pedro Flores;
 * "sanidade" acha "PÓS | SANIDADE AVÍCOLA"). Entre vários, vence quem casa as palavras INTEIRAS
 * ("ana" fica com Ana, não com Anabela); empate = pergunta de volta, nunca chuta.
 */
export function encontrarPorNome<T extends { nome: string }>(itens: T[], consulta: string): Busca<T> {
  const q = normalizar(consulta).split(" ").filter(Boolean);
  if (!q.length) return { tipo: "nenhuma" };
  const pontuadas = itens
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
  if (pontuadas.length === 1 || pontuadas[0].pontos > pontuadas[1].pontos) return { tipo: "ok", item: pontuadas[0].p };
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
    "🎓 *pos <nome da pós>* [período]",
    "Resumo de uma pós: leads, reuniões, comparecidas, vendas, faturamento e CAC de mídia.",
    "",
    "🏆 *ranking* [período]",
    "As pós mais vendidas, com o faturamento de cada uma.",
    "",
    "💵 *faturamento* [período]",
    "Quanto foi vendido, com a matrícula inclusa: pós, cursos livres e módulos.",
    "",
    "💸 *cac* [mês]",
    "Custo por matrícula (mídia + times), geral e por canal. Padrão: o mês atual.",
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
    "Exemplos: _resumo Aline_ · _pos sanidade mês_ · _ranking setembro_ · _cac mês passado_",
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

export function textoNaoAcheiPos(nome: string): string {
  return `Não achei nenhuma pós com *${nome}* no nome. Tente uma palavra do nome, ex.: _pos sanidade_, _pos bovinos_, _pos cannabis_.`;
}

/** Empate na busca: lista as opções e mostra como pedir. `comando` = "resumo" ou "pos". */
export function textoVarias(opcoes: { nome: string }[], comando = "resumo"): string {
  const exemplo = normalizar(opcoes[0].nome).split(" ").filter((w) => w !== "pos" && w !== "mba").slice(0, 3).join(" ");
  return [
    comando === "pos" ? "Achei mais de uma pós. Qual delas?" : "Achei mais de uma pessoa. Qual delas?",
    ...opcoes.map((o) => `• ${o.nome}`),
    "",
    `Mande o nome mais completo, ex.: _${comando} ${comando === "pos" ? exemplo : opcoes[0].nome}_`,
  ].join("\n");
}

// ── Pós, ranking, faturamento e CAC ──────────────────────────────────────────

/** Um item de bot_comercial_por_pos (uma pós, curso livre ou módulo no período). */
export interface ItemPos {
  curso_id: string;
  nome: string;
  tipo: string | null;
  ativo: boolean;
  categoria: string | null; // pos_graduacao | curso_livre | modulo_pratico | null (sem venda)
  vendas: number;
  faturamento: number;
  valor_contratos: number;
  valor_matriculas: number;
  leads: number;
  qualificados: number;
  verba: number;
  reunioes: number;
  avaliadas: number;
  comparecidas: number;
}

export function lerItensPos(j: any): ItemPos[] {
  return (Array.isArray(j?.itens) ? j.itens : []).map((e: any) => ({
    curso_id: String(e?.curso_id ?? ""),
    nome: String(e?.nome ?? "(sem curso)"),
    tipo: e?.tipo ?? null,
    ativo: e?.ativo !== false,
    categoria: e?.categoria ?? null,
    vendas: num(e?.vendas),
    faturamento: num(e?.faturamento),
    valor_contratos: num(e?.valor_contratos),
    valor_matriculas: num(e?.valor_matriculas),
    leads: num(e?.leads),
    qualificados: num(e?.qualificados),
    verba: num(e?.verba),
    reunioes: num(e?.reunioes),
    avaliadas: num(e?.avaliadas),
    comparecidas: num(e?.comparecidas),
  }));
}

/** É pós? Curso do tipo Pós-Graduação (MBA incluso), ou que vendeu como pós no período. */
export function ehPos(i: ItemPos): boolean {
  return i.tipo === "Pós-Graduação" || i.categoria === "pos_graduacao";
}

export function textoResumoPos(i: ItemPos, p: Periodo): string {
  return [
    `🎓 *${i.nome}*`,
    `📅 ${p.rotulo}`,
    "",
    `📥 Leads: *${i.leads}* (qualificados: ${i.qualificados})`,
    `📆 Reuniões: *${i.reunioes}*`,
    `✅ Comparecidas: *${i.comparecidas}* · comparecimento *${pct(i.comparecidas, i.avaliadas)}*`,
    `💰 Vendas: *${i.vendas}*`,
    `📊 Vendas ÷ comparecidas: *${pct(i.vendas, i.comparecidas)}* · vendas ÷ leads: *${pct(i.vendas, i.leads)}*`,
    "",
    `💵 Faturamento: *${reais(i.faturamento)}*`,
    `   contratos ${reais(i.valor_contratos)} + matrículas ${reais(i.valor_matriculas)}`,
    `   ticket médio ${i.vendas ? reais(i.faturamento / i.vendas) : "—"}`,
    `📣 Verba de mídia: *${reais(i.verba)}*`,
    `💸 CAC de mídia (verba ÷ vendas): *${i.vendas ? reais(i.verba / i.vendas) : "—"}*`,
    "",
    "_Leads e verba: Dashboard por Pós · reuniões: interesse marcado na reunião · vendas e faturamento: régua do Receita por Pós (data de assinatura; contrato + matrícula). O CAC completo, com os times, é o comando *cac*._",
  ].join("\n");
}

const MEDALHAS = ["🥇", "🥈", "🥉"];

export function textoRanking(itens: ItemPos[], p: Periodo, limite = 15): string {
  const pos = itens.filter((i) => ehPos(i) && i.vendas > 0)
    .sort((a, b) => b.vendas - a.vendas || b.faturamento - a.faturamento || a.nome.localeCompare(b.nome));
  if (!pos.length) return [`🏆 *Pós mais vendidas*`, `📅 ${p.rotulo}`, "", "Nenhuma pós vendida no período."].join("\n");
  const totalVendas = pos.reduce((s, i) => s + i.vendas, 0);
  const totalFat = pos.reduce((s, i) => s + i.faturamento, 0);
  const linhas = pos.slice(0, limite).map((i, k) =>
    `${MEDALHAS[k] ?? `${k + 1}.`} ${i.nome} — *${i.vendas}* ${i.vendas === 1 ? "venda" : "vendas"} · ${reais(i.faturamento)}`);
  const resto = pos.length > limite ? [`… e mais ${pos.length - limite} pós com venda.`] : [];
  return [
    `🏆 *Pós mais vendidas*`,
    `📅 ${p.rotulo}`,
    "",
    ...linhas,
    ...resto,
    "",
    `*Total:* ${totalVendas} vendas de pós · ${reais(totalFat)} (matrícula inclusa)`,
  ].join("\n");
}

export function textoFaturamento(itens: ItemPos[], p: Periodo): string {
  const soma = (cat: string) => {
    const xs = itens.filter((i) => i.categoria === cat);
    return {
      vendas: xs.reduce((s, i) => s + i.vendas, 0),
      fat: xs.reduce((s, i) => s + i.faturamento, 0),
      contratos: xs.reduce((s, i) => s + i.valor_contratos, 0),
      matriculas: xs.reduce((s, i) => s + i.valor_matriculas, 0),
    };
  };
  const pos = soma("pos_graduacao");
  const livres = soma("curso_livre");
  const modulos = soma("modulo_pratico");
  const totalVendas = pos.vendas + livres.vendas + modulos.vendas;
  const total = pos.fat + livres.fat + modulos.fat;
  return [
    `💵 *Faturamento* (matrícula inclusa)`,
    `📅 ${p.rotulo}`,
    "",
    `🎓 Pós-graduação: *${reais(pos.fat)}* · ${pos.vendas} vendas`,
    `   contratos ${reais(pos.contratos)} + matrículas ${reais(pos.matriculas)}`,
    `   ticket médio ${pos.vendas ? reais(pos.fat / pos.vendas) : "—"}`,
    `📘 Cursos livres: *${reais(livres.fat)}* · ${livres.vendas} vendas`,
    `🧪 Módulos práticos: *${reais(modulos.fat)}* · ${modulos.vendas} vendas`,
    "",
    `*Total: ${reais(total)}* · ${totalVendas} vendas`,
    "",
    "_Valor vendido (contratos assinados no período), não o que entrou no caixa. Mesma régua do gráfico Receita por Pós._",
  ].join("\n");
}

/** Uma linha de mkt_cac_mensal (mês × canal). */
export interface LinhaCac {
  mes: string;
  canal_nome: string;
  custo: number;
  verba_midia: number;
  matriculas: number;
  mes_consolidado: boolean;
}

/** O CAC é mensal: os meses inteiros que o período toca. */
export function mesesDoPeriodo(p: Periodo): { ini: string; fim: string } {
  const ini = `${p.de.slice(0, 7)}-01`;
  const [y, m] = p.ate.slice(0, 7).split("-").map(Number);
  const prox = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { ini, fim: addDias(prox, -1) };
}

export function textoCac(linhas: LinhaCac[], p: Periodo): string {
  const meses = [...new Set(linhas.map((l) => l.mes.slice(0, 7)))].sort();
  const rotuloMeses = meses.map((m) => `${MESES_ROTULO[Number(m.slice(5, 7)) - 1]}/${m.slice(0, 4)}`).join(" + ");
  const aberto = linhas.some((l) => !l.mes_consolidado);
  const custo = linhas.reduce((s, l) => s + l.custo, 0);
  const verba = linhas.reduce((s, l) => s + l.verba_midia, 0);
  const matr = linhas.reduce((s, l) => s + l.matriculas, 0);
  if (!linhas.length) return `💸 *CAC* · ${p.rotulo}\n\nSem dados de custo para esse período.`;

  const porCanal = new Map<string, { custo: number; verba: number; matr: number }>();
  for (const l of linhas) {
    const c = porCanal.get(l.canal_nome) ?? { custo: 0, verba: 0, matr: 0 };
    c.custo += l.custo; c.verba += l.verba_midia; c.matr += l.matriculas;
    porCanal.set(l.canal_nome, c);
  }
  const canais = [...porCanal.entries()].sort((a, b) => b[1].matr - a[1].matr).map(([nome, c]) => {
    const midia = c.verba > 0 ? ` · mídia ${reais(c.verba)}` : "";
    return `• ${nome}: *${c.matr ? reais(c.custo / c.matr) : "—"}* por matrícula (${c.matr} matr.)${midia}`;
  });
  return [
    `💸 *CAC* · ${rotuloMeses}${aberto ? " (mês aberto)" : " (fechado)"}`,
    "",
    `Custo total (mídia + times): *${reais(custo)}*`,
    `Verba de mídia: ${reais(verba)}`,
    `Matrículas: *${matr}*`,
    `*CAC geral: ${matr ? reais(custo / matr) : "—"} por matrícula*`,
    "",
    "Por canal de origem:",
    ...canais,
    "",
    `_Mídia + salários e premiação dos times, com o comercial rateado por tempo (tela CAC e Payback). O CAC é mensal: o período vira os meses inteiros que ele toca.${aberto ? " Mês aberto: a premiação só entra quando o mês fecha." : ""}_`,
  ].join("\n");
}

export const TEXTO_PERIODO_INVALIDO =
  "Não entendi o período. Use: hoje · ontem · semana · semana passada · mês · mês passado · 15/10 · 01/10 a 15/10 (até 120 dias, nunca no futuro).";

export const TEXTO_RESUMO_SEM_NOME = "De quem? Mande *resumo* e o nome, ex.: _resumo Aline_ ou _resumo Aline mês_.";

export const TEXTO_SO_TEXTO = "Por enquanto eu só entendo mensagem de texto. Mande *menu* para ver os comandos.";
