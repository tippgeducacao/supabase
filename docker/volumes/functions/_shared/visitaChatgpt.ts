// Régua da contagem de VISITAS que chegam ao site pelo ChatGPT — a MESMA para a edge (que grava) e para os testes.
// Sem import por URL (esm.sh) de propósito: assim o vitest carrega este arquivo.
//
// O PEDIDO (06/11/2026, Marketing): "cada pesquisa feita no ChatGPT que entregar o link da PPGVET [...] para termos
// uma noção de quantos são". Quem só VÊ o link na resposta não deixa rastro em lugar nenhum (a OpenAI não entrega
// relatório de citações); quem CLICA chega com `utm_source=chatgpt.com` — o PRÓPRIO ChatGPT acrescenta isso nos links
// que cita — ou, no anúncio do ChatGPT Ads, com `utm_source=openai`. É o clique que esta régua reconhece.
//
// ⚠️ ESPELHO do banco: quem é "do ChatGPT" e quem é "anúncio" tem de ser o MESMO critério de `leads_v4_origem_norm` /
// `leads_v4_origem_sub_norm` (migration `…_leads_v4_origem_chatgpt.sql`), senão o cartão da Gestão de Leads divide
// leads de um jeito por visitas de outro e a taxa mente:
//   · marca explícita: o utm_source COMEÇA com "chatgpt" ou "openai"
//   · anúncio: utm_source começa com "openai", OU o utm_medium diz mídia paga (paid/cpc/ppc/pago ou a palavra "ads"
//     INTEIRA — "leads" também termina em "ads")
//   · resposta: o resto
//   · sem marca na URL mas vindo de chatgpt.com (referrer) → resposta, via "referrer"
//
// ⚠️ O aviso sai do navegador de quem clicou e a porta é pública: NADA do que vem no pedido é confiável. Por isso o
// tipo é decidido AQUI (o cliente só manda a URL e o referrer), a página só entra se for dos domínios da PPG, e o que
// se grava é um caminho normalizado — sem query, sem hash, sem IP, sem nada que identifique a pessoa.

/** Domínios (e seus subdomínios) cujas visitas contam. Quem não é daqui é ignorado calado. */
export const HOSTS_DA_PPG = [
  "ppgvet.com.br",
  "ppgeducacao.com.br",
  "ppgagro.com.br",
  "produtivaassessoriavet.com.br",
] as const;

export type TipoVisita = "resposta" | "anuncio";
export type ViaVisita = "utm" | "referrer";

export interface VisitaChatgpt {
  /** Sem "www." — `www.ppgvet.com.br` e `ppgvet.com.br` são o mesmo site. */
  host: string;
  /** Caminho normalizado ("/poa"; "/" = home; "(outras)" = não passou na validação). */
  pagina: string;
  tipo: TipoVisita;
  via: ViaVisita;
}

export const MAX_BYTES_DO_PEDIDO = 4096;
const MAX_URL = 2048;

const MARCA_CHATGPT = /^(chatgpt|openai)/;
const MARCA_ANUNCIO_NO_SOURCE = /^openai/;
// "ads" só como palavra inteira: `(^|[^a-z])ads($|[^a-z])` — igual ao banco
const MEDIO_DE_MIDIA_PAGA = /(paid|cpc|ppc|pago|(^|[^a-z])ads($|[^a-z]))/;

/** O host é da PPG (domínio exato ou subdomínio)? Recebe o host já em minúsculas. */
export function hostDaPpg(host: string): boolean {
  return HOSTS_DA_PPG.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Caminho normalizado e seguro para a coluna `pagina` (o banco só aceita `^(/[a-z0-9._/-]{0,119}|\(outras\))$`). */
export function normalizarPagina(pathname: string): string {
  let p: string;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return "(outras)";
  }
  p = p.toLowerCase().replace(/\/{2,}/g, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 120 || !/^\/[a-z0-9._/-]*$/.test(p)) return "(outras)";
  return p;
}

