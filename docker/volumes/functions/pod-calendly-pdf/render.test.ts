import { describe, expect, it } from "vitest";
import * as jspdfMod from "jspdf";
import {
  decodificarEntidades,
  htmlParaTexto,
  montarPdfEmail,
  nomeArquivoPdf,
  paraComoTexto,
  paraFonteDoPdf,
  rotuloDaAcao,
  type EmailParaPdf,
} from "./render.ts";

// jspdf no Node é CJS (dist/jspdf.node.min.js): o nome pode vir no namespace ou no default.
// deno-lint-ignore no-explicit-any
const ns = jspdfMod as any;
const jsPDF = ns.jsPDF ?? ns.default?.jsPDF ?? ns.default;

// Forma real do aviso do Calendly (21/10–09/11/2026): tabela com <p><strong>Rótulo:</strong><br> valor</p>,
// style no corpo, logo, botão com link de cancelar/remarcar (com token) e comentário HTML.
const HTML_CALENDLY = `<body>
<meta name="viewport" content="width=device-width">
<title>Calendly</title>
<style>.x{color:red} p{margin:0}</style>
<div class="main-wrapper" style="padding:20px 0">
<table class="body-wrap"><tr><td style="text-align:center"><p><img alt="Calendly" src="http://assets.calendly.com/logo.png" width="60"></p></td></tr></table>
<!-- BODY -->
<table class="body-wrap"><tr><td>
<p style="margin-bottom:12px"> Olá Fulana Host, </p>
<p> Foi agendado um novo evento. </p>
<p><strong style="font-size:14px"> Tipo de evento: </strong><br> Pet Food Podcast </p>
<p><strong> Convidado: </strong><br> Dra. Ana Exemplo Souza </p>
<p><strong> E-mail do convidado: </strong><br> ana.souza@exemplo.com.br </p>
<p><strong> Data/hora do evento: </strong><br> 15:00 - Sexta-feira, 4 de Dezembro de 2026 (Horário de Brasília) </p>
<p><strong> Local: </strong><br> https://zencastr.com/exemplo-sala </p>
<p>Perguntas &amp; respostas: Área de expertise &mdash; Nutrição de c&atilde;es&nbsp;e gatos</p>
<p><a href="https://calendly.com/cancellations/TOKEN-SECRETO-123/new">Cancelar evento</a></p>
</td></tr></table>
</div></body>`;

const email: EmailParaPdf = {
  assunto: "Novo evento: Ana Exemplo Souza - 15:00 Sex, 4 de Dez de 2026 - Pet Food Podcast",
  de_nome: "Calendly",
  de_email: "notifications@calendly.com",
  para: [{ name: "", email: "calendly+host@exemplo.com.br" }],
  recebido_em: "2026-11-06T17:55:09Z",
  acao: "novo",
  convidado_nome: "Dra. Ana Exemplo Souza",
  body_html: HTML_CALENDLY,
};

describe("htmlParaTexto", () => {
  const t = htmlParaTexto(HTML_CALENDLY);

  it("quebra por bloco e por <br>: o rótulo fica numa linha e o valor na seguinte", () => {
    expect(t).toContain("Tipo de evento:\nPet Food Podcast");
    expect(t).toContain("Convidado:\nDra. Ana Exemplo Souza");
    expect(t).toContain("E-mail do convidado:\nana.souza@exemplo.com.br");
    expect(t).toContain("Data/hora do evento:\n15:00 - Sexta-feira, 4 de Dezembro de 2026 (Horário de Brasília)");
  });

  it("descarta style, título, comentário e imagem", () => {
    expect(t).not.toContain("color:red");
    expect(t).not.toContain("Calendly\n"); // o <title>
    expect(t).not.toContain("BODY");
    expect(t).not.toContain("logo.png");
  });

  it("NUNCA deixa passar o endereço de um link (o de cancelar tem token do evento)", () => {
    expect(t).toContain("Cancelar evento");
    expect(t).not.toContain("TOKEN-SECRETO");
    expect(t).not.toContain("calendly.com/cancellations");
  });

  it("mantém o endereço que é TEXTO visível (o Local da sala)", () => {
    expect(t).toContain("https://zencastr.com/exemplo-sala");
  });

  it("decodifica entidades e não deixa espaço duplo nem mais de uma linha em branco seguida", () => {
    expect(t).toContain("Perguntas & respostas: Área de expertise — Nutrição de cães e gatos");
    expect(t).not.toMatch(/ {2,}/);
    expect(t).not.toMatch(/\n{3,}/);
  });

  it("quebra de linha do código-fonte (\\r\\n entre as tags, como o Calendly manda) não vira linha em branco no texto", () => {
    const fonte = "<p>\r\n  <strong>Tipo de evento:</strong>\r\n  <br>\r\n  Pet Food Podcast\r\n</p>\r\n<p>\r\n  <strong>Convidado:</strong>\r\n  <br>\r\n  Fulana\r\n</p>\r\n";
    expect(htmlParaTexto(fonte)).toBe("Tipo de evento:\nPet Food Podcast\n\nConvidado:\nFulana");
  });

  it("entrada vazia ou nula vira texto vazio", () => {
    expect(htmlParaTexto(null)).toBe("");
    expect(htmlParaTexto("")).toBe("");
    expect(htmlParaTexto("<p> </p>")).toBe("");
  });

  it("não engole o resto do e-mail quando há dois blocos <style>", () => {
    expect(htmlParaTexto("<style>a{}</style><p>um</p><style>b{}</style><p>dois</p>")).toBe("um\n\ndois");
  });
});

