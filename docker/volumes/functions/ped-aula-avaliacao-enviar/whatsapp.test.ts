/**
 * Trava da régua do WhatsApp da avaliação ao professor.
 *
 * O modo de falha aqui é CALADO e cobra caro: variável vazia (131008) ou com quebra de linha
 * (132000) faz a Meta recusar o modelo inteiro — o professor não recebe nada e a equipe acha que
 * mandou. E a ordem das variáveis tem que bater com o modelo aprovado, senão a nota vai no lugar
 * da data.
 */
import { describe, expect, it } from "vitest";
import {
  decodificarPdf,
  erroWhatsappAmigavel,
  nomeDoPdf,
  paramWa,
  parametrosWhatsapp,
  componentesDoCorpo,
  traduzirStatusModelo,
  PDF_MAX_BYTES,
} from "./whatsapp";

const base = { professorNome: "Antônio Carlos Souza", titulo: "Manejo de Alojamento", data: "2026-09-29", nota: 9.88, total: 17 };

describe("parametrosWhatsapp — as 5 variáveis na ordem do modelo", () => {
  it("nome, título, data, nota e respostas, nessa ordem", () => {
    const p = parametrosWhatsapp(base);
    expect(p).toEqual({ ok: true, valores: ["Antônio", "Manejo de Alojamento", "29/09/2026", "9,88", "17 respostas"] });
  });

  it("nota sempre com 2 casas e vírgula (regra de ouro), mesmo inteira", () => {
    const p = parametrosWhatsapp({ ...base, nota: 10 });
    expect(p.ok && p.valores[3]).toBe("10,00");
  });

  it("1 resposta no singular", () => {
    const p = parametrosWhatsapp({ ...base, total: 1 });
    expect(p.ok && p.valores[4]).toBe("1 resposta");
  });

  it("título com quebra de linha vira uma linha só (a Meta recusa \\n em parâmetro)", () => {
    const p = parametrosWhatsapp({ ...base, titulo: "Biosseguridade\nna Avicultura:\t  Estratégia" });
    expect(p.ok && p.valores[1]).toBe("Biosseguridade na Avicultura: Estratégia");
  });

  it("sem título NÃO manda vazio — devolve o que falta", () => {
    expect(parametrosWhatsapp({ ...base, titulo: "  " })).toEqual({ ok: false, faltando: "título da aula" });
  });

  it("sem data NÃO manda vazio", () => {
    expect(parametrosWhatsapp({ ...base, data: null })).toEqual({ ok: false, faltando: "data da aula" });
  });

  it("professor sem nome não trava: cumprimenta genérico", () => {
    const p = parametrosWhatsapp({ ...base, professorNome: null });
    expect(p.ok && p.valores[0]).toBe("professor(a)");
  });

  it("componentes no formato do crm-whatsapp-send", () => {
    expect(componentesDoCorpo(["a", "b"])).toEqual([
      { type: "body", parameters: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
    ]);
  });

  it("paramWa corta 4+ espaços", () => {
    expect(paramWa("a    b")).toBe("a b");
  });
});

describe("nomeDoPdf — o que o professor vê no card do WhatsApp", () => {
  it("usa o nome pedido pela tela", () => {
    expect(nomeDoPdf("Avaliação da aula - Genética - 15-09-2026.pdf", "x", "2026-09-15")).toBe(
      "Avaliação da aula - Genética - 15-09-2026.pdf",
    );
  });

  it("sem nome pedido, monta pelo título e data", () => {
    expect(nomeDoPdf(null, "Genética", "2026-09-15")).toBe("Avaliação da aula - Genética - 15-09-2026.pdf");
  });

  it("barra no título não vira pasta", () => {
    expect(nomeDoPdf(null, "Corte/Postura", "2026-09-15")).not.toContain("/");
  });

  it("sempre termina em .pdf, uma vez só", () => {
    expect(nomeDoPdf("relatorio.PDF", null, null)).toBe("relatorio.pdf");
  });
});

describe("decodificarPdf — só PDF de verdade vai para o bucket público", () => {
  const pdfB64 = btoa("%PDF-1.4\n%fake\n");

  it("aceita PDF puro e com prefixo data:", () => {
    expect(decodificarPdf(pdfB64).ok).toBe(true);
    expect(decodificarPdf(`data:application/pdf;base64,${pdfB64}`).ok).toBe(true);
  });

  it("recusa o que não é PDF", () => {
    expect(decodificarPdf(btoa("<html>oi</html>"))).toEqual({ ok: false, erro: "o arquivo não é um PDF" });
  });

  it("recusa base64 quebrado e vazio", () => {
    expect(decodificarPdf("%%%").ok).toBe(false);
    expect(decodificarPdf("").ok).toBe(false);
    expect(decodificarPdf(undefined).ok).toBe(false);
  });

  it("recusa acima do teto", () => {
    const grande = "A".repeat(Math.ceil((PDF_MAX_BYTES + 1024) / 3) * 4);
    expect(decodificarPdf(grande)).toEqual({ ok: false, erro: "PDF grande demais" });
  });
});

describe("erroWhatsappAmigavel — a equipe lê o motivo, não o código", () => {
  it("modelo ainda em análise", () => {
    expect(erroWhatsappAmigavel({ error: "x", meta_code: 132001 }, 422)).toMatch(/ainda não foi aprovado/);
  });

  it("número impossível na ficha", () => {
    expect(erroWhatsappAmigavel({ error: "telefone_impossivel", detalhe: "..." }, 422)).toMatch(/não é um número válido/);
  });

  it("erro desconhecido cai no texto da edge", () => {
    expect(erroWhatsappAmigavel({ error: "Conta WhatsApp CRM não encontrada" }, 500)).toBe("Conta WhatsApp CRM não encontrada");
  });

  it("sem corpo nenhum diz o status", () => {
    expect(erroWhatsappAmigavel(null, 504)).toBe("falha no envio (HTTP 504)");
  });
});

describe("traduzirStatusModelo — por que o WhatsApp não pode sair ainda", () => {
  it("em análise, pausado, inexistente", () => {
    expect(traduzirStatusModelo("PENDING")).toBe("em análise");
    expect(traduzirStatusModelo("PAUSED")).toBe("pausado");
    expect(traduzirStatusModelo("INEXISTENTE")).toBe("inexistente nesta conta");
  });

  it("status desconhecido não some: aparece cru, em minúsculas", () => {
    expect(traduzirStatusModelo("LIMIT_EXCEEDED")).toBe("limit_exceeded");
  });

  it("132000 é variável que não bate, não modelo inexistente (132001)", () => {
    expect(erroWhatsappAmigavel({ meta_code: 132000 }, 422)).toMatch(/variáveis/);
  });
});
