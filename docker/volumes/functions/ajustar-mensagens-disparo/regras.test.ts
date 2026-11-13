import { describe, expect, it } from "vitest";
import {
  alvosValidos, custoUsd, historicoLimpo, ordenar, pedidoDeReescrita, pedidoDeRoteamento,
  rotuloDaMensagem, type MensagemDoDisparo,
} from "./regras";

const msg = (p: Partial<MensagemDoDisparo>): MensagemDoDisparo => ({
  id: "x", canal: "whatsapp_grupo", texto: "Oi", ordem: 1, momento: "1 dia antes",
  deslocamento: "-1d", intencao: null, status: "rascunho", ...p,
});

describe("alvosValidos", () => {
  it("descarta número fora da lista, repetido ou sem instrução", () => {
    const r = alvosValidos([
      { numero: 1, o_que_mudar: "trocar 19h por 20h" },
      { numero: 1, o_que_mudar: "de novo" },
      { numero: 0, o_que_mudar: "zero" },
      { numero: 4, o_que_mudar: "não existe" },
      { numero: 2, o_que_mudar: "  " },
      { numero: 3, o_que_mudar: "encurtar o assunto" },
      { numero: "2", o_que_mudar: "string vira número" },
    ], 3);
    expect(r).toEqual([
      { numero: 1, o_que_mudar: "trocar 19h por 20h" },
      { numero: 3, o_que_mudar: "encurtar o assunto" },
      { numero: 2, o_que_mudar: "string vira número" },
    ]);
  });

  it("lista vazia ou lixo = nenhuma mudança (pergunta sem pedido)", () => {
    expect(alvosValidos([], 5)).toEqual([]);
    expect(alvosValidos(null, 5)).toEqual([]);
    expect(alvosValidos("1,2", 5)).toEqual([]);
  });
});

describe("historicoLimpo", () => {
  it("fica só com os últimos turnos válidos", () => {
    const bruto = [
      ...Array.from({ length: 10 }, (_, i) => ({ papel: i % 2 ? "ia" : "usuario", texto: `t${i}` })),
      { papel: "sistema", texto: "ignore" },
      { papel: "usuario", texto: 42 },
    ];
    const h = historicoLimpo(bruto);
    expect(h).toHaveLength(8);
    expect(h[0].texto).toBe("t2");
    expect(h.every((t) => t.papel === "usuario" || t.papel === "ia")).toBe(true);
  });
  it("não-array vira vazio", () => {
    expect(historicoLimpo(undefined)).toEqual([]);
  });
});

describe("pedidos", () => {
  it("roteamento numera na ordem da tela e marca a aprovada", () => {
    const msgs = ordenar([
      msg({ id: "b", ordem: 2, canal: "email", texto: "ASSUNTO: A", status: "aprovado", momento: "No dia", deslocamento: "0" }),
      msg({ id: "a", ordem: 1, texto: "Aula às 19h" }),
    ]);
    const p = pedidoDeRoteamento(msgs, "troque para 20h", [{ papel: "usuario", texto: "oi" }]);
    expect(p.indexOf("MENSAGEM 1 · 1 dia antes (-1d) · WhatsApp Grupo")).toBeLessThan(p.indexOf("MENSAGEM 2 · No dia (0) · E-mail"));
    expect(p).toContain("· já aprovada");
    expect(p).toContain("Pessoa: oi");
    expect(p.trim().endsWith("troque para 20h")).toBe(true);
  });

  it("reescrita leva o texto atual, o ajuste e o formato do canal", () => {
    const m = msg({ canal: "email", texto: "ASSUNTO: Aula\nCORPO:\n<p>19h</p>" });
    const p = pedidoDeReescrita(m, { numero: 3, o_que_mudar: "19h → 20h" }, "troque o horário");
    expect(p).toContain("<p>19h</p>");
    expect(p).toContain("19h → 20h");
    expect(p).toContain("ASSUNTO: <assunto>");
    expect(rotuloDaMensagem(m, 3)).toBe("3 · 1 dia antes (-1d) · E-mail");
  });
});

describe("custoUsd", () => {
  it("Opus 5.5 = $4 entrada / $20 saída por milhão", () => {
    expect(custoUsd(1_000_000, 0)).toBe(4);
    expect(custoUsd(0, 1_000_000)).toBe(20);
  });
});
