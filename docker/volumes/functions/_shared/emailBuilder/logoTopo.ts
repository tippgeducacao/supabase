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

/** Caminho FIXO no bucket público `email-imagens`.
 *  Fixo porque a URL precisa ser previsível por quem monta o documento sem subir
 *  nada (construtor em branco) — o upload aleatório `ia-<uuid>` não serve. */
export const CAMINHO_LOGO_TOPO_EMAIL = "institucional/logo-ppgvet.png";
/** 180px é a largura usada no atributo `width` do `<img>` — o que o Outlook obedece. */
export const LARGURA_LOGO_TOPO_EMAIL = 180;
export const ALT_LOGO_TOPO_EMAIL = "PPGVET Educação";
export const ID_LINHA_LOGO_TOPO_EMAIL = "lin_logo_ppgvet";
export const ID_BLOCO_LOGO_TOPO_EMAIL = "b_logo_ppgvet";

/** URL pública do logo institucional na instância configurada. */
export function urlLogoTopoEmail(urlPublica: string): string {
  return `${urlPublica.replace(/\/+$/, "")}/storage/v1/object/public/email-imagens/${CAMINHO_LOGO_TOPO_EMAIL}`;
}

export function linhaLogoTopoEmail(url: string): Linha {
  const logo: Bloco = {
    id: ID_BLOCO_LOGO_TOPO_EMAIL,
    tipo: "imagem",
    nome: "Logo PPGVET",
    props: { src: url, alt: ALT_LOGO_TOPO_EMAIL },
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
  return {
    id: ID_LINHA_LOGO_TOPO_EMAIL,
    nome: "Logo institucional",
    colunas: [{ id: "col_logo_ppgvet", larguraPct: 100, blocos: [logo] }],
    estilo: { corFundo: "#ffffff", padding: { topo: 0, direita: 0, baixo: 0, esquerda: 0 } },
  };
}

/** O documento já mostra este logo em algum ponto? Serve para não duplicar quando
 *  a IA (ou a pessoa) já colocou o logo no e-mail. */
export function emailTemLogoTopo(doc: DocumentoEmail, url: string): boolean {
  return doc.linhas.some(l => l.id === ID_LINHA_LOGO_TOPO_EMAIL
    || l.colunas.some(c => c.blocos.some(b => b.id === ID_BLOCO_LOGO_TOPO_EMAIL || b.props.src === url)));
}

/** Devolve o documento com a faixa do logo na PRIMEIRA linha. Sem alteração quando
 *  o logo já está lá — inclusive quando a IA o manteve de uma geração anterior. */
export function garantirLogoTopoEmail(doc: DocumentoEmail, url: string): DocumentoEmail {
  if (!url || emailTemLogoTopo(doc, url)) return doc;
  return { ...doc, linhas: [linhaLogoTopoEmail(url), ...doc.linhas] };
}
