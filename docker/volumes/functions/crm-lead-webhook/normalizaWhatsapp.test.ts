import { describe, expect, it } from "vitest";
import { normalizeWhatsapp } from "./normalizaWhatsapp.ts";
import { classificaTelefone, digitosParaEnvio } from "../_shared/telefone.ts";

describe("normalizeWhatsapp (intake do webhook)", () => {
  it.each([
    ["+351935624417", "351935624417"],      // Portugal — o caso de 17/10/2026
    ["+351 935 624 417", "351935624417"],
    ["+54 9 11 2345-6789", "5491123456789"], // Argentina
    ["+1 (305) 555-0123", "13055550123"],    // EUA
  ])("preserva DDI estrangeiro explícito: %s", (entrada, esperado) => {
    const w = normalizeWhatsapp(entrada);
    expect(w).toBe(esperado);
    expect(classificaTelefone(w)).toBe("internacional");
    expect(digitosParaEnvio(w)).toBe(esperado);
  });

  it.each([
    ["(16) 99772-2712", "5516997722712"],
    ["16997722712", "5516997722712"],
    ["+55 16 99772-2712", "5516997722712"],
    ["5516997722712", "5516997722712"],
    [16997722712, "5516997722712"],
  ])("continua lendo número sem DDI estrangeiro como BR: %s", (entrada, esperado) => {
    expect(normalizeWhatsapp(entrada)).toBe(esperado);
  });

  it("número sem '+' não vira estrangeiro (não adivinha DDI)", () => {
    expect(normalizeWhatsapp("351935624417")).toBe("55351935624417");
  });

  it.each([null, undefined, "", "abc", "1234567", {}])("descarta o que não é telefone: %j", entrada => {
    expect(normalizeWhatsapp(entrada)).toBeNull();
  });
});
