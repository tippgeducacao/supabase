import { describe, expect, it } from "vitest";
import {
  codigoDoMeet,
  ESQUEMA_SAIDA,
  interpretarSaida,
  janelaDasMinhas,
  lerRespostaLuna,
  limparFalas,
  pedidoLuna,
  limparDicasDadas,
  limparTurnos,
  maisProximaDeAgora,
  montarContexto,
  montarPedido,
} from "./logica";

describe("codigoDoMeet", () => {
  it("tira o código da URL, do título da aba ou do código puro", () => {
    expect(codigoDoMeet("https://meet.google.com/bwg-wzrr-zhu?authuser=0")).toBe("bwg-wzrr-zhu");
    expect(codigoDoMeet("Meet: BWG-WZRR-ZHU")).toBe("bwg-wzrr-zhu");
    expect(codigoDoMeet("bwg-wzrr-zhu")).toBe("bwg-wzrr-zhu");
  });

  it("recusa o que não é código de Meet (inclusive curinga de busca)", () => {
    expect(codigoDoMeet("https://zoom.us/j/123456")).toBeNull();
    expect(codigoDoMeet("%")).toBeNull();
    expect(codigoDoMeet("abcd-efgh-ijkl")).toBeNull();
    expect(codigoDoMeet(42)).toBeNull();
  });
});

describe("limparTurnos", () => {
  it("junta falas seguidas da mesma pessoa e descarta o que é inválido", () => {
    expect(limparTurnos([
      { quem: "vendedor", texto: "Oi." },
      { quem: "vendedor", texto: "Tudo bem?" },
      { quem: "robo", texto: "ignorar" },
      { quem: "lead", texto: "   " },
      { quem: "lead", texto: "Tudo." },
    ])).toEqual([
      { quem: "vendedor", texto: "Oi. Tudo bem?" },
      { quem: "lead", texto: "Tudo." },
    ]);
    expect(limparTurnos("texto solto")).toEqual([]);
  });

  it("conversa longa: fica o FIM, e a última fala do lead nunca se perde", () => {
    const longa = Array.from({ length: 60 }, (_, i) => ({ quem: i % 2 ? "lead" : "vendedor", texto: `${i} ${"x".repeat(300)}` }));
    const r = limparTurnos(longa);
    expect(r.reduce((n, t) => n + t.texto.length, 0)).toBeLessThanOrEqual(6000);
    expect(r[r.length - 1].quem).toBe("lead");
    expect(r[r.length - 1].texto.startsWith("59 ")).toBe(true);
  });
});

describe("montarPedido", () => {
  it("lista as dicas já dadas antes da conversa", () => {
    const pedido = montarPedido([{ quem: "lead", texto: "Achei caro." }], ["Pergunte o que ele quer resolver."]);
    expect(pedido).toContain("- Pergunte o que ele quer resolver.");
    expect(pedido).toContain("Lead: Achei caro.");
    expect(pedido.indexOf("Dicas que já apareceram")).toBeLessThan(pedido.indexOf("Conversa"));
  });

  it("sem dica anterior não cria a seção", () => {
    expect(montarPedido([{ quem: "lead", texto: "Oi." }], limparDicasDadas(null))).not.toContain("Dicas que já apareceram");
  });
});

describe("interpretarSaida", () => {
  it("devolve a dica quando o modelo manda mostrar", () => {
    expect(interpretarSaida('{"mostrar":true,"tipo":"objecao","texto":" O que mudaria pra você em um ano com a pós? "}'))
      .toEqual({ tipo: "objecao", texto: "O que mudaria pra você em um ano com a pós?" });
  });

  it("silêncio é o caso comum: mostrar=false, texto vazio, JSON quebrado ou nada", () => {
    expect(interpretarSaida('{"mostrar":false,"tipo":"pergunta","texto":""}')).toBeNull();
    expect(interpretarSaida('{"mostrar":true,"tipo":"pergunta","texto":"  "}')).toBeNull();
    expect(interpretarSaida('{"mostrar":true,"tipo":')).toBeNull();
    expect(interpretarSaida(undefined)).toBeNull();
  });

  it("tipo desconhecido vira pergunta em vez de derrubar a dica", () => {
    expect(interpretarSaida('{"mostrar":true,"tipo":"outro","texto":"A empresa valoriza quem estuda?"}')?.tipo).toBe("pergunta");
  });

  it("não existe tipo de dica para fato de curso (preço não é devolvido)", () => {
    expect(ESQUEMA_SAIDA.properties.tipo.enum).toEqual(["pergunta", "objecao", "lembrete"]);
  });
});

