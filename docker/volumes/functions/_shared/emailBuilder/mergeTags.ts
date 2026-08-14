/**
 * Merge tags — `{{contato.primeiro_nome | fallback:"Olá"}}`
 *
 * Fonte única (front + edge + vitest): ver o cabeçalho de `types.ts`.
 *
 * ⚠️ COMPATIBILIDADE COM O QUE JÁ RODA: existem 29 templates em produção (funil de TCC)
 * usando a sintaxe simples `{{nome}}`, resolvida hoje pelo `renderTemplate` do
 * `email-send`. Este motor precisa continuar entregando o MESMO resultado para elas —
 * por isso `{{nome}}` sem filtro e sem ponto continua sendo uma busca rasa na bag de
 * variáveis, e tag não resolvida continua saindo literal (`{{nome}}`) em vez de vazia.
 * Mudar isso silenciosamente estragaria e-mail que a Secretaria manda todo dia.
 */

/** Um filtro aplicado à tag, na ordem em que aparece. */
export interface Filtro {
  nome: string;
  arg?: string;
}

export interface TagAnalisada {
  /** Texto original completo, com as chaves. */
  bruto: string;
  /** Caminho da variável, ex.: "contato.primeiro_nome". */
  caminho: string;
  filtros: Filtro[];
}

/**
 * Captura `{{ ... }}` de forma não-gulosa. Não tenta ser um parser de expressão:
 * o conteúdo é dividido por `|` fora de aspas, o que cobre a sintaxe especificada
 * sem abrir a porta para execução de código no template.
 */
const RE_TAG = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Divide por `|` respeitando aspas — `fallback:"a|b"` não pode ser cortado no meio. */
function dividirForaDeAspas(entrada: string): string[] {
  const partes: string[] = [];
  let atual = "";
  let aspas: '"' | "'" | null = null;
  for (let i = 0; i < entrada.length; i++) {
    const c = entrada[i];
    if (aspas) {
      if (c === aspas && entrada[i - 1] !== "\\") aspas = null;
      atual += c;
      continue;
    }
    if (c === '"' || c === "'") { aspas = c; atual += c; continue; }
    if (c === "|") { partes.push(atual); atual = ""; continue; }
    atual += c;
  }
  partes.push(atual);
  return partes.map((p) => p.trim()).filter((p) => p.length > 0);
}

