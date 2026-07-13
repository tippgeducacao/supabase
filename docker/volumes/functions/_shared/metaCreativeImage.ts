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
async function tokenDaConta(sb: any, adAccountId: string | null | undefined): Promise<string | null> {
  if (!adAccountId) return null;
  const { data: acc } = await sb.from("meta_accounts").select("access_token").eq("ad_account_id", adAccountId).maybeSingle();
  return acc?.access_token || null;
}

// Resolve a imagem por CREATIVE_ID (meta_creatives, preferido) OU por AD_ID
// (meta_ads — cobre anúncio INATIVO que o sync de criativos não pegou). Sempre
// fresca na Graph API, com fallback na thumbnail guardada (quando houver).
// deno-lint-ignore no-explicit-any
export async function resolverImagemCriativo(
  sb: any,
  ref: string | { creativeId?: string | null; adId?: string | null },
): Promise<ImagemResolvida | null> {
  const creativeId = typeof ref === "string" ? ref : ref.creativeId || null;
  const adId = typeof ref === "string" ? null : ref.adId || null;

  const candidatas: string[] = [];
  let storedThumb: string | null = null;

  // 1) por creative_id (adcreative direto)
  if (creativeId) {
    const { data: cre } = await sb.from("meta_creatives")
      .select("ad_account_id, thumbnail_url").eq("id", creativeId).maybeSingle();
    storedThumb = cre?.thumbnail_url || null;
    const token = await tokenDaConta(sb, cre?.ad_account_id);
    if (token) {
      try {
        const r = await fetch(`${META_API}/${creativeId}?fields=image_url,thumbnail_url&access_token=${encodeURIComponent(token)}`);
        const j = await r.json();
        if (!j?.error && (j?.image_url || j?.thumbnail_url)) candidatas.push(j.image_url || j.thumbnail_url);
      } catch { /* segue */ }
    }
  }

  // 2) por ad_id (o criativo mora no anúncio; cobre inativo fora de meta_creatives)
  if (adId) {
    const { data: ad } = await sb.from("meta_ads")
      .select("ad_account_id").eq("id", adId).maybeSingle();
    const token = await tokenDaConta(sb, ad?.ad_account_id);
    if (token) {
      try {
        const r = await fetch(`${META_API}/${adId}?fields=creative{image_url,thumbnail_url}&access_token=${encodeURIComponent(token)}`);
        const j = await r.json();
        const cr = j?.creative;
        if (!j?.error && cr && (cr.image_url || cr.thumbnail_url)) candidatas.push(cr.image_url || cr.thumbnail_url);
      } catch { /* segue */ }
    }
  }

  // 3) fallback na thumbnail guardada (pode estar expirada)
  if (storedThumb) candidatas.push(storedThumb);

  for (const url of candidatas) {
    const img = await baixar(url);
    if (img) return img;
  }
  return null;
}

// Resolve o VÍDEO de um criativo (quando o anúncio é vídeo). Devolve o poster
// SEMPRE e a URL do mp4 (`source`) QUANDO a Meta libera — o que NÃO acontece para
// post não publicado / vídeo de Página com token de conta de anúncios (aí videoUrl
// vem null e o front mostra o frame + aviso). Null = não é vídeo. Graph API fresca.
// deno-lint-ignore no-explicit-any
export async function resolverVideoCriativo(
  sb: any,
  ref: { creativeId?: string | null; adId?: string | null },
): Promise<{ videoUrl: string | null; posterUrl: string | null } | null> {
  const creativeId = ref.creativeId || null;
  const adId = ref.adId || null;

  // token + node de onde extrair o video_id
  let token: string | null = null;
  let nodeUrl: string | null = null;
  if (creativeId) {
    const { data: cre } = await sb.from("meta_creatives").select("ad_account_id").eq("id", creativeId).maybeSingle();
    token = await tokenDaConta(sb, cre?.ad_account_id);
    if (token) nodeUrl = `${META_API}/${creativeId}?fields=video_id,object_story_spec{video_data{video_id}},thumbnail_url&access_token=${encodeURIComponent(token)}`;
  }
  if (!nodeUrl && adId) {
    const { data: ad } = await sb.from("meta_ads").select("ad_account_id").eq("id", adId).maybeSingle();
    token = await tokenDaConta(sb, ad?.ad_account_id);
    if (token) nodeUrl = `${META_API}/${adId}?fields=creative{video_id,object_story_spec{video_data{video_id}},thumbnail_url}&access_token=${encodeURIComponent(token)}`;
  }
  if (!nodeUrl || !token) return null;

  try {
    const r = await fetch(nodeUrl);
    const j = await r.json();
    if (j?.error) return null;
    const node = j?.creative || j; // ad path aninha em creative
    const videoId = node?.video_id || node?.object_story_spec?.video_data?.video_id || null;
    if (!videoId) return null; // não é vídeo
    const vr = await fetch(`${META_API}/${videoId}?fields=source,picture&access_token=${encodeURIComponent(token)}`);
    const vj = await vr.json();
    const posterUrl = vj?.picture || node?.thumbnail_url || null;
    const videoUrl = (!vj?.error && vj?.source) ? vj.source : null; // `source` só quando a Meta libera
    return { videoUrl, posterUrl };
  } catch {
    return null;
  }
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
