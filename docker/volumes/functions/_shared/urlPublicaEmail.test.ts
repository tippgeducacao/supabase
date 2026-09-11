import { describe, expect, it } from "vitest";
import { urlPublicaEmail } from "./urlPublicaEmail.ts";

describe("URL pública exclusiva de e-mail", () => {
  it("prioriza o domínio de e-mail e remove barras finais sem alterar o ambiente Supabase", () => {
    const env = {
      EMAIL_PUBLIC_URL: " https://email.exemplo.com/// ",
      SUPABASE_PUBLIC_URL: "https://api.exemplo.com",
      SUPABASE_URL: "http://kong:8000",
    };
    expect(urlPublicaEmail((chave) => env[chave])).toBe("https://email.exemplo.com");
    expect(env.SUPABASE_URL).toBe("http://kong:8000");
    expect(env.SUPABASE_PUBLIC_URL).toBe("https://api.exemplo.com");
  });

  it.each([
    [{ SUPABASE_PUBLIC_URL: "https://api.exemplo.com", PUBLIC_SUPABASE_URL: "https://alternativa.exemplo.com" }, "https://api.exemplo.com"],
    [{ EMAIL_PUBLIC_URL: " ", PUBLIC_SUPABASE_URL: "https://alternativa.exemplo.com/" }, "https://alternativa.exemplo.com"],
    [{ SUPABASE_URL: "http://kong:8000" }, "http://kong:8000"],
  ])("mantém os fallbacks existentes quando não há domínio dedicado: %j", (env, esperado) => {
    expect(urlPublicaEmail((chave) => env[chave])).toBe(esperado);
  });

  it("identifica ambiente sem URL em vez de produzir um link incompleto", () => {
    expect(() => urlPublicaEmail(() => undefined)).toThrow("URL pública de e-mail não configurada.");
  });
});
