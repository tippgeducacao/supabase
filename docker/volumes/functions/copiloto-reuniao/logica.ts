// Réguas PURAS do copiloto de reunião (sem Deno, sem rede) — testadas em logica.test.ts.

// Não existe tipo "dado": o copiloto não devolve preço nem fato de curso (13/10/2026).
export const TIPOS = ["pergunta", "objecao", "lembrete"] as const;
export type TipoDica = (typeof TIPOS)[number];
export type Dica = { tipo: TipoDica; texto: string };
export type Turno = { quem: "lead" | "vendedor"; texto: string };

export const ESQUEMA_SAIDA = {
  type: "object",
  properties: {
    mostrar: { type: "boolean" },
    tipo: { type: "string", enum: [...TIPOS] },
    texto: { type: "string" },
  },
  required: ["mostrar", "tipo", "texto"],
  additionalProperties: false,
} as const;

const MAX_POR_FALA = 700;
const MAX_CONVERSA = 6000;
const MAX_DICAS_DADAS = 12;
const MAX_TEXTO_DICA = 220;

/** Aceita o código puro, a URL da chamada ou o título da aba ("Meet: abc-defg-hij"). */
export function codigoDoMeet(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.toLowerCase().match(/(?:^|[^a-z])([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[^a-z]|$)/);
  return m ? m[1] : null;
}

/**
 * O que veio do navegador vira a conversa que o modelo lê: só falas válidas, falas
 * seguidas da mesma pessoa viram uma, e fica o FIM da conversa (o começo é o que sai
 * quando passa do teto — a dica é sobre o que acabou de ser dito).
 */
export function limparTurnos(v: unknown): Turno[] {
  if (!Array.isArray(v)) return [];
  const turnos: Turno[] = [];
  for (const t of v) {
    const quem = (t as Turno)?.quem;
    const texto = typeof (t as Turno)?.texto === "string" ? (t as Turno).texto.trim() : "";
    if ((quem !== "lead" && quem !== "vendedor") || !texto) continue;
    const anterior = turnos[turnos.length - 1];
    if (anterior && anterior.quem === quem) anterior.texto = `${anterior.texto} ${texto}`;
    else turnos.push({ quem, texto });
  }
  let sobra = MAX_CONVERSA;
  const fim: Turno[] = [];
  for (let i = turnos.length - 1; i >= 0 && sobra > 0; i--) {
    const texto = turnos[i].texto.slice(-Math.min(MAX_POR_FALA, sobra));
    fim.unshift({ quem: turnos[i].quem, texto });
    sobra -= texto.length;
  }
  return fim;
}

export function limparDicasDadas(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((d): d is string => typeof d === "string" && !!d.trim())
    .slice(-MAX_DICAS_DADAS)
    .map((d) => d.trim().slice(0, MAX_TEXTO_DICA));
}

export function montarPedido(turnos: Turno[], dicasDadas: string[]): string {
  const conversa = turnos.map((t) => `${t.quem === "lead" ? "Lead" : "Vendedor"}: ${t.texto}`).join("\n");
  const dadas = dicasDadas.length
    ? `Dicas que já apareceram nesta reunião:\n${dicasDadas.map((d) => `- ${d}`).join("\n")}\n\n`
    : "";
  return `${dadas}Conversa (o mais recente no fim):\n${conversa}\n\nA última fala é do lead. Há algo que o vendedor precise ver agora?`;
}

/** O JSON do modelo vira uma dica — ou nada, que é a resposta mais comum. */
export function interpretarSaida(texto: string | null | undefined): Dica | null {
  if (!texto) return null;
  let saida: { mostrar?: unknown; tipo?: unknown; texto?: unknown };
  try {
    saida = JSON.parse(texto);
  } catch {
    return null;
  }
  const dica = typeof saida?.texto === "string" ? saida.texto.trim() : "";
  if (saida?.mostrar !== true || !dica) return null;
  const tipo = (TIPOS as readonly string[]).includes(String(saida.tipo)) ? (saida.tipo as TipoDica) : "pergunta";
  return { tipo, texto: dica.slice(0, MAX_TEXTO_DICA) };
}

// ── Luna 6 (OpenAI, Responses API) ───────────────────────────────────────────

/**
 * Pedido da pergunta ao vivo para a Luna. As instruções (prompt + informações da reunião)
 * vêm primeiro e iguais a cada fala: é o prefixo que o cache automático da OpenAI reaproveita.
 */
export function pedidoLuna(p: { modelo: string; esforco: string; instrucoes: string; pedido: string }) {
  return {
    model: p.modelo,
    store: false,
    instructions: p.instrucoes,
    input: [{ role: "user", content: p.pedido }],
    reasoning: { effort: p.esforco },
    // inclui o raciocínio: com esforço baixo sobra folga para a frase
    max_output_tokens: 2000,
    text: { format: { type: "json_schema", name: "dica_do_copiloto", schema: ESQUEMA_SAIDA, strict: true } },
  };
}

type RespostaLuna = {
  model?: string;
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string; refusal?: string }> }>;
  usage?: {
    input_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number };
  };
};

