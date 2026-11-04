import { describe, expect, it } from "vitest";
import {
  acaoDaLista, corpoDoLote, dividirEmLotes, especificacaoSemelhante, ESQUEMA, eventoDoItem, mensagemDeErroMeta,
  novaSessao, type Linha,
} from "./regras";

const linha = (i: number): Linha => [`e${i}`, `t${i}`, "fn", "ln", "br"];
const linhas = (n: number) => Array.from({ length: n }, (_, i) => linha(i));

describe("dividirEmLotes", () => {
  it("lista vazia não gera lote", () => {
    expect(dividirEmLotes([], 10)).toEqual([]);
  });

  it("numera a partir de 1 e marca só o último", () => {
    const lotes = dividirEmLotes(linhas(25), 10);
    expect(lotes.map((l) => [l.batch_seq, l.linhas.length, l.last_batch_flag])).toEqual([
      [1, 10, false],
      [2, 10, false],
      [3, 5, true],
    ]);
  });

  it("lista do tamanho exato do lote vira um lote só, já marcado como último", () => {
    const lotes = dividirEmLotes(linhas(10), 10);
    expect(lotes).toHaveLength(1);
    expect(lotes[0].last_batch_flag).toBe(true);
  });

  it("não perde nem repete linha", () => {
    const todas = linhas(23);
    expect(dividirEmLotes(todas, 7).flatMap((l) => l.linhas)).toEqual(todas);
  });

  it("recusa tamanho de lote inválido", () => {
    expect(() => dividirEmLotes(linhas(3), 0)).toThrow();
  });
});

describe("corpoDoLote", () => {
  it("monta payload com o esquema fixo e a sessão do lote", () => {
    const [lote] = dividirEmLotes(linhas(2), 10);
    const corpo = corpoDoLote(lote, 123, 2, "TOKEN");
    expect(JSON.parse(corpo.get("payload")!)).toEqual({ schema: [...ESQUEMA], data: lote.linhas });
    expect(JSON.parse(corpo.get("session")!)).toEqual({
      session_id: 123,
      batch_seq: 1,
      last_batch_flag: true,
      estimated_num_total: 2,
    });
    expect(corpo.get("access_token")).toBe("TOKEN");
  });

  it("toda linha tem uma coluna por campo do esquema", () => {
    const [lote] = dividirEmLotes(linhas(3), 10);
    const { data } = JSON.parse(corpoDoLote(lote, 1, 3, "x").get("payload")!);
    for (const l of data) expect(l).toHaveLength(ESQUEMA.length);
  });
});

describe("acaoDaLista", () => {
  it("público já no catálogo: substitui a lista (não reinicia o aprendizado)", () => {
    expect(acaoDaLista("123", undefined)).toEqual({ acao: "atualizar", endpoint: "usersreplace" });
  });
  it("público com o mesmo nome já na conta: adota e substitui", () => {
    expect(acaoDaLista(null, "456")).toEqual({ acao: "adotar", endpoint: "usersreplace" });
  });
  it("público novo: cria e faz a 1ª carga por /users", () => {
    expect(acaoDaLista(null, undefined)).toEqual({ acao: "criar", endpoint: "users" });
  });
});

describe("especificacaoSemelhante", () => {
  it("1% no Brasil", () => {
    expect(JSON.parse(especificacaoSemelhante(0.01, "BR"))).toEqual({ ratio: 0.01, country: "BR" });
  });
  it("recusa fora de 1% a 20% e país fora do ISO", () => {
    expect(() => especificacaoSemelhante(0.5, "BR")).toThrow();
    expect(() => especificacaoSemelhante(0.01, "Brasil")).toThrow();
  });
});

describe("mensagemDeErroMeta", () => {
  it("prefere o texto para o usuário e anexa os códigos", () => {
    const corpo = {
      error: {
        message: "Invalid parameter",
        code: 100,
        error_subcode: 1870034,
        error_user_title: "Termos não aceitos",
        error_user_msg: "Aceite os termos do público personalizado.",
      },
    };
    expect(mensagemDeErroMeta(corpo, 400)).toBe(
      "Termos não aceitos: Aceite os termos do público personalizado. (código 100, subcódigo 1870034)",
    );
  });
  it("sem corpo de erro, diz o status", () => {
    expect(mensagemDeErroMeta({}, 502)).toBe("HTTP 502 sem corpo de erro");
  });
});

describe("novaSessao", () => {
  it("é inteiro positivo e seguro no JavaScript", () => {
    const s = novaSessao(Date.UTC(2026, 10, 4), 0.999);
    expect(Number.isSafeInteger(s)).toBe(true);
    expect(s).toBeGreaterThan(0);
  });
});

describe("eventoDoItem", () => {
  it("rodada sem mudança não gera evento", () => {
    expect(eventoDoItem({ acao: "atualizar", entraram: 0, sairam: 0, total: 490 })).toBeNull();
  });
  it("gente entrando ou saindo vira 'atualizado' com os números", () => {
    expect(eventoDoItem({ acao: "atualizar", entraram: 12, sairam: 3, total: 499 })).toEqual({
      tipo: "atualizado", resumo: null, entraram: 12, sairam: 3, total: 499,
    });
  });
  it("público novo vira 'criado'", () => {
    expect(eventoDoItem({ acao: "criar", entraram: 490, sairam: 0, total: 490 })?.tipo).toBe("criado");
    expect(eventoDoItem({ acao: "adotar" })?.resumo).toContain("já existia");
  });
  it("erro vence tudo, inclusive a criação que aconteceu antes de falhar", () => {
    expect(eventoDoItem({ acao: "criar", erro: "Token sem permissão (código 200)" })).toEqual({
      tipo: "erro", resumo: "Token sem permissão (código 200)", entraram: null, sairam: null, total: null,
    });
  });
  it("aviso vira 'aviso'", () => {
    expect(eventoDoItem({ acao: "atualizar", aviso: "a Meta ainda está processando" })?.tipo).toBe("aviso");
  });
});
