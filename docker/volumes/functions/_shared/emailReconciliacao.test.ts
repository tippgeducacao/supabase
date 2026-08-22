/**
 * A reconciliação é o pedaço do sync que pode APAGAR a marca de não lido de uma
 * caixa inteira. Os testes aqui são os casos que justificam cada linha dela.
 */
import { describe, expect, it } from "vitest";
import { diferencaPorLinha, emLotes, LOTE_FILTRO_IN } from "./emailReconciliacao.ts";

const linha = (id: string, atual: boolean, desejado: boolean) => ({ id, atual, desejado });

describe("diferencaPorLinha", () => {
  it("desliga o que o banco acha marcado e o servidor não confirma", () => {
    // É O CASO DO BUG ORIGINAL: a pessoa leu no Gmail, o servidor não devolve mais
    // a conversa como não lida, e o banco continuava dizendo que sim.
    const d = diferencaPorLinha([linha("t1", true, false)]);
    expect(d.desligar).toEqual(["t1"]);
    expect(d.ligar).toEqual([]);
  });

  it("liga o que o servidor confirma e o banco ainda não tem", () => {
    // O outro sentido: desmarcou como lida no Gmail, tem que voltar a acender aqui.
    const d = diferencaPorLinha([linha("t1", false, true)]);
    expect(d.ligar).toEqual(["t1"]);
    expect(d.desligar).toEqual([]);
  });

  it("os dois sentidos na mesma passada", () => {
    const d = diferencaPorLinha([
      linha("t1", true, false),
      linha("t2", false, true),
    ]);
    expect(d.desligar).toEqual(["t1"]);
    expect(d.ligar).toEqual(["t2"]);
  });

  it("linha já no estado certo não gera UPDATE — escrita à toa acorda o realtime", () => {
    const d = diferencaPorLinha([linha("t1", true, true), linha("t2", false, false)]);
    expect(d).toEqual({ ligar: [], desligar: [] });
  });

  it("servidor sem nada não lido apaga TODAS as marcas — e é o esperado", () => {
    // Caixa lida por inteiro no webmail. Este caminho só pode ser percorrido com
    // lista COMPLETA; a guarda contra lista truncada vive em quem chama, e é por
    // isso que ela existe.
    const d = diferencaPorLinha([linha("t1", true, false), linha("t2", true, false)]);
    expect(d.desligar).toEqual(["t1", "t2"]);
  });

  it("lista vazia não gera nada", () => {
    expect(diferencaPorLinha([])).toEqual({ ligar: [], desligar: [] });
  });

  it("o que o servidor tem A MAIS simplesmente não aparece — é o conserto do desperdício", () => {
    // A régua parte das NOSSAS linhas. Conversa que o Gmail tem e nós ainda não
    // baixamos não vira UPDATE nenhum: era isso que gerava 137 PATCH inúteis por
    // rodada na caixa programappgvet (6.808 não lidas lá contra 2.774 threads aqui).
    const nossas = [linha("t1", false, true)];
    const d = diferencaPorLinha(nossas);
    expect(d.ligar).toHaveLength(1);
    expect(d.ligar.concat(d.desligar).every((id) => nossas.some((l) => l.id === id))).toBe(true);
  });

  it("toda saída é id de linha nossa, nunca chave do servidor", () => {
    const d = diferencaPorLinha([linha("uuid-1", true, false), linha("uuid-2", false, true)]);
    expect(d.desligar).toEqual(["uuid-1"]);
    expect(d.ligar).toEqual(["uuid-2"]);
  });
});

describe("emLotes", () => {
  it("parte na medida pedida e guarda o resto no último lote", () => {
    expect(emLotes([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("lista menor que o lote sai inteira em um só", () => {
    expect(emLotes([1], 200)).toEqual([[1]]);
  });

  it("lista vazia não gera lote nenhum — nada de UPDATE com IN vazio", () => {
    expect(emLotes([], 200)).toEqual([]);
  });
});

describe("LOTE_FILTRO_IN — o limite é o tamanho da URL, não a contagem", () => {
  // O `IN` do PostgREST viaja na query string, e o Kong corta em ~8 KB. Com 200
  // itens a reconciliação morria em `URI too long` — e morria justamente nas
  // caixas com MUITA coisa a corrigir, porque as pequenas cabiam no lote parcial.
  const UUID = "7f3c1a92-4b8e-4d21-9f0a-1c2d3e4f5a6b";
  const CHAVE_IMAP = `imap:${UUID}:inbox:12345`;
  const LIMITE_URI = 8192;

  const tamanhoNaUrl = (valores: string[]) =>
    valores.map((v) => encodeURIComponent(v).length + 3).reduce((a, b) => a + b, 0);

  it("um lote cheio de UUIDs cabe na URL com folga", () => {
    const lote = Array.from({ length: LOTE_FILTRO_IN }, () => UUID);
    expect(tamanhoNaUrl(lote)).toBeLessThan(LIMITE_URI / 2);
  });

  it("um lote cheio de chaves IMAP — as mais longas — também cabe", () => {
    const lote = Array.from({ length: LOTE_FILTRO_IN }, () => CHAVE_IMAP);
    expect(tamanhoNaUrl(lote)).toBeLessThan(LIMITE_URI / 2);
  });

  it("o lote antigo de 200 chaves IMAP estourava — é a regressão que este número trava", () => {
    const lote = Array.from({ length: 200 }, () => CHAVE_IMAP);
    expect(tamanhoNaUrl(lote)).toBeGreaterThan(LIMITE_URI);
  });
});
