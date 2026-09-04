import { afterEach, describe, expect, it, vi } from "vitest";
import { comContinuidadeWebchat } from "./continuidadeWebchat";

afterEach(() => vi.useRealTimers());

describe("consciência de canal na continuidade do webchat", () => {
  it("exige confirmação individual de material sem presumir qualificação", () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-09-04T20:00:00Z"));
    const prompt = comContinuidadeWebchat("Prompt base", "2026-09-04T19:00:00Z");
    expect(prompt).toContain("não comprova envio de cronograma ou valor");
    expect(prompt).toContain("uma mensagem de continuidade pode ter sido o único envio");
    expect(prompt).toContain("valide os dados ainda ausentes");
    expect(prompt).not.toContain("estão NESTA conversa, logo acima");
  });

  it.each([null, "inválido", "2026-09-05T00:00:00Z", "2026-08-27T00:00:00Z"])(
    "não ativa continuidade com data ausente, inválida ou fora da janela: %s", (data) => {
      vi.useFakeTimers().setSystemTime(new Date("2026-09-04T20:00:00Z"));
      expect(comContinuidadeWebchat("Prompt base", data)).toBe("Prompt base");
    },
  );
});
