// O laço da IA Administrativa: pedido → (ferramentas)* → resposta, com streaming.
//
// Mesmo desenho do laço da Mimosa de Vendas (supabase/functions/mimosa-vendas/agente.ts), com
// duas diferenças que a investigação exige:
//   * mais rodadas (uma investigação séria faz 5–15 consultas) e um PRAZO: o worker da edge
//     vive no máximo 5 min, então passado o prazo a próxima rodada é forçada a concluir;
//   * cada ferramenta devolve uma `memoria` curta (SQL + amostra) que a edge guarda junto da
//     resposta — na próxima pergunta do chat o modelo lembra do que já apurou.
//
// Sem import de runtime do SDK: tudo entra por `DependenciasAgente` (vitest usa stream falso).
import type Anthropic from "npm:@anthropic-ai/sdk@0.128.0";
import { rotuloDaFerramenta, type EtapaIa, type ResultadoFerramenta } from "./ferramentas.ts";

/** Eventos para o navegador, um JSON por linha (NDJSON). */
export type EventoIaAdmin =
  | { tipo: "conversa"; id: string }
  | { tipo: "status"; texto: string }
  | { tipo: "etapa"; etapa: EtapaIa }
  | { tipo: "texto"; passo: number; delta: string }
  | { tipo: "passo_consulta"; passo: number }
  | { tipo: "refazer_passo"; passo: number }
  | { tipo: "aviso"; texto: string }
  | { tipo: "ping" }
  | { tipo: "fim"; modelo: string; passos: number; custo_usd: number }
  | { tipo: "erro"; mensagem: string };

export interface StreamLike {
  on(evento: "text", ouvinte: (delta: string) => void): unknown;
  finalMessage(): Promise<Anthropic.Beta.BetaMessage>;
}

export interface DependenciasAgente {
  abrirStream(params: Record<string, unknown>): StreamLike;
  executar(nome: string, entrada: unknown): Promise<ResultadoFerramenta>;
  emitir(evento: EventoIaAdmin): void;
  ehErroDaApi(e: unknown): boolean;
  cancelado?: () => boolean;
  agora?: () => number;
}

export interface EntradaAgente {
  system: Anthropic.Beta.BetaTextBlockParam[];
  tools: unknown[];
  messages: Anthropic.Beta.BetaMessageParam[];
}

export interface OpcoesAgente {
  maxPassos: number;
  /** Depois deste tempo (ms desde o início), a próxima rodada tem de concluir sem ferramenta. */
  prazoMs: number;
  passoInicial?: number;
}

export interface UsoTokens {
  entrada: number;
  saida: number;
  cacheLeitura: number;
  cacheEscrita: number;
}

export interface ResumoAgente {
  passos: number;
  etapas: EtapaIa[];
  memoria: string[];
  achados: string[];
  consultas: number;
  uso: UsoTokens;
  /** Texto da última rodada (a resposta final). */
  textoFinal: string;
  terminou: "resposta" | "recusa" | "limite" | "cancelado" | "erro";
}

const MAX_REFAZER_JSON = 2;
const AVISO_PRAZO =
  "[Tempo desta rodada esgotado. Não chame mais ferramentas: conclua AGORA com o que já apurou, " +
  "dizendo com clareza o que ficou confirmado, o que ficou sem verificar e o que o admin pode pedir em seguida.]";

/** Preço por milhão de tokens (US$). Cache: leitura e escrita (5 min). */
const PRECOS: Array<{ prefixo: string; entrada: number; saida: number; cacheLeitura: number; cacheEscrita: number }> = [
  { prefixo: "claude-opus-5-5", entrada: 4, saida: 20, cacheLeitura: 0.2, cacheEscrita: 5 },
  { prefixo: "claude-sonnet-5-5", entrada: 2, saida: 10, cacheLeitura: 0.2, cacheEscrita: 2.5 },
  { prefixo: "claude-opus", entrada: 5, saida: 25, cacheLeitura: 0.5, cacheEscrita: 6.25 },
  { prefixo: "claude-sonnet", entrada: 3, saida: 15, cacheLeitura: 0.3, cacheEscrita: 3.75 },
];

