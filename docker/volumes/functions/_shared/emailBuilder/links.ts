/**
 * Tratamento de links do e-mail: UTM em todos os destinos e wrapping de clique.
 * Fonte única (front + edge + vitest): ver o cabeçalho de `types.ts`.
 */

export interface Utm {
  source?: string | null;
  campaign?: string | null;
  medium?: string | null;
  term?: string | null;
  content?: string | null;
}

/** Esquemas que NÃO recebem UTM nem wrapping — não são navegação web. */
const ESQUEMAS_IGNORADOS = ["mailto:", "tel:", "sms:", "#"];

export function ehLinkNavegavel(href: string): boolean {
  const h = href.trim().toLowerCase();
  if (!h) return false;
  if (ESQUEMAS_IGNORADOS.some((e) => h.startsWith(e))) return false;
  // Link que ainda é uma merge tag pura ({{contato.url}}) só resolve no render:
  // mexer nele agora produziria URL inválida.
  if (h.startsWith("{{")) return false;
  return h.startsWith("http://") || h.startsWith("https://");
}

/**
 * Anexa UTMs a uma URL, SEM sobrescrever parâmetro que o autor já pôs à mão —
 * quem escreveu `?utm_source=newsletter` no link tinha um motivo.
 *
 * Feito com parser manual em vez de `URL`: precisa preservar merge tags no meio da
 * query (`?id={{contato.id}}`), que o `URL` percent-encodaria e quebraria.
 */
export function aplicarUtm(href: string, utm: Utm | null | undefined): string {
  if (!utm || !ehLinkNavegavel(href)) return href;

  const pares: Array<[string, string]> = [];
  const add = (k: string, v: string | null | undefined) => {
    if (v !== null && v !== undefined && String(v).trim() !== "") pares.push([k, String(v).trim()]);
  };
  add("utm_source", utm.source);
  add("utm_campaign", utm.campaign);
  add("utm_medium", utm.medium);
  add("utm_term", utm.term);
  add("utm_content", utm.content);
  if (pares.length === 0) return href;

  const [semHash, ...restoHash] = href.split("#");
  const hash = restoHash.length ? `#${restoHash.join("#")}` : "";
  const temQuery = semHash.includes("?");
  const queryAtual = temQuery ? semHash.slice(semHash.indexOf("?") + 1) : "";
  const base = temQuery ? semHash.slice(0, semHash.indexOf("?")) : semHash;

  const jaExiste = new Set(
    queryAtual.split("&").filter(Boolean).map((p) => p.split("=")[0]),
  );
  const novos = pares
    .filter(([k]) => !jaExiste.has(k))
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`);

  if (novos.length === 0) return href;
  const query = [queryAtual, ...novos].filter(Boolean).join("&");
  return `${base}?${query}${hash}`;
}

/**
 * Envolve o link no redirecionador de cliques.
 * O destino vai percent-encodado num parâmetro para o servidor devolver 302.
 */
export function envolverClique(href: string, baseRastreio: string, envioId: string): string {
  if (!ehLinkNavegavel(href)) return href;
  const sep = baseRastreio.includes("?") ? "&" : "?";
  return `${baseRastreio}${sep}e=${encodeURIComponent(envioId)}&u=${encodeURIComponent(href)}`;
}

export interface OpcoesLink {
  utm?: Utm | null;
  /** Quando presente, todos os links navegáveis passam pelo redirecionador. */
  rastrearCliques?: { baseUrl: string; envioId: string } | null;
}

/** Aplica UTM e (se pedido) wrapping a um href. A ordem importa: UTM primeiro,
 *  para que o destino final registrado já contenha os parâmetros de campanha. */
export function prepararHref(href: string, opcoes: OpcoesLink): string {
  if (!href) return href;
  let saida = aplicarUtm(href, opcoes.utm);
  if (opcoes.rastrearCliques) {
    saida = envolverClique(saida, opcoes.rastrearCliques.baseUrl, opcoes.rastrearCliques.envioId);
  }
  return saida;
}

/** Reescreve os href de um HTML já pronto (usado no caminho legado, que é HTML cru). */
export function prepararLinksNoHtml(html: string, opcoes: OpcoesLink): string {
  if (!html) return html;
  return html.replace(
    /(<a\b[^>]*?\bhref\s*=\s*)(["'])(.*?)\2/gi,
    (inteiro, antes: string, aspas: string, href: string) => {
      const novo = prepararHref(href, opcoes);
      return novo === href ? inteiro : `${antes}${aspas}${novo}${aspas}`;
    },
  );
}
