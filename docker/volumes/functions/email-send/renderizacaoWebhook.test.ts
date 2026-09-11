import { describe, expect, it } from "vitest";
import { emailEhMarketing, renderizarEmailWebhook } from "./renderizacaoWebhook.ts";

const modelo = {
  assunto: "Olá, {{nome}}", corpoHtml: '<p>Olá, {{nome}}</p><a href="{{link}}">Curso</a>',
  corpoTexto: "Olá, {{nome}}", variaveis: { nome: "Ana & João", link: "https://ppg.example/curso" },
};

describe("renderização de e-mail do webhook", () => {
  it("preserva acentos e texto simples, escapando somente o HTML", () => {
    const resultado = renderizarEmailWebhook(modelo);
    expect(resultado.assunto).toBe("Olá, Ana & João");
    expect(resultado.corpoTexto).toBe("Olá, Ana & João");
    expect(resultado.corpoHtml).toContain("Ana &amp; João");
  });

  it("impede que o conteúdo de um formulário crie tags ou atributos HTML", () => {
    const resultado = renderizarEmailWebhook({ ...modelo, variaveis: {
      nome: '<img src=x onerror="alert(1)">', link: 'https://ppg.example/" onclick="alert(1)',
    } });
    expect(resultado.corpoHtml).toContain("&lt;img");
    expect(resultado.corpoHtml).not.toContain('<img');
    expect(resultado.corpoHtml).toContain("&quot; onclick=&quot;");
  });

  it.each(["", " ", "{{outra}}", "{webhook=ausente}", "Ana\r\nBcc: outro@example.com"])(
    "recusa variável vazia, órfã ou quebra de cabeçalho: %j", (nome) => {
      expect(() => renderizarEmailWebhook({ ...modelo, variaveis: { ...modelo.variaveis, nome } })).toThrow();
    },
  );

  it("não usa propriedades herdadas como variáveis", () => {
    expect(() => renderizarEmailWebhook({ ...modelo, assunto: "{{toString}}" })).toThrow();
  });

  it.each([
    '<a href={{link}}>Curso</a>', '<div onclick="{{nome}}">Aviso</div>', '<{{nome}}>Aviso</{{nome}}>',
    '<img alt="1 > 0" onerror="{{nome}}" src="x">', '<script>{{nome}}</script>',
    '<style>body {background:{{nome}}}</style>', '<a href="java&#x73;cript:{{nome}}">Curso</a>',
    '<a href="javascript&colon;{{nome}}">Curso</a>',
  ])(
    "recusa variável construindo marcação executável: %s", (corpoHtml) => {
      expect(() => renderizarEmailWebhook({ ...modelo, corpoHtml })).toThrow();
    },
  );

  it("aceita atributos textuais com sinal de maior e URL escapada sem dupla decodificação", () => {
    expect(renderizarEmailWebhook({ ...modelo, corpoHtml: '<img alt="1 > 0 {{nome}}" src="https://ppg.example/logo.png">' }).corpoHtml)
      .toContain('alt="1 > 0 Ana &amp; João"');
  });

  it("reserva o link de descadastro para o servidor, sem aceitar sobrescrita", () => {
    const resultado = renderizarEmailWebhook({ ...modelo,
      corpoHtml: '<a href="{{ descadastro_url }}">Descadastrar</a>', corpoTexto: "{{descadastro_url}}",
      variaveis: { descadastro_url: "https://outro.example" }, assunto: "Aviso",
    });
    expect(resultado.corpoHtml).toContain('href="{{descadastro_url}}"');
    expect(resultado.corpoTexto).toBe("{{descadastro_url}}");
    expect(() => renderizarEmailWebhook({ ...modelo, assunto: "{{descadastro_url}}" })).toThrow();
  });

  it.each(["javascript:alert(1)", "java\nscript:alert(1)", "data:text/html,teste", "file:///tmp/arquivo"])(
    "recusa protocolo de URL perigoso: %s", (link) => {
      expect(() => renderizarEmailWebhook({ ...modelo, variaveis: { ...modelo.variaveis, link } })).toThrow();
    },
  );

  it("distingue marketing de transacional sem mudar os contextos anteriores", () => {
    expect(emailEhMarketing("webhook", "marketing")).toBe(true);
    expect(emailEhMarketing("webhook", "transacional")).toBe(false);
    expect(emailEhMarketing("campanha", null)).toBe(true);
    expect(emailEhMarketing("teste", "marketing")).toBe(false);
    expect(emailEhMarketing(undefined, "marketing")).toBe(false);
  });
});
