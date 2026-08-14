import { describe, expect, it } from "vitest";
import { analisarTag, extrairTags, renderizarTags, validarTags } from "./mergeTags.ts";
import { aplicarUtm, ehLinkNavegavel, envolverClique, prepararLinksNoHtml } from "./links.ts";

describe("análise da sintaxe", () => {
  it("separa caminho e filtros", () => {
    const t = analisarTag('contato.primeiro_nome | fallback:"Olá" | upper', "{{...}}");
    expect(t.caminho).toBe("contato.primeiro_nome");
    expect(t.filtros).toEqual([{ nome: "fallback", arg: "Olá" }, { nome: "upper" }]);
  });

  it("não corta o argumento no pipe DENTRO das aspas", () => {
    const t = analisarTag('a | fallback:"x | y"', "{{...}}");
    expect(t.filtros[0].arg).toBe("x | y");
  });

  it("extrai todas as tags de um texto na ordem", () => {
    const tags = extrairTags("Oi {{a}}, seu curso é {{b.c}} — {{a}}");
    expect(tags.map((t) => t.caminho)).toEqual(["a", "b.c", "a"]);
  });
});

describe("render com dados", () => {
  const dados = {
    nome: "Ana Paula Souza",
    contato: { primeiro_nome: "Ana", email: "ana@x.com", vazio: "" },
    data: "2026-03-15T10:00:00Z",
  };

  it("resolve caminho aninhado", () => {
    expect(renderizarTags("Olá {{contato.primeiro_nome}}", dados)).toBe("Olá Ana");
  });

  it("usa o fallback quando o valor falta ou é string vazia", () => {
    expect(renderizarTags('{{contato.inexistente | fallback:"aluno"}}', dados)).toBe("aluno");
    expect(renderizarTags('{{contato.vazio | fallback:"aluno"}}', dados)).toBe("aluno");
  });

  it("aplica os filtros na ordem escrita", () => {
    expect(renderizarTags("{{contato.primeiro_nome | upper}}", dados)).toBe("ANA");
    expect(renderizarTags("{{nome | primeiro_nome | upper}}", dados)).toBe("ANA");
    expect(renderizarTags("{{nome | truncate:8}}", dados)).toBe("Ana Paul…");
    expect(renderizarTags("{{data | date:iso}}", dados)).toBe("2026-03-15");
  });

  it("escapa HTML do valor por padrão — merge tag não injeta markup", () => {
    expect(renderizarTags("{{x}}", { x: "<b>oi</b>" })).toBe("&lt;b&gt;oi&lt;/b&gt;");
  });

  it("não escapa quando o destino é text/plain", () => {
    expect(renderizarTags("{{x}}", { x: "a & b" }, { escapar: false })).toBe("a & b");
  });

  it("filtro desconhecido é ignorado no render em vez de derrubar o envio", () => {
    expect(renderizarTags("{{contato.primeiro_nome | inventado}}", dados)).toBe("Ana");
  });
});

describe("compatibilidade com os 29 templates legados", () => {
  // Os templates do funil de TCC usam {{nome}} raso e contam com o comportamento
  // do renderTemplate atual do email-send. Quebrar isso quebra e-mail em produção.
  it("resolve chave rasa sem ponto, como o renderTemplate antigo", () => {
    expect(renderizarTags("Prezado {{nome_aluno}}", { nome_aluno: "João" })).toBe("Prezado João");
  });

  it("tag não resolvida sai LITERAL, e não vazia (comportamento atual)", () => {
    expect(renderizarTags("Prezado {{nome_aluno}}", {})).toBe("Prezado {{nome_aluno}}");
  });

  it("aceita espaço interno como o regex antigo", () => {
    expect(renderizarTags("{{ nome }}", { nome: "Ana" })).toBe("Ana");
  });

  it("modo 'vazio' é opt-in, nunca o padrão", () => {
    expect(renderizarTags("x{{a}}", {}, { naoResolvida: "vazio" })).toBe("x");
  });
});

describe("validação de tags", () => {
  const validos = ["contato.primeiro_nome", "contato.email"];

  it("acusa variável fora do catálogo", () => {
    const p = validarTags("{{contato.inventado}}", validos);
    expect(p.some((x) => x.tipo === "variavel-desconhecida")).toBe(true);
  });

  it("acusa filtro inexistente", () => {
    const p = validarTags("{{contato.email | xpto}}", validos);
    expect(p.some((x) => x.tipo === "filtro-desconhecido")).toBe(true);
  });

  it("avisa sobre tag sem fallback — é o que vaza {{tag}} para 2.000 pessoas", () => {
    const p = validarTags("{{contato.email}}", validos);
    expect(p.some((x) => x.tipo === "sem-fallback")).toBe(true);
  });

  it("tag válida com fallback não gera problema", () => {
    expect(validarTags('{{contato.email | fallback:"-"}}', validos)).toHaveLength(0);
  });
});

describe("links: UTM", () => {
  it("anexa os cinco parâmetros", () => {
    const r = aplicarUtm("https://e.com/p", {
      source: "crm", campaign: "c", medium: "email", term: "t", content: "v",
    });
    for (const k of ["utm_source", "utm_campaign", "utm_medium", "utm_term", "utm_content"]) {
      expect(r).toContain(k);
    }
  });

  it("preserva a query existente e o fragmento", () => {
    const r = aplicarUtm("https://e.com/p?a=1#secao", { source: "crm" });
    expect(r).toBe("https://e.com/p?a=1&utm_source=crm#secao");
  });

  it("não mexe em mailto, tel nem âncora", () => {
    for (const h of ["mailto:a@b.com", "tel:+5511999", "#topo"]) {
      expect(aplicarUtm(h, { source: "crm" })).toBe(h);
      expect(ehLinkNavegavel(h)).toBe(false);
    }
  });

  it("não destrói merge tag dentro da query (o motivo de não usar URL)", () => {
    const r = aplicarUtm("https://e.com/p?id={{contato.id}}", { source: "crm" });
    expect(r).toContain("{{contato.id}}");
    expect(r).toContain("utm_source=crm");
  });

  it("link que é só uma merge tag não é tocado — só resolve no render", () => {
    expect(aplicarUtm("{{contato.url}}", { source: "crm" })).toBe("{{contato.url}}");
  });
});

describe("links: rastreamento de clique", () => {
  it("envolve o destino no redirecionador com o destino codificado", () => {
    const r = envolverClique("https://e.com/a?b=1", "https://api.x.com/clique", "envio_1");
    expect(r).toContain("e=envio_1");
    expect(r).toContain(encodeURIComponent("https://e.com/a?b=1"));
  });

  it("reescreve os href de um HTML pronto (caminho legado)", () => {
    const html = '<p><a href="https://e.com">x</a> <a href="mailto:a@b.com">y</a></p>';
    const r = prepararLinksNoHtml(html, { utm: { source: "crm" } });
    expect(r).toContain("https://e.com?utm_source=crm");
    expect(r).toContain('href="mailto:a@b.com"');
  });
});
