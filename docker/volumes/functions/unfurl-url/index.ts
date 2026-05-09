import "https://deno.land/x/xhr@0.1.0/mod.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const pickMeta = (html: string, names: string[]) => {
  for (const n of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]+content=["']([^"']+)["']`, "i");
    const m = html.match(re);
    if (m) return m[1];
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${n}["']`, "i");
    const m2 = html.match(re2);
    if (m2) return m2[1];
  }
  return "";
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const { url } = await req.json();
    if (!url || !/^https?:\/\//i.test(url)) {
      return new Response(JSON.stringify({ error: "URL inválida" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    }
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; PPGVetUnfurl/1.0)" },
      redirect: "follow",
    });
    const html = (await res.text()).slice(0, 200_000);
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = pickMeta(html, ["og:title", "twitter:title"]) || (titleMatch ? titleMatch[1].trim() : "");
    const description = pickMeta(html, ["og:description", "twitter:description", "description"]);
    let image = pickMeta(html, ["og:image", "twitter:image"]);
    if (image && image.startsWith("/")) {
      const u = new URL(url);
      image = `${u.origin}${image}`;
    }
    const domain = new URL(url).hostname.replace(/^www\./, "");
    return new Response(JSON.stringify({ url, title, description, image, domain }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
