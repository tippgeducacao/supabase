import { describe, expect, it } from "vitest";
import { marcarLinksDoEmailNoHtml, utmNomeDoEnvio } from "./emailBuilder/links.ts";
import { marcarComponentsDoModelo, marcarLinksNoTexto, utmDoWhatsapp } from "./utmEnvio.ts";

describe("UTM dos links que o sistema manda sozinho (padrão v4, 17/11/2026)", () => {
  it("nome do modelo vira campanha sem número; a data do fim fica", () => {
    expect(utmNomeDoEnvio("Seletivo Professores 2026 | Pré-inscrição recebida")).toBe("seletivo-professores-pre-inscricao-recebida");
    expect(utmNomeDoEnvio("boas_vindas_escola_v2")).toBe("boas-vindas-escola-v");
    expect(utmNomeDoEnvio("Natal Dez 2026")).toBe("natal-dez-2026");
    expect(utmNomeDoEnvio(null)).toBe("");
  });

  it("WhatsApp: marca link nosso sem UTM, deixa a pontuação de fora e não mexe no que já veio marcado", () => {
    const utm = utmDoWhatsapp("lembrete_aula_sanidade");
    expect(marcarLinksNoTexto("Inscreva-se: https://site.ppgvet.com.br/pos-sa. Até já!", utm))
      .toBe("Inscreva-se: https://site.ppgvet.com.br/pos-sa?utm_source=whatsapp&utm_campaign=lembrete-aula-sanidade&utm_medium=social. Até já!");
    expect(marcarLinksNoTexto("*https://escoladeespecializacao.ppgvet.com.br/ee-sa*", utmDoWhatsapp(null)))
      .toBe("*https://escoladeespecializacao.ppgvet.com.br/ee-sa?utm_source=whatsapp&utm_medium=social*");
    const marcado = "https://site.ppgvet.com.br/?utm_source=whatsapp-aves&utm_medium=social";
    expect(marcarLinksNoTexto(`Grupo: ${marcado}`, utm)).toBe(`Grupo: ${marcado}`);
    expect(marcarLinksNoTexto("https://youtube.com/watch?v=1 e https://ppgvet.com.br.golpe.com/x", utm))
      .toBe("https://youtube.com/watch?v=1 e https://ppgvet.com.br.golpe.com/x");
  });

  it("modelo da Meta: marca só os parâmetros de texto do corpo", () => {
    const comps = [
      { type: "body", parameters: [{ type: "text", text: "https://site.ppgvet.com.br/curso-cc" }, { type: "text", text: "Ana" }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "abc" }] },
    ];
    const saida = marcarComponentsDoModelo(comps, utmDoWhatsapp("convite"));
    expect(saida[0].parameters[0].text).toBe("https://site.ppgvet.com.br/curso-cc?utm_source=whatsapp&utm_campaign=convite&utm_medium=social");
    expect(saida[0].parameters[1].text).toBe("Ana");
    expect(saida[1]).toEqual(comps[1]);
  });

  it("e-mail: todo href nosso no HTML ganha email/email/<modelo>, com & escapado no atributo", () => {
    const html = '<a href="https://site.ppgvet.com.br/x?a=1&amp;b=2">x</a> <a href="mailto:a@b.c">m</a> <a href="https://youtube.com">y</a>';
    expect(marcarLinksDoEmailNoHtml(html, "Boas-vindas 2026"))
      .toBe('<a href="https://site.ppgvet.com.br/x?a=1&amp;b=2&amp;utm_source=email&amp;utm_campaign=boas-vindas&amp;utm_medium=email">x</a> <a href="mailto:a@b.c">m</a> <a href="https://youtube.com">y</a>');
  });
});
