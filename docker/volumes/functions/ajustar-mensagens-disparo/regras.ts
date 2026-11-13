// Régua PURA do chat "Ajustar com IA" da Central de Disparos (13/11/2026).
//
// Sem import por URL de propósito: o vitest do front carrega este arquivo (ver vitest.config) e
// o teste de ponta a ponta roda o MESMO motor (`executarAjuste`) fora do Deno. A edge (index.ts)
// só confere quem chama, lê o banco, soma o custo e responde.

import { limparSaidaIA } from "../_shared/limparSaidaIA.ts";

export interface MensagemDoDisparo {
  id: string;
  canal: string;
  texto: string;
  ordem: number | null;
  momento: string | null; // timing_label, ex.: "1 dia antes"
  deslocamento: string | null; // timing_offset, ex.: "-1d"
  intencao: string | null;
  status: string | null;
}

export interface TurnoDoChat {
  papel: "usuario" | "ia";
  texto: string;
}

export interface Alvo {
  numero: number;
  o_que_mudar: string;
}

export const NOME_DO_CANAL: Record<string, string> = {
  whatsapp_grupo: "WhatsApp Grupo",
  whatsapp_oficial: "WhatsApp Oficial",
  email: "E-mail",
};

/** Rótulo curto que a pessoa reconhece na tela: "3 · 1 dia antes (-1d) · E-mail". */
export function rotuloDaMensagem(m: MensagemDoDisparo, numero: number): string {
  const momento = m.momento ? `${m.momento}${m.deslocamento ? ` (${m.deslocamento})` : ""}` : "sem momento";
  return `${numero} · ${momento} · ${NOME_DO_CANAL[m.canal] ?? m.canal}`;
}

/** Ordem da tela: a sequência do tipo e, dentro dela, o canal. */
export function ordenar(msgs: MensagemDoDisparo[]): MensagemDoDisparo[] {
  return [...msgs].sort((a, b) => (a.ordem ?? 999) - (b.ordem ?? 999) || a.canal.localeCompare(b.canal));
}

export const LIMITE_INSTRUCAO = 2000;
export const LIMITE_HISTORICO = 8; // turnos anteriores que vão de contexto

/** Histórico vindo do navegador: só os últimos turnos, só os dois papéis, texto aparado. */
export function historicoLimpo(bruto: unknown): TurnoDoChat[] {
  if (!Array.isArray(bruto)) return [];
  return bruto
    .filter((t): t is TurnoDoChat =>
      !!t && typeof t === "object" && (t.papel === "usuario" || t.papel === "ia") && typeof t.texto === "string")
    .slice(-LIMITE_HISTORICO)
    .map((t) => ({ papel: t.papel, texto: t.texto.slice(0, 1500) }));
}

/** O pedido do 1º passo: todas as mensagens numeradas, a conversa até aqui e o pedido novo. */
export function pedidoDeRoteamento(
  msgs: MensagemDoDisparo[],
  instrucao: string,
  historico: TurnoDoChat[],
): string {
  const blocos = msgs.map((m, i) =>
    `### MENSAGEM ${rotuloDaMensagem(m, i + 1)}${m.status === "aprovado" ? " · já aprovada" : ""}\n${m.texto || "(vazia)"}`,
  );
  const conversa = historico.length
    ? `CONVERSA ATÉ AQUI (para entender "faça o mesmo", "desfaz o tom" etc.):\n${historico
        .map((t) => `${t.papel === "usuario" ? "Pessoa" : "Você"}: ${t.texto}`)
        .join("\n")}\n\n`
    : "";
  return `${blocos.join("\n\n")}\n\n${conversa}PEDIDO NOVO DA PESSOA:\n${instrucao}`;
}

/**
 * O que a IA devolveu no 1º passo, conferido: número existe, sem repetição, com instrução.
 * Número fora da lista é descartado (a IA não escolhe mensagem que não existe).
 */
