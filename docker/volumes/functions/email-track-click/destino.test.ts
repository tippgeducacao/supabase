import { describe, expect, it } from "vitest";
import { candidatosDeDestino } from "./destino.ts";

describe("candidatosDeDestino (resgate dos links sem aspa, 22–28/09/2026)", () => {
  it("destino limpo: um candidato só", () => {
    expect(candidatosDeDestino("https://ppgvet.com.br/curso?a=1")).toEqual(["https://ppgvet.com.br/curso?a=1"]);
  });

  it("href que engoliu o atributo seguinte: tenta também o trecho antes do espaço", () => {
    expect(candidatosDeDestino("https://www.youtube.com/watch?v=_QFeoNefTzM target=")).toEqual([
      "https://www.youtube.com/watch?v=_QFeoNefTzM target=",
      "https://www.youtube.com/watch?v=_QFeoNefTzM",
    ]);
    expect(candidatosDeDestino("https://ppgvet.com.br/ style=")).toEqual(["https://ppgvet.com.br/ style=", "https://ppgvet.com.br/"]);
  });

  it("href que era o último atributo e engoliu o texto do link", () => {
    expect(candidatosDeDestino("https://ppgvet.com.br/x>Clique aqui</a><p>")[1]).toBe("https://ppgvet.com.br/x");
  });
});
