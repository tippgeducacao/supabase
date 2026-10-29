import { expect, it } from "vitest";
import { nomeComPrefixo } from "./prefixoNome";

it("identifica o Fórum sem duplicar o prefixo nos reenvios", () => {
  expect(nomeComPrefixo("Maria Souza", "FÓRUM")).toBe("FÓRUM Maria Souza");
  expect(nomeComPrefixo("FÓRUM Maria Souza", "FÓRUM")).toBe("FÓRUM Maria Souza");
  expect(nomeComPrefixo("fórum Maria Souza", "FÓRUM")).toBe("fórum Maria Souza");
  expect(nomeComPrefixo("Maria Souza", undefined)).toBe("Maria Souza");
  expect(nomeComPrefixo(null, "FÓRUM")).toBeNull();
});