export function alvosValidos(bruto: unknown, total: number): Alvo[] {
  if (!Array.isArray(bruto)) return [];
  const vistos = new Set<number>();
  const saida: Alvo[] = [];
  for (const a of bruto) {
    const numero = Number((a as Alvo)?.numero);
    const oQue = String((a as Alvo)?.o_que_mudar ?? "").trim();
    if (!Number.isInteger(numero) || numero < 1 || numero > total || vistos.has(numero) || !oQue) continue;
    vistos.add(numero);
    saida.push({ numero, o_que_mudar: oQue });
  }
  return saida;
}

/** Instrução de formato por canal — a mesma régua da geração (generate-dispatch). */
export function formatoDoCanal(canal: string): string {
  if (canal === "email") {
    return `É um E-MAIL no formato:
ASSUNTO: <assunto>
CORPO:
<corpo em HTML simples (<p>, <strong>, <a>, <ul>, <li>), sem <html>, <head> ou <body>>
Mantenha exatamente esse formato.`;
  }
  if (canal === "whatsapp_oficial") {
    return "É uma mensagem do WhatsApp Oficial API: texto plano, sem markdown, curta (até ~600 caracteres). Os botões interativos não fazem parte do texto.";
  }
  return "É uma mensagem de grupo de WhatsApp: formatação do WhatsApp (*negrito*, _itálico_), emojis pontuais, legível no celular.";
}

/** O pedido do 2º passo: UMA mensagem, o ajuste dela e o pedido original. */
export function pedidoDeReescrita(m: MensagemDoDisparo, alvo: Alvo, instrucao: string): string {
  return `MENSAGEM ATUAL (${rotuloDaMensagem(m, alvo.numero)}):
<<<
${m.texto}
>>>

AJUSTE A FAZER NESTA MENSAGEM:
${alvo.o_que_mudar}

PEDIDO ORIGINAL DA PESSOA (contexto):
${instrucao}

Aplique SÓ o ajuste. Todo o resto fica como está: estrutura, ordem, links, dados, formatação e tamanho. Não melhore o que não foi pedido.
${formatoDoCanal(m.canal)}
Responda só com a mensagem nova, completa, pronta para colar.`;
}

/** Custo em US$ do Claude Opus 5.5 ($4 / $20 por milhão de tokens). */
export function custoUsd(entrada: number, saida: number): number {
  return (entrada * 4 + saida * 20) / 1_000_000;
}

// ── Prompts (a edge e o teste de ponta a ponta usam os mesmos) ──────────────────────────

export const SCHEMA_ROTEAMENTO = {
  type: "object",
  properties: {
    resposta: {
      type: "string",
      description: "O que você diz à pessoa no chat, 1 a 3 frases, em português, sem travessão.",
    },
    alvos: {
      type: "array",
      items: {
        type: "object",
        properties: {
          numero: { type: "integer" },
          o_que_mudar: { type: "string" },
        },
        required: ["numero", "o_que_mudar"],
        additionalProperties: false,
      },
    },
  },
  required: ["resposta", "alvos"],
  additionalProperties: false,
};

