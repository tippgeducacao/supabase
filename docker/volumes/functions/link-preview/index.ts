import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

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
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
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
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Erro ao buscar preview" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
