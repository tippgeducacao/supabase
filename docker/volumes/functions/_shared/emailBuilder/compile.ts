/**
 * Compilador DOCUMENTO → HTML de e-mail.
 * Fonte única (front + edge + vitest): ver o cabeçalho de `types.ts`.
 *
 * Por que tabela e não flexbox/grid: Outlook (desktop, Windows) renderiza com o motor
 * do Word desde 2007 — sem flex, sem grid, sem `float` confiável, sem `position`.
 * Tabela aninhada com atributos de apresentação é o único layout que atravessa todos
 * os clientes. Cada regra abaixo existe por causa de um cliente específico:
 *
 *  - CSS INLINE: Gmail remove `<style>` em boa parte dos contextos (notadamente no app
 *    móvel e em mensagens encaminhadas). O que precisa valer sempre vai inline; o
 *    `<style>` fica só para o que é progressivo (media query de mobile e dark mode).
 *  - LARGURA 600px: cabe no painel de leitura do Outlook sem barra horizontal.
 *  - CONDICIONAL MSO: Outlook ignora `max-width`, então o container ganha uma tabela
 *    de largura fixa dentro de `<!--[if mso]>`.
 *  - BOTÃO: nada de `<button>` nem de padding em `<a>` (Outlook engole) — o botão é
 *    uma tabela com o padding na `<td>`.
 *  - IMAGEM: `display:block` mata o gap fantasma do descendente de linha-base;
 *    `border:0` mata a borda azul do Outlook em imagem dentro de link; `alt` sempre,
 *    porque muita gente lê com imagem bloqueada por padrão.
 *  - `role="presentation"`: sem isso o leitor de tela anuncia a tabela de layout.
 */

import {
  type Bloco,
  type Coluna,
  type DocumentoEmail,
  type EstiloBloco,
  type Espacamento,
  type GlobaisDoc,
  type Linha,
  GLOBAIS_PADRAO,
  blocoVisivel,
} from "./types.ts";
import { escaparHtml, renderizarTags } from "./mergeTags.ts";
import { type OpcoesLink, prepararHref } from "./links.ts";

export interface OpcoesCompilacao extends OpcoesLink {
  /** Dados para resolver as merge tags. Ausente = mantém as tags (modo template). */
  dados?: Record<string, unknown>;
  /** URL absoluta do pixel de abertura. TEM que ser pública (nada de kong:8000). */
  pixelUrl?: string | null;
  /** URL de descadastro — vira o rodapé obrigatório. */
  descadastroUrl?: string | null;
  /** Rótulo do link de descadastro (i18n). */
  descadastroTexto?: string;
  /** Minificar o HTML final. */
  minificar?: boolean;
}

// ------------------------------------------------------------------ utilidades

const esc = escaparHtml;

/** Atributo HTML seguro: escapa e envolve em aspas. Nunca interpola valor cru. */
function attr(nome: string, valor: string | number | null | undefined): string {
  if (valor === null || valor === undefined || valor === "") return "";
  return ` ${nome}="${esc(String(valor))}"`;
}

function css(regras: Array<[string, string | number | null | undefined]>): string {
  return regras
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
}

function px(v: number | string | null | undefined): string | null {
  if (v === null || v === undefined || v === "") return null;
  return typeof v === "number" ? `${v}px` : String(v);
}

function padding(e: Espacamento | undefined, padraoZero = true): string | null {
  if (!e) return padraoZero ? null : null;
  const t = e.topo ?? 0, d = e.direita ?? 0, b = e.baixo ?? 0, l = e.esquerda ?? 0;
  if (!t && !d && !b && !l) return null;
  return `${t}px ${d}px ${b}px ${l}px`;
}

function borda(e: EstiloBloco["borda"]): string | null {
  if (!e || !e.largura) return null;
  return `${e.largura}px ${e.estilo ?? "solid"} ${e.cor ?? "#000000"}`;
}

