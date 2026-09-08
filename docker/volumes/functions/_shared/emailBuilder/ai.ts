/** Contrato da IA: JSON de blocos nativos, nunca HTML/CSS executável no canvas. */
import {
  GLOBAIS_PADRAO, VERSAO_DOC,
  type Bloco, type Coluna, type DocumentoEmail, type Espacamento,
  type EstiloBloco, type GlobaisDoc, type Linha, type PropsBloco,
} from "./types.ts";

const TIPOS = ["texto", "botao", "link", "lista", "imagem", "imagem-link", "video", "separador", "espacador"] as const;
type TipoSeguro = typeof TIPOS[number];
type Objeto = Record<string, unknown>;
const FONTES: Record<string, string> = {
  arial: "Arial, Helvetica, sans-serif",
  helvetica: "Helvetica, Arial, sans-serif",
  verdana: "Verdana, Geneva, sans-serif",
  tahoma: "Tahoma, Verdana, sans-serif",
  "trebuchet ms": "'Trebuchet MS', Helvetica, sans-serif",
  georgia: "Georgia, 'Times New Roman', serif",
  "times new roman": "'Times New Roman', Times, serif",
  "courier new": "'Courier New', Courier, monospace",
};

/** Metadados definidos pelo contrato, sem valores gerados ou dados do pedido.
 * A edge pode diagnosticar uma recusa sem registrar o e-mail nem prompts. */
export class ErroDocumentoIA extends Error {
  constructor(public readonly caminho: string, public readonly motivo: string) {
    super(`Documento da IA inválido em ${caminho}: ${motivo}.`);
    this.name = "ErroDocumentoIA";
  }
}

function erro(caminho: string, motivo: string): never {
  throw new ErroDocumentoIA(caminho, motivo);
}

function objeto(valor: unknown, caminho: string): Objeto {
  if (valor === null || typeof valor !== "object" || Array.isArray(valor)) erro(caminho, "esperado objeto");
  const proto = Object.getPrototypeOf(valor);
  if (proto !== Object.prototype && proto !== null) erro(caminho, "esperado objeto JSON simples");
  return valor as Objeto;
}

function campos(valor: Objeto, permitidos: string[], caminho: string): void {
  for (const chave of Object.keys(valor)) {
    if (!permitidos.includes(chave)) erro(caminho, "campo não permitido");
  }
}

function temControle(valor: string, permitirQuebra = false): boolean {
  return [...valor].some(c => {
    const n = c.charCodeAt(0);
    return n === 127 || (n < 32 && !(permitirQuebra && [9, 10, 13].includes(n)));
  });
}

function texto(valor: unknown, caminho: string, limite: number, obrigatorio = false): string {
  if (typeof valor !== "string") erro(caminho, "esperado texto");
  if (valor.length > limite) erro(caminho, `texto excede ${limite} caracteres`);
  if (temControle(valor, true)) erro(caminho, "caractere de controle não permitido");
  const resultado = valor.trim();
  if (obrigatorio && !resultado) erro(caminho, "texto obrigatório");
  return resultado;
}

function numero(valor: unknown, caminho: string, minimo: number, maximo: number): number {
  if (typeof valor !== "number" || !Number.isFinite(valor)) erro(caminho, "esperado número finito");
  return Math.min(maximo, Math.max(minimo, valor));
}

function booleano(valor: unknown, caminho: string): boolean {
  if (typeof valor !== "boolean") erro(caminho, "esperado booleano");
  return valor;
}

function escolha<T extends string>(valor: unknown, opcoes: readonly T[], caminho: string): T {
  if (typeof valor !== "string" || !opcoes.includes(valor as T)) erro(caminho, "opção não permitida");
  return valor as T;
}

function cor(valor: unknown, caminho: string): string {
  const v = texto(valor, caminho, 7, true);
  if (!/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(v)) erro(caminho, "use cor hexadecimal #RGB ou #RRGGBB");
  return v.toLowerCase();
}

