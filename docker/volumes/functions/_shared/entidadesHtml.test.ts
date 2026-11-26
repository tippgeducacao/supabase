import { describe, expect, it } from "vitest";
import { decodificarEntidadesHtml } from "./entidadesHtml";

describe("decodificarEntidadesHtml", () => {
  it("título do Instagram que chegava cru ao cartão", () => {
    expect(decodificarEntidadesHtml("Hendel Favarin on Instagram: &quot;Eu j&#xe1; passei&#x2026;&quot;"))
      .toBe('Hendel Favarin on Instagram: "Eu já passei…"');
  });

  it("nomeadas, decimais e hexadecimais", () => {
    expect(decodificarEntidadesHtml("P&oacute;s &amp; Gest&atilde;o &#8212; &#39;ok&#39; &#X41;")).toBe("Pós & Gestão — 'ok' A");
  });

  it("uma passada só, como o navegador", () => {
    expect(decodificarEntidadesHtml("&amp;quot;")).toBe("&quot;");
  });

  it("deixa como está o que não é entidade válida", () => {
    for (const s of ["a &naoexiste; b", "&#0;", "&#xD800;", "&#1114112;", "R&D", "a & b", "&#;"]) {
      expect(decodificarEntidadesHtml(s), s).toBe(s);
    }
  });

  it("vazio e nulo", () => {
    expect(decodificarEntidadesHtml("")).toBe("");
    expect(decodificarEntidadesHtml(null)).toBe("");
    expect(decodificarEntidadesHtml(undefined)).toBe("");
  });

  it("URL de imagem com &amp;", () => {
    expect(decodificarEntidadesHtml("https://x.cdn/a.jpg?a=1&amp;b=2")).toBe("https://x.cdn/a.jpg?a=1&b=2");
  });
});
