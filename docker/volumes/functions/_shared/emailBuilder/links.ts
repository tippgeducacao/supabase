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

/**
 * Entidades que aparecem num atributo href escrito pelo compilador (`&` vira
 * `&amp;`). Sem desfazer isso, o destino guardado no rastreio sairia com
 * "&amp;utm_source=..." e o parâmetro morreria no site.
 */
function decodificarHref(href: string): string {
  return href
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#0*39;/g, "'")
    .replace(/&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}

/** Volta para dentro do atributo: `&` precisa virar `&amp;` de novo. */
function escaparHref(href: string): string {
  return href.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** Que elemento do e-mail recebeu o clique. Vem do atributo data-elemento que o compilador
 *  põe em cada <a>; em HTML legado (sem o atributo) é deduzido: tem <img> = imagem, senão link. */
export const ELEMENTOS_CLIQUE = ["botao", "link", "imagem", "video"] as const;
export type ElementoClique = typeof ELEMENTOS_CLIQUE[number];
export const LIMITE_ROTULO_CLIQUE = 80;

export interface InfoClique {
  elemento: ElementoClique;
  /** Texto do botão/link ou alt da imagem. Só para o relatório se entender; até 80 caracteres. */
  rotulo: string;
}

export function ehElementoClique(v: unknown): v is ElementoClique {
  return typeof v === "string" && (ELEMENTOS_CLIQUE as readonly string[]).includes(v);
}

/** Rótulo seguro para guardar/exibir: sem tag, sem quebra, sem caractere de controle. */
export function limparRotuloClique(bruto: string): string {
  return decodificarHref(bruto)
    .replace(/<[^>]*>/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LIMITE_ROTULO_CLIQUE);
}

/**
 * Lê, no HTML, o elemento e o rótulo do <a> que começa em `inicio`. O tag vai até o
 * primeiro ">" e o conteúdo até o próximo </a> (ou o próximo <a>, se o HTML estiver mal fechado).
 */
function infoDoAnchor(html: string, inicio: number): InfoClique {
  const fimTag = html.indexOf(">", inicio);
  const tag = fimTag < 0 ? html.slice(inicio) : html.slice(inicio, fimTag + 1);
  const corpoDepois = fimTag < 0 ? "" : html.slice(fimTag + 1);
  const proximoFecha = corpoDepois.search(/<\/a\s*>|<a\b/i);
  const interno = proximoFecha < 0 ? corpoDepois.slice(0, 2000) : corpoDepois.slice(0, proximoFecha);
  const declarado = /\bdata-elemento\s*=\s*["']([a-z]+)["']/i.exec(tag)?.[1]?.toLowerCase();
  const temImagem = /<img\b/i.test(interno);
  const elemento: ElementoClique = ehElementoClique(declarado) ? declarado : temImagem ? "imagem" : "link";
  let rotulo = limparRotuloClique(interno);
  if (!rotulo && temImagem) rotulo = limparRotuloClique(/<img\b[^>]*\balt\s*=\s*(["'])(.*?)\1/i.exec(interno)?.[2] ?? "");
  return { elemento, rotulo };
}

/**
 * Reescreve os `href` de um HTML JÁ PRONTO para passarem pelo redirecionador de
 * cliques. É async porque a URL rastreada é ASSINADA (ver `linkCliqueEmail`), e
 * assinar é `crypto.subtle`, que é assíncrono.
 *
 * Roda no ENVIO, não na compilação: o `corpo_html` do modelo é compilado e salvo
 * uma vez, e o id do envio — que é o que identifica o clique — só existe na hora
 * de despachar. Por isso também aceita HTML legado, que nunca passou pelo
 * construtor.
 *
 * O que NÃO é embrulhado: mailto/tel/âncora, merge tag não resolvida e qualquer
 * link que `ignorar` recusar (o descadastro, que precisa chegar inteiro ao
 * destinatário e tem trava própria).
 *
 * `rastrear` recebe também QUE ELEMENTO é (botão, link, imagem, vídeo) e o rótulo dele,
 * para o relatório dizer onde a pessoa clicou — não só para qual URL ela foi. Um mesmo
 * destino em dois elementos (botão E imagem) gera dois links rastreados distintos.
 */
export async function envolverCliquesNoHtml(
  html: string,
  rastrear: (href: string, info: InfoClique) => Promise<string>,
  ignorar: (href: string) => boolean = () => false,
): Promise<string> {
  if (!html) return html;
  const padrao = /(<a\b[^>]*?\bhref\s*=\s*)(["'])(.*?)\2/gi;
  const chave = (destino: string, info: InfoClique) => destino + "\n" + info.elemento + "\n" + info.rotulo;
  const encontrados = new Map<string, { destino: string; info: InfoClique }>();
  for (const m of html.matchAll(padrao)) {
    const limpo = decodificarHref(m[3]);
    if (!ehLinkNavegavel(limpo) || ignorar(limpo)) continue;
    const info = infoDoAnchor(html, m.index ?? 0);
    const k = chave(limpo, info);
    if (!encontrados.has(k)) encontrados.set(k, { destino: limpo, info });
  }
  if (encontrados.size === 0) return html;
  // Assina uma vez por (destino, elemento, rótulo): e-mail com o mesmo CTA em três botões
  // de mesmo texto faria três HMACs idênticos.
  const mapa = new Map<string, string>();
  for (const [k, { destino, info }] of encontrados) mapa.set(k, await rastrear(destino, info));
  return html.replace(padrao, (inteiro, antes: string, aspas: string, href: string, deslocamento: number) => {
    const limpo = decodificarHref(href);
    const novo = mapa.get(chave(limpo, infoDoAnchor(html, deslocamento)));
    // A aspa de FECHAMENTO também foi consumida pelo padrão — tem que voltar. De 22/09 a
    // 28/09/2026 ela faltava: o href engolia o atributo seguinte (`…u=…%2F target=`), a
    // assinatura não conferia e TODO link rastreado caía em "Link inválido" (0 cliques em
    // 1.539 e-mails). O email-track-click resgata os que já saíram assim.
    return novo ? `${antes}${aspas}${escaparHref(novo)}${aspas}` : inteiro;
  });
}
