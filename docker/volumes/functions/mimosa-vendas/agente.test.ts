import { describe, expect, it, vi } from "vitest";
import {
  comCacheNoFim,
  conteudoParaEco,
  criarRastreioDaTela,
  MAX_PASSOS,
  motivoDaReserva,
  rodarAgente,
  semCreditoNaIA,
  type DependenciasAgente,
  type EventoMimosa,
} from "./agente";
import type { ResultadoFerramenta } from "./ferramentas";
// A tela de verdade (puro, sem React): prova o que a pessoa VÊ depois do recomeço.
import { aplicarEvento, respostaVazia, textoFinal } from "../../../src/components/comercial-v2/copiloto/mimosaStream";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function mensagem(conteudo: Json[], stop_reason: string, extra: Json = {}): Json {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: conteudo,
    stop_reason,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10, ...extra.usage },
  };
}

/** Stream falso: emite os textos da mensagem e devolve a mensagem (ou lança). */
function roteiro(respostas: (Json | Error)[]) {
  const chamadas: Record<string, unknown>[] = [];
  let i = 0;
  const abrirStream = (params: Record<string, unknown>) => {
    // Congela o que foi enviado NESTA chamada (o laço continua mexendo no histórico).
    chamadas.push(JSON.parse(JSON.stringify(params)));
    const resposta = respostas[Math.min(i++, respostas.length - 1)];
    let ouvinte: ((d: string) => void) | null = null;
    return {
      on(_e: "text", fn: (d: string) => void) {
        ouvinte = fn;
        return this;
      },
      async finalMessage() {
        if (resposta instanceof Error) throw resposta;
        for (const b of resposta.content) if (b.type === "text") ouvinte?.(b.text);
        return resposta;
      },
    };
  };
  return { abrirStream, chamadas };
}

class ErroApi extends Error {}

function deps(respostas: (Json | Error)[], executar?: DependenciasAgente["executar"]) {
  const { abrirStream, chamadas } = roteiro(respostas);
  const eventos: EventoMimosa[] = [];
  const exec = vi.fn(executar ?? (async (): Promise<ResultadoFerramenta> => ({
    conteudo: '{"ok":true}',
    erro: false,
    fontes: [{ tipo: "pedagogico", rotulo: "Sanidade Avícola — cadastro do Pedagógico", atualizado_em: "2026-09-20T00:00:00Z" }],
  })));
  const d: DependenciasAgente = {
    abrirStream,
    executar: exec,
    emitir: (e) => eventos.push(e),
    ehErroDaApi: (e) => e instanceof ErroApi,
  };
  return { d, eventos, chamadas, exec };
}

const entrada = {
  system: [{ type: "text" as const, text: "sys" }],
  tools: [{ name: "detalhar_produto" }],
  messages: [{ role: "user" as const, content: "Qual o próximo prático de Sanidade?" }],
};

