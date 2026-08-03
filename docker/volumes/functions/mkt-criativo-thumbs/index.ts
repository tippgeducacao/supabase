import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// Resolve a MINIATURA de VÁRIOS criativos do Meta Ads de uma vez, devolvendo só a
// URL fresca (nunca os bytes) — é o que a lista/ranking precisa para desenhar a
// fotinha do anúncio.
//
// ⚠️ Por que existe: a `meta_creatives.thumbnail_url` que o sync guarda é uma URL
// ASSINADA do scontent.fbcdn.net que a Meta invalida em ~1–2 dias (medido: uma
// thumb sincronizada há 2 dias já devolve 403, MESMO com o `oe=` ainda no futuro).
// Resultado: na lista a maioria dos criativos caía no placeholder enquanto o
// preview abria normal — porque o preview (mkt-criativo-imagem) já resolvia fresco.
//
// ≠ do `mkt-criativo-imagem`: aquele é 1 criativo, resolve vídeo e devolve a imagem
// GRANDE em data URL (pesado, certo para o preview). Aqui são N criativos e só a
// URL — resposta minúscula, e o <img> baixa do CDN da Meta como sempre.

const META_API = "https://graph.facebook.com/v19.0";
const MAX_REFS = 60; // teto do payload do painel (criativos_thumb_ate)
const MAX_IDS_POR_CHAMADA = 50; // limite prático do `?ids=` da Graph API
// A Graph devolve a thumb em 64x64 por padrão — borrada numa caixa de 44px em tela
// retina. Ela ACEITA dimensionar (verificado: volta com `p320x320` na URL), e 320
// é nítido no dobro da maior caixa da tela sem virar a imagem cheia.
const THUMB_PX = 320;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
const getErr = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Ref {
  chave: string;
  creative_id: string | null;
  ad_id: string | null;
}

// deno-lint-ignore no-explicit-any
async function tokensPorConta(sb: any, contas: string[]): Promise<Map<string, string>> {
  const mapa = new Map<string, string>();
  if (!contas.length) return mapa;
  const { data } = await sb.from("meta_accounts").select("ad_account_id, access_token").in("ad_account_id", contas);
  for (const c of (data ?? []) as { ad_account_id: string; access_token: string | null }[]) {
    if (c.access_token) mapa.set(c.ad_account_id, c.access_token);
  }
  return mapa;
}

// UMA chamada Graph para até 50 ids (`?ids=a,b,c`). Falha de um id não derruba os
// outros: o que não vier no retorno simplesmente fica sem miniatura.
async function graphEmLote(
  ids: string[],
  fields: string,
  token: string,
): Promise<Record<string, unknown>> {
  if (!ids.length) return {};
  const url =
    `${META_API}/?ids=${encodeURIComponent(ids.join(","))}` +
    `&fields=${encodeURIComponent(fields)}` +
    `&thumbnail_width=${THUMB_PX}&thumbnail_height=${THUMB_PX}` +
    `&access_token=${encodeURIComponent(token)}`;
  try {
    const r = await fetch(url);
    const j = await r.json();
    if (!j || j.error) return {};
    return j as Record<string, unknown>;
  } catch {
    return {};
  }
}