export const SISTEMA_ROTEAMENTO = `Você é o assistente de texto da Central de Disparos da PPGVET. A pessoa já gerou a sequência de mensagens de um disparo (WhatsApp e e-mail) e agora conversa com você para ajustar os textos.

Seu trabalho neste passo: decidir QUAIS mensagens mudam e O QUE muda em cada uma. Você não reescreve nada aqui.

COMO DECIDIR O ALCANCE:
- Pedido SEM dizer onde ("troque o horário para 20h", "tire os emojis", "fale 'pós' em vez de 'especialização'") vale para TODAS as mensagens em que ele faz sentido. Mensagem onde não há nada a mudar (não cita o horário, não tem emoji) fica de fora.
- Pedido que DIZ onde vale SÓ lá: pelo número ("na 3"), pelo canal ("só no e-mail", "nos grupos"), pelo momento ("na de 1 hora antes", "na do dia"), ou por outra referência clara. Não estenda para as outras.
- Referência ambígua (não dá para saber qual mensagem): não mude nada e pergunte na resposta, citando as opções.
- Pergunta ou comentário sem pedido de mudança: alvos vazio, e responda.
- "Faça o mesmo na X", "desfaz isso": use a conversa até aqui para entender.

PARA CADA ALVO, "o_que_mudar" é uma instrução concreta e autossuficiente para quem vai reescrever SÓ aquela mensagem (ex.: "Trocar o horário 19h por 20h, nas duas vezes em que aparece." / "Encurtar o ASSUNTO para até 6 palavras, mantendo o tema."). Se o pedido traz informação nova (data, link, nome), copie-a exata.

RESPOSTA: curta, direta, em português, sem travessão. Diga o que vai mudar e onde (pelos números/momentos), ou faça a pergunta. Não liste o texto novo.

Nunca invente fato que não esteja nas mensagens ou no pedido.`;

export function contextoDaMarca(bp: Record<string, unknown> | null): string {
  if (!bp) return "";
  const l: string[] = [];
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  if (s(bp.brand_name) || s(bp.account_name)) l.push(`MARCA: ${s(bp.brand_name) || s(bp.account_name)}`);
  if (s(bp.tom_de_voz)) l.push(`TOM DE VOZ: ${s(bp.tom_de_voz)}`);
  if (Array.isArray(bp.termos_proibidos) && bp.termos_proibidos.length) {
    l.push(`TERMOS PROIBIDOS: ${(bp.termos_proibidos as string[]).join(", ")}`);
  }
  if (s(bp.alertas_nao_usar)) l.push(`NÃO USAR: ${s(bp.alertas_nao_usar)}`);
  return l.join("\n");
}

export function sistemaDeReescrita(marca: string): string {
  return `Você ajusta mensagens da PPGVET já escritas, para alunos e interessados (veterinários, zootecnistas, produtores). A voz é a de um professor da casa falando com a turma: direto, sem enfeite, sem locução de vendedor.

O QUE VOCÊ DEVOLVE: SOMENTE o texto completo da mensagem ajustada, pronto para copiar e colar. Nada antes e nada depois: sem "Aqui está", sem "---", sem crase tripla, sem explicar o que mudou.

EDIÇÃO MÍNIMA: aplique o ajuste pedido e mantenha o resto igual. Não reescreva frase que não precisa mudar, não troque links, datas ou dados que o pedido não citou.
LIMITE PEDIDO É LIMITE: se o ajuste fala em número de palavras, caracteres ou linhas, conte antes de responder e fique dentro dele.

NÃO PODE PARECER TEXTO DE IA:
- Proibido travessão (—) e meia-risca (–). Use vírgula, ponto ou dois-pontos.
- Proibido "não é só X, é Y", "Você sabia que", "Imagine só", "revolucionário", "transformador".
- No máximo dois emojis, salvo se a mensagem já tinha mais e o pedido não fala deles.
${marca ? `\nVOZ DA MARCA (como escrever, nunca o que escrever):\n${marca}\n- Nunca use os termos proibidos.` : ""}`;
}

// ── Motor: chamada à IA e os dois passos (a edge e o teste de ponta a ponta usam o mesmo) ──

export interface Uso { entrada: number; saida: number }