/** Aplica merge tags quando há dados; senão devolve o texto como está. */
function txt(valor: string | undefined, o: OpcoesCompilacao, escapar = true): string {
  const v = valor ?? "";
  if (!o.dados) return v;
  return renderizarTags(v, o.dados, { escapar });
}

// ------------------------------------------------------------------ blocos

function compilarTexto(b: Bloco, g: GlobaisDoc, o: OpcoesCompilacao): string {
  const e = b.estilo ?? {};
  const estilo = css([
    ["font-family", e.fonte ?? g.fonte],
    ["font-size", px(e.tamanhoFonte ?? g.tamanhoFonte)],
    ["font-weight", e.pesoFonte ?? null],
    ["line-height", e.alturaLinha ?? g.alturaLinha],
    ["color", e.corTexto ?? g.corTexto],
    ["text-align", e.alinhamento ?? "left"],
    // `margin:0` porque o default do cliente varia e vira espaçamento aleatório.
    ["margin", "0"],
  ]);
  // texto-composto e html já vêm com markup do editor; texto simples é escapado.
  const conteudo = b.tipo === "texto-composto"
    ? txt(b.props.html ?? b.props.texto, o, false)
    : esc(txt(b.props.texto, o, false)).replace(/\n/g, "<br />");
  return `<div style="${estilo}">${conteudo}</div>`;
}

function compilarBotao(b: Bloco, g: GlobaisDoc, o: OpcoesCompilacao): string {
  const e = b.estilo ?? {};
  const href = prepararHref(txt(b.props.href, o, false), o);
  const corFundo = e.corFundo ?? g.corLink;
  const raio = e.raio ?? 6;
  const p = e.padding ?? { topo: 12, direita: 24, baixo: 12, esquerda: 24 };

  // O botão é uma TABELA: padding em <a> é ignorado pelo Outlook, e <button> não
  // sobrevive a cliente nenhum. A cor de fundo vai na <td>, não no link.
  const tdEstilo = css([
    ["background-color", corFundo],
    ["border-radius", px(raio)],
    ["padding", padding(p)],
    ["text-align", "center"],
    ["border", borda(e.borda)],
  ]);
  const aEstilo = css([
    ["font-family", e.fonte ?? g.fonte],
    ["font-size", px(e.tamanhoFonte ?? 16)],
    ["font-weight", e.pesoFonte ?? 600],
    ["color", e.corTexto ?? "#ffffff"],
    ["text-decoration", "none"],
    ["display", "inline-block"],
    // Outlook precisa de line-height explícito, senão o texto sobe dentro do botão.
    ["line-height", "1.2"],
  ]);
  const alinha = e.alinhamento ?? "left";

  return [
    `<table role="presentation" border="0" cellpadding="0" cellspacing="0"`,
    ` style="${css([["margin", alinha === "center" ? "0 auto" : alinha === "right" ? "0 0 0 auto" : "0"]])}">`,
    `<tr><td style="${tdEstilo}">`,
    `<a${attr("href", href)}${attr("target", b.props.alvo ?? "_blank")} style="${aEstilo}">${esc(txt(b.props.texto, o, false))}</a>`,
    `</td></tr></table>`,
  ].join("");
}

function compilarLink(b: Bloco, g: GlobaisDoc, o: OpcoesCompilacao): string {
  const e = b.estilo ?? {};
  const href = prepararHref(txt(b.props.href, o, false), o);
  const estilo = css([
    ["font-family", e.fonte ?? g.fonte],
    ["font-size", px(e.tamanhoFonte ?? g.tamanhoFonte)],
    ["color", e.corTexto ?? g.corLink],
    ["text-decoration", "underline"],
  ]);
  const wrap = css([["text-align", e.alinhamento ?? "left"]]);
  return `<div style="${wrap}"><a${attr("href", href)}${attr("target", b.props.alvo ?? "_blank")} style="${estilo}">${esc(txt(b.props.texto, o, false))}</a></div>`;
}

