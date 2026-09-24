// O classificador do direct do Instagram: o modelo LÊ a resposta da pessoa e preenche um
// formulário fechado (tool forçada). Ele não escreve a conversa — as frases são fixas, em
// fluxo.ts. A única coisa que ele redige é uma resposta curta quando a pessoa pergunta algo
// fora do roteiro, e mesmo essa só com os fatos listados aqui.
//
// MODELO (24/09/2026, pedido do Gustavo): a LUNA (GPT-5.6, API da OpenAI), a mesma do
// piloto do João — `provedorOpenai()` lê AGENTE_SDR_OPENAI_KEY / AGENTE_SDR_OPENAI_MODEL
// (hoje gpt-5.6-luna). O pedido sai no formato da Anthropic e o `chamarAnthropic` do João
// traduz para a Responses API (provedorOpenai.ts). Se a Luna falhar ou não houver chave,
// o CLAUDE (AGENTE_SDR_MODEL) responde no lugar — mesma regra do piloto.
import { chamarAnthropic, type ProvedorIA, provedorOpenai } from "../crm-agente-sdr/agente.ts";
import type { Classificacao, EtapaFluxo, Intencao, Situacao } from "./fluxo.ts";
import type { TurnoHistorico } from "./historico.ts";

const MODELO_CLAUDE = Deno.env.get("AGENTE_SDR_MODEL") ?? "claude-sonnet-5";
// Prazo por tentativa. O do piloto do WhatsApp (45 s) não cabe aqui: robô no direct tem
// de responder em até 30 s (política da Meta), e ainda tem a espera de silêncio antes.
const PRAZO_LUNA_MS = 15_000;
const PRAZO_CLAUDE_MS = 12_000;

const O_QUE_A_IA_ACABOU_DE_PERGUNTAR: Record<EtapaFluxo, string> = {
  boas_vindas:
    "A PPGVET mandou a boas-vindas a um novo seguidor oferecendo acesso à Escola de Especialização gratuita (\"quer receber o acesso?\") ou perguntando se a pessoa já se formou ou está na graduação.",
  pergunta_formacao: "A IA perguntou se a pessoa já se formou e trabalha, ou se ainda está na graduação.",
  pergunta_whatsapp: "A IA pediu o WhatsApp da pessoa (com DDD) para mandar o link e o portfólio em PDF.",
  escola_enviada: "A IA já mandou o link da Escola gratuita; o roteiro terminou.",
  whatsapp_enviado: "A IA já recebeu o WhatsApp e mandou o material por lá; o roteiro terminou.",
  encerrada: "A pessoa disse que não queria; o roteiro terminou.",
};

const INSTRUCOES = [
  "Você lê mensagens que uma pessoa mandou no direct do Instagram da PPGVET e preenche a ferramenta `classificar`. Não converse: só classifique.",
  "",
  "situacao (sobre a GRADUAÇÃO, ensino superior, em QUALQUER área):",
  "- formado: já concluiu uma graduação (\"sou vet\", \"me formei em zootecnia\", \"sou médica veterinária\", \"trabalho como agrônomo\").",
  "- estudante: está cursando uma graduação (\"tô no 7º período\", \"faço agronomia\", \"sou estudante de vet\").",
  "- nenhum: disse que não fez nem faz faculdade (ensino médio, só técnico, produtor sem graduação, só curiosidade).",
  "- nao_informou: não deu para saber. Na dúvida, é nao_informou — nunca deduza pela profissão sem a pessoa dizer.",
  "",
  "intencao:",
  "- aceita: quer receber / topou (\"quero\", \"sim\", \"manda\").",
  "- recusa: não quer, ou agradece e encerra.",
  "- pergunta: fez uma pergunta.",
  "- outro: qualquer outra coisa (cumprimento, resposta solta).",
  "",
  "telefone: copie o número de telefone/WhatsApp que a pessoa escreveu, se houver; senão null.",
  "area: a graduação ou área que a pessoa citou (ex.: \"medicina veterinária\"); senão null.",
  "",
  "resposta_pergunta: só quando intencao = pergunta. UMA resposta curta (1 a 2 frases), no tom do",
  "direct, sem markdown, usando APENAS estes fatos:",
  "- A PPGVET tem pós-graduações (especializações e MBAs) em veterinária e agro, e às vezes cursos de extensão.",
  "- A Escola de Especialização é gratuita: mais de 10 cursos, além de artigos, e-books e podcasts.",
  "- O portfólio em PDF apresenta as pós-graduações.",
  "- Valores, datas, duração, formato e matrícula: o time explica pelo WhatsApp.",
  "Se a pergunta for além disso, diga que o time explica tudo pelo WhatsApp. Nunca invente preço,",
  "data, curso ou condição. Não faça pergunta nenhuma na resposta (o roteiro já faz a próxima).",
].join("\n");

