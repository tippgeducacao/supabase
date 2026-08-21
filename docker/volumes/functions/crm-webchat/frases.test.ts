import { describe, expect, it } from "vitest";
import { fraseConviteWhatsapp, frasePedidoCronograma, limparCurso } from "./frases";

// Estas frases saem NO WHATSAPP de um lead, como parâmetro de template. Duas coisas não
// podem escapar: quebra de linha (a Meta recusa o envio inteiro) e o artigo errado.

describe("nome do curso como se fala", () => {
  it("tira o prefixo de catálogo da pós", () => {
    expect(limparCurso("PÓS | CLÍNICA MÉDICA E CIRÚRGICA DE BOVINOS"))
      .toBe("CLÍNICA MÉDICA E CIRÚRGICA DE BOVINOS");
  });

  it("o prefixo de MBA vira parte do nome, não some", () => {
    expect(limparCurso("MBA | Gestão da Pecuária Leiteira")).toBe("MBA Gestão da Pecuária Leiteira");
  });

  it("aguenta nulo e vazio", () => {
    expect(limparCurso(null)).toBe("");
    expect(limparCurso(undefined)).toBe("");
    expect(limparCurso("  ")).toBe("");
  });
});

describe("convite pra continuar no WhatsApp", () => {
  it("pós leva “a pós em”", () => {
    expect(fraseConviteWhatsapp("Sanidade Avícola")).toContain("a pós em Sanidade Avícola");
  });

  it("MBA leva “o”, não “a pós em” — errar o artigo entrega que é robô", () => {
    const f = fraseConviteWhatsapp("MBA Gestão da Pecuária Leiteira");
    expect(f).toContain("o MBA Gestão da Pecuária Leiteira");
    expect(f).not.toContain("a pós em MBA");
  });

  // O visitante pode pedir o WhatsApp ANTES de escolher a pós. Citar "a pós em " com o nome
  // vazio seria pior que não citar.
  it("sem curso, convida sem citar curso nenhum", () => {
    for (const vazio of [null, undefined, "", "   "]) {
      const f = fraseConviteWhatsapp(vazio);
      expect(f).toContain("de onde a gente parou");
      expect(f).not.toContain("pós em ");
    }
  });

  it("nunca tem quebra de linha — a Meta recusa o envio inteiro", () => {
    for (const c of ["Sanidade Avícola", "MBA Crédito Rural, Cooperativismo e Vendas", null]) {
      expect(fraseConviteWhatsapp(c)).not.toMatch(/[\r\n]/);
    }
  });
});

describe("pedido de confirmação junto do cronograma", () => {
  it("termina puxando o “Consegue confirmar?” do template", () => {
    const f = frasePedidoCronograma("Sanidade Avícola");
    expect(f).toContain("a pós em Sanidade Avícola");
    expect(f.trimEnd().endsWith(".")).toBe(true);
    expect(f).toContain("preciso saber se é essa mesmo a pós que te interessa");
  });

  it("MBA também acerta o artigo aqui", () => {
    expect(frasePedidoCronograma("MBA Postura Comercial")).toContain("o MBA Postura Comercial");
  });

  it("nunca tem quebra de linha", () => {
    expect(frasePedidoCronograma("Produção de Suínos")).not.toMatch(/[\r\n]/);
  });
});