export function custoEstimado(modelo: string, uso: UsoTokens): number {
  const p = PRECOS.find((x) => modelo.startsWith(x.prefixo)) ?? PRECOS[0];
  const usd = (uso.entrada * p.entrada + uso.saida * p.saida + uso.cacheLeitura * p.cacheLeitura + uso.cacheEscrita * p.cacheEscrita) / 1_000_000;
  return Math.round(usd * 10_000) / 10_000;
}

/** Marca o último bloco da última mensagem para o cache (clona — não suja o histórico). */
export function comCacheNoFim(mensagens: Anthropic.Beta.BetaMessageParam[]): Anthropic.Beta.BetaMessageParam[] {
  if (!mensagens.length) return mensagens;
  const copia = mensagens.slice();
  const ultima = copia[copia.length - 1];
  const blocos = typeof ultima.content === "string"
    ? [{ type: "text" as const, text: ultima.content }]
    : ultima.content.slice();
  if (!blocos.length) return copia;
  blocos[blocos.length - 1] = { ...blocos[blocos.length - 1], cache_control: { type: "ephemeral" } } as never;
  copia[copia.length - 1] = { ...ultima, content: blocos as never };
  return copia;
}

/** Depois de um fallback no meio da resposta, só o texto anterior ao marcador pode voltar. */
export function conteudoParaEco(conteudo: Anthropic.Beta.BetaContentBlock[]): Anthropic.Beta.BetaContentBlock[] {
  const ultimoFallback = conteudo.map((b) => b.type).lastIndexOf("fallback");
  if (ultimoFallback < 0) return conteudo;
  return conteudo.filter((b, i) => i > ultimoFallback || b.type === "text");
}

/** 404 = modelo indisponível; 529/overloaded = sobrecarga (também chega no meio do stream). */
export function motivoDaReserva(e: unknown): "modelo_indisponivel" | "sobrecarga" | null {
  if (!e || typeof e !== "object") return null;
  const x = e as { status?: unknown; type?: unknown; error?: { type?: unknown; error?: { type?: unknown } }; message?: unknown };
  if (x.status === 404) return "modelo_indisponivel";
  const tipo = x.type ?? x.error?.error?.type ?? x.error?.type;
  if (x.status === 529 || tipo === "overloaded_error" || /overloaded/i.test(String(x.message ?? ""))) return "sobrecarga";
  return null;
}

/** Conta da IA sem crédito: tentar de novo não resolve. */
export function semCreditoNaIA(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const x = e as { status?: unknown; type?: unknown; error?: { type?: unknown; error?: { type?: unknown } }; message?: unknown };
  const tipo = x.type ?? x.error?.error?.type ?? x.error?.type;
  return x.status === 402 || tipo === "billing_error"
    || /credit balance is too low|insufficient (credit|balance)/i.test(String(x.message ?? ""));
}

