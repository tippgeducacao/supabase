import { describe, expect, it } from "vitest";
import { decidirAvanco, etapasDeOrigem } from "./avancarCard.ts";

const PRE = "828ab123-35fc-4bd6-accb-2d39455d0744";
const EDITAL = "0f8044a0-5d1e-497d-b9cf-4515b6b93b5b";

describe("etapasDeOrigem", () => {
  it("sem a opção (todas as webhooks antigas) = desligada", () => {
    expect(etapasDeOrigem({})).toEqual([]);
    expect(etapasDeOrigem(undefined)).toEqual([]);
    expect(etapasDeOrigem({ avancarDe: "não-é-lista" })).toEqual([]);
  });
  it("guarda só uuid, sem repetir", () => {
    expect(etapasDeOrigem({ avancarDe: [PRE, PRE, "x", 3, null, EDITAL] })).toEqual([PRE, EDITAL]);
  });
});

describe("decidirAvanco — só anda para a frente", () => {
  it("pré-inscrição (0) → inscrição do edital (1) move", () => {
    expect(decidirAvanco(0, 1)).toBe("mover");
  });
  it("já na etapa da ação: recadastro, sem mover", () => {
    expect(decidirAvanco(1, 1)).toBe("recadastro");
  });
  it("card mais à frente nunca volta (pré-inscrição repetida depois do edital)", () => {
    expect(decidirAvanco(5, 0)).toBe("recadastro");
  });
  it("ordem desconhecida não move", () => {
    expect(decidirAvanco(null, 1)).toBe("recadastro");
    expect(decidirAvanco(0, undefined)).toBe("recadastro");
  });
});