function compilarImagem(b: Bloco, g: GlobaisDoc, o: OpcoesCompilacao): string {
  const e = b.estilo ?? {};
  const src = txt(b.props.src, o, false);
  // alt SEMPRE: imagem bloqueada é o padrão em muitos clientes corporativos.
  const alt = esc(txt(b.props.alt, o, false) || "");
  const larguraMax = g.larguraContainer - (g.paddingPadrao.esquerda ?? 0) - (g.paddingPadrao.direita ?? 0);
  const estilo = css([
    // display:block mata o gap fantasma abaixo da imagem (descendente de linha-base).
    ["display", "block"],
    ["width", e.largura ?? "100%"],
    ["max-width", px(larguraMax)],
    ["height", e.altura ?? "auto"],
    ["border-radius", px(e.raio)],
    ["outline", "none"],
    ["text-decoration", "none"],
    ["-ms-interpolation-mode", "bicubic"],
  ]);
  // border="0" evita a moldura azul do Outlook quando a imagem está dentro de link.
  const img = `<img${attr("src", src)} alt="${alt}" border="0"${attr("width", larguraMax)} style="${estilo}" />`;

  const conteudo = b.tipo === "imagem-link" || b.props.href
    ? `<a${attr("href", prepararHref(txt(b.props.href, o, false), o))}${attr("target", b.props.alvo ?? "_blank")}>${img}</a>`
    : img;
  return `<div style="${css([["text-align", e.alinhamento ?? "center"]])}">${conteudo}</div>`;
}

function compilarVideo(b: Bloco, g: GlobaisDoc, o: OpcoesCompilacao): string {
  // E-mail não roda player: vira thumbnail clicável para o destino real.
  const thumb: Bloco = {
    ...b,
    tipo: "imagem-link",
    props: {
      ...b.props,
      src: b.props.thumbnail ?? b.props.src,
      alt: b.props.alt ?? "Assistir ao vídeo",
    },
  };
  return compilarImagem(thumb, g, o);
}

function compilarSeparador(b: Bloco, g: GlobaisDoc): string {
  const e = b.estilo ?? {};
  // <hr> renderiza diferente em cada cliente; uma <td> com border-top é previsível.
  const estilo = css([
    ["border-top", `${e.borda?.largura ?? b.props.espessura ?? 1}px ${e.borda?.estilo ?? "solid"} ${e.borda?.cor ?? "#e4e4e7"}`],
    ["font-size", "0"],
    ["line-height", "0"],
  ]);
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="${estilo}">&nbsp;</td></tr></table>`;
}

function compilarLista(b: Bloco, g: GlobaisDoc, o: OpcoesCompilacao): string {
  const e = b.estilo ?? {};
  const tag = b.props.ordenada ? "ol" : "ul";
  const estilo = css([
    ["font-family", e.fonte ?? g.fonte],
    ["font-size", px(e.tamanhoFonte ?? g.tamanhoFonte)],
    ["line-height", e.alturaLinha ?? g.alturaLinha],
    ["color", e.corTexto ?? g.corTexto],
    ["margin", "0"],
    ["padding-left", "20px"],
  ]);
  const itens = (b.props.itens ?? [])
    .map((i) => `<li style="${css([["margin-bottom", "6px"]])}">${esc(txt(i, o, false))}</li>`)
    .join("");
  return `<${tag} style="${estilo}">${itens}</${tag}>`;
}

function compilarEspacador(b: Bloco): string {
  const h = b.props.altura ?? 24;
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="${css([["height", px(h)], ["font-size", "0"], ["line-height", "0"]])}">&nbsp;</td></tr></table>`;
}

function compilarHtml(b: Bloco, o: OpcoesCompilacao): string {
  // Bloco de escape consciente: o autor assume a responsabilidade pelo markup.
  // Merge tag aqui NÃO é escapada (é HTML por definição) — por isso o bloco é
  // restrito a quem edita template, não a quem só dispara campanha.
  return txt(b.props.html, o, false);
}