/** A resposta da Luna vira a mesma dica do Haiku. Recusa ou texto vazio = nada a mostrar. */
export function lerRespostaLuna(resposta: RespostaLuna) {
  const partes = (resposta.output ?? []).filter((i) => i?.type === "message").flatMap((i) => i.content ?? []);
  const recusou = partes.some((c) => c?.type === "refusal");
  const texto = partes.filter((c) => c?.type === "output_text").map((c) => c.text ?? "").join("");
  const u = resposta.usage ?? {};
  return {
    dica: recusou ? null : interpretarSaida(texto),
    modelo: resposta.model ?? "luna",
    uso: {
      entrada: u.input_tokens ?? null,
      cacheLido: u.input_tokens_details?.cached_tokens ?? null,
      saida: u.output_tokens ?? null,
      raciocinio: u.output_tokens_details?.reasoning_tokens ?? null,
    },
  };
}

// ── As informações da reunião (bloco cacheado do prompt) ─────────────────────

export type DadosReuniao = {
  agendamento: {
    pos_graduacao_interesse?: string | null;
    observacoes?: string | null;
    principal_dor_objetivo?: string | null;
    local_trabalho?: string | null;
    canal_contato?: string | null;
    origem?: string | null;
  };
  lead?: Record<string, unknown> | null;
  anteriores?: Array<Record<string, unknown>>;
  /** Resumo do lead gerado antes da reunião (`copiloto_reuniao_resumos`). */
  resumo?: string | null;
  /** Mapa de carreira do comercial para o grupo desta pós (`sdr_carreira_mapa_*`). */
  mapa?: { ramos: Array<Record<string, unknown>>; perguntas: Array<Record<string, unknown>> } | null;
};

const txt = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

function linhas(pares: Array<[string, unknown]>): string[] {
  return pares.map(([rotulo, v]) => [rotulo, txt(v)] as const).filter(([, v]) => v).map(([rotulo, v]) => `- ${rotulo}: ${v}`);
}

