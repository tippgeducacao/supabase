import { describe, expect, it } from "vitest";
import { gerarSenhaForte, problemaDaSenha } from "./senhaForte";

describe("regra de senha forte (29/10/2026)", () => {
  it("aceita 10+ com maiúscula, minúscula e número", () => {
    expect(problemaDaSenha("Ppgvet2026a")).toBeNull();
  });
  it("recusa curta, sem maiúscula, sem minúscula, sem número", () => {
    expect(problemaDaSenha("Abc12345")).toMatch(/10 caracteres/);
    expect(problemaDaSenha("abcdefgh12")).toMatch(/maiúscula/);
    expect(problemaDaSenha("ABCDEFGH12")).toMatch(/minúscula/);
    expect(problemaDaSenha("Abcdefghij")).toMatch(/número/);
    expect(problemaDaSenha("")).not.toBeNull();
    expect(problemaDaSenha(undefined)).not.toBeNull();
  });
  it("o gerador sempre cumpre a regra", () => {
    for (let i = 0; i < 200; i++) expect(problemaDaSenha(gerarSenhaForte())).toBeNull();
  });
});
