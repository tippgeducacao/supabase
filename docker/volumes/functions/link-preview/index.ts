import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { exigirAcesso, respostaAcessoNegado } from "../_shared/acesso.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Extrai metadados Open Graph / <title> de uma URL para montar o card de preview de link.
function pickMeta(html: string, names: string[]): string | null {
  for (const name of names) {
    // <meta property="og:title" content="...">  (ordem property/content em qualquer posição)
    const re1 = new RegExp(
      `<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`,
      "i",
    );
    const re2 = new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`,
      "i",
    );
    const m = html.match(re1) || html.match(re2);
    if (m && m[1]) return decodeEntities(m[1].trim());
  }
  return null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// ── Anti-SSRF (29/10/2026) ─────────────────────────────────────────────────────────────
// A edge busca uma URL escolhida por quem chama, de dentro da rede dos containers. Sem esta
// conferência ela lia o <title> de kong/studio/serviços internos e servia de proxy aberto.
// Recusa: porta fora de 80/443, usuário:senha na URL, nome sem ponto (serviço docker:
// supabase-kong, db...), sufixos internos, e qualquer host cujo DNS aponte para IP privado,
// loopback, link-local (169.254 = metadados de nuvem), CGNAT, multicast ou reservado.
// O redirect é seguido À MÃO e cada salto é conferido de novo (máx. 4).
class UrlBloqueada extends Error {}
const HOST_INTERNO = /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|arpa|test|invalid|onion)$/i;

function ipPublico(ip: string): boolean {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const p = ip.split(".").map(Number);
    if (p.some((n) => n > 255) || p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224
      || p[0] === 100 && p[1] >= 64 && p[1] <= 127 || p[0] === 169 && p[1] === 254
      || p[0] === 172 && p[1] >= 16 && p[1] <= 31 || p[0] === 192 && (p[1] === 168 || p[1] === 0 || p[1] === 2 || p[1] === 88 && p[2] === 99)
      || p[0] === 198 && (p[1] === 18 || p[1] === 19 || p[1] === 51 && p[2] === 100)
      || p[0] === 203 && p[1] === 0 && p[2] === 113) return false;
    return true;
  }
  if (!/^[\da-f:.]+$/i.test(ip) || !ip.includes(":")) return false;
  let canonico: string;
  try { canonico = new URL(`http://[${ip}]/`).hostname.slice(1, -1).toLowerCase(); } catch { return false; }
  const [a, b] = canonico.split(":").map((n) => parseInt(n || "0", 16));
  // Só IPv6 global unicast (2000::/3), fora de 6to4, Teredo/benchmark e documentação.
  return a >= 0x2000 && a <= 0x3fff && a !== 0x2002 && !(a === 0x2001 && (b < 0x200 || b === 0xdb8)) && a !== 0x3fff;
}

async function resolverIps(host: string): Promise<string[]> {
  // deno-lint-ignore no-explicit-any
  const d = (globalThis as any).Deno;
  if (typeof d?.resolveDns !== "function") throw new UrlBloqueada("DNS indisponível.");
  const r = await Promise.allSettled([d.resolveDns(host, "A"), d.resolveDns(host, "AAAA")]);
  return r.flatMap((x) => (x.status === "fulfilled" ? (x.value as string[]) : []));
}

async function conferirUrlPublica(bruta: string): Promise<URL> {
  let u: URL;
  try { u = new URL(bruta); } catch { throw new UrlBloqueada("URL inválida."); }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new UrlBloqueada("URL não permitida.");
  if (u.port && u.port !== "80" && u.port !== "443") throw new UrlBloqueada("Porta não permitida.");
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const ehIp = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");
  if (!ehIp && (!host.includes(".") || HOST_INTERNO.test(host))) throw new UrlBloqueada("Endereço interno não permitido.");
  const ips = ehIp ? [host] : await resolverIps(host);
  if (!ips.length || ips.some((ip) => !ipPublico(ip))) throw new UrlBloqueada("Endereço interno não permitido.");
  return u;
}

async function buscarPublico(bruta: string, init: RequestInit): Promise<Response> {
  let url = await conferirUrlPublica(bruta);
  for (let salto = 0; salto < 4; salto++) {
    const res = await fetch(url, { ...init, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const destino = res.headers.get("location");
      await res.body?.cancel();
      if (!destino) throw new UrlBloqueada("Redirecionamento inválido.");
      url = await conferirUrlPublica(new URL(destino, url).href);
      continue;
    }
    return res;
  }
  throw new UrlBloqueada("Redirecionamentos demais.");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  // Só colaborador logado (card de link do disparo, DispatchMessageMedia.tsx).
  try { await exigirAcesso(req, { usuario: true }); }
  catch (e) { return respostaAcessoNegado(e, corsHeaders); }

  try {
    const { url } = await req.json();
    if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      return new Response(JSON.stringify({ error: "URL inválida" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Timeout defensivo para não estourar o tempo da function
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let html = "";
    try {
      const res = await buscarPublico(url, {
        signal: controller.signal,
        headers: {
          // Alguns sites bloqueiam sem user-agent de navegador
          "User-Agent":
            "Mozilla/5.0 (compatible; RufloLinkPreview/1.0; +https://ruflo.app)",
          "Accept": "text/html,application/xhtml+xml",
        },
      });
      // Só lê os primeiros ~200KB (o <head> com as metatags vem no começo)
      const buf = new Uint8Array(await res.arrayBuffer());
      html = new TextDecoder("utf-8").decode(buf.slice(0, 200_000));
    } finally {
      clearTimeout(timer);
    }

    const titulo =
      pickMeta(html, ["og:title", "twitter:title"]) ||
      (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? null);
    const descricao = pickMeta(html, [
      "og:description",
      "twitter:description",
      "description",
    ]);
    let imagem = pickMeta(html, ["og:image", "twitter:image", "twitter:image:src"]);

    // Resolve imagem relativa para absoluta
    if (imagem && !/^https?:\/\//i.test(imagem)) {
      try {
        imagem = new URL(imagem, url).toString();
      } catch (_) {
        imagem = null;
      }
    }

    let site: string | null = null;
    try {
      site = new URL(url).hostname.replace(/^www\./, "");
    } catch (_) { /* ignore */ }

    return new Response(
      JSON.stringify({ url, titulo, descricao, imagem, site }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    if (e instanceof UrlBloqueada) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Erro ao buscar preview" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
