/**
 * Faixa do LOGO INSTITUCIONAL no topo do e-mail — o padrão da casa.
 *
 * Todo e-mail nosso abre com a marca. Pedir isso ao modelo no prompt não garante
 * nada (ele esquece, ou troca por um texto "PPGVET EDUCAÇÃO" dentro do cabeçalho
 * colorido), então a faixa é INSERIDA depois, aqui, com estrutura fixa: uma linha
 * própria, fundo branco dentro do container, logo centralizado a 180px.
 *
 * Branco é deliberado: o logo colorido tem letra em turquesa e bicho em magenta, e
 * a IA escolhe a paleta do cabeçalho livremente — sobre verde escuro ou magenta o
 * logo sumiria. A faixa é só o container (600px); a área externa continua com a cor
 * de página do documento.
 *
 * ⚠️ Arquivo do diretório FONTE ÚNICA (front + edge + vitest): TypeScript puro,
 * sem dependência e sem API de plataforma. Ver o cabeçalho de `types.ts`.
 */
import type { Bloco, DocumentoEmail, Linha } from "./types.ts";

/**
 * Caminho FIXO no bucket público `email-imagens`.
 *
 * Fixo porque a URL precisa ser previsível por quem monta o documento sem subir
 * nada (construtor em branco) — o upload aleatório `ia-<uuid>` não serve.
 *
 * ⚠️ Versionado no NOME. O arquivo publicado é imutável na prática: o bucket só
 * aceita UPDATE de quem é gestão, e o `cache-control` é de um ano. Trocar a arte
 * (ou o tamanho dela) é publicar um caminho novo, nunca reescrever este — e-mail
 * já enviado continua buscando o caminho antigo, para sempre.
 * `-400` = a largura do arquivo: 400x225, ~30 KB (o asset original tem 1920x1080
 * e 168 KB para mostrar 180px, o que é peso puro no celular de quem recebe).
 */
export const CAMINHO_LOGO_TOPO_EMAIL = "institucional/logo-ppgvet-400.png";
/** Prefixo comum a TODAS as versões do arquivo — é assim que se reconhece a faixa
 *  de um e-mail montado antes da versão atual, e não se insere uma segunda. */
export const PREFIXO_LOGO_TOPO_EMAIL = "/email-imagens/institucional/logo-ppgvet";
/** 180px é a largura usada no atributo `width` do `<img>` — o que o Outlook obedece. */
export const LARGURA_LOGO_TOPO_EMAIL = 180;
export const ALT_LOGO_TOPO_EMAIL = "PPGVET Educação";
/** Destino do clique. Sem UTM à mão de propósito: `aplicarUtm` (links.ts) não
 *  sobrescreve parâmetro escrito pelo autor, e fixar um aqui apagaria o
 *  `utm_content` que a campanha usa para separar as versões A e B. */
export const DESTINO_LOGO_TOPO_EMAIL = "https://ppgvet.com.br/";
export const ID_LINHA_LOGO_TOPO_EMAIL = "lin_logo_ppgvet";
export const ID_BLOCO_LOGO_TOPO_EMAIL = "b_logo_ppgvet";

/** URL pública do logo institucional na instância configurada. */
export function urlLogoTopoEmail(urlPublica: string): string {
  return `${(urlPublica ?? "").replace(/\/+$/, "")}/storage/v1/object/public/email-imagens/${CAMINHO_LOGO_TOPO_EMAIL}`;
}

/** O bloco sozinho — é o que a biblioteca do construtor insere numa coluna. */
export function blocoLogoTopoEmail(url: string): Bloco {
  return {
    id: ID_BLOCO_LOGO_TOPO_EMAIL,
    // Logo clicável: leva ao site. O compilador já põe `border:0` para não sobrar
    // a moldura azul do Outlook, e o rastreio de cliques do envio reconhece o
    // destino sem precisar de parâmetro nosso.
    tipo: "imagem-link",
    nome: "Logo PPGVET",
    props: { src: url, alt: ALT_LOGO_TOPO_EMAIL, href: DESTINO_LOGO_TOPO_EMAIL, alvo: "_blank" },
    estilo: {
      alinhamento: "center",
      largura: `${LARGURA_LOGO_TOPO_EMAIL}px`,
      // `corFundo` é o prato branco atrás do PNG transparente — é o que salva o
      // logo no modo escuro do cliente de e-mail (ver compilarImagem).
      corFundo: "#ffffff",
      padding: { topo: 24, direita: 24, baixo: 16, esquerda: 24 },
    },
    estiloMobile: { largura: "150px", padding: { topo: 20, direita: 16, baixo: 12, esquerda: 16 } },
  };
}

export function linhaLogoTopoEmail(url: string): Linha {
  return {
    id: ID_LINHA_LOGO_TOPO_EMAIL,
    nome: "Logo institucional",
    colunas: [{ id: "col_logo_ppgvet", larguraPct: 100, blocos: [blocoLogoTopoEmail(url)] }],
    estilo: { corFundo: "#ffffff", padding: { topo: 0, direita: 0, baixo: 0, esquerda: 0 } },
  };
}

/** O documento já mostra este logo em algum ponto? Serve para não duplicar quando
 *  a IA (ou a pessoa) já colocou o logo no e-mail — inclusive uma VERSÃO ANTERIOR
 *  do arquivo, que continua sendo o mesmo logo na tela de quem recebe. */
export function emailTemLogoTopo(doc: DocumentoEmail, url: string): boolean {
  const ehLogo = (src: unknown) => typeof src === "string" && (src === url || src.includes(PREFIXO_LOGO_TOPO_EMAIL));
  return doc.linhas.some(l => l.id === ID_LINHA_LOGO_TOPO_EMAIL
    || l.colunas.some(c => c.blocos.some(b => b.id === ID_BLOCO_LOGO_TOPO_EMAIL || ehLogo(b.props.src))));
}

/** Devolve o documento com a faixa do logo na PRIMEIRA linha. Sem alteração quando
 *  o logo já está lá — inclusive quando a IA o manteve de uma geração anterior. */
export function garantirLogoTopoEmail(doc: DocumentoEmail, url: string): DocumentoEmail {
  if (!url || emailTemLogoTopo(doc, url)) return doc;
  return { ...doc, linhas: [linhaLogoTopoEmail(url), ...doc.linhas] };
}