describe("rodarAgente", () => {
  it("consulta a ferramenta, devolve o resultado com o mesmo id e responde", async () => {
    const { d, eventos, chamadas, exec } = deps([
      mensagem([
        { type: "text", text: "Vou conferir." },
        { type: "tool_use", id: "tu_1", name: "detalhar_produto", input: { produto: "sanidade", secoes: ["praticos"] } },
      ], "tool_use"),
      mensagem([{ type: "text", text: "É em 14/04/2027, em Cascavel." }], "end_turn"),
    ]);

    const r = await rodarAgente(entrada, d);

    expect(r.terminou).toBe("resposta");
    expect(r.passos).toBe(2);
    expect(r.ferramentas).toEqual(["detalhar_produto"]);
    expect(exec).toHaveBeenCalledWith("detalhar_produto", { produto: "sanidade", secoes: ["praticos"] });
    expect(r.uso).toEqual({ entrada: 200, saida: 40, cacheLeitura: 100, cacheEscrita: 20 });
    expect(r.fontes).toHaveLength(1);

    // Ordem dos eventos: texto do passo 0, recolhe como consulta, status, resposta final.
    expect(eventos.map((e) => e.tipo)).toEqual(["texto", "passo_consulta", "status", "texto"]);
    expect(eventos[2]).toEqual({ tipo: "status", texto: "Abrindo a ficha de “sanidade”" });

    // A 2ª chamada leva o turno do modelo e o tool_result casado pelo id.
    const msgs = chamadas[1].messages as Json[];
    expect(msgs).toHaveLength(3);
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu_1", content: '{"ok":true}' });
    // O cache vai só no último bloco da requisição.
    expect(msgs[2].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(msgs[1].content.some((b: Json) => b.cache_control)).toBe(false);
  });

  it("chamadas paralelas voltam juntas, numa única mensagem, na mesma ordem", async () => {
    const { d, chamadas } = deps([
      mensagem([
        { type: "tool_use", id: "a", name: "modulos_praticos", input: { cidade: "Cacique" } },
        { type: "tool_use", id: "b", name: "turmas", input: {} },
      ], "tool_use"),
      mensagem([{ type: "text", text: "ok" }], "end_turn"),
    ]);
    await rodarAgente(entrada, d);
    const ultima = (chamadas[1].messages as Json[]).at(-1);
    expect(ultima.content.map((b: Json) => b.tool_use_id)).toEqual(["a", "b"]);
  });

  it("erro da ferramenta vira tool_result com is_error, e as fontes não se repetem", async () => {
    let n = 0;
    const { d, chamadas } = deps(
      [
        mensagem([
          { type: "tool_use", id: "a", name: "buscar_na_base", input: { consulta: "x" } },
          { type: "tool_use", id: "b", name: "buscar_na_base", input: { consulta: "y" } },
        ], "tool_use"),
        mensagem([{ type: "text", text: "ok" }], "end_turn"),
      ],
      async () => (n++ === 0
        ? { conteudo: '{"erro":"falhou"}', erro: true, fontes: [] }
        : { conteudo: "{}", erro: false, fontes: [{ tipo: "busca", rotulo: "Grade" }, { tipo: "busca", rotulo: "Grade" }] }),
    );
    const r = await rodarAgente(entrada, d);
    const res = (chamadas[1].messages as Json[]).at(-1).content;
    expect(res[0].is_error).toBe(true);
    expect(res[1].is_error).toBeUndefined();
    expect(r.fontes).toEqual([{ tipo: "busca", rotulo: "Grade" }]);
  });

  it("recusa: avisa e NÃO executa o tool_use do turno", async () => {
    const { d, eventos, exec } = deps([
      mensagem([{ type: "tool_use", id: "x", name: "turmas", input: {} }], "refusal"),
    ]);
    const r = await rodarAgente(entrada, d);
    expect(r.terminou).toBe("recusa");
    expect(exec).not.toHaveBeenCalled();
    expect(eventos.at(-1)?.tipo).toBe("erro");
  });

  it("max_tokens com tool_use cortado: não executa", async () => {
    const { d, exec } = deps([
      mensagem([{ type: "tool_use", id: "x", name: "turmas", input: {} }], "max_tokens"),
    ]);
    const r = await rodarAgente(entrada, d);
    expect(r.terminou).toBe("erro");
    expect(exec).not.toHaveBeenCalled();
  });

  it("a última rodada é forçada a responder (tool_choice none)", async () => {
    const semFim = mensagem([{ type: "tool_use", id: "t", name: "turmas", input: {} }], "tool_use");
    const respostas: Json[] = Array.from({ length: MAX_PASSOS - 1 }, () => semFim);
    respostas.push(mensagem([{ type: "text", text: "Resposta com o que tenho." }], "end_turn"));
    const { d, chamadas } = deps(respostas);
    const r = await rodarAgente(entrada, d);
    expect(r.passos).toBe(MAX_PASSOS);
    expect(r.terminou).toBe("resposta");
    expect(chamadas.at(-1)?.tool_choice).toEqual({ type: "none" });
    expect(chamadas[0].tool_choice).toBeUndefined();
  });

  it("JSON de ferramenta ilegível refaz a rodada; erro de API sobe", async () => {
    const { d, eventos } = deps([
      new Error("Unable to parse tool parameter JSON from model"),
      mensagem([{ type: "text", text: "ok" }], "end_turn"),
    ]);
    const r = await rodarAgente(entrada, d);
    expect(r.terminou).toBe("resposta");
    expect(eventos[0]).toEqual({ tipo: "refazer_passo", passo: 0 });

    const { d: d2 } = deps([new ErroApi("429")]);
    await expect(rodarAgente(entrada, d2)).rejects.toThrow("429");
  });

  it("marca o fallback quando outro modelo assumiu a resposta", async () => {
    const { d } = deps([
      mensagem([{ type: "text", text: "ok" }], "end_turn", { usage: { iterations: [{ type: "message" }, { type: "fallback_message" }] } }),
    ]);
    const r = await rodarAgente(entrada, d);
    expect(r.fallback).toBe(true);
  });

  it("para de gastar quando o navegador cancela", async () => {
    const { d, exec } = deps([mensagem([{ type: "text", text: "ok" }], "end_turn")]);
    d.cancelado = () => true;
    const r = await rodarAgente(entrada, d);
    expect(r.terminou).toBe("cancelado");
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("reserva quando a IA principal falha", () => {
  // Como a sobrecarga chegou em 29/09/2026 09:30 (único erro das primeiras 24 perguntas):
  // evento de erro no meio do stream, sem status, com o JSON no message.
  const JSON_SOBRECARGA = '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_x"}';
  const sobrecargaNoStream = () => Object.assign(new ErroApi(JSON_SOBRECARGA), {
    error: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
  });

  it("motivoDaReserva: 404 = modelo indisponível; 529/overloaded_error (também no meio do stream) = sobrecarga", () => {
    expect(motivoDaReserva({ status: 404 })).toBe("modelo_indisponivel");
    expect(motivoDaReserva({ status: 529 })).toBe("sobrecarga");
    expect(motivoDaReserva({ status: 529, type: "overloaded_error" })).toBe("sobrecarga");
    expect(motivoDaReserva(sobrecargaNoStream())).toBe("sobrecarga");
    expect(motivoDaReserva(new Error(JSON_SOBRECARGA))).toBe("sobrecarga");
    // o resto continua virando erro na tela
    expect(motivoDaReserva({ status: 429, type: "rate_limit_error" })).toBeNull();
    expect(motivoDaReserva({ status: 400, type: "invalid_request_error" })).toBeNull();
    expect(motivoDaReserva(new Error("Unable to parse tool parameter JSON from model"))).toBeNull();
    expect(motivoDaReserva(null)).toBeNull();
  });

  it("rastreio da tela: frase recolhida como consulta não conta como resposta visível", () => {
    const tela = criarRastreioDaTela();
    tela.registrar({ tipo: "texto", passo: 0, delta: "Vou conferir." });
    tela.registrar({ tipo: "passo_consulta", passo: 0 });
    tela.registrar({ tipo: "status", texto: "Abrindo a ficha de “sanidade”" });
    expect(tela.respostaVisivel()).toBe(false);
    expect(tela.proximoPasso()).toBe(1);

    tela.registrar({ tipo: "texto", passo: 1, delta: "É em 14/04." });
    expect(tela.respostaVisivel()).toBe(true);

    tela.registrar({ tipo: "refazer_passo", passo: 1 });
    expect(tela.respostaVisivel()).toBe(false);
    expect(tela.proximoPasso()).toBe(2);
  });

  it("recomeço com a reserva: a resposta nova aparece inteira, sem cair num passo recolhido", async () => {
    const tela = criarRastreioDaTela();
    let naTela = respostaVazia();
    const emitir = (ev: EventoMimosa) => {
      tela.registrar(ev);
      naTela = aplicarEvento(naTela, ev as never);
    };

    // Principal: consulta no passo 0 e sobrecarrega no passo 1, antes de responder.
    const principal = deps([
      mensagem([
        { type: "text", text: "Vou conferir." },
        { type: "tool_use", id: "t1", name: "detalhar_produto", input: { produto: "sanidade" } },
      ], "tool_use"),
      sobrecargaNoStream(),
    ]);
    principal.d.emitir = emitir;
    await expect(rodarAgente(entrada, principal.d)).rejects.toThrow(/overloaded/);
    expect(tela.respostaVisivel()).toBe(false);

    // Reserva: recomeça da pergunta original, numerando a partir do próximo passo.
    const reserva = deps([mensagem([{ type: "text", text: "É em 14/04/2027, em Cascavel." }], "end_turn")]);
    reserva.d.emitir = emitir;
    const r = await rodarAgente(entrada, reserva.d, { passoInicial: tela.proximoPasso() });

    expect(r.terminou).toBe("resposta");
    expect(r.passos).toBe(1);
    expect(reserva.chamadas[0].messages).toHaveLength(1);
    expect(textoFinal(naTela)).toBe("É em 14/04/2027, em Cascavel.");
  });

  it("passoInicial desloca a numeração e a última rodada continua forçada a responder", async () => {
    const semFim = mensagem([{ type: "tool_use", id: "t", name: "turmas", input: {} }], "tool_use");
    const respostas: Json[] = Array.from({ length: MAX_PASSOS - 1 }, () => semFim);
    respostas.push(mensagem([{ type: "text", text: "ok" }], "end_turn"));
    const { d, eventos, chamadas } = deps(respostas);

    const r = await rodarAgente(entrada, d, { passoInicial: 3 });

    expect(r.passos).toBe(MAX_PASSOS);
    expect(chamadas.at(-1)?.tool_choice).toEqual({ type: "none" });
    expect(eventos.find((e) => e.tipo === "passo_consulta")).toEqual({ tipo: "passo_consulta", passo: 3 });
    expect(eventos.at(-1)).toEqual({ tipo: "texto", passo: 3 + MAX_PASSOS - 1, delta: "ok" });
  });
});

describe("conta da IA sem crédito", () => {
  // O texto que chegou em mimosa_vendas_uso.erro em 29/09/2026 (18:19–19:52).
  const SEM_CREDITO = '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}';

  it("reconhece o 400 de saldo baixo, o 402 e o billing_error", () => {
    expect(semCreditoNaIA(new Error(SEM_CREDITO))).toBe(true);
    expect(semCreditoNaIA({ status: 400, message: SEM_CREDITO })).toBe(true);
    expect(semCreditoNaIA({ status: 402 })).toBe(true);
    expect(semCreditoNaIA({ status: 400, type: "billing_error" })).toBe(true);
  });

  it("não confunde com sobrecarga, limite de uso ou pedido inválido comum", () => {
    expect(semCreditoNaIA({ status: 529, type: "overloaded_error" })).toBe(false);
    expect(semCreditoNaIA({ status: 429, type: "rate_limit_error" })).toBe(false);
    expect(semCreditoNaIA({ status: 400, type: "invalid_request_error", message: "max_tokens: too large" })).toBe(false);
    expect(semCreditoNaIA(null)).toBe(false);
    // e a reserva não é tentada (é a mesma conta)
    expect(motivoDaReserva(new Error(SEM_CREDITO))).toBeNull();
  });
});

describe("utilitários do laço", () => {
  it("comCacheNoFim não altera o histórico original", () => {
    const original = [{ role: "user" as const, content: "oi" }];
    const marcado = comCacheNoFim(original);
    expect(original[0].content).toBe("oi");
    expect(marcado[0].content).toEqual([{ type: "text", text: "oi", cache_control: { type: "ephemeral" } }]);
  });

  it("conteudoParaEco descarta pensamento e tool_use de antes do fallback, mantém o texto", () => {
    const conteudo: Json[] = [
      { type: "thinking", thinking: "" },
      { type: "text", text: "parte 1" },
      { type: "tool_use", id: "velho", name: "turmas", input: {} },
      { type: "fallback", from: { model: "a" }, to: { model: "b" } },
      { type: "text", text: "parte 2" },
      { type: "tool_use", id: "novo", name: "turmas", input: {} },
    ];
    expect(conteudoParaEco(conteudo).map((b: Json) => b.type + (b.id ? `:${b.id}` : ""))).toEqual([
      "text",
      "text",
      "tool_use:novo",
    ]);
    const sem = [{ type: "text", text: "x" }] as Json[];
    expect(conteudoParaEco(sem)).toBe(sem);
  });
});
