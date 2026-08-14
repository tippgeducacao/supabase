/**
 * Modelo de documento do CONSTRUTOR DE E-MAILS — a fonte da verdade.
 *
 * ⚠️ Este diretório é FONTE ÚNICA compartilhada por três runtimes:
 *   - o front (Vite/React) — preview ao vivo no construtor;
 *   - as edge functions (Deno) — preview no servidor e render no envio;
 *   - o vitest (Node) — a suíte de compatibilidade.
 * Por isso: TypeScript puro, ZERO dependências, sem API de plataforma (nada de
 * `window`, `Deno`, `process`, `Buffer`) e imports relativos com extensão `.ts`.
 *
 * O repo já tem o hábito de ESPELHAR arquivos entre front e edge ("mudou um, mude o
 * outro"). Para um compilador isso seria veneno: duas cópias que divergem fazem o
 * preview mentir sobre o que o destinatário recebe. Aqui é um arquivo só.
 *
 * A estrutura é DELIBERADAMENTE de fluxo (linha → coluna → bloco), sem posicionamento
 * livre: e-mail é tabela aninhada e não suporta `position:absolute`. É o motivo pelo
 * qual o editor de Pages (que é posicionamento livre) não serve de base aqui.
 */

/** Versão do formato. Migração de documento antigo olha para cá. */
export const VERSAO_DOC = 1;

export type Dispositivo = "desktop" | "mobile";
export type Alinhamento = "left" | "center" | "right" | "justify";

/** Blocos suportados. Conjunto FECHADO — é o que nos deixa compilar HTML confiável. */
export type TipoBloco =
  // primários
  | "texto"
  | "botao"
  | "link"
  | "separador"
  | "lista"
  | "imagem"
  | "imagem-link"
  | "video"
  | "espacador"
  // dinâmicos (conteúdo vem de merge tag)
  | "texto-dinamico"
  | "imagem-dinamica"
  | "link-dinamico"
  // avançados
  | "html"
  | "texto-composto"
  | "html-dinamico";

/** Caixa de espaçamento em px. Ausente = herda do global. */
export interface Espacamento {
  topo?: number;
  direita?: number;
  baixo?: number;
  esquerda?: number;
}

/** Estilo comum a blocos. Tudo opcional: o que faltar cai no global. */
export interface EstiloBloco {
  corTexto?: string;
  corFundo?: string;
  fonte?: string;
  tamanhoFonte?: number;
  pesoFonte?: number | string;
  alturaLinha?: number | string;
  alinhamento?: Alinhamento;
  padding?: Espacamento;
  borda?: { largura?: number; cor?: string; estilo?: "solid" | "dashed" | "dotted" };
  raio?: number;
  largura?: string;
  altura?: string;
}

/**
 * Props do bloco. Bag por tipo — o compilador estreita por `tipo`.
 * Só o que o e-mail precisa; nada de estado de UI aqui.
 */
export interface PropsBloco {
  /** texto / botão / link: conteúdo. Aceita merge tags. */
  texto?: string;
  /** texto-composto e html*: markup already rich. */
  html?: string;
  /** botão / link / imagem-link: destino. Aceita merge tags. */
  href?: string;
  alvo?: "_blank" | "_self";
  /** imagem */
  src?: string;
  alt?: string;
  /** lista */
  itens?: string[];
  ordenada?: boolean;
  /** video: e-mail não roda player — vira thumbnail clicável. */
  thumbnail?: string;
  /** separador */
  espessura?: number;
  /** espaçador */
  altura?: number;
  /** blocos dinâmicos: a merge tag que resolve o conteúdo. */
  variavel?: string;
  /** fallback quando a variável não resolve (além do filtro na própria tag). */
  fallback?: string;
}

export interface Bloco {
  id: string;
  tipo: TipoBloco;
  /** Nome amigável no gerenciador de camadas. */
  nome?: string;
  props: PropsBloco;
  estilo?: EstiloBloco;
  /** Overrides ESPARSOS do mobile — só o que divergir do desktop.
   *  Efetivo = `{ ...estilo, ...estiloMobile }`. Mesmo padrão já provado no editor
   *  de Pages, que é o único pedaço daquele editor que se aproveita aqui. */
  estiloMobile?: EstiloBloco;
  /** Visibilidade por dispositivo (ausente = visível nos dois). */
  visivel?: { desktop?: boolean; mobile?: boolean };
  oculto?: boolean;
}

export interface Coluna {
  id: string;
  /** Largura em % do container. As colunas de uma linha devem somar 100. */
  larguraPct: number;
  blocos: Bloco[];
  estilo?: Pick<EstiloBloco, "corFundo" | "padding" | "borda" | "raio">;
  /** Alinhamento vertical do conteúdo da coluna. */
  alinhamentoVertical?: "top" | "middle" | "bottom";
}

export interface Linha {
  id: string;
  nome?: string;
  colunas: Coluna[];
  estilo?: Pick<EstiloBloco, "corFundo" | "padding">;
  /** Cor de fundo que sangra na largura total (fora do container de 600px). */
  corFundoExterna?: string;
  /** No mobile as colunas empilham (padrão). false = mantém lado a lado. */
  empilharMobile?: boolean;
  oculto?: boolean;
}

/** Estilos globais do documento — a aba "GLOBAIS" do construtor. */
export interface GlobaisDoc {
  larguraContainer: number;
  fonte: string;
  corFundo: string;
  /** Fundo da área externa ao container. */
  corFundoPagina: string;
  corTexto: string;
  corLink: string;
  tamanhoFonte: number;
  alturaLinha: number | string;
  paddingPadrao: Espacamento;
  breakpointMobile: number;
}

export const GLOBAIS_PADRAO: GlobaisDoc = {
  // 600px é o consenso histórico: cabe no painel de leitura do Outlook sem cortar.
  larguraContainer: 600,
  fonte: "Arial, Helvetica, sans-serif",
  corFundo: "#ffffff",
  corFundoPagina: "#f4f4f5",
  corTexto: "#18181b",
  corLink: "#7c3aed",
  tamanhoFonte: 16,
  alturaLinha: 1.5,
  paddingPadrao: { topo: 12, direita: 24, baixo: 12, esquerda: 24 },
  breakpointMobile: 480,
};

export interface DocumentoEmail {
  versao: number;
  nome: string;
  globais: GlobaisDoc;
  linhas: Linha[];
  /** CSS extra injetado no <head> (aba "CÓDIGO CUSTOMIZADO"). */
  cssCustomizado?: string;
  /** Texto do preheader — o trecho que aparece na lista da caixa, ao lado do assunto.
   *  Sem isso o cliente de e-mail usa a primeira frase do corpo, que costuma ser ruim. */
  preheader?: string;
}

export function docVazio(nome = "Novo e-mail"): DocumentoEmail {
  return { versao: VERSAO_DOC, nome, globais: { ...GLOBAIS_PADRAO }, linhas: [] };
}

/** Estilo efetivo de um bloco no dispositivo pedido. */
export function estiloEfetivo(bloco: Bloco, dispositivo: Dispositivo): EstiloBloco {
  if (dispositivo === "desktop") return bloco.estilo ?? {};
  return { ...(bloco.estilo ?? {}), ...(bloco.estiloMobile ?? {}) };
}

export function blocoVisivel(bloco: Bloco, dispositivo: Dispositivo): boolean {
  if (bloco.oculto) return false;
  return bloco.visivel?.[dispositivo] !== false;
}
