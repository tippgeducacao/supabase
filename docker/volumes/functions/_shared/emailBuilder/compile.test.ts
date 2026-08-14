/**
 * Suíte de compatibilidade do compilador de e-mail.
 *
 * Cada teste aqui existe por causa de um CLIENTE que quebra sem a regra. Trocamos o
 * MJML por compilador próprio (ver docs) — esta suíte é o que compra de volta a
 * confiança que o MJML tinha acumulado. Regra nova de compatibilidade entra com teste,
 * senão a próxima refatoração a desfaz sem ninguém perceber.
 */
import { describe, expect, it } from "vitest";
import { compilarDocumento, gerarTextoSimples } from "./compile.ts";
import { docVazio, type Bloco, type DocumentoEmail, type Linha } from "./types.ts";

function linha(blocos: Bloco[], extra: Partial<Linha> = {}): Linha {
  return { id: "l1", colunas: [{ id: "c1", larguraPct: 100, blocos }], ...extra };
}
function doc(blocos: Bloco[], extra: Partial<DocumentoEmail> = {}): DocumentoEmail {
  return { ...docVazio("Teste"), linhas: [linha(blocos)], ...extra };
}
const TEXTO: Bloco = { id: "b1", tipo: "texto", props: { texto: "Olá mundo" } };

describe("estrutura do documento HTML", () => {
  it("usa tabela em vez de flex/grid — Outlook renderiza com o motor do Word", () => {
    const { html } = compilarDocumento(doc([TEXTO]));
    expect(html).toContain("<table");
    expect(html).not.toMatch(/display\s*:\s*(flex|grid)/);
    expect(html).not.toMatch(/position\s*:\s*absolute/);
  });

  it("marca tabela de layout como apresentação (leitor de tela não anuncia)", () => {
    const { html } = compilarDocumento(doc([TEXTO]));
    const tabelas = html.match(/<table[^>]*>/g) ?? [];
    expect(tabelas.length).toBeGreaterThan(0);
    for (const t of tabelas) expect(t).toContain('role="presentation"');
  });

  it("fecha o container em 600px e repete a largura no condicional do Outlook", () => {
    const { html } = compilarDocumento(doc([TEXTO]));
    expect(html).toContain("max-width:600px");
    // Outlook ignora max-width: precisa da tabela de largura fixa no condicional.
    expect(html).toMatch(/<!--\[if mso\]>[\s\S]*width="600"[\s\S]*<!\[endif\]-->/);
  });

  it("declara charset, viewport e suporte a dark mode", () => {
    const { html } = compilarDocumento(doc([TEXTO]));
    expect(html).toContain('charset="utf-8"');
    expect(html).toContain("width=device-width");
    expect(html).toContain('name="color-scheme"');
  });

  it("neutraliza a auto-detecção de data/telefone do iOS", () => {
    const { html } = compilarDocumento(doc([TEXTO]));
    expect(html).toContain("x-apple-data-detectors");
  });

  it("empilha colunas no mobile por media query", () => {
    const { html } = compilarDocumento(doc([TEXTO]));
    expect(html).toMatch(/@media only screen and \(max-width:480px\)/);
    expect(html).toMatch(/\.coluna\{[^}]*display:block!important/);
    expect(html).toMatch(/<td class="coluna"/);
  });

  it("linha com empilharMobile:false sai SEM a classe que empilha", () => {
    const d: DocumentoEmail = {
      ...docVazio(),
      linhas: [linha([TEXTO], { empilharMobile: false })],
    };
    const { html } = compilarDocumento(d);
    // A regra continua na folha (outras linhas podem usá-la); a coluna é que não opta.
    expect(html).not.toContain('<td class="coluna"');
  });
});

/**
 * O modo mobile do construtor só existe se o override CHEGAR no HTML. Estes testes
 * existem porque ele não chegava: `estiloMobile` era gravado, aparecia no canvas e o
 * compilador o ignorava — a pessoa ajustava o celular e o destinatário recebia o
 * desktop. Verificar "existe uma media query" não prova nada; o que prova é a regra
 * com o valor certo, no seletor certo, com `!important` (inline vence folha).
 */
