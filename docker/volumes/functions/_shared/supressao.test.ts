/**
 * Checagem de supressão — fecha o critério de aceite 3: enviar para um endereço
 * suprimido é bloqueado.
 */
import { describe, expect, it } from "vitest";
import { FakeSupabase } from "../../../tests/helpers/fakeSupabase.ts";
import { buscarSupressao, buscarSupressoes, normalizarEmail, supressaoSeAplica } from "./supressao.ts";

const banco = (emails: Array<{ email: string; motivo: string }> = []) =>
  new FakeSupabase({ email_supressoes: { linhas: emails, unicas: ["email"] } });

describe("a quem a supressão se aplica", () => {
  it("vale para todo disparo por API (resend/ses)", () => {
    expect(supressaoSeAplica("resend", false)).toBe(true);
    expect(supressaoSeAplica("ses", false)).toBe(true);
    expect(supressaoSeAplica("smtp", false)).toBe(true);
  });

  it("vale para campanha, mesmo saindo pelo Gmail", () => {
    expect(supressaoSeAplica("gmail", true)).toBe(true);
  });

  it("NÃO vale para o 1:1 do Gmail — travaria o funil de TCC", () => {
    // A Secretaria precisa poder reenviar para um aluno; a supressão é regra de
    // disparo em massa, não de correspondência individual.
    expect(supressaoSeAplica("gmail", false)).toBe(false);
  });
});

describe("critério 3 — endereço suprimido é bloqueado", () => {
  it("encontra o endereço e devolve o motivo", async () => {
    const db = banco([{ email: "bounce@exemplo.com", motivo: "bounce" }]);
    const r = await buscarSupressao(db, "bounce@exemplo.com");
    expect(r).toMatchObject({ motivo: "bounce" });
  });

  it("encontra mesmo com caixa e espaços diferentes", async () => {
    const db = banco([{ email: "bounce@exemplo.com", motivo: "spam" }]);
    expect(await buscarSupressao(db, "  Bounce@Exemplo.COM ")).toMatchObject({ motivo: "spam" });
  });

  it("endereço limpo não é bloqueado", async () => {
    const db = banco([{ email: "bounce@exemplo.com", motivo: "bounce" }]);
    expect(await buscarSupressao(db, "ok@exemplo.com")).toBeNull();
  });

  it("underscore no e-mail NÃO vira coringa", async () => {
    // Com ILIKE, "joao_silva@x.com" casaria com "joaoXsilva@x.com" e bloquearia
    // alguém que nunca foi suprimido. Por isso a busca é por igualdade.
    const db = banco([{ email: "joao_silva@exemplo.com", motivo: "bounce" }]);
    expect(await buscarSupressao(db, "joaoXsilva@exemplo.com")).toBeNull();
    expect(await buscarSupressao(db, "joao_silva@exemplo.com")).not.toBeNull();
  });
});

describe("checagem em lote", () => {
  it("devolve só os bloqueados, normalizados", async () => {
    const db = banco([
      { email: "a@x.com", motivo: "bounce" },
      { email: "c@x.com", motivo: "descadastro" },
    ]);

    const bloqueados = await buscarSupressoes(db, ["A@X.com", "b@x.com", "c@x.com"]);

    expect(bloqueados.has("a@x.com")).toBe(true);
    expect(bloqueados.has("c@x.com")).toBe(true);
    expect(bloqueados.has("b@x.com")).toBe(false);
    expect(bloqueados.size).toBe(2);
  });

  it("lista vazia não consulta o banco", async () => {
    const db = banco([{ email: "a@x.com", motivo: "bounce" }]);
    expect((await buscarSupressoes(db, [])).size).toBe(0);
  });

  it("deduplica os endereços antes de consultar", async () => {
    const db = banco([{ email: "a@x.com", motivo: "bounce" }]);
    const r = await buscarSupressoes(db, ["a@x.com", "A@X.COM", "a@x.com"]);
    expect(r.size).toBe(1);
  });
});

describe("normalização", () => {
  it("bate com o que o trigger do banco faz", () => {
    expect(normalizarEmail("  Aluno@Exemplo.COM ")).toBe("aluno@exemplo.com");
    expect(normalizarEmail("")).toBe("");
  });
});
