import { describe, expect, it, vi } from "vitest";
import { comCacheNoFim, custoEstimado, rodarAgente, type DependenciasAgente, type EventoIaAdmin } from "./agente";
import type { ResultadoFerramenta } from "./ferramentas";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function mensagem(conteudo: Json[], stop_reason: string): Json {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: conteudo,
    stop_reason,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
  };
}

const usoFerramenta = (id: string, name: string, input: Json) => ({ type: "tool_use", id, name, input });

/** Stream falso: emite os textos da mensagem e devolve a mensagem. */
function roteiro(respostas: Json[]) {
  const chamadas: Record<string, unknown>[] = [];
  let i = 0;
  const abrirStream = (params: Record<string, unknown>) => {
    chamadas.push(JSON.parse(JSON.stringify(params)));
    const resposta = respostas[Math.min(i++, respostas.length - 1)];
    let ouvinte: ((d: string) => void) | null = null;
    return {
      on(_e: "text", fn: (d: string) => void) {
        ouvinte = fn;
        return this;
      },
      async finalMessage() {
        for (const b of resposta.content) if (b.type === "text") ouvinte?.(b.text);
        return resposta;
      },
    };
  };
  return { abrirStream, chamadas };
}

function deps(respostas: Json[], opts: { agora?: () => number; executar?: DependenciasAgente["executar"] } = {}) {
  const { abrirStream, chamadas } = roteiro(respostas);
  const eventos: EventoIaAdmin[] = [];
  const executar = vi.fn(opts.executar ?? (async (nome: string): Promise<ResultadoFerramenta> => ({
    conteudo: "1 linha(s):\n[{\"n\":14}]",
    erro: false,
    etapa: { ferramenta: nome, rotulo: "Consultando o banco", detalhe: "select 1", linhas: 1 },
    memoria: "- conta → 1 linha(s)",
  })));
  const d: DependenciasAgente = {
    abrirStream,
    executar,
    emitir: (e) => eventos.push(e),
    ehErroDaApi: () => false,
    agora: opts.agora,
  };
  return { d, eventos, chamadas, executar };
}

const entrada = {
  system: [{ type: "text" as const, text: "sys" }],
  tools: [{ name: "consultar_banco" }],
  messages: [{ role: "user" as const, content: "Quantas reuniões da IA caíram no ADM?" }],
};

describe("rodarAgente (IA Administrativa)", () => {
  it("consulta, devolve o resultado ao modelo e termina com a resposta final", async () => {
    const { d, eventos, chamadas, executar } = deps([
      mensagem([usoFerramenta("t1", "consultar_banco", { sql: "select 1", objetivo: "contar" })], "tool_use"),
      mensagem([{ type: "text", text: "Foram 14 reuniões." }], "end_turn"),
    ]);
    const r = await rodarAgente(entrada, d, { maxPassos: 5, prazoMs: 60_000 });

    expect(executar).toHaveBeenCalledWith("consultar_banco", { sql: "select 1", objetivo: "contar" });
    expect(r.terminou).toBe("resposta");
    expect(r.textoFinal).toBe("Foram 14 reuniões.");
    expect(r.consultas).toBe(1);
    expect(r.memoria).toEqual(["- conta → 1 linha(s)"]);
    expect(r.etapas).toHaveLength(1);
    // A segunda chamada leva o tool_result.
    const msgs = chamadas[1].messages as Json[];
    expect(msgs[msgs.length - 1].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1" });
    expect(eventos.some((e) => e.tipo === "etapa")).toBe(true);
    // Uso somado nas duas rodadas.
    expect(r.uso).toEqual({ entrada: 200, saida: 40, cacheLeitura: 100, cacheEscrita: 20 });
  });

  it("passado o prazo, avisa o modelo e força a conclusão sem ferramenta", async () => {
    let t = 0;
    const { d, chamadas } = deps([
      mensagem([usoFerramenta("t1", "consultar_banco", { sql: "select 1", objetivo: "a" })], "tool_use"),
      mensagem([{ type: "text", text: "Conclusão parcial." }], "end_turn"),
    ], { agora: () => (t += 100_000) });
    const r = await rodarAgente(entrada, d, { maxPassos: 10, prazoMs: 150_000 });

    expect(r.terminou).toBe("resposta");
    expect(chamadas[0].tool_choice).toBeUndefined();
    expect(chamadas[1].tool_choice).toEqual({ type: "none" });
    const ultima = (chamadas[1].messages as Json[]).at(-1);
    expect(ultima.content.at(-1)).toMatchObject({ type: "text" });
    expect(ultima.content.at(-1).text).toMatch(/Tempo desta rodada esgotado/);
  });

  it("a última rodada permitida também é forçada a responder", async () => {
    const { d, chamadas } = deps([
      mensagem([usoFerramenta("t1", "consultar_banco", { sql: "select 1", objetivo: "a" })], "tool_use"),
      mensagem([{ type: "text", text: "Fim." }], "end_turn"),
    ]);
    await rodarAgente(entrada, d, { maxPassos: 2, prazoMs: 999_999 });
    expect(chamadas[1].tool_choice).toEqual({ type: "none" });
  });

  it("conta os achados registrados", async () => {
    const { d } = deps([
      mensagem([usoFerramenta("t1", "registrar_achado", { assinatura: "x-y", titulo: "T", gravidade: "alta", area: "sac", resumo: "R" })], "tool_use"),
      mensagem([{ type: "text", text: "Registrado." }], "end_turn"),
    ], {
      executar: async (nome) => ({
        conteudo: "{\"ok\":true}",
        erro: false,
        etapa: { ferramenta: nome, rotulo: "Registrando achado", achado_id: "11111111-1111-1111-1111-111111111111" },
      }),
    });
    const r = await rodarAgente(entrada, d, { maxPassos: 4, prazoMs: 60_000 });
    expect(r.achados).toEqual(["11111111-1111-1111-1111-111111111111"]);
    expect(r.consultas).toBe(0);
  });

  it("recusa não roda ferramenta", async () => {
    const { d, executar } = deps([
      mensagem([usoFerramenta("t1", "consultar_banco", { sql: "select 1" })], "refusal"),
    ]);
    const r = await rodarAgente(entrada, d, { maxPassos: 4, prazoMs: 60_000 });
    expect(r.terminou).toBe("recusa");
    expect(executar).not.toHaveBeenCalled();
  });
});

describe("custoEstimado", () => {
  it("usa a tabela do Opus 5.5 e arredonda em 4 casas", () => {
    // 1M entrada ($4) + 100k saída ($2) + 1M cache lido ($0,20) + 100k cache escrito ($0,50)
    expect(custoEstimado("claude-opus-5-5", { entrada: 1_000_000, saida: 100_000, cacheLeitura: 1_000_000, cacheEscrita: 100_000 })).toBe(6.7);
  });
  it("modelo desconhecido cai no preço do padrão", () => {
    expect(custoEstimado("x", { entrada: 1_000_000, saida: 0, cacheLeitura: 0, cacheEscrita: 0 })).toBe(4);
  });
});

describe("comCacheNoFim", () => {
  it("marca só a cópia", () => {
    const original = [{ role: "user" as const, content: "oi" }];
    const marcado = comCacheNoFim(original) as Json[];
    expect(marcado[0].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(original[0].content).toBe("oi");
  });
});