/** Chamada à Messages API com a reserva automática do servidor (mesmo padrão do comercial-quiz-gerar). */
export async function chamarIA(opts: {
  apiKey: string;
  modelo: string;
  sistema: string;
  pedido: string;
  schema?: Record<string, unknown>;
  esforco: "low" | "medium";
  maxTokens: number;
  timeoutMs: number;
  uso: Uso;
}): Promise<string> {
  const signal = AbortSignal.timeout(opts.timeoutMs);
  const chamar = (comReserva: boolean) =>
    fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal,
      headers: {
        "x-api-key": opts.apiKey,
        "anthropic-version": "2023-06-01",
        ...(comReserva ? { "anthropic-beta": "server-side-fallback-2026-07-01" } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: opts.modelo,
        max_tokens: opts.maxTokens,
        ...(comReserva ? { fallbacks: "default" } : {}),
        output_config: {
          effort: opts.esforco,
          ...(opts.schema ? { format: { type: "json_schema", schema: opts.schema } } : {}),
        },
        system: opts.sistema,
        messages: [{ role: "user", content: opts.pedido }],
      }),
    });
  let res = await chamar(true);
  if (res.status === 400) {
    const txt = await res.clone().text();
    if (/fallback/i.test(txt)) res = await chamar(false);
  }
  if (!res.ok) throw new Error(`IA ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const msg = await res.json();
  opts.uso.entrada += msg?.usage?.input_tokens ?? 0;
  opts.uso.saida += msg?.usage?.output_tokens ?? 0;
  if (msg.stop_reason === "refusal") throw new Error("A IA recusou o pedido.");
  if (msg.stop_reason === "max_tokens") throw new Error("A resposta da IA foi cortada (max_tokens).");
  return (msg.content ?? [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("");
}

export const CONCORRENCIA = 6;

export interface ResultadoDoAjuste {
  resposta: string;
  alteracoes: { id: string; numero: number; rotulo: string; texto: string }[];
  falhas: string[];
  uso: Uso;
}

/**
 * Os dois passos: (1) roteamento, uma chamada com saída estruturada que decide o que muda e
 * onde; (2) reescrita, uma chamada por mensagem-alvo, em paralelo. Reescrita que falha vira
 * `falhas` (as outras seguem); texto igual ao de antes não conta como alteração.
 */
export async function executarAjuste(opts: {
  apiKey: string;
  modelo: string;
  msgs: MensagemDoDisparo[];
  instrucao: string;
  historico: TurnoDoChat[];
  marca: string;
}): Promise<ResultadoDoAjuste> {
  const { apiKey, modelo, msgs, instrucao, historico } = opts;
  const uso: Uso = { entrada: 0, saida: 0 };

  const bruto = await chamarIA({
    apiKey, modelo, uso,
    sistema: SISTEMA_ROTEAMENTO,
    pedido: pedidoDeRoteamento(msgs, instrucao, historico),
    schema: SCHEMA_ROTEAMENTO,
    esforco: "medium",
    maxTokens: 6000,
    timeoutMs: 45_000,
  });
  const rota = JSON.parse(bruto) as { resposta?: string; alvos?: unknown };
  const alvos = alvosValidos(rota.alvos, msgs.length);

  const sistema = sistemaDeReescrita(opts.marca);
  const alteracoes: ResultadoDoAjuste["alteracoes"] = [];
  const falhas: string[] = [];
  let cursor = 0;
  const trabalhador = async () => {
    while (cursor < alvos.length) {
      const alvo = alvos[cursor++];
      const m = msgs[alvo.numero - 1];
      try {
        const saida = await chamarIA({
          apiKey, modelo, uso, sistema,
          pedido: pedidoDeReescrita(m, alvo, instrucao),
          esforco: "low",
          maxTokens: 6000,
          timeoutMs: 45_000,
        });
        const texto = limparSaidaIA(saida);
        if (!texto.trim()) throw new Error("resposta vazia");
        if (texto !== m.texto) {
          alteracoes.push({ id: m.id, numero: alvo.numero, rotulo: rotuloDaMensagem(m, alvo.numero), texto });
        }
      } catch (e) {
        console.error("ajustar-mensagens-disparo: reescrita falhou", alvo.numero, e);
        falhas.push(rotuloDaMensagem(m, alvo.numero));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCORRENCIA, alvos.length) }, trabalhador));
  alteracoes.sort((a, b) => a.numero - b.numero);

  const resposta = String(rota.resposta ?? "").trim()
    || (alteracoes.length ? "Pronto." : "Não encontrei o que mudar.");
  return { resposta, alteracoes, falhas, uso };
}
