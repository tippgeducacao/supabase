// O laço da Mimosa de Vendas: pergunta → (ferramentas)* → resposta, com streaming.
//
// Sem import de runtime do SDK nem do supabase-js: tudo entra por `DependenciasAgente`,
// para o vitest exercitar o laço com um stream falso. O `import type` some na
// transpilação (Deno e esbuild).
import type Anthropic from "npm:@anthropic-ai/sdk@0.128.0";
import { statusDaFerramenta, type FonteMimosa, type ResultadoFerramenta } from "./ferramentas.ts";

/** Eventos que a edge manda ao navegador, um JSON por linha (NDJSON). */
export type EventoMimosa =
  | { tipo: "status"; texto: string }
  | { tipo: "texto"; passo: number; delta: string }
  /** O texto já enviado neste passo era a frase antes de consultar — o front o recolhe. */
  | { tipo: "passo_consulta"; passo: number }
  /** O passo foi refeito (JSON de ferramenta ilegível): o front descarta o texto dele. */
  | { tipo: "refazer_passo"; passo: number }
  | { tipo: "aviso"; texto: string }
  | { tipo: "fontes"; itens: FonteMimosa[] }
  | { tipo: "fim"; modelo: string; passos: number; fallback: boolean }
  | { tipo: "erro"; mensagem: string };

export interface StreamLike {
  on(evento: "text", ouvinte: (delta: string) => void): unknown;
  finalMessage(): Promise<Anthropic.Beta.BetaMessage>;
}

export interface DependenciasAgente {
  abrirStream(params: Record<string, unknown>): StreamLike;
  executar(nome: string, entrada: unknown): Promise<ResultadoFerramenta>;
  emitir(evento: EventoMimosa): void;
  /** `e instanceof Anthropic.APIError` — injetado para o laço não depender do SDK em runtime. */
  ehErroDaApi(e: unknown): boolean;
  /** true quando o navegador desistiu: para de gastar na próxima volta. */
  cancelado?: () => boolean;
}

export interface EntradaAgente {
  system: Anthropic.Beta.BetaTextBlockParam[];
  tools: unknown[];
  messages: Anthropic.Beta.BetaMessageParam[];
}

export interface ResumoAgente {
  passos: number;
  ferramentas: string[];
  fontes: FonteMimosa[];
  uso: { entrada: number; saida: number; cacheLeitura: number; cacheEscrita: number };
  fallback: boolean;
  terminou: "resposta" | "recusa" | "limite" | "cancelado" | "erro";
}

/** Rodadas de modelo por pergunta; a última é forçada a responder sem ferramenta. */
export const MAX_PASSOS = 6;
const MAX_REFAZER_JSON = 2;

/**
 * Marca o último bloco da última mensagem para o cache: a rodada seguinte do laço
 * reenvia tudo e lê esse prefixo do cache. Clona — não suja o histórico real, onde
 * o marcador se acumularia (o limite é 4 por requisição; o system já usa 2).
 */
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

/**
 * O que ecoar do turno do modelo na rodada seguinte. Depois de um fallback no meio da
 * resposta, o que veio ANTES do último bloco `fallback` (pensamento e tool_use do modelo
 * que recusou) não pode voltar; só o texto. O marcador em si é ignorável.
 */
export function conteudoParaEco(conteudo: Anthropic.Beta.BetaContentBlock[]): Anthropic.Beta.BetaContentBlock[] {
  const ultimoFallback = conteudo.map((b) => b.type).lastIndexOf("fallback");
  if (ultimoFallback < 0) return conteudo;
  return conteudo.filter((b, i) => i > ultimoFallback || b.type === "text");
}

function houveFallback(msg: Anthropic.Beta.BetaMessage): boolean {
  if (msg.content.some((b) => b.type === "fallback")) return true;
  const iteracoes = (msg.usage as { iterations?: { type?: string }[] | null } | undefined)?.iterations ?? [];
  return iteracoes.some((i) => i?.type === "fallback_message");
}