export async function rodarAgente(
  entrada: EntradaAgente,
  deps: DependenciasAgente,
  opcoes: OpcoesAgente,
): Promise<ResumoAgente> {
  const agora = deps.agora ?? Date.now;
  const inicioMs = agora();
  const mensagens = entrada.messages.slice();
  const resumo: ResumoAgente = {
    passos: 0,
    etapas: [],
    memoria: [],
    achados: [],
    consultas: 0,
    uso: { entrada: 0, saida: 0, cacheLeitura: 0, cacheEscrita: 0 },
    textoFinal: "",
    terminou: "limite",
  };
  const inicio = opcoes.passoInicial ?? 0;
  let avisouPrazo = false;

  for (let rodada = 0; rodada < opcoes.maxPassos; rodada++) {
    if (deps.cancelado?.()) {
      resumo.terminou = "cancelado";
      break;
    }
    const passo = inicio + rodada;
    const semTempo = agora() - inicioMs > opcoes.prazoMs;
    const ultimoPasso = rodada === opcoes.maxPassos - 1 || semTempo;

    // Sem tempo: avisa o modelo DENTRO da última mensagem (texto depois dos tool_result).
    if (semTempo && !avisouPrazo) {
      avisouPrazo = true;
      const ultima = mensagens[mensagens.length - 1];
      if (ultima?.role === "user" && Array.isArray(ultima.content)) {
        mensagens[mensagens.length - 1] = {
          ...ultima,
          content: [...ultima.content, { type: "text", text: AVISO_PRAZO }] as never,
        };
      }
    }

    let msg: Anthropic.Beta.BetaMessage | null = null;
    let textoDoPasso = "";
    for (let tentativa = 0; ; tentativa++) {
      textoDoPasso = "";
      const stream = deps.abrirStream({
        system: entrada.system,
        tools: entrada.tools,
        messages: comCacheNoFim(mensagens),
        ...(ultimoPasso ? { tool_choice: { type: "none" } } : {}),
      });
      stream.on("text", (delta) => {
        textoDoPasso += delta;
        deps.emitir({ tipo: "texto", passo, delta });
      });
      try {
        msg = await stream.finalMessage();
        break;
      } catch (e) {
        if (deps.ehErroDaApi(e) || tentativa >= MAX_REFAZER_JSON) throw e;
        deps.emitir({ tipo: "refazer_passo", passo });
      }
    }

    resumo.passos = rodada + 1;
    resumo.uso.entrada += msg.usage?.input_tokens ?? 0;
    resumo.uso.saida += msg.usage?.output_tokens ?? 0;
    resumo.uso.cacheLeitura += msg.usage?.cache_read_input_tokens ?? 0;
    resumo.uso.cacheEscrita += msg.usage?.cache_creation_input_tokens ?? 0;

    if (msg.stop_reason === "refusal") {
      deps.emitir({ tipo: "erro", mensagem: "A IA recusou continuar esta investigação. Reformule o pedido?" });
      resumo.terminou = "recusa";
      break;
    }

    const usos = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (!usos.length) {
      resumo.textoFinal = textoDoPasso;
      if (msg.stop_reason === "max_tokens") {
        deps.emitir({ tipo: "aviso", texto: "A resposta ficou longa demais e cortou no fim. Peça para continuar." });
      }
      resumo.terminou = "resposta";
      break;
    }
    if (msg.stop_reason === "max_tokens") {
      deps.emitir({ tipo: "erro", mensagem: "A investigação ficou grande demais de uma vez. Peça por partes?" });
      resumo.terminou = "erro";
      break;
    }

    deps.emitir({ tipo: "passo_consulta", passo });
    mensagens.push({ role: "assistant", content: conteudoParaEco(msg.content) as never });

    const resultados = await Promise.all(usos.map(async (uso) => {
      const entradaFerramenta = (uso.input ?? {}) as Record<string, unknown>;
      deps.emitir({ tipo: "status", texto: rotuloDaFerramenta(uso.name, entradaFerramenta) });
      const r = await deps.executar(uso.name, entradaFerramenta);
      deps.emitir({ tipo: "etapa", etapa: r.etapa });
      return { uso, r };
    }));

    for (const { uso, r } of resultados) {
      resumo.etapas.push(r.etapa);
      if (r.memoria) resumo.memoria.push(r.memoria);
      if (uso.name === "consultar_banco") resumo.consultas++;
      if (uso.name === "registrar_achado" && r.etapa.achado_id) resumo.achados.push(r.etapa.achado_id);
    }

    // Todos os resultados numa única mensagem (separar ensina o modelo a parar de paralelizar).
    mensagens.push({
      role: "user",
      content: resultados.map(({ uso, r }) => ({
        type: "tool_result" as const,
        tool_use_id: uso.id,
        content: r.conteudo,
        ...(r.erro ? { is_error: true } : {}),
      })),
    });
  }

  return resumo;
}
