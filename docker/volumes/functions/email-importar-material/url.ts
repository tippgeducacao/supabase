import { MAX_TEXTO_MATERIAL_EMAIL_IA, normalizarTextoMaterialEmailIA, type MaterialEmailIA } from "../_shared/emailBuilder/aiMateriais.ts";

export const MAX_BYTES_PAGINA_EMAIL_IA = 2 * 1024 * 1024;
export class ErroMaterialEmailIA extends Error { constructor(public status: number, mensagem: string) { super(mensagem); } }
export function validarUrlMaterialEmailIA(valor: unknown): URL {
  try {
    if (typeof valor !== "string" || valor.length > 2048 || /[\s\\]/.test(valor)) throw new Error();
    const url = new URL(valor);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.port && url.port !== "443" || url.username || url.password || url.hash
      || !/^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(host) || !host.includes(".") || host.includes("..")
      || /(?:^|\.)(?:localhost|local|internal|intranet|test|invalid|onion|home|lan)$/.test(host)
      || /^\d+(?:\.\d+)*$/.test(host) || host.endsWith(".arpa")) throw new Error();
    return url;
  } catch { throw new ErroMaterialEmailIA(400, "Use uma URL HTTPS pública, sem senha, porta alternativa ou endereço IP."); }
}

/** Lista conservadora: aceita IPv4 global e IPv6 global unicast, excluindo faixas
 * especiais, transição/túneis e documentação. IPv4 mapeado nunca passa como IPv6. */
export function ipPublicoMaterialEmailIA(ip: string): boolean {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const p = ip.split(".").map(Number);
    if (p.some(n => n > 255) || p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224
      || p[0] === 100 && p[1] >= 64 && p[1] <= 127 || p[0] === 169 && p[1] === 254
      || p[0] === 172 && p[1] >= 16 && p[1] <= 31 || p[0] === 192 && (p[1] === 168 || p[1] === 0 || p[1] === 2 || p[1] === 88 && p[2] === 99)
      || p[0] === 198 && (p[1] === 18 || p[1] === 19 || p[1] === 51 && p[2] === 100)
      || p[0] === 203 && p[1] === 0 && p[2] === 113) return false;
    return true;
  }
  if (!/^[\da-f:]+$/i.test(ip) || !ip.includes(":")) return false;
  let canonico: string;
  try { canonico = new URL(`https://[${ip}]/`).hostname.slice(1, -1).toLowerCase(); } catch { return false; }
  const [a, b] = canonico.split(":").map(n => parseInt(n || "0", 16));
  return a >= 0x2000 && a <= 0x3fff && a !== 0x2002 && !(a === 0x2001 && (b < 0x200 || b === 0xdb8)) && a !== 0x3fff;
}
export interface RespostaPagina { status: number; headers: Headers; corpo: Uint8Array }
export interface RedeMaterialEmailIA {
  resolver(hostname: string): Promise<string[]>;
  // Deve conectar EXCLUSIVAMENTE ao IP recebido, mantendo hostname para SNI/TLS.
  baixar(url: URL, ip: string, signal: AbortSignal): Promise<RespostaPagina>;
}
function entidades(texto: string): string {
  const nomes: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", bull: "•", hellip: "…", copy: "©", reg: "®" };
  return texto.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (original, codigo: string) => {
    if (!codigo.startsWith("#")) return nomes[codigo.toLowerCase()] ?? original;
    const n = codigo[1].toLowerCase() === "x" ? parseInt(codigo.slice(2), 16) : parseInt(codigo.slice(1), 10);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
  });
}
export function extrairTextoHtmlEmailIA(html: string): string {
  const semAtivos = html.replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(/<(script|style|noscript|template|svg|iframe|object)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ");
  const principal = semAtivos.match(/<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)\s*>/i)?.[1] ?? semAtivos;
  return normalizarTextoMaterialEmailIA(entidades(principal.replace(/<(?:br|\/p|\/div|\/h[1-6]|\/li|\/section|\/tr)\b[^>]*>/gi, "\n").replace(/<[^>]*(?:>|$)/g, " ")));
}
export async function importarUrlMaterialEmailIA(valor: unknown, rede: RedeMaterialEmailIA, timeoutMs = 15000): Promise<MaterialEmailIA> {
  let url = validarUrlMaterialEmailIA(valor);
  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), timeoutMs);
  const interrompida = new Promise<never>((_, reject) => controle.signal.addEventListener("abort", () => reject(new ErroMaterialEmailIA(504, "A página demorou mais de 15 segundos. Tente outra URL ou copie seu texto.")), { once: true }));
  try {
    return await Promise.race([interrompida, (async () => {
      const visitadas = new Set<string>();
      for (let passo = 0; passo < 4; passo++) {
        if (controle.signal.aborted) throw new ErroMaterialEmailIA(504, "Importação cancelada.");
        if (visitadas.has(url.href)) throw new ErroMaterialEmailIA(422, "A página possui um ciclo de redirecionamentos.");
        visitadas.add(url.href);
        const ips = await rede.resolver(url.hostname);
        if (!ips.length || ips.some(ip => !ipPublicoMaterialEmailIA(ip))) throw new ErroMaterialEmailIA(400, "A URL não aponta exclusivamente para endereços públicos permitidos.");
        if (controle.signal.aborted) throw new ErroMaterialEmailIA(504, "Importação cancelada.");
        const resposta = await rede.baixar(url, ips[0], controle.signal);
        if ([301, 302, 303, 307, 308].includes(resposta.status)) {
          const local = resposta.headers.get("location");
          if (!local) throw new ErroMaterialEmailIA(422, "A página retornou um redirecionamento inválido.");
          url = validarUrlMaterialEmailIA(new URL(local, url).href); continue;
        }
        if (resposta.status !== 200) throw new ErroMaterialEmailIA(422, "A página não está disponível publicamente. Use uma URL sem login ou copie o texto.");
        if (resposta.corpo.byteLength > MAX_BYTES_PAGINA_EMAIL_IA) throw new ErroMaterialEmailIA(413, "A página ultrapassa 2 MB. Copie apenas o conteúdo necessário.");
        const tipo = resposta.headers.get("content-type") ?? "";
        if (!/^(?:text\/html|text\/plain|application\/xhtml\+xml)(?:;|$)/i.test(tipo)) throw new ErroMaterialEmailIA(422, "A URL precisa abrir uma página de texto. Para PDF, use Importar PDF.");
        const charset = tipo.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] ?? "utf-8";
        let fonte: string;
        try { fonte = new TextDecoder(charset).decode(resposta.corpo); } catch { throw new ErroMaterialEmailIA(422, "Não foi possível ler a codificação da página."); }
        const texto = /^text\/plain/i.test(tipo) ? normalizarTextoMaterialEmailIA(fonte) : extrairTextoHtmlEmailIA(fonte);
        if (texto.length < 20) throw new ErroMaterialEmailIA(422, "Não encontrei texto suficiente. Páginas que dependem de login ou JavaScript precisam ser copiadas manualmente.");
        return { tipo: "url" as const, origem: url.href, texto: texto.slice(0, MAX_TEXTO_MATERIAL_EMAIL_IA), truncado: texto.length > MAX_TEXTO_MATERIAL_EMAIL_IA };
      }
      throw new ErroMaterialEmailIA(422, "A página redirecionou mais de três vezes. Use a URL final.");
    })()]);
  } finally { clearTimeout(timer); controle.abort(); }
}