export async function rodarAgente(entrada: EntradaAgente, deps: DependenciasAgente): Promise<ResumoAgente> {
  const mensagens = entrada.messages.slice();
  const resumo: ResumoAgente = {
    passos: 0,
    ferramentas: [],
    fontes: [],
    uso: { entrada: 0, saida: 0, cacheLeitura: 0, cacheEscrita: 0 },
    fallback: false,
    terminou: "limite",
  };
  const rotulosVistos = new Set<string>();

  for (let passo = 0; passo < MAX_PASSOS; passo++) {
    if (deps.cancelado?.()) {
      resumo.terminou = "cancelado";
      break;
    }
    const ultimoPasso = passo === MAX_PASSOS - 1;
    let msg: Anthropic.Beta.BetaMessage | null = null;

    for (let tentativa = 0; ; tentativa++) {
      const stream = deps.abrirStream({
        system: entrada.system,
        tools: entrada.tools,
        messages: comCacheNoFim(mensagens),
        ...(ultimoPasso ? { tool_choice: { type: "none" } } : {}),
      });
      stream.on("text", (delta) => deps.emitir({ tipo: "texto", passo, delta }));
      try {
        msg = await stream.finalMessage();
        break;
      } catch (e) {
        // Com eager_input_streaming o servidor não valida o JSON da ferramenta; se o
        // SDK não conseguiu nem ler, refaz a rodada. Erro de API sobe como está.
        if (deps.ehErroDaApi(e) || tentativa >= MAX_REFAZER_JSON) throw e;
        deps.emitir({ tipo: "refazer_passo", passo });
      }
    }

    resumo.passos = passo + 1;
    resumo.uso.entrada += msg.usage?.input_tokens ?? 0;
    resumo.uso.saida += msg.usage?.output_tokens ?? 0;
    resumo.uso.cacheLeitura += msg.usage?.cache_read_input_tokens ?? 0;
    resumo.uso.cacheEscrita += msg.usage?.cache_creation_input_tokens ?? 0;
    if (houveFallback(msg)) resumo.fallback = true;

    // Recusa: nunca roda ferramenta desse turno (o tool_use pode ter sido cortado).
    if (msg.stop_reason === "refusal") {
      deps.emitir({ tipo: "erro", mensagem: "A Mimosa não conseguiu responder a essa pergunta. Tente reformular." });
      resumo.terminou = "recusa";
      break;
    }

    const usos = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (!usos.length) {
      if (msg.stop_reason === "max_tokens") {
        deps.emitir({ tipo: "aviso", texto: "A resposta ficou longa demais e foi cortada. Peça a continuação ou uma versão mais curta." });
      }
      resumo.terminou = "resposta";
      break;
    }
    if (msg.stop_reason === "max_tokens") {
      // tool_use cortado no meio pode até parecer válido — não executa.
      deps.emitir({ tipo: "erro", mensagem: "A consulta ficou grande demais. Tente perguntar por partes." });
      resumo.terminou = "erro";
      break;
    }

    deps.emitir({ tipo: "passo_consulta", passo });
    mensagens.push({ role: "assistant", content: conteudoParaEco(msg.content) as never });

    const resultados = await Promise.all(usos.map(async (uso) => {
      const entradaFerramenta = (uso.input ?? {}) as Record<string, unknown>;
      deps.emitir({ tipo: "status", texto: statusDaFerramenta(uso.name, entradaFerramenta) });
      const r = await deps.executar(uso.name, entradaFerramenta);
      return { uso, r };
    }));

    for (const { uso, r } of resultados) {
      resumo.ferramentas.push(uso.name);
      for (const f of r.fontes) {
        if (rotulosVistos.has(f.rotulo)) continue;
        rotulosVistos.add(f.rotulo);
        resumo.fontes.push(f);
      }
    }

    // Todos os resultados numa única mensagem de usuário (separar ensina o modelo a
    // parar de chamar ferramentas em paralelo).
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