function tirarAspas(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).replace(/\\(["'])/g, "$1");
  }
  return t;
}

export function analisarTag(conteudo: string, bruto: string): TagAnalisada {
  const partes = dividirForaDeAspas(conteudo);
  const caminho = partes.shift() ?? "";
  const filtros: Filtro[] = partes.map((p) => {
    const idx = p.indexOf(":");
    if (idx === -1) return { nome: p.trim().toLowerCase() };
    return {
      nome: p.slice(0, idx).trim().toLowerCase(),
      arg: tirarAspas(p.slice(idx + 1)),
    };
  });
  return { bruto, caminho: caminho.trim(), filtros };
}

/** Todas as tags de um texto, na ordem de aparição (com repetição). */
export function extrairTags(texto: string): TagAnalisada[] {
  const achadas: TagAnalisada[] = [];
  for (const m of texto.matchAll(RE_TAG)) {
    achadas.push(analisarTag(m[1], m[0]));
  }
  return achadas;
}

/** Busca `a.b.c` num objeto aninhado, sem estourar em nulo pelo caminho. */
function buscarCaminho(dados: Record<string, unknown>, caminho: string): unknown {
  if (!caminho) return undefined;
  // Compatibilidade: `{{nome}}` (sem ponto) primeiro tenta a chave rasa, que é como
  // os 29 templates legados alimentam suas variáveis.
  if (!caminho.includes(".") && caminho in dados) return dados[caminho];

  let atual: unknown = dados;
  for (const parte of caminho.split(".")) {
    if (atual === null || atual === undefined) return undefined;
    if (typeof atual !== "object") return undefined;
    atual = (atual as Record<string, unknown>)[parte];
  }
  return atual;
}

function vazio(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

/** Escapa para uso seguro dentro de HTML — merge tag NUNCA injeta markup. */
export function escaparHtml(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function capitalizar(s: string): string {
  return s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

/**
 * Filtros suportados. Conjunto fechado de propósito: template é conteúdo editável por
 * usuário, então nada aqui pode virar execução arbitrária.
 */
function aplicarFiltros(valor: unknown, filtros: Filtro[]): { valor: unknown; usouFallback: boolean } {
  let v = valor;
  let usouFallback = false;

  for (const f of filtros) {
    switch (f.nome) {
      case "fallback":
      case "default":
        if (vazio(v)) { v = f.arg ?? ""; usouFallback = true; }
        break;
      case "upper":
        if (!vazio(v)) v = String(v).toUpperCase();
        break;
      case "lower":
        if (!vazio(v)) v = String(v).toLowerCase();
        break;
      case "capitalize":
        if (!vazio(v)) v = capitalizar(String(v).toLowerCase());
        break;
      case "trim":
        if (!vazio(v)) v = String(v).trim();
        break;
      case "primeiro_nome":
      case "first_word":
        if (!vazio(v)) v = String(v).trim().split(/\s+/)[0] ?? "";
        break;
      case "truncate": {
        const n = Number(f.arg ?? 0);
        if (!vazio(v) && Number.isFinite(n) && n > 0 && String(v).length > n) {
          v = String(v).slice(0, n).trimEnd() + "…";
        }
        break;
      }
      case "date": {
        // Só formatos fixos — nada de string de formato arbitrária.
        if (!vazio(v)) {
          const d = new Date(String(v));
          if (!Number.isNaN(d.getTime())) {
            v = f.arg === "iso" ? d.toISOString().slice(0, 10) : d.toLocaleDateString("pt-BR");
          }
        }
        break;
      }
      default:
        // Filtro desconhecido é ignorado no render (o valor passa direto) e reportado
        // por `validarTags` — falhar o envio por um filtro escrito errado seria pior.
        break;
    }
  }
  return { valor: v, usouFallback };
}

export interface OpcoesRender {
  /** Escapar o valor para HTML. Desligue só para contexto text/plain. */
  escapar?: boolean;
  /**
   * O que fazer com tag que não resolve e não tem fallback.
   * 'literal' (padrão) mantém `{{tag}}` — é o comportamento atual do email-send e o
   * que os 29 templates legados esperam. 'vazio' remove.
   */
  naoResolvida?: "literal" | "vazio";
}

/** Substitui as merge tags de um texto pelos valores de `dados`. */
export function renderizarTags(
  texto: string,
  dados: Record<string, unknown>,
  opcoes: OpcoesRender = {},
): string {
  const { escapar = true, naoResolvida = "literal" } = opcoes;
  if (!texto) return texto;

  return texto.replace(RE_TAG, (bruto, conteudo: string) => {
    const tag = analisarTag(conteudo, bruto);
    const cru = buscarCaminho(dados, tag.caminho);
    const { valor, usouFallback } = aplicarFiltros(cru, tag.filtros);

    if (vazio(valor) && !usouFallback) {
      return naoResolvida === "vazio" ? "" : bruto;
    }
    const texto2 = String(valor ?? "");
    return escapar ? escaparHtml(texto2) : texto2;
  });
}

// ------------------------------------------------------------------ validação

export interface ProblemaTag {
  tag: string;
  caminho: string;
  tipo: "variavel-desconhecida" | "filtro-desconhecido" | "sem-fallback";
  mensagem: string;
}

export const FILTROS_CONHECIDOS = [
  "fallback", "default", "upper", "lower", "capitalize",
  "trim", "primeiro_nome", "first_word", "truncate", "date",
];

/**
 * Confere as tags de um texto contra o catálogo de variáveis disponíveis.
 * Roda no construtor (aviso ao usuário) e antes do envio — é o que evita mandar
 * "Olá {{contato.primeiro_nome}}" literal para 2.000 pessoas.
 */
export function validarTags(texto: string, caminhosValidos: string[]): ProblemaTag[] {
  const validos = new Set(caminhosValidos);
  const problemas: ProblemaTag[] = [];

  for (const tag of extrairTags(texto)) {
    if (tag.caminho && !validos.has(tag.caminho)) {
      problemas.push({
        tag: tag.bruto,
        caminho: tag.caminho,
        tipo: "variavel-desconhecida",
        mensagem: `A variável "${tag.caminho}" não existe no catálogo.`,
      });
    }
    for (const f of tag.filtros) {
      if (!FILTROS_CONHECIDOS.includes(f.nome)) {
        problemas.push({
          tag: tag.bruto,
          caminho: tag.caminho,
          tipo: "filtro-desconhecido",
          mensagem: `O filtro "${f.nome}" não existe e será ignorado.`,
        });
      }
    }
    const temFallback = tag.filtros.some((f) => f.nome === "fallback" || f.nome === "default");
    if (tag.caminho && !temFallback) {
      problemas.push({
        tag: tag.bruto,
        caminho: tag.caminho,
        tipo: "sem-fallback",
        mensagem: `"${tag.caminho}" não tem fallback — se o dado faltar, a tag sai literal no e-mail.`,
      });
    }
  }
  return problemas;
}