describe("overrides de mobile", () => {
  it("emite a regra do estiloMobile com !important dentro da media query", () => {
    const { html } = compilarDocumento(doc([{
      ...TEXTO,
      estilo: { tamanhoFonte: 32 },
      estiloMobile: { tamanhoFonte: 20 },
    }]));
    expect(html).toContain("font-size:32px");
    const media = html.match(/@media only screen and \(max-width:480px\)\{[\s\S]*?\n\s*\}/)?.[0] ?? "";
    expect(media).toContain("font-size:20px!important");
    expect(media).toContain(".bl-b1");
  });

  it("bloco escondido no mobile vira display:none na media query", () => {
    const { html } = compilarDocumento(doc([{ ...TEXTO, visivel: { desktop: true, mobile: false } }]));
    expect(html).toContain("Olá mundo");
    expect(html).toMatch(/\.bl-b1\{display:none!important/);
  });

  it("bloco SÓ de mobile sai no HTML escondido e a media query o revela", () => {
    const { html } = compilarDocumento(doc([{ ...TEXTO, visivel: { desktop: false, mobile: true } }]));
    // Antes o filtro era só desktop e este bloco sumia inteiro do e-mail.
    expect(html).toContain("Olá mundo");
    expect(html).toMatch(/<div class="bl-b1[^"]*"[^>]*style="[^"]*display:none/);
    expect(html).toMatch(/\.bl-b1\{display:block!important/);
  });

  it("bloco oculto nos dois dispositivos não entra na saída", () => {
    const { html } = compilarDocumento(doc([{ ...TEXTO, visivel: { desktop: false, mobile: false } }]));
    expect(html).not.toContain("Olá mundo");
  });

  it("mira o <a> do botão e a <td> da caixa — inline no elemento errado não venceria", () => {
    const { html } = compilarDocumento(doc([{
      id: "b1", tipo: "botao",
      props: { texto: "Ir", href: "https://e.com" },
      estiloMobile: { tamanhoFonte: 14, corFundo: "#000000" },
    }]));
    expect(html).toMatch(/\.bl-b1 a\{[^}]*font-size:14px!important/);
    expect(html).toMatch(/\.bl-b1 td\{[^}]*background-color:#000000!important/);
  });

  it("documento sem override não polui a media query", () => {
    const { html } = compilarDocumento(doc([TEXTO]));
    expect(html).not.toContain("!important;padding");
    expect(html).not.toMatch(/\.bl-b1\{/);
  });
});

describe("bloco de botão", () => {
  const BOTAO: Bloco = {
    id: "b", tipo: "botao",
    props: { texto: "Clique aqui", href: "https://exemplo.com" },
  };

  it("é uma tabela com padding na td — padding em <a> some no Outlook", () => {
    const { html } = compilarDocumento(doc([BOTAO]));
    expect(html).not.toContain("<button");
    const trecho = html.slice(html.indexOf("Clique aqui") - 400, html.indexOf("Clique aqui"));
    expect(trecho).toMatch(/<td[^>]*padding:/);
  });

  it("fixa line-height — sem isso o texto sobe dentro do botão no Outlook", () => {
    const { html } = compilarDocumento(doc([BOTAO]));
    const a = html.match(/<a[^>]*>Clique aqui<\/a>/)?.[0] ?? "";
    expect(a).toContain("line-height");
  });

  it("leva a cor de fundo na td, não no link", () => {
    const { html } = compilarDocumento(doc([{ ...BOTAO, estilo: { corFundo: "#ff0000" } }]));
    const a = html.match(/<a[^>]*>Clique aqui<\/a>/)?.[0] ?? "";
    expect(a).not.toContain("background-color");
    expect(html).toContain("background-color:#ff0000");
  });
});

describe("bloco de imagem", () => {
  const IMG: Bloco = {
    id: "i", tipo: "imagem",
    props: { src: "https://cdn.exemplo.com/a.png", alt: "Foto do campus" },
  };

  it("sempre tem alt — imagem bloqueada é padrão em cliente corporativo", () => {
    const { html } = compilarDocumento(doc([IMG]));
    expect(html).toContain('alt="Foto do campus"');
  });

  it("gera alt vazio (não ausente) quando não informado", () => {
    const { html } = compilarDocumento(doc([{ ...IMG, props: { src: "x.png" } }]));
    expect(html).toMatch(/<img[^>]*alt=""/);
  });

  it("usa display:block e border=0 — mata o gap fantasma e a moldura do Outlook", () => {
    const { html } = compilarDocumento(doc([IMG]));
    const img = html.match(/<img[^>]*>/)?.[0] ?? "";
    expect(img).toContain("display:block");
    expect(img).toContain('border="0"');
  });

  it("imagem-link envolve a img num <a>", () => {
    const { html } = compilarDocumento(doc([
      { ...IMG, tipo: "imagem-link", props: { ...IMG.props, href: "https://x.com" } },
    ]));
    expect(html).toMatch(/<a[^>]*href="https:\/\/x\.com"[^>]*><img/);
  });

  it("vídeo vira thumbnail clicável — e-mail não roda player", () => {
    const { html } = compilarDocumento(doc([{
      id: "v", tipo: "video",
      props: { thumbnail: "https://cdn/t.jpg", href: "https://youtu.be/x", alt: "Aula 1" },
    }]));
    expect(html).not.toContain("<video");
    expect(html).toContain("https://cdn/t.jpg");
    expect(html).toMatch(/href="https:\/\/youtu\.be\/x"/);
  });

  it("vídeo traz a chamada de assistir — senão sai idêntico a uma imagem com link", () => {
    const { html } = compilarDocumento(doc([{
      id: "v", tipo: "video",
      props: { thumbnail: "https://cdn/t.jpg", href: "https://youtu.be/x", alt: "Aula 1" },
    }]));
    expect(html).toContain("Assistir ao vídeo");
    // Dois links para o mesmo destino: a miniatura e a chamada abaixo dela.
    expect(html.match(/href="https:\/\/youtu\.be\/x"/g) ?? []).toHaveLength(2);
  });
});

describe("segurança do conteúdo", () => {
  it("escapa markup vindo de bloco de texto — merge tag não injeta HTML", () => {
    const { html } = compilarDocumento(doc([
      { id: "t", tipo: "texto", props: { texto: '<script>alert(1)</script>' } },
    ]));
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapa valor injetado por merge tag nos dados", () => {
    const { html } = compilarDocumento(
      doc([{ id: "t", tipo: "texto", props: { texto: "Olá {{nome}}" } }]),
      { dados: { nome: '<img src=x onerror=alert(1)>' } },
    );
    expect(html).not.toContain("onerror=alert(1)>");
    expect(html).toContain("&lt;img");
  });

  it("escapa aspas em atributo de link (não dá para escapar do href)", () => {
    const { html } = compilarDocumento(doc([
      { id: "l", tipo: "link", props: { texto: "x", href: 'https://a.com" onmouseover="alert(1)' } },
    ]));
    expect(html).not.toContain('onmouseover="alert(1)"');
  });

  it("bloco HTML é escape consciente e mantém o markup do autor", () => {
    const { html } = compilarDocumento(doc([
      { id: "h", tipo: "html", props: { html: "<b>negrito</b>" } },
    ]));
    expect(html).toContain("<b>negrito</b>");
  });
});

describe("merge tags no compilador", () => {
  const D = doc([{ id: "t", tipo: "texto", props: { texto: "Olá {{contato.primeiro_nome}}" } }]);

  it("sem dados, preserva as tags (modo template)", () => {
    const { html } = compilarDocumento(D);
    expect(html).toContain("{{contato.primeiro_nome}}");
  });

  it("com dados, resolve o caminho aninhado", () => {
    const { html } = compilarDocumento(D, { dados: { contato: { primeiro_nome: "Ana" } } });
    expect(html).toContain("Olá Ana");
    expect(html).not.toContain("{{");
  });

  it("bloco dinâmico monta a tag a partir de variavel + fallback", () => {
    const { html } = compilarDocumento(
      doc([{ id: "d", tipo: "texto-dinamico", props: { variavel: "contato.nome", fallback: "aluno" } }]),
      { dados: {} },
    );
    expect(html).toContain("aluno");
  });
});

describe("UTM e rastreamento", () => {
  const comLink = doc([
    { id: "l", tipo: "link", props: { texto: "site", href: "https://exemplo.com/pagina" } },
  ]);

  it("anexa UTM a todos os links do corpo", () => {
    const { html } = compilarDocumento(comLink, {
      utm: { source: "crm", campaign: "black-friday", medium: "email" },
    });
    expect(html).toContain("utm_source=crm");
    expect(html).toContain("utm_campaign=black-friday");
    expect(html).toContain("utm_medium=email");
  });

  it("não sobrescreve UTM que o autor já escreveu no link", () => {
    const d = doc([{ id: "l", tipo: "link", props: { texto: "x", href: "https://e.com/?utm_source=manual" } }]);
    const { html } = compilarDocumento(d, { utm: { source: "crm" } });
    expect(html).toContain("utm_source=manual");
    expect(html).not.toContain("utm_source=crm");
  });

  it("injeta o pixel de abertura com a URL recebida", () => {
    const { html } = compilarDocumento(comLink, { pixelUrl: "https://api.exemplo.com/abrir?id=1" });
    expect(html).toMatch(/<img[^>]*src="https:\/\/api\.exemplo\.com\/abrir\?id=1"[^>]*width="1"/);
  });
});

describe("descadastro e conformidade", () => {
  it("renderiza o rodapé de descadastro quando a URL é dada", () => {
    const { html } = compilarDocumento(doc([TEXTO]), {
      descadastroUrl: "https://api.exemplo.com/sair?t=abc",
    });
    expect(html).toContain("https://api.exemplo.com/sair?t=abc");
    expect(html).toContain("Descadastrar");
  });

  it("AVISA quando o documento sai sem descadastro — exigência de LGPD/CAN-SPAM", () => {
    const { avisos } = compilarDocumento(doc([TEXTO]));
    expect(avisos.join(" ")).toMatch(/descadastro/i);
  });

  it("AVISA quando o HTML passa de 102 KB — acima disso o Gmail corta a mensagem", () => {
    const gordo = doc([{ id: "h", tipo: "html", props: { html: "<p>x</p>".repeat(20_000) } }]);
    const { avisos, bytes } = compilarDocumento(gordo);
    expect(bytes).toBeGreaterThan(102 * 1024);
    expect(avisos.join(" ")).toMatch(/102 KB/);
  });

  it("AVISA imagem sem alt e link ainda no placeholder https://", () => {
    const { avisos } = compilarDocumento(doc([
      { id: "i", tipo: "imagem", props: { src: "x.png" } },
      { id: "b", tipo: "botao", props: { texto: "Clique", href: "https://" } },
    ]));
    expect(avisos.join(" ")).toMatch(/texto alternativo/i);
    expect(avisos.join(" ")).toMatch(/sem destino/i);
  });

  it("preheader fica escondido no corpo mas presente no HTML", () => {
    const { html } = compilarDocumento(doc([TEXTO], { preheader: "Resumo da semana" }));
    expect(html).toContain("Resumo da semana");
    expect(html).toMatch(/display:none[^"]*"[^>]*>Resumo da semana/);
  });
});

describe("versão text/plain", () => {
  it("deriva do documento, com link explícito ao lado do rótulo", () => {
    const texto = gerarTextoSimples(doc([
      { id: "t", tipo: "texto", props: { texto: "Bem-vindo" } },
      { id: "b", tipo: "botao", props: { texto: "Acessar", href: "https://e.com" } },
    ]));
    expect(texto).toContain("Bem-vindo");
    expect(texto).toContain("Acessar: https://e.com");
    expect(texto).not.toContain("<");
  });

  it("usa o alt da imagem e marca o separador", () => {
    const texto = gerarTextoSimples(doc([
      { id: "i", tipo: "imagem", props: { src: "x", alt: "Turma 2026" } },
      { id: "s", tipo: "separador", props: {} },
    ]));
    expect(texto).toContain("[Turma 2026]");
    expect(texto).toContain("---");
  });
});

describe("robustez", () => {
  it("documento vazio compila sem quebrar", () => {
    const { html } = compilarDocumento(docVazio());
    expect(html).toContain("<body");
  });

  it("bloco de tipo desconhecido é pulado, não derruba o e-mail", () => {
    const d = doc([{ id: "x", tipo: "inexistente" as never, props: {} }]);
    const { html } = compilarDocumento(d);
    expect(html).toContain("<body");
    expect(html).toContain("não suportado");
  });

  it("bloco oculto não aparece na saída", () => {
    const { html } = compilarDocumento(doc([{ ...TEXTO, oculto: true }]));
    expect(html).not.toContain("Olá mundo");
  });

  it("linha com fundo externo sangra na largura total", () => {
    const d: DocumentoEmail = {
      ...docVazio(),
      linhas: [linha([TEXTO], { corFundoExterna: "#000000" })],
    };
    const { html } = compilarDocumento(d);
    expect(html).toContain("background-color:#000000");
  });
});
