/**
 * A reconciliação é o pedaço do sync que pode APAGAR a marca de não lido de uma
 * caixa inteira. Os testes aqui são os casos que justificam cada linha dela.
 */
import { describe, expect, it } from "vitest";
import {
  diferencaDeArquivadas,
  diferencaDeSinalizador,
  emLotes,
  LOTE_FILTRO_IN,
} from "./emailReconciliacao.ts";

const linha = (id: string, chave = id) => ({ id, chave });

describe("diferencaDeSinalizador — o não lido e o favoritado", () => {
  it("desmarca o que o banco acha marcado e o servidor não confirma", () => {
    // É O CASO DO BUG: a pessoa leu no Gmail, o servidor não devolve mais a
    // conversa como não lida, e o banco continuava dizendo que sim.
    const d = diferencaDeSinalizador(
      [linha("t1", "g1"), linha("t2", "g2")],
      new Set(["g2"]),
    );
    expect(d.desmarcar).toEqual(["t1"]);
    expect(d.marcar).toEqual([]);
  });

  it("marca o que o servidor confirma e o banco ainda não tem", () => {
    // O outro sentido: desmarcou como lida no Gmail, tem que voltar a acender aqui.
    const d = diferencaDeSinalizador([linha("t1", "g1")], new Set(["g1", "g9"]));
    expect(d.desmarcar).toEqual([]);
    expect(d.marcar).toEqual(["g9"]);
  });

  it("os dois sentidos na mesma passada", () => {
    const d = diferencaDeSinalizador(
      [linha("t1", "g1"), linha("t2", "g2")],
      new Set(["g2", "g3"]),
    );
    expect(d.desmarcar).toEqual(["t1"]);
    expect(d.marcar).toEqual(["g3"]);
  });

  it("estado já alinhado não gera UPDATE nenhum", () => {
    const d = diferencaDeSinalizador([linha("t1", "g1")], new Set(["g1"]));
    expect(d.desmarcar).toEqual([]);
    expect(d.marcar).toEqual([]);
  });

  it("servidor sem nada não lido apaga TODAS as marcas — e é o esperado", () => {
    // Caixa lida por inteiro no webmail. Este é o caminho que só pode ser
    // percorrido com lista COMPLETA; a guarda contra lista truncada vive em quem
    // chama, e é por isso que ela existe.
    const d = diferencaDeSinalizador([linha("t1", "g1"), linha("t2", "g2")], new Set());
    expect(d.desmarcar).toEqual(["t1", "t2"]);
  });

  it("banco sem nada marcado acende tudo que o servidor devolveu", () => {
    const d = diferencaDeSinalizador([], new Set(["g1", "g2"]));
    expect(d.marcar).toEqual(["g1", "g2"]);
    expect(d.desmarcar).toEqual([]);
  });

  it("desmarcar sai em ID do banco; marcar sai em chave do servidor", () => {
    // A assimetria é de propósito: o que precisa acender o banco ainda não achou.
    const d = diferencaDeSinalizador([linha("uuid-1", "thread-abc")], new Set(["thread-xyz"]));
    expect(d.desmarcar).toEqual(["uuid-1"]);
    expect(d.marcar).toEqual(["thread-xyz"]);
  });

  it("duas linhas na mesma conversa (caixa que aparece duas vezes) não se atrapalham", () => {
    const d = diferencaDeSinalizador(
      [linha("t1", "g1"), linha("t2", "g1")],
      new Set(["g1"]),
    );
    expect(d.desmarcar).toEqual([]);
    expect(d.marcar).toEqual([]);
  });

  it("aceita lista vazia dos dois lados sem estourar", () => {
    expect(diferencaDeSinalizador([], new Set())).toEqual({ desmarcar: [], marcar: [] });
  });

  it("aceita array no lugar do Set — o IMAP entrega assim", () => {
    const d = diferencaDeSinalizador([linha("t1")], ["t1", "t2"]);
    expect(d.desmarcar).toEqual([]);
    expect(d.marcar).toEqual(["t2"]);
  });
});

describe("diferencaDeArquivadas", () => {
  const arquivavel = (id: string, chave: string, arquivado: boolean) => ({ id, chave, arquivado });

  it("arquiva o que saiu da caixa de entrada do servidor", () => {
    const d = diferencaDeArquivadas(
      [arquivavel("t1", "g1", false), arquivavel("t2", "g2", false)],
      new Set(["g2"]),
    );
    expect(d.paraArquivar).toEqual(["t1"]);
    expect(d.paraDesarquivar).toEqual([]);
  });

  it("desarquiva o que voltou pra caixa de entrada", () => {
    const d = diferencaDeArquivadas([arquivavel("t1", "g1", true)], new Set(["g1"]));
    expect(d.paraDesarquivar).toEqual(["t1"]);
    expect(d.paraArquivar).toEqual([]);
  });

  it("não toca em quem já está certo — o UPDATE inútil dispara realtime à toa", () => {
    const d = diferencaDeArquivadas(
      [arquivavel("t1", "g1", true), arquivavel("t2", "g2", false)],
      new Set(["g2"]),
    );
    expect(d).toEqual({ paraArquivar: [], paraDesarquivar: [] });
  });

  it("thread que o servidor não conhece conta como arquivada", () => {
    // Conversa que sumiu da inbox lá (movida, apagada) não pode continuar contando
    // como ativa aqui.
    const d = diferencaDeArquivadas([arquivavel("t1", "sumiu", false)], new Set(["g1"]));
    expect(d.paraArquivar).toEqual(["t1"]);
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
  const UUID = "7f3c1a92-4b8e-4d21-9f0a-1c2d3e4f5a6b";           // 36 chars
  const CHAVE_IMAP = `imap:${UUID}:inbox:12345`;                  // + ':' vira %3A
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
