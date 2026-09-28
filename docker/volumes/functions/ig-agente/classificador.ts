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
    "A PPGVET mandou a boas-vindas a um novo seguidor (\"Oii, tudo bem?\"). Respostas como \"tudo sim, e você?\" são só cumprimento (intencao = outro).",
  pergunta_formacao:
    "A IA perguntou se a pessoa já se formou e trabalha, ou se ainda está na graduação. Se a ÚLTIMA pergunta da IA foi \"Você não possui graduação?\", é uma confirmação: \"não tenho\", \"não possuo\", \"sim, não tenho\", \"só o ensino médio\" = nenhum; \"tenho sim\", \"sou formado em…\", \"faço…\" = formado/estudante; \"sim\" ou \"não\" sozinhos são ambíguos = nao_informou. Se a ÚLTIMA pergunta da IA foi \"Você ainda tá cursando?\": \"sim\", \"tô sim, faço zootecnia\" = estudante (com a area, se disse); \"não\", \"tranquei\", \"parei\" = nenhum.",
  pergunta_curso:
    "A IA perguntou QUAL é o curso da graduação da pessoa (a formação dela, ou o curso que ela faz). Preencha `area` com o curso dito (ex.: \"medicina veterinária\", \"zootecnia\"); se ela não disse o curso, null.",
  pergunta_data_formacao:
    "A IA perguntou quando a pessoa se forma (mês e ano). Preencha `conclusao` com o que ela disse, em MM/AAAA. Se a resposta é AMBÍGUA mas dá para arriscar uma leitura (\"fim de 28\", \"no meio do ano que vem\", \"28\"), deixe `conclusao` null e escreva em `confirmar_conclusao` UMA pergunta curta confirmando a sua leitura, como a Flávia (ex.: \"Seria no 2º semestre de 2028? 😊\", \"Em dezembro de 2028, então?\"). Se a ÚLTIMA fala da IA foi uma confirmação dessas e a pessoa confirmou (\"isso\", \"sim\", \"exato\"), `conclusao` = a data que a IA propôs, em MM/AAAA.",
  pergunta_interesse:
    "A IA perguntou se a pessoa tem interesse em conhecer as pós-graduações e se pode encaminhar o portfólio (\"sim\", \"quero\", \"pode mandar\" = aceita).",
  pergunta_whatsapp: "A IA pediu o WhatsApp da pessoa (com DDD) para mandar o link e o portfólio em PDF.",
  escola_enviada: "A IA já mandou o link da Escola gratuita; o roteiro terminou.",
  whatsapp_enviado: "A IA já recebeu o WhatsApp e mandou o material por lá; o roteiro terminou.",
  encerrada: "A pessoa disse que não queria; o roteiro terminou.",
};

