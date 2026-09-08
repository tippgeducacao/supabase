import { describe, expect, it } from "vitest";
import { validarDocumentoIA, PROMPT_DOCUMENTO_IA } from "./ai.ts";
import { compilarDocumento } from "./compile.ts";
import type { DocumentoEmail } from "./types.ts";

const blocoTexto = { id: "repetido", tipo: "texto", props: { texto: "Uma nova etapa começa aqui" } };

function documento(blocos: unknown[] = [blocoTexto], extras: Record<string, unknown> = {}) {
  return {
    versao: 1,
    nome: "Convite para a próxima turma",
    assunto: "Seu próximo passo profissional",
    preheader: "Veja os benefícios e conheça a formação.",
    globais: { fonte: "Arial", corLink: "#7c3aed" },
    linhas: [{ id: "repetido", colunas: [{ id: "repetido", larguraPct: 100, blocos }] }],
    ...extras,
  };
}

function todosIds(doc: DocumentoEmail): string[] {
  return doc.linhas.flatMap(l => [l.id, ...l.colunas.flatMap(c => [c.id, ...c.blocos.map(b => b.id)])]);
}

describe("documentos de IA seguros para o construtor de e-mails", () => {
  it("reconstrói um documento visual com os nove blocos nativos e compila HTML de e-mail", () => {
    const doc = validarDocumentoIA(documento([
      { ...blocoTexto, estilo: { tamanhoFonte: 36, pesoFonte: 700, corTexto: "#ffffff", corFundo: "#7633aa", padding: { topo: 32, baixo: 24 } }, estiloMobile: { tamanhoFonte: 28, padding: { direita: 12, esquerda: 12 } } },
      { tipo: "imagem", props: { src: "https://cdn.example.com/hero.webp", alt: "Formação profissional" } },
      { tipo: "lista", props: { itens: ["Conteúdo aplicado", "Aulas com especialistas"], ordenada: false } },
      { tipo: "botao", props: { texto: "Conhecer a formação", href: "https://example.com/curso", alvo: "_blank" } },
      { tipo: "imagem-link", props: { src: "https://cdn.example.com/curso.png", href: "https://example.com/curso", alt: "Conheça o curso" } },
      { tipo: "video", props: { thumbnail: "https://cdn.example.com/aula.jpg", href: "https://example.com/video", texto: "Assistir à apresentação" } },
      { tipo: "separador", props: { espessura: 1 } },
      { tipo: "espacador", props: { altura: 24 } },
      { tipo: "link", props: { texto: "Descadastrar", href: "{{descadastro_url}}" } },
    ]));
    const { html } = compilarDocumento(doc, { dados: { descadastro_url: "https://example.com/sair" } });
    expect(doc.globais.fonte).toBe("Arial, Helvetica, sans-serif");
    expect(doc.globais.larguraContainer).toBe(600);
    expect(doc.linhas[0].empilharMobile).toBe(true);
    expect(html).toContain('<table role="presentation"');
    expect(html).toContain("font-size:36px");
    expect(html).toContain("font-size:28px!important");
    expect(html).toContain("Conhecer a formação");
    expect(html).toContain('href="https://example.com/sair"');
    expect(html).toContain('src="https://cdn.example.com/aula.jpg"');
    expect(html).not.toMatch(/<iframe|<script|<video|<button/i);
  });

  it("nunca transforma texto puro nem valores de merge tags em HTML ativo", () => {
    const ataque = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const doc = validarDocumentoIA(documento([
      { tipo: "texto", props: { texto: ataque + " {{contato.nome}}" } },
      { tipo: "botao", props: { texto: ataque, href: "https://example.com" } },
      { tipo: "lista", props: { itens: [ataque] } },
      { tipo: "imagem", props: { src: "https://cdn.example.com/logo.png", alt: ataque } },
    ], { nome: ataque, preheader: ataque }));
    const { html } = compilarDocumento(doc, { dados: { contato: { nome: ataque } } });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    const imagens = html.match(/<img\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi) ?? [];
    expect(imagens).toHaveLength(1);
    // O texto do ataque dentro do alt escapado não é um atributo executável.
    expect(imagens[0].replace(/"[^"]*"|'[^']*'/g, '""')).not.toMatch(/\sonerror=/i);
    expect(html).not.toContain('<img src=x');
  });

  it.each(["html", "html-dinamico", "texto-composto", "texto-dinamico", "imagem-dinamica", "link-dinamico", "inventado"])("rejeita tipo sem contrato seguro: %s", tipo => {
    expect(() => validarDocumentoIA(documento([{ tipo, props: { texto: "Teste" } }]))).toThrow(/tipo/);
  });

  it.each([
    { nome: "HTML nas props de texto", bloco: { tipo: "texto", props: { texto: "Teste", html: '<img onerror="alert(1)">' } } },
    { nome: "evento inesperado", bloco: { ...blocoTexto, onClick: "alert(1)" } },
    { nome: "CSS injetado na cor", bloco: { ...blocoTexto, estilo: { corTexto: '#fff;"><script>alert(1)</script>' } } },
    { nome: "CSS injetado na fonte", bloco: { ...blocoTexto, estilo: { fonte: "Arial; background:url(javascript:alert(1))" } } },
    { nome: "CSS no override mobile", bloco: { ...blocoTexto, estiloMobile: { alturaLinha: '</style><script>alert(1)</script>' } } },
    { nome: "expressão em dimensão", bloco: { ...blocoTexto, estilo: { largura: "expression(alert(1))" } } },
    { nome: "HTML no padding", bloco: { ...blocoTexto, estilo: { padding: { topo: '<img src=x>' } } } },
    { nome: "tipo de borda arbitrário", bloco: { ...blocoTexto, estilo: { borda: { estilo: "solid; background:red" } } } },
  ])("rejeita $nome antes de abrir no canvas", ({ bloco }) => {
    expect(() => validarDocumentoIA(documento([bloco]))).toThrow(/Documento da IA inválido/);
  });

  it.each(["", "body{background:red}", "</style><script>alert(1)</script>"])("não aceita cssCustomizado mesmo vazio: %s", cssCustomizado => {
    expect(() => validarDocumentoIA(documento(undefined, { cssCustomizado }))).toThrow(/campo não permitido/);
  });

  it.each([
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)", "//example.com", "file:///tmp/arquivo", "https://", "https://user:password@example.com",
    "https://example.com\" onclick=\"alert(1)", "https://example.com\\@evil.test", "https://example.com/%0Ajavascript:alert(1)",
    "{{contato.url}}", '{{descadastro_url | fallback:"javascript:alert(1)"}}', "https://example.com/{{contato.url}}",
  ])("rejeita destino inseguro ou variável de URL não controlada: %s", href => {
    expect(() => validarDocumentoIA(documento([{ tipo: "botao", props: { texto: "Abrir", href } }]))).toThrow(/href/);
  });

  it.each([
    "https://example.com/curso?origem=email#detalhes", "http://example.com:8080/curso", "mailto:contato@example.com",
    "tel:+5546999999999", "{{descadastro_url}}", "{{ descadastro_url }}",
  ])("preserva um destino permitido: %s", href => {
    const doc = validarDocumentoIA(documento([{ tipo: "link", props: { texto: "Abrir", href } }]));
    expect(doc.linhas[0].colunas[0].blocos[0].props.href).toBe(href.includes("{{") ? "{{descadastro_url}}" : href);
  });

  it.each([
    "data:image/svg+xml,<svg onload=alert(1)>", "data:image/png;base64,AAAA", "javascript:alert(1)",
    "https://cdn.example.com/imagem.svg", "https://cdn.example.com/imagem.SVG?width=600", "https://cdn.example.com/imagem%2esvg",
    "https://cdn.example.com/imagem?format=svg", "{{imagem_url}}", "mailto:foto@example.com",
  ])("recusa imagem incompatível ou insegura: %s", src => {
    expect(() => validarDocumentoIA(documento([{ tipo: "imagem", props: { src, alt: "Imagem" } }]))).toThrow(/src/);
    expect(() => validarDocumentoIA(documento([{ tipo: "video", props: { thumbnail: src, href: "https://example.com/video" } }]))).toThrow(/thumbnail/);
  });

  it("regera IDs duplicados ou maliciosos com valores únicos e determinísticos", () => {
    const entrada = documento([blocoTexto, { ...blocoTexto, id: '"><style>body{display:none}</style>' }]);
    const doc = validarDocumentoIA(entrada);
    const ids = todosIds(doc);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(id => /^ia-(linha|coluna|bloco)-\d+(?:-\d+)*$/.test(id))).toBe(true);
    expect(todosIds(validarDocumentoIA(entrada))).toEqual(ids);
    expect(compilarDocumento(doc).html).not.toContain("body{display:none}");
  });

  it("normaliza larguras para 100%, preservando proporções e mobile empilhado", () => {
    const doc = validarDocumentoIA(documento(undefined, {
      linhas: [{ colunas: [10, 20, 30].map(larguraPct => ({ larguraPct, blocos: [blocoTexto] })) }],
    }));
    expect(doc.linhas[0].colunas.map(c => c.larguraPct)).toEqual([16.67, 33.33, 50]);
    expect(doc.linhas[0].colunas.reduce((n, c) => n + c.larguraPct, 0)).toBe(100);
    expect(doc.linhas[0].empilharMobile).toBe(true);
  });

  it("limita medidas numéricas exageradas sem admitir strings de CSS", () => {
    const doc = validarDocumentoIA(documento([{ ...blocoTexto, estilo: { tamanhoFonte: 9000, raio: -3, largura: "5000px", padding: { topo: 9000 } } }], {
      globais: { larguraContainer: 9000, tamanhoFonte: 1, alturaLinha: 9000, breakpointMobile: 9000 },
    }));
    expect(doc.globais).toMatchObject({ larguraContainer: 800, tamanhoFonte: 12, alturaLinha: 3, breakpointMobile: 640 });
    expect(doc.linhas[0].colunas[0].blocos[0].estilo).toMatchObject({ tamanhoFonte: 72, raio: 0, largura: "800px", padding: { topo: 80 } });
    for (const valor of [NaN, Infinity, "16px", null]) {
      expect(() => validarDocumentoIA(documento([{ ...blocoTexto, estilo: { tamanhoFonte: valor } }]))).toThrow(/número finito/);
    }
  });

  it.each([null, [], "<html>E-mail</html>", { resumo: "Texto", documento: documento() }, { ...documento(), versao: 2 }, { ...documento(), globais: null }])("rejeita envelope ou documento malformado", entrada => {
    expect(() => validarDocumentoIA(entrada)).toThrow(/Documento da IA inválido/);
  });

  it("rejeita colunas, linhas e quantidade total acima dos limites", () => {
    expect(() => validarDocumentoIA(documento(undefined, { linhas: Array.from({ length: 41 }, () => ({ colunas: [{ blocos: [blocoTexto] }] })) }))).toThrow(/40 linhas/);
    expect(() => validarDocumentoIA(documento(undefined, { linhas: [{ colunas: Array.from({ length: 4 }, () => ({ blocos: [blocoTexto] })) }] }))).toThrow(/3 colunas/);
    expect(() => validarDocumentoIA(documento(undefined, { linhas: [{ colunas: [{ blocos: Array(61).fill(blocoTexto) }, { blocos: Array(60).fill(blocoTexto) }] }] }))).toThrow(/120 blocos/);
    expect(() => validarDocumentoIA(documento([]))).toThrow(/precisa conter conteúdo/);
  });

  it("rejeita corpo excessivo e campos de texto acima de seus limites", () => {
    expect(() => validarDocumentoIA(documento([{ tipo: "texto", props: { texto: "a".repeat(160001) } }]))).toThrow(/tamanho permitido/);
    expect(() => validarDocumentoIA(documento([{ tipo: "texto", props: { texto: "a".repeat(4001) } }]))).toThrow(/4000 caracteres/);
    for (const [campo, tamanho] of [["nome", 121], ["assunto", 201], ["preheader", 251]] as const) {
      expect(() => validarDocumentoIA(documento(undefined, { [campo]: "a".repeat(tamanho) }))).toThrow(new RegExp(campo));
    }
    expect(() => validarDocumentoIA(documento([{ tipo: "lista", props: { itens: Array(31).fill("Benefício") } }]))).toThrow(/30 itens/);
  });

  it("não compartilha objetos mutáveis com a entrada nem com os defaults", () => {
    const entrada = documento([blocoTexto]);
    const doc = validarDocumentoIA(entrada);
    doc.globais.paddingPadrao.topo = 80;
    doc.linhas[0].colunas[0].blocos[0].props.texto = "Alterado";
    expect(blocoTexto.props.texto).toBe("Uma nova etapa começa aqui");
    expect(validarDocumentoIA(entrada).globais.paddingPadrao.topo).toBe(12);
  });

  it("mantém catálogo e envelope claros no prompt compartilhado", () => {
    expect(PROMPT_DOCUMENTO_IA).toContain('"resumo"');
    expect(PROMPT_DOCUMENTO_IA).toContain('"documento"');
    expect(PROMPT_DOCUMENTO_IA).toContain("{{descadastro_url}}");
    expect(PROMPT_DOCUMENTO_IA).toContain("hero");
    expect(PROMPT_DOCUMENTO_IA).toContain("NUNCA produza html");
  });
});