describe("decodificarEntidades", () => {
  it("nomeadas, decimais e hexadecimais; desconhecida fica como está; número inválido vira espaço", () => {
    // cada número inválido vira UM espaço; os separadores originais continuam: 1 + 1 (&#0;) + 1 + 1 (&#xD800;)
    expect(decodificarEntidades("a&amp;b &#233; &#xE9; &naoexiste; &#0; &#xD800;")).toBe("a&b é é &naoexiste;    ");
  });
});

describe("paraFonteDoPdf", () => {
  it("troca aspas curvas, travessões e reticências; tira os invisíveis; mantém acentos do Latin-1", () => {
    expect(paraFonteDoPdf("“olá” – ‘tudo’ bem… ação​ ç ü")).toBe("\"olá\" - 'tudo' bem... ação ç ü");
  });

  it("emoji some (com seletor de variação e tom de pele); o que a fonte não desenha e não é emoji vira ? — um por caractere", () => {
    expect(paraFonteDoPdf("pets! 🎙️ ok 👩🏽‍⚕️ fim")).toBe("pets!  ok  fim");
    expect(paraFonteDoPdf("日本")).toBe("??");
  });
});

describe("paraComoTexto", () => {
  it("lista de objetos, de textos e texto solto", () => {
    expect(paraComoTexto([{ name: "Fulana", email: "f@x.com" }, { name: "", email: "g@x.com" }])).toBe("Fulana <f@x.com>, g@x.com");
    expect(paraComoTexto(["a@x.com", "b@x.com"])).toBe("a@x.com, b@x.com");
    expect(paraComoTexto("c@x.com")).toBe("c@x.com");
    expect(paraComoTexto(null)).toBe("");
  });
});

describe("rotuloDaAcao e nomeArquivoPdf", () => {
  it("rótulos conhecidos e o genérico", () => {
    expect(rotuloDaAcao("novo")).toBe("Novo evento");
    expect(rotuloDaAcao("atualizado")).toBe("Evento atualizado");
    expect(rotuloDaAcao("cancelado")).toBe("Evento cancelado");
    expect(rotuloDaAcao("xyz")).toBe("Aviso do Calendly");
    expect(rotuloDaAcao(null)).toBe("Aviso do Calendly");
  });

  it("o nome traz a ação, o convidado e o dia do e-mail em Brasília (6/11 às 14:55)", () => {
    expect(nomeArquivoPdf(email)).toBe("E-mail de agendamento (Calendly) — Novo evento — Dra. Ana Exemplo Souza — 06-11-2026.pdf");
  });

  it("tira o que arquivo não aceita e não quebra sem convidado", () => {
    const n = nomeArquivoPdf({ acao: "atualizado", convidado_nome: 'A/B: "C"?', recebido_em: null });
    expect(n).toBe("E-mail de agendamento (Calendly) — Evento atualizado — A B C.pdf");
    expect(n).not.toMatch(/[\\/:*?"<>|]/);
  });
});

describe("montarPdfEmail", () => {
  const bytes = (e: EmailParaPdf) => montarPdfEmail({ jsPDF }, e);
  const texto = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

  it("devolve um PDF de verdade (cabeçalho %PDF, termina em %%EOF)", () => {
    const b = bytes(email);
    expect(b).toBeInstanceOf(Uint8Array);
    expect(texto(b.slice(0, 5))).toBe("%PDF-");
    expect(texto(b.slice(-8))).toContain("%%EOF");
    expect(b.byteLength).toBeGreaterThan(1500);
  });

  it("e-mail curto cabe em UMA página", () => {
    expect(texto(bytes(email))).toMatch(/\/Count 1\b/);
  });

  it("e-mail comprido pagina (não corta o texto)", () => {
    const longo = `<p>${"Linha de conteúdo do e-mail com bastante texto para ocupar a página. ".repeat(4)}</p>`.repeat(60);
    expect(texto(bytes({ ...email, body_html: longo }))).toMatch(/\/Count ([2-9]|\d{2})\b/);
  });

  it("corpo vazio, campos nulos e caracteres que a fonte não desenha não derrubam a geração", () => {
    expect(() => bytes({ ...email, body_html: null })).not.toThrow();
    expect(() => bytes({ assunto: null, de_nome: null, de_email: null, para: null, recebido_em: null, acao: null, convidado_nome: null, body_html: "<p>🎙️ 日本 “ok”</p>" })).not.toThrow();
  });

  it("palavra gigante sem espaço (um link colado) quebra em vez de estourar a margem ou travar", () => {
    const b = bytes({ ...email, body_html: `<p>${"x".repeat(900)}</p>` });
    expect(texto(b.slice(0, 5))).toBe("%PDF-");
  });
});