const INSTRUCOES = [
  "Você lê mensagens que uma pessoa mandou no direct do Instagram da PPGVET e preenche a ferramenta `classificar`. Não converse: só classifique.",
  "",
  "situacao (sobre a GRADUAÇÃO, ensino superior, em QUALQUER área):",
  "- formado: já concluiu uma graduação (\"sou vet\", \"me formei em zootecnia\", \"sou médica veterinária\", \"sou formado em agronomia\").",
  "- estudante: está cursando uma graduação (\"tô no 7º período\", \"faço agronomia\", \"sou estudante de vet\").",
  "- nenhum: disse que não fez nem faz faculdade (ensino médio, só técnico, produtor sem graduação, só curiosidade),",
  "  ou que parou/trancou e não está cursando (\"tranquei no 5º período\", \"parei a faculdade\").",
  "- incompleto: disse que a graduação está INCOMPLETA sem dizer se ainda cursa (\"grau superior incompleto\",",
  "  \"faculdade incompleta\", \"não terminei a faculdade\") — pode ter trancado. NÃO chute estudante: a IA pergunta.",
  "  \"Sou produtor rural\" sozinho NÃO é nenhum (produtor pode ter graduação): nao_informou, e a IA confirma.",
  "- nao_informou: não deu para saber. Na dúvida, é nao_informou — nunca deduza pela profissão sem a pessoa dizer.",
  "  Cargo, função ou área de trabalho NÃO dizem se a pessoa tem graduação — nem os que exigem diploma",
  "  (\"sou responsável técnico\", \"trabalho como agrônomo\", \"atuo em bovinocultura de leite\", \"trabalho com",
  "  clínica de pequenos animais\", \"trabalho numa granja\"): é nao_informou, e a IA pergunta.",
  "",
  "intencao:",
  "- aceita: quer receber / topou (\"quero\", \"sim\", \"manda\").",
  "- recusa: não quer, ou agradece e encerra.",
  "- pergunta: fez uma pergunta.",
  "- outro: qualquer outra coisa (cumprimento, resposta solta).",
  "",
  "telefone: copie o número de telefone/WhatsApp que a pessoa escreveu, se houver; senão null.",
  "area: o CURSO da graduação que a pessoa citou (ex.: \"medicina veterinária\"). \"Tô na graduação\" ou \"sou formado\" sem dizer o curso = null — nunca deduza o curso.",
  "conclusao: quando a pessoa disse quando SE FORMA, o mês e o ano em MM/AAAA (ex.: \"julho do ano que vem\" em 2026 → \"07/2027\"; ano.semestre — \"2028.2\" ou \"28.2\" → \"12/2028\", \"27.1\" → \"06/2027\"). Posição no curso (\"tô no 7º período\") NÃO é data: null. Sem data: null.",
  "",
  "resposta_pergunta: só quando intencao = pergunta. UMA resposta curta (1 a 2 frases), no tom do",
  "direct, sem markdown, usando APENAS estes fatos:",
  "- A PPGVET tem pós-graduações (especializações e MBAs) em veterinária e agro, e às vezes cursos de extensão.",
  "- A Escola de Especialização é gratuita: mais de 10 cursos, além de artigos, e-books e podcasts.",
  "- O portfólio em PDF apresenta as pós-graduações.",
  "- Valores, datas, duração, formato e matrícula: o time explica pelo WhatsApp.",
  "Você responde como a Flávia, da PPGVET (é o nome da atendente no direct). Se perguntarem se é",
  "robô, bot ou IA, não negue: diga que é a assistente virtual da PPGVET e que o time está junto.",
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
      situacao: { type: "string", enum: ["formado", "estudante", "nenhum", "nao_informou", "incompleto"] },
      area: { type: ["string", "null"] },
      telefone: { type: ["string", "null"] },
      conclusao: { type: ["string", "null"] },
      resposta_pergunta: { type: ["string", "null"] },
      confirmar_conclusao: { type: ["string", "null"] },
    },
    required: ["intencao", "situacao", "area", "telefone", "conclusao", "resposta_pergunta", "confirmar_conclusao"],
  },
} as const;

export const CLASSIFICACAO_NEUTRA: Classificacao = {
  intencao: "outro",
  situacao: "nao_informou",
  area: null,
  telefone: null,
  conclusao: null,
  resposta_pergunta: null,
  confirmar_conclusao: null,
};

const INTENCOES: readonly Intencao[] = ["aceita", "recusa", "pergunta", "outro"];
const SITUACOES: readonly Situacao[] = ["formado", "estudante", "nenhum", "nao_informou", "incompleto"];

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
    conclusao: texto(b.conclusao, 20),
    resposta_pergunta: intencao === "pergunta" ? texto(b.resposta_pergunta, 400) : null,
    confirmar_conclusao: perguntaDeConfirmacao(b.confirmar_conclusao),
  };
}

/**
 * A confirmação da data é o único texto do roteiro escrito pelo modelo: só passa se for UMA
 * pergunta curta, sem link. Qualquer outra coisa → null, e o roteiro usa a frase fixa.
 */
export function perguntaDeConfirmacao(v: unknown): string | null {
  const s = texto(v, 200);
  if (!s || s.length > 120) return null;
  if (/https?:|www\.|\n/i.test(s)) return null;
  if (!/\?\s*(?:\p{Extended_Pictographic}|\uFE0F|\s)*$/u.test(s)) return null;
  if ((s.match(/\?/g) ?? []).length > 1) return null;
  return s;
}

function montarPedido(etapa: EtapaFluxo, historico: TurnoHistorico[], novas: string[]) {
  const conversa = historico.slice(-10)
    .map((t) => `${t.role === "user" ? "PESSOA" : "PPGVET"}: ${t.text}`)
    .join("\n");
  // Hoje em Brasília: "ano que vem" / "dezembro" só viram MM/AAAA sabendo a data.
  const hoje = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10).split("-").reverse().join("/");
  return [
    `Hoje é ${hoje}.`,
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