export const TOOL_CLASSIFICAR = {
  name: "classificar",
  description: "Classifica as mensagens novas da pessoa no direct.",
  input_schema: {
    type: "object",
    properties: {
      intencao: { type: "string", enum: ["aceita", "recusa", "pergunta", "outro"] },
      situacao: { type: "string", enum: ["formado", "estudante", "nenhum", "nao_informou"] },
      area: { type: ["string", "null"] },
      telefone: { type: ["string", "null"] },
      resposta_pergunta: { type: ["string", "null"] },
    },
    required: ["intencao", "situacao", "area", "telefone", "resposta_pergunta"],
  },
} as const;

export const CLASSIFICACAO_NEUTRA: Classificacao = {
  intencao: "outro",
  situacao: "nao_informou",
  area: null,
  telefone: null,
  resposta_pergunta: null,
};

const INTENCOES: readonly Intencao[] = ["aceita", "recusa", "pergunta", "outro"];
const SITUACOES: readonly Situacao[] = ["formado", "estudante", "nenhum", "nao_informou"];

function texto(v: unknown, max: number): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, max) : null;
}

/** Aceita só o que o formulário permite; qualquer coisa fora vira o valor neutro. */
export function normalizarClassificacao(bruto: unknown): Classificacao {
  // deno-lint-ignore no-explicit-any
  const b = (bruto ?? {}) as any;
  const intencao = INTENCOES.includes(b.intencao) ? b.intencao : "outro";
  return {
    intencao,
    situacao: SITUACOES.includes(b.situacao) ? b.situacao : "nao_informou",
    area: texto(b.area, 80),
    telefone: texto(b.telefone, 40),
    resposta_pergunta: intencao === "pergunta" ? texto(b.resposta_pergunta, 400) : null,
  };
}

function montarPedido(etapa: EtapaFluxo, historico: TurnoHistorico[], novas: string[]) {
  const conversa = historico.slice(-10)
    .map((t) => `${t.role === "user" ? "PESSOA" : "PPGVET"}: ${t.text}`)
    .join("\n");
  return [
    `Onde a conversa está: ${O_QUE_A_IA_ACABOU_DE_PERGUNTAR[etapa]}`,
    "",
    "Conversa até aqui:",
    conversa || "(nada antes)",
    "",
    "Mensagens NOVAS da pessoa (classifique estas):",
    ...novas.map((m) => `- ${m}`),
  ].join("\n");
}

export type ResultadoClassificacao = {
  classificacao: Classificacao;
  /** Falhas no caminho (inclusive a da Luna quando o Claude cobriu). null = tudo certo. */
  erro: string | null;
  /** Quem classificou de fato (ex.: "gpt-5.6-luna"); null = ninguém, valeu a neutra. */
  modelo: string | null;
};

/**
 * Luna primeiro; Claude se ela falhar; classificação neutra se os dois falharem. Nunca
 * lança: um modelo fora do ar não pode derrubar a conversa (a neutra faz a IA repetir a
 * pergunta da etapa).
 */
export async function classificar(
  etapa: EtapaFluxo,
  historico: TurnoHistorico[],
  novas: string[],
): Promise<ResultadoClassificacao> {
  const pedido = {
    model: MODELO_CLAUDE, // no caminho da Luna, o tradutor troca pelo modelo do provedor
    max_tokens: 500,
    // disabled EXPLÍCITO: no Sonnet 5, omitir liga o thinking adaptativo; na Luna vira
    // reasoning.effort = "none" (paraPedidoOpenai) — classificar não precisa raciocinar.
    thinking: { type: "disabled" },
    system: INSTRUCOES,
    tools: [TOOL_CLASSIFICAR],
    tool_choice: { type: "tool", name: TOOL_CLASSIFICAR.name, disable_parallel_tool_use: true },
    messages: [{ role: "user", content: montarPedido(etapa, historico, novas) }],
  };
  const luna = provedorOpenai();
  const tentativas: { nome: string; provedor: ProvedorIA | null; prazo: number }[] = [
    ...(luna ? [{ nome: "Luna", provedor: luna, prazo: PRAZO_LUNA_MS }] : []),
    { nome: "Claude", provedor: null, prazo: PRAZO_CLAUDE_MS },
  ];
  const erros: string[] = luna ? [] : ["Luna: sem AGENTE_SDR_OPENAI_KEY"];
  for (const t of tentativas) {
    try {
      const resposta = await chamarAnthropic(pedido, {}, t.provedor, t.prazo);
      // deno-lint-ignore no-explicit-any
      const uso = (resposta?.content ?? []).find((c: any) => c?.type === "tool_use" && c?.name === TOOL_CLASSIFICAR.name);
      if (uso) {
        return {
          classificacao: normalizarClassificacao(uso.input),
          erro: erros.length ? erros.join("; ") : null,
          modelo: String(resposta?.model ?? (t.provedor?.formato === "openai" ? t.provedor.modelo : MODELO_CLAUDE)),
        };
      }
      erros.push(`${t.nome}: não preencheu o formulário`);
    } catch (e) {
      erros.push(`${t.nome}: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
    }
  }
  return { classificacao: CLASSIFICACAO_NEUTRA, erro: erros.join("; "), modelo: null };
}