describe("montarContexto", () => {
  const dados = {
    agendamento: { pos_graduacao_interesse: "PÓS | NUTRIÇÃO E GESTÃO DE BOVINOS", principal_dor_objetivo: "quer cobrar mais pela consultoria", observacoes: "" },
    lead: { nome: "Ana", profissao: "Veterinária", regiao: null },
    anteriores: [{ data_agendamento: "2026-09-30T17:00:00+00:00", pos_graduacao_interesse: "PÓS | NUTRIÇÃO E GESTÃO DE BOVINOS", resultado_reuniao: "compareceu_nao_comprou", objecoes_apresentadas: "preço" }],
    mapa: {
      ramos: [
        { ramo: "contratado", nome: "Contratado (CLT) de cooperativa", ordem: 2, sinais: ["trabalho na cooperativa", "carteira assinada"], argumento: "cargo, comissão e valorização do estudo" },
        { ramo: "autonomo", nome: "Autônomo: tem a própria consultoria", ordem: 1, sinais: ["atendo fazendas"], argumento: "cobrar mais pela consultoria" },
      ],
      perguntas: [
        { ramo: "contratado", etapa: "carreira", ordem: 1, texto: "A empresa tem plano de carreira?" },
        { ramo: "autonomo", etapa: "ganho", ordem: 2, texto: "Quanto você cobra hoje por visita?" },
        { ramo: "autonomo", etapa: "carreira", ordem: 1, texto: "O que faz o produtor escolher você?" },
        { ramo: "*", etapa: "divide", ordem: 1, texto: "Você trabalha de forma autônoma ou é contratado?" },
        { ramo: "*", etapa: "prioridade", ordem: 101, texto: "Por que você está buscando uma pós justamente agora?" },
      ],
    },
  };

  it("traz lead, reunião e histórico", () => {
    const texto = montarContexto(dados);
    expect(texto).toContain("- Nome: Ana");
    expect(texto).toContain("- Dor ou objetivo que o SDR registrou: quer cobrar mais pela consultoria");
    expect(texto).toContain("Reunião de 30/09/2026");
  });

  it("mapa de carreira: a pergunta que divide vem primeiro, ramos e perguntas na ordem do comercial", () => {
    const texto = montarContexto(dados);
    expect(texto.indexOf("Para descobrir como o lead trabalha")).toBeLessThan(texto.indexOf("### Autônomo"));
    expect(texto.indexOf("### Autônomo")).toBeLessThan(texto.indexOf("### Contratado"));
    expect(texto.indexOf("O que faz o produtor escolher você?")).toBeLessThan(texto.indexOf("Quanto você cobra hoje por visita?"));
    expect(texto).toContain("  - [ganho] Quanto você cobra hoje por visita?");
    expect(texto).toContain("- Sinais na fala do lead: trabalho na cooperativa | carteira assinada");
    expect(texto).toContain("- O que pesa para ele: cargo, comissão e valorização do estudo");
    expect(texto).toContain("### Valem para qualquer ramo\n  - [prioridade] Por que você está buscando uma pós justamente agora?");
  });

  it("a pergunta que divide não se repete dentro dos ramos nem nas gerais", () => {
    const texto = montarContexto(dados);
    expect(texto.split("Você trabalha de forma autônoma ou é contratado?")).toHaveLength(2);
  });

  it("não leva preço nem fato de curso, mesmo que alguém mande junto", () => {
    const texto = montarContexto({ ...dados, produto: { preco_oficial_online: "R$ 12.730,00" } } as never);
    expect(texto).not.toContain("12.730");
    expect(texto).not.toMatch(/Valor|Matrícula|Fatos do curso/);
  });

  it("campo vazio não vira linha, e o texto sai idêntico a cada chamada (cache do prompt)", () => {
    const texto = montarContexto(dados);
    expect(texto).not.toContain("Região");
    expect(texto).not.toContain("Anotações de quem marcou");
    expect(montarContexto(dados)).toBe(texto);
  });

  it("resumo do lead e origem do agendamento entram no contexto", () => {
    const texto = montarContexto({ ...dados, agendamento: { ...dados.agendamento, origem: "API SDR" }, resumo: "**Quem é:** contratada de cooperativa" });
    expect(texto).toContain("- Como a reunião foi marcada: pela IA de atendimento no WhatsApp");
    expect(texto).toContain("a partir da conversa no WhatsApp)\n**Quem é:** contratada de cooperativa");
    expect(texto.indexOf("O que já se sabe do lead")).toBeLessThan(texto.indexOf("Mapa de carreira"));
  });

  it("pós sem mapa ainda monta o que tem do lead", () => {
    const texto = montarContexto({ agendamento: { pos_graduacao_interesse: "CURSO NOVO" }, lead: null, mapa: { ramos: [], perguntas: [] } });
    expect(texto).toContain("- Pós de interesse: CURSO NOVO");
    expect(texto).not.toContain("Mapa de carreira");
  });
});

describe("janelaDasMinhas", () => {
  it("3 h para trás (reunião em andamento ou atrasada) e 12 h para a frente", () => {
    expect(janelaDasMinhas(new Date("2026-10-14T12:00:00Z"))).toEqual({
      de: "2026-10-14T09:00:00.000Z",
      ate: "2026-10-15T00:00:00.000Z",
    });
  });
});

