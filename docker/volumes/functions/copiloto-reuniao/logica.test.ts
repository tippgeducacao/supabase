import { describe, expect, it } from "vitest";
import {
  codigoDoMeet,
  interpretarSaida,
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
    expect(interpretarSaida('{"mostrar":true,"tipo":"objecao","texto":" Pergunte o que pesa mais: a parcela ou o momento. "}'))
      .toEqual({ tipo: "objecao", texto: "Pergunte o que pesa mais: a parcela ou o momento." });
  });

  it("silêncio é o caso comum: mostrar=false, texto vazio, JSON quebrado ou nada", () => {
    expect(interpretarSaida('{"mostrar":false,"tipo":"dado","texto":""}')).toBeNull();
    expect(interpretarSaida('{"mostrar":true,"tipo":"dado","texto":"  "}')).toBeNull();
    expect(interpretarSaida('{"mostrar":true,"tipo":')).toBeNull();
    expect(interpretarSaida(undefined)).toBeNull();
  });

  it("tipo desconhecido vira lembrete em vez de derrubar a dica", () => {
    expect(interpretarSaida('{"mostrar":true,"tipo":"outro","texto":"Combine o próximo passo."}')?.tipo).toBe("lembrete");
  });
});

describe("montarContexto", () => {
  const dados = {
    agendamento: { pos_graduacao_interesse: "PÓS | SANIDADE AVÍCOLA", principal_dor_objetivo: "quer sair da clínica", observacoes: "" },
    lead: { nome: "Ana", profissao: "Veterinária", regiao: null },
    anteriores: [{ data_agendamento: "2026-09-30T17:00:00+00:00", pos_graduacao_interesse: "PÓS | SANIDADE AVÍCOLA", resultado_reuniao: "compareceu_nao_comprou", objecoes_apresentadas: "preço" }],
    produto: { produto: "Sanidade Avícola", preco_oficial_online: "R$ 12.730,00", matricula_gerenciar_cursos: 300, proximo_pratico: "2026-11-05" },
    perfis: [
      { nome: "Segundo", ordem: 2, sinais: ["quero mudar de área"], perguntas: [] },
      { nome: "Primeiro", ordem: 1, moeda: "territorio", sinais: [], perguntas: [{ pergunta: "já fez necropsia de ave?", lacuna: "rotina de campo" }] },
    ],
    objecoes: [{ objecao: "já prescrevo informalmente", resposta: "então vc já viu que funciona", ordem: 1 }],
  };

  it("traz lead, reunião, histórico, curso, perfis na ordem e objeções", () => {
    const texto = montarContexto(dados);
    expect(texto).toContain("- Nome: Ana");
    expect(texto).toContain("- Dor ou objetivo que o SDR registrou: quer sair da clínica");
    expect(texto).toContain("Reunião de 30/09/2026");
    expect(texto).toContain("- Valor oficial online: R$ 12.730,00");
    expect(texto).toContain("- Próximo módulo prático: 05/11/2026");
    expect(texto.indexOf("### Primeiro")).toBeLessThan(texto.indexOf("### Segundo"));
    expect(texto).toContain("já fez necropsia de ave? (revela: rotina de campo)");
    expect(texto).toContain('"já prescrevo informalmente" → então vc já viu que funciona');
  });

  it("matrícula numérica sai em reais com centavos, nunca arredondada", () => {
    expect(montarContexto(dados)).toMatch(/- Matrícula: R\$\s300,00/);
  });

  it("campo vazio não vira linha, e o texto sai idêntico a cada chamada (cache do prompt)", () => {
    const texto = montarContexto(dados);
    expect(texto).not.toContain("Região");
    expect(texto).not.toContain("Anotações de quem marcou");
    expect(montarContexto(dados)).toBe(texto);
  });

  it("reunião sem pós cadastrada ainda monta o que tem", () => {
    const texto = montarContexto({ agendamento: { pos_graduacao_interesse: "CURSO NOVO" }, lead: null });
    expect(texto).toContain("- Pós de interesse: CURSO NOVO");
    expect(texto).not.toContain("Perfis de carreira");
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
