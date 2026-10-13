// Réguas PURAS do copiloto de reunião (sem Deno, sem rede) — testadas em logica.test.ts.

export const TIPOS = ["objecao", "pergunta", "lembrete", "dado"] as const;
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
  const tipo = (TIPOS as readonly string[]).includes(String(saida.tipo)) ? (saida.tipo as TipoDica) : "lembrete";
  return { tipo, texto: dica.slice(0, MAX_TEXTO_DICA) };
}

// ── As informações da reunião (bloco cacheado do prompt) ─────────────────────

export type DadosReuniao = {
  agendamento: {
    pos_graduacao_interesse?: string | null;
    observacoes?: string | null;
    principal_dor_objetivo?: string | null;
    local_trabalho?: string | null;
    canal_contato?: string | null;
  };
  lead?: Record<string, unknown> | null;
  anteriores?: Array<Record<string, unknown>>;
  produto?: Record<string, unknown> | null;
  perfis?: Array<Record<string, unknown>>;
  objecoes?: Array<Record<string, unknown>>;
};

const txt = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

function linhas(pares: Array<[string, unknown]>): string[] {
  return pares.map(([rotulo, v]) => [rotulo, txt(v)] as const).filter(([, v]) => v).map(([rotulo, v]) => `- ${rotulo}: ${v}`);
}

function dataBr(v: unknown): string {
  const m = txt(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

/** A matrícula vem do cadastro como número cru; valor em reais sempre sai com centavos. */
function reais(v: unknown): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return txt(v);
  return `R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const porOrdem =(a: Record<string, unknown>, b: Record<string, unknown>) =>
  (Number(a.ordem) || 0) - (Number(b.ordem) || 0) || txt(a.nome ?? a.objecao).localeCompare(txt(b.nome ?? b.objecao));

/**
 * Texto das informações da reunião. Precisa sair IDÊNTICO a cada chamada enquanto o
 * cadastro não muda (é o que mantém o cache do prompt): ordem fixa, nada de "hoje".
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

  if (d.produto) {
    const p = d.produto;
    const doCurso = linhas([
      ["Produto", p.produto],
      ["Formato", p.formato],
      ["Carga horária", p.carga_horaria],
      ["Duração em meses", p.meses],
      ["Coordenação", p.coordenador],
      ["Valor oficial online", p.preco_oficial_online],
      ["Valor oficial semipresencial", p.preco_oficial_semipresencial],
      ["Matrícula", reais(p.matricula_gerenciar_cursos)],
      ["Turmas abertas", p.turmas_abertas],
      ["Próximo módulo prático", dataBr(p.proximo_pratico)],
      ["Aviso do cadastro", p.aviso],
    ]);
    if (doCurso.length) partes.push(`## Fatos do curso (cadastro do sistema)\n${doCurso.join("\n")}`);
  }

  const perfis = [...(d.perfis ?? [])].sort(porOrdem).map((p) => {
    const sinais = Array.isArray(p.sinais) ? p.sinais.map(txt).filter(Boolean) : [];
    const perguntas = (Array.isArray(p.perguntas) ? p.perguntas : [])
      .map((q) => {
        const pergunta = txt((q as Record<string, unknown>)?.pergunta);
        const lacuna = txt((q as Record<string, unknown>)?.lacuna);
        return pergunta ? `  - ${pergunta}${lacuna ? ` (revela: ${lacuna})` : ""}` : "";
      })
      .filter(Boolean);
    return [
      `### ${txt(p.nome) || "Perfil"}`,
      ...linhas([
        ["O que move esse perfil", p.moeda],
        ["Sinais na fala do lead", sinais.join(" | ")],
        ["O que a pós entrega para ele", p.ponte_convite],
        ["Cuidado", p.observacao],
      ]),
      ...(perguntas.length ? ["- Perguntas que abrem a conversa:", ...perguntas] : []),
    ].join("\n");
  });
  if (perfis.length) partes.push(`## Perfis de carreira desta pós (mapa do comercial)\n${perfis.join("\n\n")}`);

  const objecoes = [...(d.objecoes ?? [])].sort(porOrdem)
    .map((o) => (txt(o.objecao) && txt(o.resposta) ? `- "${txt(o.objecao)}" → ${txt(o.resposta)}` : ""))
    .filter(Boolean);
  if (objecoes.length) partes.push(`## Objeções já trabalhadas nesta pós\n${objecoes.join("\n")}`);

  return partes.join("\n\n");
}

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
