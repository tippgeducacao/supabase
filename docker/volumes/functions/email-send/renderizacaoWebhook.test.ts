import { describe, expect, it } from "vitest";
import { contextoDeAutomacao, emailEhMarketing, renderizarEmailWebhook } from "./renderizacaoWebhook.ts";

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

  it("entende {{x | fallback:\"…\"}} do editor — com valor usa o valor; sem valor, o fallback (02/10/2026)", () => {
    const comFallback = {
      assunto: 'Seu acesso, {{contato.primeiro_nome | fallback:"Olá"}}',
      corpoHtml: '<p>{{contato.primeiro_nome | fallback:&quot;Olá&quot;}}, tudo bem?</p><p>{{contato.primeiro_nome | fallback:"Oi & cia"}}</p>',
      corpoTexto: '{{contato.primeiro_nome | fallback:"Olá"}}, tudo bem?',
    };
    const comNome = renderizarEmailWebhook({ ...comFallback, variaveis: { "contato.primeiro_nome": "Maria" } });
    expect(comNome.assunto).toBe("Seu acesso, Maria");
    expect(comNome.corpoHtml).toBe("<p>Maria, tudo bem?</p><p>Maria</p>");
    const semNome = renderizarEmailWebhook({ ...comFallback, variaveis: { "contato.primeiro_nome": "" } });
    expect(semNome.assunto).toBe("Seu acesso, Olá");
    expect(semNome.corpoHtml).toBe("<p>Olá, tudo bem?</p><p>Oi &amp; cia</p>");
    expect(semNome.corpoTexto).toBe("Olá, tudo bem?");
    // Outros filtros continuam desconhecidos: o modelo segue barrado, como antes.
    expect(() => renderizarEmailWebhook({ ...comFallback, corpoHtml: "<p>{{contato.nome | maiusculo}}</p>", variaveis: { "contato.nome": "Ana" } })).toThrow();
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

  it("fluxo de automação recebe o mesmo tratamento do webhook (28/09/2026)", () => {
    expect(contextoDeAutomacao("fluxo")).toBe(true);
    expect(contextoDeAutomacao("webhook")).toBe(true);
    expect(contextoDeAutomacao("automacao_crm")).toBe(true);
    expect(contextoDeAutomacao("automacao_sac")).toBe(true);
    expect(contextoDeAutomacao("campanha")).toBe(false);
    expect(contextoDeAutomacao("tarefa")).toBe(false);
    expect(contextoDeAutomacao(undefined)).toBe(false);
    expect(emailEhMarketing("fluxo", "marketing")).toBe(true);
    expect(emailEhMarketing("fluxo", "transacional")).toBe(false);
  });
});
