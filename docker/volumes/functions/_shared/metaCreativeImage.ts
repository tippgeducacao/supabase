// Resolve a imagem de um criativo do Meta Ads FRESCA (as thumbnail_url gravadas em
// meta_creatives são URLs assinadas do scontent.fbcdn.net que EXPIRAM em horas — por
// isso quebram no navegador). Aqui buscamos, a cada chamada, uma URL nova via a Graph
// API (com o token da conta) e baixamos os bytes no servidor. Fallback na URL guardada.
// Usado pelo preview (mkt-criativo-imagem) e como fonte do motor de variações IA.

const META_API = "https://graph.facebook.com/v19.0";

export interface ImagemResolvida {
  bytes: Uint8Array;
  contentType: string;
  urlUsada: string;
}

async function baixar(url: string): Promise<ImagemResolvida | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!buf.length) return null;
    const ct = res.headers.get("content-type") || "image/jpeg";
    // guarda contra respostas HTML (erro do CDN devolvido com 200)
    if (ct.includes("text/") || ct.includes("json")) return null;
    return { bytes: buf, contentType: ct.startsWith("image/") ? ct : "image/jpeg", urlUsada: url };
  } catch {
    return null;
  }
}

// deno-lint-ignore no-explicit-any
export async function resolverImagemCriativo(sb: any, creativeId: string): Promise<ImagemResolvida | null> {
  const { data: cre } = await sb
    .from("meta_creatives")
    .select("ad_account_id, thumbnail_url")
    .eq("id", creativeId)
    .maybeSingle();

  let freshUrl: string | null = null;
  if (cre?.ad_account_id) {
    const { data: acc } = await sb
      .from("meta_accounts")
      .select("access_token")
      .eq("ad_account_id", cre.ad_account_id)
      .maybeSingle();
    const token = acc?.access_token;
    if (token) {
      try {
        // o creative_id do meta_creatives é o id do adcreative na Graph API
        const r = await fetch(
          `${META_API}/${creativeId}?fields=image_url,thumbnail_url&access_token=${encodeURIComponent(token)}`,
        );
        const j = await r.json();
        if (!j?.error) freshUrl = j?.image_url || j?.thumbnail_url || null;
      } catch { /* segue pro fallback */ }
    }
  }

  // 1) URL fresca da Graph API; 2) thumbnail_url guardada (pode estar expirada)
  const candidatas = [freshUrl, cre?.thumbnail_url].filter((u): u is string => !!u);
  for (const url of candidatas) {
    const img = await baixar(url);
    if (img) return img;
  }
  return null;
}

export function bytesParaDataUrl(img: ImagemResolvida): string {
  // btoa em chunks (evita estouro de call stack com imagens grandes)
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < img.bytes.length; i += chunk) {
    bin += String.fromCharCode(...img.bytes.subarray(i, i + chunk));
  }
  return `data:${img.contentType};base64,${btoa(bin)}`;
}