function compilarDinamico(b: Bloco, g: GlobaisDoc, o: OpcoesCompilacao): string {
  // Bloco dinâmico é açúcar: monta a tag a partir de `variavel` + `fallback` e
  // delega para o bloco concreto equivalente.
  const tag = b.props.variavel
    ? `{{${b.props.variavel}${b.props.fallback ? ` | fallback:"${b.props.fallback}"` : ""}}}`
    : "";
  if (b.tipo === "texto-dinamico") {
    return compilarTexto({ ...b, tipo: "texto", props: { ...b.props, texto: tag } }, g, o);
  }
  if (b.tipo === "imagem-dinamica") {
    return compilarImagem({ ...b, tipo: "imagem", props: { ...b.props, src: tag } }, g, o);
  }
  if (b.tipo === "link-dinamico") {
    return compilarLink({ ...b, tipo: "link", props: { ...b.props, href: tag } }, g, o);
  }
  // html-dinamico
  return compilarHtml({ ...b, props: { ...b.props, html: b.props.html ?? tag } }, o);
}

function compilarBloco(b: Bloco, g: GlobaisDoc, o: OpcoesCompilacao): string {
  switch (b.tipo) {
    case "texto":
    case "texto-composto": return compilarTexto(b, g, o);
    case "botao": return compilarBotao(b, g, o);
    case "link": return compilarLink(b, g, o);
    case "imagem":
    case "imagem-link": return compilarImagem(b, g, o);
    case "video": return compilarVideo(b, g, o);
    case "separador": return compilarSeparador(b, g);
    case "lista": return compilarLista(b, g, o);
    case "espacador": return compilarEspacador(b);
    case "html": return compilarHtml(b, o);
    case "texto-dinamico":
    case "imagem-dinamica":
    case "link-dinamico":
    case "html-dinamico": return compilarDinamico(b, g, o);
    default: {
      // Bloco desconhecido (documento de versão futura) é PULADO, nunca quebra o
      // envio — melhor um e-mail sem um bloco do que nenhum e-mail.
      const _exaustivo: never = b.tipo;
      return `<!-- bloco não suportado: ${esc(String(_exaustivo))} -->`;
    }
  }
}

// ------------------------------------------------------------------ estrutura

function compilarColuna(c: Coluna, g: GlobaisDoc, o: OpcoesCompilacao, total: number): string {
  const blocos = c.blocos
    .filter((b) => blocoVisivel(b, "desktop"))
    .map((b) => {
      const p = padding(b.estilo?.padding);
      const wrap = p ? ` style="${css([["padding", p]])}"` : "";
      return `<div${wrap}>${compilarBloco(b, g, o)}</div>`;
    })
    .join("");

  const estilo = css([
    ["background-color", c.estilo?.corFundo],
    ["padding", padding(c.estilo?.padding)],
    ["border", borda(c.estilo?.borda)],
    ["border-radius", px(c.estilo?.raio)],
    ["vertical-align", c.alinhamentoVertical ?? "top"],
  ]);

  // width em ATRIBUTO além do style: Outlook ignora width no CSS de <td>.
  const largura = Math.round(c.larguraPct);
  return `<td class="coluna"${attr("width", `${largura}%`)} style="${estilo}">${blocos}</td>`;
}

function compilarLinha(l: Linha, g: GlobaisDoc, o: OpcoesCompilacao): string {
  if (l.oculto) return "";
  const colunas = l.colunas.map((c) => compilarColuna(c, g, o, l.colunas.length)).join("");

  const estiloInterno = css([
    ["background-color", l.estilo?.corFundo],
    ["padding", padding(l.estilo?.padding ?? g.paddingPadrao)],
  ]);

  const tabela =
    `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"` +
    ` class="linha"><tr>${colunas}</tr></table>`;

  // Faixa de cor sangrando na largura total: uma tabela externa 100% com a cor,
  // e o conteúdo continua preso ao container central.
  if (l.corFundoExterna) {
    return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="${css([["background-color", l.corFundoExterna]])}"><tr><td align="center"><table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"${attr("style", `max-width:${g.larguraContainer}px`)}><tr><td style="${estiloInterno}">${tabela}</td></tr></table></td></tr></table>`;
  }
  return `<tr><td style="${estiloInterno}">${tabela}</td></tr>`;
}