function dataBr(v: unknown): string {
  const m = txt(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

const porOrdem = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  (Number(a.ordem) || 0) - (Number(b.ordem) || 0) || txt(a.nome ?? a.texto).localeCompare(txt(b.nome ?? b.texto));

/** `ramo = '*'` no mapa: a pergunta vale para qualquer ramo do grupo. */
const TODOS_OS_RAMOS = "*";

function perguntasDe(perguntas: Array<Record<string, unknown>>, filtro: (p: Record<string, unknown>) => boolean): string[] {
  return perguntas.filter(filtro).sort(porOrdem).map((p) => `  - [${txt(p.etapa)}] ${txt(p.texto)}`).filter((l) => !l.endsWith("] "));
}

function montarMapa(mapa: NonNullable<DadosReuniao["mapa"]>): string {
  const blocos: string[] = [];
  const divide = perguntasDe(mapa.perguntas, (p) => txt(p.etapa) === "divide");
  if (divide.length) blocos.push(`Para descobrir como o lead trabalha:\n${divide.join("\n")}`);

  for (const ramo of [...mapa.ramos].sort(porOrdem)) {
    const sinais = Array.isArray(ramo.sinais) ? ramo.sinais.map(txt).filter(Boolean) : [];
    const perguntas = perguntasDe(mapa.perguntas, (p) => txt(p.ramo) === txt(ramo.ramo) && txt(p.etapa) !== "divide");
    blocos.push([
      `### ${txt(ramo.nome) || txt(ramo.ramo)}`,
      ...linhas([
        ["Sinais na fala do lead", sinais.join(" | ")],
        ["O que pesa para ele", ramo.argumento],
      ]),
      ...(perguntas.length ? ["- Perguntas, na ordem:", ...perguntas] : []),
    ].join("\n"));
  }

  const gerais = perguntasDe(mapa.perguntas, (p) => txt(p.ramo) === TODOS_OS_RAMOS && txt(p.etapa) !== "divide");
  if (gerais.length) blocos.push(`### Valem para qualquer ramo\n${gerais.join("\n")}`);
  return blocos.join("\n\n");
}

/**
 * Texto das informações da reunião. Precisa sair IDÊNTICO a cada chamada enquanto o
 * cadastro não muda (é o que mantém o cache do prompt): ordem fixa, nada de "hoje".
 * De propósito NÃO entra preço nem fato de curso: o copiloto fala do lead.
 */
export function montarContexto(d: DadosReuniao): string {
  const partes: string[] = ["# Informações desta reunião"];
  const ag = d.agendamento;
  const lead = d.lead ?? {};

  const doLead = linhas([
    ["Nome", lead.nome],
    ["Profissão", lead.profissao],
    ["Tempo de formação", lead.tempo_formacao],
    ["Cargo", lead.cargo],
    ["Onde trabalha", lead.local_trabalho || ag.local_trabalho],
    ["Região", lead.regiao],
    ["Interesse informado no cadastro", lead.curso_interesse || lead.area_interesse],
    ["Anotações no cadastro do lead", lead.observacoes],
  ]);
  if (doLead.length) partes.push(`## Lead\n${doLead.join("\n")}`);

  const daReuniao = linhas([
    ["Pós de interesse", ag.pos_graduacao_interesse],
    ["Dor ou objetivo que o SDR registrou", ag.principal_dor_objetivo],
    ["Anotações de quem marcou a reunião", ag.observacoes],
    ["Canal do contato", ag.canal_contato],
    ["Como a reunião foi marcada", ag.origem === "API SDR" ? "pela IA de atendimento no WhatsApp" : ag.origem],
  ]);
  if (daReuniao.length) partes.push(`## Reunião\n${daReuniao.join("\n")}`);

  const anteriores = (d.anteriores ?? []).map((a) => {
    const itens = linhas([
      ["Resultado", a.resultado_reuniao],
      ["Objeções", a.objecoes_apresentadas],
      ["Resumo", a.resumo_reuniao],
      ["Observações", a.observacoes_resultado],
    ]);
    return itens.length ? `Reunião de ${dataBr(a.data_agendamento) || "data não registrada"} (${txt(a.pos_graduacao_interesse) || "pós não registrada"}):\n${itens.join("\n")}` : "";
  }).filter(Boolean);
  if (anteriores.length) partes.push(`## Reuniões anteriores deste lead\n${anteriores.join("\n\n")}`);

  const resumo = txt(d.resumo);
  if (resumo) partes.push(`## O que já se sabe do lead (resumo feito antes da reunião, a partir da conversa no WhatsApp)\n${resumo}`);

  const mapa = d.mapa && (d.mapa.ramos.length || d.mapa.perguntas.length) ? montarMapa(d.mapa) : "";
  if (mapa) partes.push(`## Mapa de carreira desta pós (comercial)\n${mapa}`);

  return partes.join("\n\n");
}

/**
 * Janela das "minhas reuniões de agora" no app: 3 h para trás (a reunião que já começou,
 * ou que atrasou) e 12 h para a frente (o resto do dia de trabalho).
 */
export function janelaDasMinhas(agora: Date): { de: string; ate: string } {
  const hora = 60 * 60 * 1000;
  return {
    de: new Date(agora.getTime() - 3 * hora).toISOString(),
    ate: new Date(agora.getTime() + 12 * hora).toISOString(),
  };
}

// ── Freios (19/10/2026, reunião da Ana Ligia: 47 perguntas em 40 min) ─────────

// Palavras que o Parakeet inventa em inglês quando ouve "hum", "aham", riso ou ruído
// ("Thank you", "Yeah", "So much", "It's gonna be easy"). Fala curta feita disso é ruído.
const RUIDO = new Set([
  "thank", "thanks", "you", "yeah", "yes", "okay", "ok", "oh", "uh", "huh", "um", "mm", "hmm", "mhm",
  "so", "much", "wait", "right", "is", "it", "its", "it's", "i", "we", "they", "the", "a", "that", "this",
  "what", "are", "be", "should", "there", "one", "love", "easy", "gonna", "going", "just", "like", "bit",
  "and", "to", "of", "for", "in", "on", "me", "my", "your", "all", "not", "no", "fire", "east", "said",
  "aham", "hum", "uhum", "ahn", "ã", "é", "tá", "ah", "eh", "uh-huh", "mm-hmm",
]);

/** Fala curta só de interjeição ou de inglês inventado pelo transcritor. */
export function ehRuido(texto: string): boolean {
  const palavras = texto.toLowerCase().replace(/[^\p{L}\s'-]/gu, " ").split(/\s+/).filter(Boolean);
  if (!palavras.length) return true;
  if (palavras.length > 6) return false;
  return palavras.filter((p) => RUIDO.has(p)).length / palavras.length >= 0.6;
}

// Negociação e fechamento: parcela, cartão, contrato, link de pagamento. Nessa hora o lead
// já está comprando e pergunta de carreira atrapalha.
const FECHAMENTO = /\b(parcel\w*|cart[aã]o|limite|boleto|pix|contrato|assin\w*|matr[ií]cula|[aà] vista|desconto|bolsa|pagamento|comprovante|vencimento)\b/gi;

/** As últimas falas (dos dois lados) estão em negociação/fechamento? */
export function emFechamento(turnos: Turno[], quantas = 6): boolean {
  const texto = turnos.slice(-quantas).map((t) => t.texto).join(" ");
  return (texto.match(FECHAMENTO) ?? []).length >= 2;
}

function palavrasChave(texto: string): Set<string> {
  return new Set(
    texto.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/).filter((p) => p.length > 3),
  );
}

/** A pergunta nova diz o mesmo que alguma já mostrada (mesmas palavras, outra ordem)? */
export function repetida(nova: string, anteriores: string[], limiar = 0.5): boolean {
  const a = palavrasChave(nova);
  if (!a.size) return false;
  return anteriores.some((x) => {
    const b = palavrasChave(x);
    const comuns = [...a].filter((p) => b.has(p)).length;
    const uniao = new Set([...a, ...b]).size;
    return uniao > 0 && comuns / uniao >= limiar;
  });
}

// ── Captura das reuniões (avaliação) ─────────────────────────────────────────

export type FalaCapturada = { motor: "parakeet" | "gemini"; ordem: number; quem: "lead" | "vendedor"; texto: string; falada_em: string };

const MAX_FALAS_POR_ENVIO = 200;
const MAX_TEXTO_FALA = 4000;

/** O que o app mandou vira linhas válidas de `copiloto_reuniao_falas`; o resto é descartado. */
export function limparFalas(v: unknown): FalaCapturada[] {
  if (!Array.isArray(v)) return [];
  const falas: FalaCapturada[] = [];
  for (const f of v.slice(0, MAX_FALAS_POR_ENVIO)) {
    const x = f as Record<string, unknown>;
    const texto = typeof x?.texto === "string" ? x.texto.trim().slice(0, MAX_TEXTO_FALA) : "";
    const ordem = Number(x?.ordem);
    const quando = typeof x?.falada_em === "string" ? new Date(x.falada_em) : null;
    if (!texto || !Number.isInteger(ordem) || ordem < 0) continue;
    if (x?.motor !== "parakeet" && x?.motor !== "gemini") continue;
    if (x?.quem !== "lead" && x?.quem !== "vendedor") continue;
    falas.push({
      motor: x.motor, ordem, quem: x.quem, texto,
      falada_em: quando && !Number.isNaN(quando.getTime()) ? quando.toISOString() : new Date().toISOString(),
    });
  }
  return falas;
}

export const MOTORES_SESSAO = ["local", "nuvem", "comparar"] as const;

/** A reunião cujo horário está mais perto de agora (o mesmo link pode ter sido reusado). */
export function maisProximaDeAgora<T extends { data_agendamento?: string | null; status?: string | null }>(
  reunioes: T[],
  agora: Date,
): T | null {
  const distancia = (r: T) => {
    const t = r.data_agendamento ? new Date(r.data_agendamento).getTime() : NaN;
    return Number.isNaN(t) ? Infinity : Math.abs(t - agora.getTime());
  };
  const validas = reunioes.filter((r) => r.status !== "cancelado");
  const base = validas.length ? validas : reunioes;
  return base.reduce<T | null>((melhor, r) => (!melhor || distancia(r) < distancia(melhor) ? r : melhor), null);
}