function urlSegura(valor: unknown): URL | null {
  if (typeof valor !== "string" || valor.length === 0 || valor.length > MAX_URL) return null;
  try {
    const u = new URL(valor);
    return u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

const limpo = (v: string | null): string => (v ?? "").trim().toLowerCase().slice(0, 80);

/** O referrer é o ChatGPT? (chatgpt.com, subdomínios e o endereço antigo chat.openai.com) */
function referrerEhChatgpt(r: unknown): boolean {
  const u = urlSegura(r);
  if (!u) return false;
  const h = u.hostname.toLowerCase();
  return h === "chatgpt.com" || h.endsWith(".chatgpt.com") || h === "chat.openai.com";
}

/**
 * Decide se o aviso é uma visita vinda do ChatGPT a uma página da PPG, e de que tipo.
 * Devolve `null` para tudo o que não conta (host de fora, sem marca, URL torta) — a edge responde 204 do mesmo jeito,
 * para quem está de fora não ter como sondar o que é aceito.
 */
export function classificarVisita(entrada: { u?: unknown; r?: unknown } | null | undefined): VisitaChatgpt | null {
  const pagina = urlSegura(entrada?.u);
  if (!pagina) return null;

  const host = pagina.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  if (!hostDaPpg(host)) return null;

  // ⚠️ NAVEGAÇÃO INTERNA não é visita nova (10/11/2026). O utm_source=chatgpt.com segue na URL quando a pessoa passa da
  // LP para a página de obrigado (o GreatPages repassa a query) ou para outra página do site, e o aviso do navegador é
  // "uma vez por PÁGINA" por sessão: cada lead que se cadastrava contava DUAS visitas (LP + obrigado) — em 07/11, o
  // único lead do ChatGPT da semana virou 2 visitas (/pos-saude-unica e /saude-unica-obg). Quem chega de fora tem
  // referrer do ChatGPT, de outro site ou nenhum; referrer de um site da PPG é a mesma pessoa andando pelo site.
  const anterior = urlSegura(entrada?.r);
  if (anterior && hostDaPpg(anterior.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, ""))) return null;

  const source = limpo(pagina.searchParams.get("utm_source"));
  const medium = limpo(pagina.searchParams.get("utm_medium"));

  if (MARCA_CHATGPT.test(source)) {
    const anuncio = MARCA_ANUNCIO_NO_SOURCE.test(source) || MEDIO_DE_MIDIA_PAGA.test(medium);
    return { host, pagina: normalizarPagina(pagina.pathname), tipo: anuncio ? "anuncio" : "resposta", via: "utm" };
  }

  if (referrerEhChatgpt(entrada?.r)) {
    return { host, pagina: normalizarPagina(pagina.pathname), tipo: "resposta", via: "referrer" };
  }
  return null;
}

/**
 * Robô/ferramenta que não conta como visita de gente. O beacon é JavaScript, então robô simples nem dispara; isto pega
 * o resto (navegador sem cabeça de pré-visualização, monitor de disponibilidade, os robôs da própria OpenAI).
 * User-Agent ausente conta como robô: navegador de verdade sempre manda.
 */
export function ehRobo(userAgent: string | null | undefined): boolean {
  const ua = (userAgent ?? "").trim();
  if (!ua) return true;
  return /bot|crawl|spider|slurp|preview|headless|lighthouse|facebookexternalhit|gptbot|oai-searchbot|chatgpt-user|python-requests|curl\/|wget|httpclient|monitor|pingdom|uptime/i.test(
    ua,
  );
}

/**
 * Limite de taxa em MEMÓRIA, por chave (o IP de quem chama). Não guarda nada em disco nem no banco: some quando o
 * isolate reinicia. `agora` entra por parâmetro para o teste controlar o relógio.
 */
export function criarLimitador(opcoes: { max: number; janelaMs: number; agora?: () => number }) {
  const { max, janelaMs } = opcoes;
  const agora = opcoes.agora ?? (() => Date.now());
  const mapa = new Map<string, number[]>();
  /** true = pode passar · false = passou do limite na janela. */
  return (chave: string): boolean => {
    const t = agora();
    const recentes = (mapa.get(chave) ?? []).filter((x) => t - x < janelaMs);
    if (recentes.length >= max) {
      mapa.set(chave, recentes);
      return false;
    }
    recentes.push(t);
    mapa.set(chave, recentes);
    // poda para o mapa não crescer sem fim
    if (mapa.size > 5000) {
      for (const [k, v] of mapa) if (!v.some((x) => t - x < janelaMs)) mapa.delete(k);
    }
    return true;
  };
}

/** Quem está chamando, só para o limite de taxa (nunca é gravado). */
export function chaveDoCliente(headers: { get(nome: string): string | null }): string {
  const ip =
    headers.get("cf-connecting-ip") ??
    headers.get("x-real-ip") ??
    (headers.get("x-forwarded-for") ?? "").split(",")[0] ??
    "";
  return ip.trim() || "desconhecido";
}