// ------------------------------------------------------------------ documento

/** CSS progressivo: só o que PODE ser perdido sem estragar o e-mail. */
function estiloCabecalho(g: GlobaisDoc, cssCustomizado?: string): string {
  return `
    /* Reset mínimo — cada regra existe por um cliente específico. */
    body{margin:0;padding:0;width:100%!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
    table{border-collapse:collapse!important;mso-table-lspace:0pt;mso-table-rspace:0pt}
    img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic}
    /* Impede o iOS/Gmail de transformar data, telefone e endereço em link azul. */
    a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important;font-size:inherit!important;font-family:inherit!important;font-weight:inherit!important;line-height:inherit!important}
    u+#corpo a{color:inherit;text-decoration:none}

    @media only screen and (max-width:${g.breakpointMobile}px){
      .container{width:100%!important;max-width:100%!important}
      /* Empilha as colunas: display:block numa <td> só funciona com width forçada. */
      .coluna{display:block!important;width:100%!important;max-width:100%!important;box-sizing:border-box!important}
      .mobile-oculto{display:none!important;max-height:0!important;overflow:hidden!important}
    }

    /* Dark mode: fixa as cores para o cliente não inverter texto sobre fundo claro. */
    @media (prefers-color-scheme:dark){
      .forcar-cor{color:${g.corTexto}!important}
      .forcar-fundo{background-color:${g.corFundo}!important}
    }
    ${cssCustomizado ?? ""}
  `.trim();
}

export interface ResultadoCompilacao {
  html: string;
  /** Versão text/plain derivada, para o multipart. */
  texto: string;
  avisos: string[];
}

export function compilarDocumento(
  doc: DocumentoEmail,
  opcoes: OpcoesCompilacao = {},
): ResultadoCompilacao {
  const g = { ...GLOBAIS_PADRAO, ...(doc.globais ?? {}) };
  const avisos: string[] = [];

  const linhasSimples: string[] = [];
  const linhasSangradas: string[] = [];
  for (const l of doc.linhas ?? []) {
    const out = compilarLinha(l, g, opcoes);
    if (!out) continue;
    (l.corFundoExterna ? linhasSangradas : linhasSimples).push(out);
  }

  // Linha com fundo sangrado sai FORA do container central (ela é o container dela).
  const corpoContainer = linhasSimples.length
    ? `<table role="presentation" border="0" cellpadding="0" cellspacing="0" class="container" width="${g.larguraContainer}" style="${css([
      ["width", px(g.larguraContainer)],
      ["max-width", px(g.larguraContainer)],
      ["background-color", g.corFundo],
    ])}">${linhasSimples.join("")}</table>`
    : "";

  const preheader = doc.preheader
    ? `<div style="display:none;font-size:1px;color:${g.corFundo};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">${esc(txt(doc.preheader, opcoes, false))}</div>`
    : "";

  const pixel = opcoes.pixelUrl
    ? `<img${attr("src", opcoes.pixelUrl)} width="1" height="1" alt="" style="display:none;border:0" />`
    : "";

  // Descadastro é OBRIGATÓRIO no disparo em massa (LGPD/CAN-SPAM e exigência de
  // Gmail/Yahoo para remetente de volume). Fica no rodapé, dentro do container.
  const rodape = opcoes.descadastroUrl
    ? `<table role="presentation" border="0" cellpadding="0" cellspacing="0" class="container" width="${g.larguraContainer}" style="${css([["width", px(g.larguraContainer)], ["max-width", px(g.larguraContainer)]])}"><tr><td style="${css([
      ["padding", "16px 24px"],
      ["font-family", g.fonte],
      ["font-size", "12px"],
      ["line-height", "1.5"],
      ["color", "#71717a"],
      ["text-align", "center"],
    ])}"><a${attr("href", opcoes.descadastroUrl)} style="${css([["color", "#71717a"], ["text-decoration", "underline"]])}">${esc(opcoes.descadastroTexto ?? "Descadastrar deste tipo de e-mail")}</a></td></tr></table>`
    : "";

  if (!opcoes.descadastroUrl) {
    avisos.push("Sem link de descadastro: obrigatório em disparo de massa (LGPD/CAN-SPAM).");
  }
  if (!doc.preheader) {
    avisos.push("Sem preheader: o cliente de e-mail vai usar a primeira frase do corpo.");
  }

  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<meta name="color-scheme" content="light dark" />
<meta name="supported-color-schemes" content="light dark" />
<title>${esc(txt(doc.nome, opcoes, false))}</title>
<!--[if mso]>
<noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<![endif]-->
<style type="text/css">${estiloCabecalho(g, doc.cssCustomizado)}</style>
</head>
<body id="corpo" class="forcar-fundo" style="${css([
    ["margin", "0"],
    ["padding", "0"],
    ["background-color", g.corFundoPagina],
    ["font-family", g.fonte],
    ["color", g.corTexto],
  ])}">