function fonte(valor: unknown, caminho: string): string {
  const v = texto(valor, caminho, 100, true);
  const normal = v.toLowerCase().replace(/["']/g, "").replace(/\s*,\s*/g, ",");
  for (const [nome, pilha] of Object.entries(FONTES)) {
    if (normal === nome || normal === pilha.toLowerCase().replace(/["']/g, "").replace(/\s*,\s*/g, ",")) return pilha;
  }
  erro(caminho, "use uma fonte web-safe do catálogo");
}

function padding(valor: unknown, caminho: string): Espacamento {
  const v = objeto(valor, caminho);
  campos(v, ["topo", "direita", "baixo", "esquerda"], caminho);
  const resultado: Espacamento = {};
  for (const lado of ["topo", "direita", "baixo", "esquerda"] as const) {
    if (v[lado] !== undefined) resultado[lado] = numero(v[lado], `${caminho}.${lado}`, 0, 80);
  }
  return resultado;
}

function dimensao(valor: unknown, caminho: string): string {
  if (typeof valor === "number") return `${numero(valor, caminho, 0, 800)}px`;
  const v = texto(valor, caminho, 20, true);
  if (v === "auto") return v;
  const partes = v.match(/^(\d+(?:\.\d+)?)(px|%)$/);
  if (!partes) erro(caminho, "use número em px, porcentagem ou auto");
  return `${numero(Number(partes[1]), caminho, 0, partes[2] === "%" ? 100 : 800)}${partes[2]}`;
}

function estilo(valor: unknown, caminho: string, nivel: "bloco" | "coluna" | "linha" = "bloco"): EstiloBloco {
  const v = objeto(valor, caminho);
  campos(v, nivel === "linha" ? ["corFundo", "padding"] : nivel === "coluna"
    ? ["corFundo", "padding", "borda", "raio"]
    : ["corTexto", "corFundo", "fonte", "tamanhoFonte", "pesoFonte", "alturaLinha", "alinhamento", "padding", "borda", "raio", "largura", "altura"], caminho);
  const e: EstiloBloco = {};
  if (v.corTexto !== undefined) e.corTexto = cor(v.corTexto, `${caminho}.corTexto`);
  if (v.corFundo !== undefined) e.corFundo = cor(v.corFundo, `${caminho}.corFundo`);
  if (v.fonte !== undefined) e.fonte = fonte(v.fonte, `${caminho}.fonte`);
  if (v.tamanhoFonte !== undefined) e.tamanhoFonte = numero(v.tamanhoFonte, `${caminho}.tamanhoFonte`, 10, 72);
  if (v.pesoFonte !== undefined) e.pesoFonte = v.pesoFonte === "normal" ? 400 : v.pesoFonte === "bold" ? 700 : numero(v.pesoFonte, `${caminho}.pesoFonte`, 100, 900);
  if (v.alturaLinha !== undefined) e.alturaLinha = numero(v.alturaLinha, `${caminho}.alturaLinha`, 1, 3);
  if (v.alinhamento !== undefined) e.alinhamento = escolha(v.alinhamento, ["left", "center", "right", "justify"] as const, `${caminho}.alinhamento`);
  if (v.padding !== undefined) e.padding = padding(v.padding, `${caminho}.padding`);
  if (v.raio !== undefined) e.raio = numero(v.raio, `${caminho}.raio`, 0, 60);
  if (v.largura !== undefined) e.largura = dimensao(v.largura, `${caminho}.largura`);
  if (v.altura !== undefined) e.altura = dimensao(v.altura, `${caminho}.altura`);
  if (v.borda !== undefined) {
    const b = objeto(v.borda, `${caminho}.borda`);
    campos(b, ["largura", "cor", "estilo"], `${caminho}.borda`);
    e.borda = {};
    if (b.largura !== undefined) e.borda.largura = numero(b.largura, `${caminho}.borda.largura`, 0, 8);
    if (b.cor !== undefined) e.borda.cor = cor(b.cor, `${caminho}.borda.cor`);
    if (b.estilo !== undefined) e.borda.estilo = escolha(b.estilo, ["solid", "dashed", "dotted"] as const, `${caminho}.borda.estilo`);
  }
  return e;
}

/** URLs de imagem não recebem merge tags. Em href só há a tag de descadastro,
 * preenchida pelo servidor: uma variável livre poderia resolver para javascript:. */
function url(valor: unknown, caminho: string, imagem = false): string {
  const v = texto(valor, caminho, 2048, true);
  // CTA sem destino informado ainda pode ser desenhado. O compilador sinaliza
  // esse placeholder para revisão antes do envio; não aceita outros fragmentos.
  if (!imagem && v === "#") return v;
  if (!imagem && /^\{\{\s*descadastro_url\s*\}\}$/.test(v)) return "{{descadastro_url}}";
  if (temControle(v) || /[\s<>"'`\\{}]/.test(v) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(v)) erro(caminho, "URL contém caracteres não permitidos");
  if (!imagem && /^mailto:[a-z0-9.!#$%&*+/=?^_~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(v)) return v;
  if (!imagem && /^tel:\+?[0-9().-]{3,24}$/i.test(v)) return v;
  const partes = v.match(/^https?:\/\/([^/?#]+)(?:[/?#].*)?$/i);
  if (!partes) erro(caminho, imagem ? "imagem exige URL http(s)" : "use URL http(s), mailto, tel ou descadastro_url");
  const autoridade = partes[1].match(/^([a-z0-9.-]+)(?::([0-9]{1,5}))?$/i);
  if (!autoridade || autoridade[1].split(".").some(p => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(p))
    || (autoridade[2] && (Number(autoridade[2]) < 1 || Number(autoridade[2]) > 65535))) erro(caminho, "domínio inválido");
  if (imagem) {
    let decodificada: string;
    try { decodificada = decodeURIComponent(v); } catch { erro(caminho, "URL codificada inválida"); }
    if (/\.svg(?:z)?(?:[/?#]|$)/i.test(decodificada) || /[?&](?:format|fm|type|mime)=[^&#]*svg/i.test(decodificada)) erro(caminho, "SVG não é permitido; use PNG, JPEG, GIF ou WebP");
  }
  return v;
}

function props(valor: unknown, tipo: TipoSeguro, caminho: string): PropsBloco {
  const v = objeto(valor, caminho);
  const catalogo: Record<TipoSeguro, string[]> = {
    texto: ["texto"], botao: ["texto", "href", "alvo"], link: ["texto", "href", "alvo"],
    lista: ["itens", "ordenada"], imagem: ["src", "alt", "href", "alvo"],
    "imagem-link": ["src", "alt", "href", "alvo"], video: ["thumbnail", "src", "href", "texto", "alt", "alvo"],
    separador: ["espessura"], espacador: ["altura"],
  };
  campos(v, catalogo[tipo], caminho);
  const p: PropsBloco = {};
  if (tipo === "texto" || tipo === "botao" || tipo === "link") p.texto = texto(v.texto, `${caminho}.texto`, tipo === "texto" ? 4000 : 200, true);
  if (tipo === "botao" || tipo === "link" || tipo === "imagem-link" || tipo === "video" || v.href !== undefined) p.href = url(v.href, `${caminho}.href`);
  if (tipo === "imagem" || tipo === "imagem-link") p.src = url(v.src, `${caminho}.src`, true);
  if (tipo === "video") {
    p.thumbnail = url(v.thumbnail ?? v.src, `${caminho}.thumbnail`, true);
    if (v.src !== undefined) url(v.src, `${caminho}.src`, true);
    if (v.texto !== undefined) p.texto = texto(v.texto, `${caminho}.texto`, 200);
  }
  if (v.alt !== undefined) p.alt = texto(v.alt, `${caminho}.alt`, 200);
  if (v.alvo !== undefined) p.alvo = escolha(v.alvo, ["_blank", "_self"] as const, `${caminho}.alvo`);
  if (tipo === "lista") {
    if (!Array.isArray(v.itens) || !v.itens.length || v.itens.length > 30) erro(`${caminho}.itens`, "use de 1 a 30 itens");
    p.itens = v.itens.map((item, i) => texto(item, `${caminho}.itens[${i}]`, 500, true));
    if (v.ordenada !== undefined) p.ordenada = booleano(v.ordenada, `${caminho}.ordenada`);
  }
  if (tipo === "separador" && v.espessura !== undefined) p.espessura = numero(v.espessura, `${caminho}.espessura`, 1, 8);
  if (tipo === "espacador" && v.altura !== undefined) p.altura = numero(v.altura, `${caminho}.altura`, 0, 200);
  return p;
}

function globais(valor: unknown): GlobaisDoc {
  const v = objeto(valor, "globais");
  campos(v, Object.keys(GLOBAIS_PADRAO), "globais");
  const g = { ...GLOBAIS_PADRAO, paddingPadrao: { ...GLOBAIS_PADRAO.paddingPadrao } };
  if (v.larguraContainer !== undefined) g.larguraContainer = numero(v.larguraContainer, "globais.larguraContainer", 320, 800);
  if (v.fonte !== undefined) g.fonte = fonte(v.fonte, "globais.fonte");
  for (const campo of ["corFundo", "corFundoPagina", "corTexto", "corLink"] as const) {
    if (v[campo] !== undefined) g[campo] = cor(v[campo], `globais.${campo}`);
  }
  if (v.tamanhoFonte !== undefined) g.tamanhoFonte = numero(v.tamanhoFonte, "globais.tamanhoFonte", 12, 32);
  if (v.alturaLinha !== undefined) g.alturaLinha = numero(v.alturaLinha, "globais.alturaLinha", 1, 3);
  if (v.paddingPadrao !== undefined) g.paddingPadrao = padding(v.paddingPadrao, "globais.paddingPadrao");
  if (v.breakpointMobile !== undefined) g.breakpointMobile = numero(v.breakpointMobile, "globais.breakpointMobile", 320, 640);
  return g;
}

/** Recebe o DOCUMENTO (o chamador extrai o envelope {resumo, documento}).
 * Reconstrói todos os objetos por allowlist; nunca devolve um cast do JSON da IA.
 * IDs não são conteúdo: substituídos por caminhos determinísticos únicos, evitando
 * colisão de seleção do editor e injeção nos seletores CSS do compilador. */
export function validarDocumentoIA(valor: unknown): DocumentoEmail {
  // Alguns provedores serializam o documento dentro do envelope. Aceitamos uma
  // única camada de JSON válido, nunca Markdown, HTML ou extração por heurística.
  // O objeto decodificado passa pela mesma lista de campos e regras de segurança.
  if (typeof valor === "string") {
    if (valor.length > 160000) erro("documento", "conteúdo excede o tamanho permitido");
    try { valor = JSON.parse(valor); } catch { erro("documento", "JSON malformado"); }
  }
  const v = objeto(valor, "documento");
  let serializado: string;
  try { serializado = JSON.stringify(v); } catch { erro("documento", "JSON malformado"); }
  if (serializado.length > 160000) erro("documento", "conteúdo excede o tamanho permitido");
  campos(v, ["versao", "nome", "assunto", "preheader", "globais", "linhas"], "documento");
  if (v.versao !== undefined && v.versao !== VERSAO_DOC) erro("versao", "versão não suportada");
  if (!Array.isArray(v.linhas) || !v.linhas.length || v.linhas.length > 40) erro("linhas", "use de 1 a 40 linhas");
  let totalBlocos = 0;
  const linhas: Linha[] = v.linhas.map((valorLinha, li) => {
    const caminho = `linhas[${li}]`;
    const l = objeto(valorLinha, caminho);
    campos(l, ["id", "nome", "colunas", "estilo", "corFundoExterna", "empilharMobile", "oculto"], caminho);
    if (!Array.isArray(l.colunas) || !l.colunas.length || l.colunas.length > 3) erro(`${caminho}.colunas`, "use de 1 a 3 colunas");
    const colunas: Coluna[] = l.colunas.map((valorColuna, ci) => {
      const cc = `${caminho}.colunas[${ci}]`;
      const c = objeto(valorColuna, cc);
      campos(c, ["id", "larguraPct", "blocos", "estilo", "alinhamentoVertical"], cc);
      if (!Array.isArray(c.blocos) || c.blocos.length > 120) erro(`${cc}.blocos`, "lista de blocos inválida");
      totalBlocos += c.blocos.length;
      if (totalBlocos > 120) erro("blocos", "máximo de 120 blocos por documento");
      const coluna: Coluna = {
        id: `ia-coluna-${li + 1}-${ci + 1}`,
        larguraPct: c.larguraPct === undefined ? 1 : numero(c.larguraPct, `${cc}.larguraPct`, 1, 100),
        blocos: c.blocos.map((valorBloco, bi): Bloco => {
          const cb = `${cc}.blocos[${bi}]`;
          const b = objeto(valorBloco, cb);
          campos(b, ["id", "tipo", "nome", "props", "estilo", "estiloMobile", "visivel", "oculto"], cb);
          const tipo = escolha(b.tipo, TIPOS, `${cb}.tipo`);
          const bloco: Bloco = { id: `ia-bloco-${li + 1}-${ci + 1}-${bi + 1}`, tipo, props: props(b.props === undefined ? {} : b.props, tipo, `${cb}.props`) };
          if (b.nome !== undefined) bloco.nome = texto(b.nome, `${cb}.nome`, 120);
          if (b.estilo !== undefined) bloco.estilo = estilo(b.estilo, `${cb}.estilo`);
          if (b.estiloMobile !== undefined) bloco.estiloMobile = estilo(b.estiloMobile, `${cb}.estiloMobile`);
          if (b.oculto !== undefined) bloco.oculto = booleano(b.oculto, `${cb}.oculto`);
          if (b.visivel !== undefined) {
            const visivel = objeto(b.visivel, `${cb}.visivel`);
            campos(visivel, ["desktop", "mobile"], `${cb}.visivel`);
            bloco.visivel = {};
            if (visivel.desktop !== undefined) bloco.visivel.desktop = booleano(visivel.desktop, `${cb}.visivel.desktop`);
            if (visivel.mobile !== undefined) bloco.visivel.mobile = booleano(visivel.mobile, `${cb}.visivel.mobile`);
          }
          return bloco;
        }),
      };
      if (c.estilo !== undefined) coluna.estilo = estilo(c.estilo, `${cc}.estilo`, "coluna");
      if (c.alinhamentoVertical !== undefined) coluna.alinhamentoVertical = escolha(c.alinhamentoVertical, ["top", "middle", "bottom"] as const, `${cc}.alinhamentoVertical`);
      return coluna;
    });
    const soma = colunas.reduce((n, c) => n + c.larguraPct, 0);
    let restante = 100;
    colunas.forEach((c, i) => {
      c.larguraPct = i === colunas.length - 1 ? restante : Math.round(c.larguraPct / soma * 10000) / 100;
      restante = Math.round((restante - c.larguraPct) * 100) / 100;
    });
    const linha: Linha = { id: `ia-linha-${li + 1}`, colunas, empilharMobile: true };
    if (l.nome !== undefined) linha.nome = texto(l.nome, `${caminho}.nome`, 120);
    if (l.estilo !== undefined) linha.estilo = estilo(l.estilo, `${caminho}.estilo`, "linha");
    if (l.corFundoExterna !== undefined) linha.corFundoExterna = cor(l.corFundoExterna, `${caminho}.corFundoExterna`);
    if (l.empilharMobile !== undefined) linha.empilharMobile = booleano(l.empilharMobile, `${caminho}.empilharMobile`);
    if (l.oculto !== undefined) linha.oculto = booleano(l.oculto, `${caminho}.oculto`);
    return linha;
  });
  if (!totalBlocos) erro("blocos", "o documento precisa conter conteúdo");
  const documento: DocumentoEmail = { versao: VERSAO_DOC, nome: texto(v.nome, "nome", 120, true), globais: globais(v.globais === undefined ? {} : v.globais), linhas };
  if (v.assunto !== undefined) documento.assunto = texto(v.assunto, "assunto", 200);
  if (v.preheader !== undefined) documento.preheader = texto(v.preheader, "preheader", 250);
  return documento;
}

export const PROMPT_DOCUMENTO_IA = `Você monta e-mails visuais editáveis no construtor da PPGVET. Responda SOMENTE JSON válido, sem markdown, no envelope {"resumo":"O que foi criado ou ajustado, até 300 caracteres","documento":{...}}.
O documento inteiro usa: {"versao":1,"nome":"Nome interno (até 120 caracteres)","assunto":"Assunto (até 200)","preheader":"Prévia da mensagem (até 250)","globais":{...},"linhas":[...]}.
Globais: larguraContainer 600, fonte "Arial, Helvetica, sans-serif", corFundo "#ffffff", corFundoPagina "#f4f4f5", corTexto "#18181b", corLink "#7c3aed", tamanhoFonte 16, alturaLinha 1.5, paddingPadrao {topo:12,direita:24,baixo:12,esquerda:24}, breakpointMobile 480. Ajuste a paleta ao pedido. Cores somente #RGB ou #RRGGBB.
Linha: {"nome":"Seção","colunas":[...],"empilharMobile":true,"estilo":{"corFundo":"#ffffff","padding":{...}}}. Pode ter corFundoExterna hexadecimal. Coluna: {"larguraPct":100,"blocos":[...]}; estilo opcional {corFundo,padding,borda,raio}, alinhamentoVertical top/middle/bottom. Até 40 linhas, até 3 colunas por linha, total até 120 blocos. Colunas somam 100%. IDs são dispensáveis: o sistema gera IDs seguros.
Bloco: {"tipo":"texto","nome":"Título","props":{"texto":"Sua próxima conquista"},"estilo":{...},"estiloMobile":{...}}. Catálogo EXCLUSIVO:
- texto: props {texto} (texto puro, até 4000 caracteres; quebras de linha permitidas).
- botao e link: props {texto,href,alvo:"_blank"}; rótulo até 200 caracteres.
- lista: props {itens:["Benefício concreto",...],ordenada:false}; até 30 itens de 500 caracteres.
- imagem e imagem-link: props {src,alt}; imagem-link exige href. Imagens somente URLs públicas http/https PNG/JPEG/GIF/WebP fornecidas no contexto. Não invente URLs, não use SVG/data/base64.
- video: props {thumbnail,href,alt,texto:"Assistir ao vídeo"}; miniatura clicável, nunca player.
- separador: props {espessura:1}.
- espacador: props {altura:24}.
Estilos de bloco desktop/mobile: corTexto,corFundo (hex); fonte web-safe (Arial, Helvetica, Verdana, Tahoma, Trebuchet MS, Georgia, Times New Roman ou Courier New); tamanhoFonte numérico 10–72; pesoFonte numérico 100–900; alturaLinha numérica 1–3; alinhamento left/center/right/justify; padding {topo,direita,baixo,esquerda} numérico 0–80; borda {largura:0–8,cor:"#...",estilo:"solid"/"dashed"/"dotted"}; raio numérico 0–60; largura/altura "100%", "200px" ou "auto". Não use objetos de CSS livre, expressões, URLs de fundo, classes ou nomes de fonte externos.
NUNCA produza html, html-dinamico, texto-composto, props.html, cssCustomizado, scripts, tags HTML ou handlers. Formatação vem dos estilos de blocos separados. Links apenas http(s), mailto, tel ou a tag exata {{descadastro_url}}. Quando o pedido não fornecer destino para o CTA, use exatamente href:"#" como placeholder editável, que será sinalizado para revisão; nunca invente URL. Não use outras variáveis como destino. Texto pode conter {{contato.primeiro_nome | fallback:"Olá"}} e variáveis existentes fornecidas no contexto.
Crie composição visual intencional, não uma parede de texto: hero com título forte e fundo de destaque; abertura curta; benefícios em blocos ou colunas; CTA claro com contraste; respiros, separadores e rodapé discreto. Use imagem somente quando houver URL fornecida; sem imagem, hero tipográfico com cor. Evite inventar preços, prazos, provas sociais ou promessas. Preserve informações do pedido/documento atual. Títulos 28–40px e corpo 16–18px; no mobile reduza títulos e padding, mantendo leitura confortável e colunas empilhadas. Inclua um bloco link de rodapé com texto "Descadastrar" e href "{{descadastro_url}}". Retorne o documento COMPLETO editável, não HTML compilado nem instruções para o usuário.`;
