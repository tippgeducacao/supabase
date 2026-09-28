import { describe, expect, it } from "vitest";
import { calcularOrcamento, ErroOrcamento, formatarBRL, somarMeses } from "./mimosaOrcamento";

describe("calcularOrcamento — pedidos reais dos vendedores (set/2026)", () => {
  it("12.730,00 com 20% em 24x e matrícula 492,50 com 60%: aponta os centavos que não fecham", () => {
    const r = calcularOrcamento({
      valor_integral: 12730,
      desconto_percentual: 20,
      parcelas: 24,
      matricula: 492.5,
      desconto_matricula_percentual: 60,
      primeiro_vencimento: "2026-10-25",
    });
    expect(r.valor_final).toBe("R$ 10.184,00");
    expect(r.desconto_em_reais).toBe("R$ 2.546,00");
    expect(r.valor_parcela).toBe("R$ 424,33");
    expect(r.soma_das_parcelas).toBe("R$ 10.183,92");
    expect(r.ultima_parcela).toBe("R$ 424,41");
    expect(r.matricula_final).toBe("R$ 197,00");
    expect(r.total_com_matricula).toBe("R$ 10.381,00");
    expect(r.primeiro_vencimento).toBe("25/10/2026");
    expect(r.ultimo_vencimento).toBe("25/09/2028");
    expect(r.avisos.join(" ")).toContain("faltam R$ 0,08");
  });

  it("17.000,00 com 40% em 24x fecha exato — sem aviso de arredondamento", () => {
    const r = calcularOrcamento({ valor_integral: 17000, desconto_percentual: 40, parcelas: 24 });
    expect(r.valor_final).toBe("R$ 10.200,00");
    expect(r.valor_parcela).toBe("R$ 425,00");
    expect(r.ultima_parcela).toBeNull();
    expect(r.avisos).toEqual([]);
  });

  it("27.429 × 0,9 não vira 24686,100000000002: conta em centavos", () => {
    const r = calcularOrcamento({ valor_integral: 27429, desconto_percentual: 10, parcelas: 24 });
    expect(r.valor_final).toBe("R$ 24.686,10");
    expect(r.valor_parcela).toBe("R$ 1.028,59");
    expect(r.ultima_parcela).toBe("R$ 1.028,53");
    expect(r.avisos.join(" ")).toContain("sobram R$ 0,06");
  });

  it("a entrada sai do valor ANTES de parcelar", () => {
    const r = calcularOrcamento({ valor_integral: 10000, entrada: 1000, parcelas: 9 });
    expect(r.valor_parcela).toBe("R$ 1.000,00");
    expect(r.entrada).toBe("R$ 1.000,00");
    expect(r.resumo).toContain("entrada de R$ 1.000,00");
  });

  it("valor fechado na negociação manda, mas a divergência com a bolsa é avisada", () => {
    const r = calcularOrcamento({ valor_integral: 12730, desconto_percentual: 20, valor_final: 9800, parcelas: 10 });
    expect(r.valor_final).toBe("R$ 9.800,00");
    expect(r.valor_parcela).toBe("R$ 980,00");
    expect(r.avisos.join(" ")).toContain("R$ 10.184,00");
  });

  it("à vista, sem matrícula", () => {
    const r = calcularOrcamento({ valor_integral: 17000, desconto_percentual: 5 });
    expect(r.parcelas).toBe(1);
    expect(r.valor_parcela).toBe("R$ 16.150,00");
    expect(r.resumo).toContain("à vista");
    expect(r.matricula_final).toBeNull();
    expect(r.total_com_matricula).toBe("R$ 16.150,00");
  });

  it("percentual sai sempre com 2 casas (regra de ouro 5)", () => {
    const r = calcularOrcamento({ valor_integral: 12730, desconto_percentual: 12.5, parcelas: 12 });
    expect(r.desconto_percentual).toBe("12,50%");
  });

  it("recusa entrada inválida com mensagem que o modelo consegue corrigir", () => {
    expect(() => calcularOrcamento({ valor_integral: 0 })).toThrow(ErroOrcamento);
    expect(() => calcularOrcamento({ valor_integral: 1000, desconto_percentual: 120 })).toThrow(/entre 0 e 100/);
    expect(() => calcularOrcamento({ valor_integral: 1000, parcelas: 0 })).toThrow(/1 a 48/);
    expect(() => calcularOrcamento({ valor_integral: 1000, parcelas: 2.5 })).toThrow(/inteiro/);
    expect(() => calcularOrcamento({ valor_integral: 1000, entrada: 1000 })).toThrow(/menor que o valor final/);
    expect(() => calcularOrcamento({ valor_integral: 1000, primeiro_vencimento: "25/10/2026" })).toThrow(/AAAA-MM-DD/);
    expect(() => calcularOrcamento({ valor_integral: 1000, primeiro_vencimento: "2026-02-31" })).toThrow(/AAAA-MM-DD/);
  });
});

describe("utilitários", () => {
  it("formatarBRL em pt-BR com 2 casas", () => {
    expect(formatarBRL(123456789)).toBe("R$ 1.234.567,89");
    expect(formatarBRL(5)).toBe("R$ 0,05");
    expect(formatarBRL(100)).toBe("R$ 1,00");
  });

  it("somarMeses segura o dia no fim do mês", () => {
    expect(somarMeses("2027-01-31", 1)).toBe("2027-02-28");
    expect(somarMeses("2026-10-25", 23)).toBe("2028-09-25");
    expect(somarMeses("2027-12-10", 1)).toBe("2028-01-10");
  });
});