describe("maisProximaDeAgora", () => {
  const agora = new Date("2026-10-13T18:00:00Z");

  it("link reusado: vale a reunião mais perto de agora", () => {
    const r = maisProximaDeAgora([
      { id: "ontem", data_agendamento: "2026-10-12T18:00:00Z", status: "realizado" },
      { id: "agora", data_agendamento: "2026-10-13T18:30:00Z", status: "agendado" },
      { id: "semana", data_agendamento: "2026-10-18T18:00:00Z", status: "agendado" },
    ], agora);
    expect(r?.id).toBe("agora");
  });

  it("cancelada só vale se for a única", () => {
    const lista = [
      { id: "cancelada", data_agendamento: "2026-10-13T18:00:00Z", status: "cancelado" },
      { id: "valida", data_agendamento: "2026-10-13T20:00:00Z", status: "remarcado" },
    ];
    expect(maisProximaDeAgora(lista, agora)?.id).toBe("valida");
    expect(maisProximaDeAgora([lista[0]], agora)?.id).toBe("cancelada");
    expect(maisProximaDeAgora([], agora)).toBeNull();
  });
});

describe("Luna 6", () => {
  it("pedido: instruções fixas primeiro, saída presa ao mesmo esquema da dica", () => {
    const p = pedidoLuna({ modelo: "gpt-6-luna", esforco: "low", instrucoes: "PROMPT + REUNIÃO", pedido: "Lead: achei caro" });
    expect(p).toMatchObject({
      model: "gpt-6-luna", store: false, instructions: "PROMPT + REUNIÃO",
      input: [{ role: "user", content: "Lead: achei caro" }], reasoning: { effort: "low" },
      text: { format: { type: "json_schema", strict: true, schema: ESQUEMA_SAIDA } },
    });
  });

  it("resposta com pergunta vira a mesma dica do Haiku, com uso e modelo", () => {
    const r = lerRespostaLuna({
      model: "gpt-6-luna-2026-09-30",
      output: [
        { type: "reasoning" },
        { type: "message", content: [{ type: "output_text", text: '{"mostrar":true,"tipo":"pergunta","texto":"A cooperativa tem plano de carreira?"}' }] },
      ],
      usage: { input_tokens: 3200, input_tokens_details: { cached_tokens: 2944 }, output_tokens: 90, output_tokens_details: { reasoning_tokens: 40 } },
    });
    expect(r.dica).toEqual({ tipo: "pergunta", texto: "A cooperativa tem plano de carreira?" });
    expect(r.modelo).toBe("gpt-6-luna-2026-09-30");
    expect(r.uso).toEqual({ entrada: 3200, cacheLido: 2944, saida: 90, raciocinio: 40 });
  });

  it("silêncio, recusa ou resposta sem mensagem = nada a mostrar", () => {
    expect(lerRespostaLuna({ output: [{ type: "message", content: [{ type: "output_text", text: '{"mostrar":false,"tipo":"pergunta","texto":""}' }] }] }).dica).toBeNull();
    expect(lerRespostaLuna({ output: [{ type: "message", content: [{ type: "refusal", refusal: "não" }] }] }).dica).toBeNull();
    expect(lerRespostaLuna({}).dica).toBeNull();
  });
});

describe("limparFalas (captura para avaliação)", () => {
  it("aceita só fala com motor, quem, ordem e texto válidos", () => {
    const r = limparFalas([
      { motor: "parakeet", ordem: 0, quem: "lead", texto: " Trabalho na cooperativa. ", falada_em: "2026-10-16T13:00:00Z" },
      { motor: "gemini", ordem: 0, quem: "lead", texto: "Trabalho na cooperativa.", falada_em: "2026-10-16T13:00:01Z" },
      { motor: "whisper", ordem: 1, quem: "lead", texto: "motor desconhecido" },
      { motor: "parakeet", ordem: -1, quem: "lead", texto: "ordem negativa" },
      { motor: "parakeet", ordem: 2, quem: "robo", texto: "quem inválido" },
      { motor: "parakeet", ordem: 3, quem: "vendedor", texto: "   " },
    ]);
    expect(r).toEqual([
      { motor: "parakeet", ordem: 0, quem: "lead", texto: "Trabalho na cooperativa.", falada_em: "2026-10-16T13:00:00.000Z" },
      { motor: "gemini", ordem: 0, quem: "lead", texto: "Trabalho na cooperativa.", falada_em: "2026-10-16T13:00:01.000Z" },
    ]);
  });

  it("data inválida vira agora; lixo vira lista vazia", () => {
    const [f] = limparFalas([{ motor: "parakeet", ordem: 5, quem: "vendedor", texto: "oi", falada_em: "ontem" }]);
    expect(Number.isNaN(new Date(f.falada_em).getTime())).toBe(false);
    expect(limparFalas("x")).toEqual([]);
  });
});