${preheader}
<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="${css([["background-color", g.corFundoPagina]])}">
<tr><td align="center" style="${css([["padding", "24px 8px"]])}">
<!--[if mso]><table role="presentation" border="0" cellpadding="0" cellspacing="0" width="${g.larguraContainer}"><tr><td><![endif]-->
${linhasSangradas.join("")}
${corpoContainer}
${rodape}
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
${pixel}
</body>
</html>`;

  return {
    html: opcoes.minificar ? minificar(html) : html,
    texto: gerarTextoSimples(doc, opcoes),
    avisos,
  };
}

/** Minificação conservadora: NÃO mexe dentro de condicional do Outlook. */
function minificar(html: string): string {
  return html
    .replace(/\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * Versão text/plain a partir do documento (não do HTML) — sai mais limpa, porque
 * conhece a semântica de cada bloco em vez de tentar desmontar tabela.
 */
export function gerarTextoSimples(doc: DocumentoEmail, opcoes: OpcoesCompilacao = {}): string {
  const partes: string[] = [];
  if (doc.preheader) partes.push(txt(doc.preheader, opcoes, false));

  for (const l of doc.linhas ?? []) {
    if (l.oculto) continue;
    for (const c of l.colunas) {
      for (const b of c.blocos) {
        if (!blocoVisivel(b, "desktop")) continue;
        switch (b.tipo) {
          case "texto":
          case "texto-dinamico":
            partes.push(txt(b.props.texto, opcoes, false));
            break;
          case "texto-composto":
            partes.push(semTags(txt(b.props.html, opcoes, false)));
            break;
          case "botao":
          case "link":
          case "link-dinamico": {
            const alvo = prepararHref(txt(b.props.href, opcoes, false), opcoes);
            partes.push(`${txt(b.props.texto, opcoes, false)}: ${alvo}`.trim());
            break;
          }
          case "lista":
            for (const i of b.props.itens ?? []) partes.push(`- ${txt(i, opcoes, false)}`);
            break;
          case "imagem":
          case "imagem-link":
          case "imagem-dinamica":
          case "video": {
            const alt = txt(b.props.alt, opcoes, false);
            if (alt) partes.push(`[${alt}]`);
            break;
          }
          case "separador":
            partes.push("---");
            break;
          case "html":
          case "html-dinamico":
            partes.push(semTags(txt(b.props.html, opcoes, false)));
            break;
          default:
            break;
        }
      }
    }
  }

  if (opcoes.descadastroUrl) {
    partes.push("", `${opcoes.descadastroTexto ?? "Descadastrar"}: ${opcoes.descadastroUrl}`);
  }
  return partes.filter((p) => p !== undefined).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function semTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .trim();
}
