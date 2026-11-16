import { describe, expect, it } from "vitest";
import { fraseConviteWhatsapp, frasePedidoCronograma, limparCurso } from "./frases";

// Estas frases saem NO WHATSAPP de um lead, como parâmetro de template. Duas coisas não
// podem escapar: quebra de linha (a Meta recusa o envio inteiro) e o artigo errado.

describe("nome do curso como se fala", () => {
  it("tira o prefixo de catálogo e devolve caixa de título", () => {
    expect(limparCurso("PÓS | CLÍNICA MÉDICA E CIRÚRGICA DE BOVINOS"))
      .toBe("Clínica Médica e Cirúrgica de Bovinos");
    expect(limparCurso("MBA | GESTÃO DE PESSOAS E RH EM COOPERATIVAS DE CRÉDITO"))
      .toBe("Gestão de Pessoas e RH em Cooperativas de Crédito");
  });

  it("MBA some: para o visitante tudo é pós-graduação (marca.md)", () => {
    expect(limparCurso("MBA | Gestão da Pecuária Leiteira")).toBe("Gestão da Pecuária Leiteira");
    expect(limparCurso("MBA Postura Comercial")).toBe("Postura Comercial");
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

  it("nome de catálogo com MBA também vira “a pós em”, sem MBA", () => {
    const f = fraseConviteWhatsapp("MBA | GESTÃO DA PECUÁRIA LEITERA");
    expect(f).toContain("a pós em Gestão da Pecuária Leitera");
    expect(f).not.toMatch(/MBA/);
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

  it("sem MBA aqui também", () => {
    expect(frasePedidoCronograma("MBA Postura Comercial")).toContain("a pós em Postura Comercial");
  });

  it("nunca tem quebra de linha", () => {
    expect(frasePedidoCronograma("Produção de Suínos")).not.toMatch(/[\r\n]/);
  });
});