const urlDe = (no: unknown): string | null => {
  const o = no as { thumbnail_url?: string; image_url?: string; creative?: { thumbnail_url?: string; image_url?: string } } | null;
  if (!o) return null;
  // thumbnail_url primeiro: é a versão pequena — barata para uma lista.
  return o.thumbnail_url || o.image_url || o.creative?.thumbnail_url || o.creative?.image_url || null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Gate "logado" (mesmo padrão do mkt-criativo-variacao). A tela é interna.
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const { data: userData } = jwt ? await sb.auth.getUser(jwt) : { data: { user: null } };
    if (!userData?.user?.id) {
      return new Response(JSON.stringify({ error: "Não autenticado." }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const refs: Ref[] = Array.isArray(body?.refs)
      ? (body.refs as Ref[])
          .filter((r) => r && typeof r.chave === "string" && (r.creative_id || r.ad_id))
          .slice(0, MAX_REFS)
      : [];
    if (!refs.length) {
      return new Response(JSON.stringify({ thumbs: {} }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const creativeIds = [...new Set(refs.map((r) => r.creative_id).filter(Boolean) as string[])];
    const adIds = [...new Set(refs.map((r) => r.ad_id).filter(Boolean) as string[])];

    // De qual conta é cada id (o token é POR conta de anúncios).
    const [cre, ads] = await Promise.all([
      creativeIds.length
        ? sb.from("meta_creatives").select("id, ad_account_id").in("id", creativeIds)
        : Promise.resolve({ data: [] }),
      adIds.length
        ? sb.from("meta_ads").select("id, ad_account_id").in("id", adIds)
        : Promise.resolve({ data: [] }),
    ]);
    const contaDoCreative = new Map<string, string>();
    for (const c of ((cre as { data?: { id: string; ad_account_id: string | null }[] }).data ?? [])) {
      if (c.ad_account_id) contaDoCreative.set(c.id, c.ad_account_id);
    }
    const contaDoAd = new Map<string, string>();
    for (const a of ((ads as { data?: { id: string; ad_account_id: string | null }[] }).data ?? [])) {
      if (a.ad_account_id) contaDoAd.set(a.id, a.ad_account_id);
    }

    const tokens = await tokensPorConta(sb, [
      ...new Set([...contaDoCreative.values(), ...contaDoAd.values()]),
    ]);

    // Agrupa por token e resolve em lote: creatives e ads em consultas separadas
    // (os campos são diferentes), mas ainda 1 request por grupo de até 50 ids.
    const porTokenCre = new Map<string, string[]>();
    for (const id of creativeIds) {
      const t = tokens.get(contaDoCreative.get(id) ?? "");
      if (t) porTokenCre.set(t, [...(porTokenCre.get(t) ?? []), id]);
    }
    const porTokenAd = new Map<string, string[]>();
    for (const id of adIds) {
      const t = tokens.get(contaDoAd.get(id) ?? "");
      if (t) porTokenAd.set(t, [...(porTokenAd.get(t) ?? []), id]);
    }

    const chamadas: Promise<Record<string, unknown>>[] = [];
    for (const [token, ids] of porTokenCre) {
      for (let i = 0; i < ids.length; i += MAX_IDS_POR_CHAMADA) {
        chamadas.push(graphEmLote(ids.slice(i, i + MAX_IDS_POR_CHAMADA), "thumbnail_url,image_url", token));
      }
    }
    for (const [token, ids] of porTokenAd) {
      for (let i = 0; i < ids.length; i += MAX_IDS_POR_CHAMADA) {
        chamadas.push(graphEmLote(ids.slice(i, i + MAX_IDS_POR_CHAMADA), "creative{thumbnail_url,image_url}", token));
      }
    }
    const respostas = await Promise.all(chamadas);
    const porId: Record<string, unknown> = Object.assign({}, ...respostas);

    // creative_id primeiro (é o node do criativo); ad_id cobre o anúncio INATIVO,
    // que o sync de criativos não pega e por isso nunca teve thumb guardada.
    const thumbs: Record<string, string | null> = {};
    for (const r of refs) {
      const u =
        (r.creative_id ? urlDe(porId[r.creative_id]) : null) ??
        (r.ad_id ? urlDe(porId[r.ad_id]) : null);
      if (u) thumbs[r.chave] = u;
    }

    return new Response(JSON.stringify({ thumbs }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    // 422 e nunca 5xx: miniatura indisponível é ESTADO, não erro — e resposta
    // 502/504 vinda da origem some atrás da página do Cloudflare (sem CORS).
    return new Response(JSON.stringify({ error: getErr(e), thumbs: {} }), {
      status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
