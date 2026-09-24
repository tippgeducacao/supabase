// tiktok-ads-connect — conecta uma conta do TikTok Ads Manager (Marketing API).
//
// Dois caminhos, porque na prática o segundo é o que resolve:
//  • GET  → 302 para o portal de autorização do TikTok for Business (precisa de
//    TIKTOK_ADS_APP_ID configurado E da nossa URL registrada como redirect no app).
//  • POST → salva `advertiser_id` + `access_token` colados à mão. É o caminho de quem já
//    tem um app autorizado (o do gestor de tráfego, por exemplo): não exige mexer no app
//    nem registrar redirect. O token é VALIDADO contra a API antes de ser gravado.
//
// ⚠️ verify_jwt = false (o GET é um clique de navegador, sem header). Por isso o POST
// confere o JWT e o cargo NA MÃO — sem isso qualquer um plantaria um token aqui dentro.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

const API = "https://business-api.tiktok.com/open_api/v1.3";
const REDIRECT_URI = "https://api.ppgeducacao.site/functions/v1/tiktok-ads-oauth-callback";

async function getConfig(supabase: ReturnType<typeof createClient>, chave: string): Promise<string | null> {
  const { data } = await supabase.from("ped_configuracoes").select("valor").eq("chave", chave).maybeSingle();
  return (data?.valor as string) || Deno.env.get(chave) || null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // ── GET: manda o navegador pro portal de autorização ───────────────────────────
  if (req.method === "GET") {
    try {
      const appId = await getConfig(admin, "TIKTOK_ADS_APP_ID");
      if (!appId) {
        return new Response(
          "TikTok Ads: falta o TIKTOK_ADS_APP_ID no servidor. Use o botão \"Colar token\" na tela, ou peça à TI para cadastrar o app.",
          { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } },
        );
      }
      const state = new URL(req.url).searchParams.get("state") || "ppgvet";
      const authUrl = `https://business-api.tiktok.com/portal/auth?app_id=${encodeURIComponent(appId)}`
        + `&state=${encodeURIComponent(state)}`
        + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
      return new Response(null, { status: 302, headers: { Location: authUrl } });
    } catch (e) {
      console.error("[tiktok-ads-connect] GET:", e);
      return new Response("Erro ao iniciar a conexão com o TikTok Ads.", { status: 500 });
    }
  }

  if (req.method !== "POST") return json({ error: "Método não suportado." }, 405);

  // ── POST: grava advertiser_id + access_token (só marketing/diretoria) ──────────
  try {
    const auth = req.headers.get("Authorization") || "";
    if (!auth) return json({ ok: false, error: "Não autenticado" }, 401);

    const comoUsuario = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    const { data: u } = await comoUsuario.auth.getUser();
    if (!u?.user) return json({ ok: false, error: "Não autenticado" }, 401);

    const [mkt, dir] = await Promise.all([
      comoUsuario.rpc("is_marketing_user"),
      comoUsuario.rpc("is_admin_ou_diretor_user"),
    ]);
    if (mkt.data !== true && dir.data !== true) {
      return json({ ok: false, error: "Sem permissão para conectar contas de anúncio." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const advertiserId = String(body.advertiser_id ?? "").replace(/\D/g, "");
    const accessToken = String(body.access_token ?? "").trim();
    if (!advertiserId) return json({ ok: false, error: "Informe o ID da conta de anúncios (só números)." }, 400);
    if (!accessToken) return json({ ok: false, error: "Informe o Access Token do app do TikTok." }, 400);

    // Valida ANTES de gravar: token errado salvo em silêncio vira tela vazia sem explicação.
    const url = new URL(`${API}/advertiser/info/`);
    url.searchParams.set("advertiser_ids", JSON.stringify([advertiserId]));
    url.searchParams.set("fields", JSON.stringify(["name", "currency", "timezone"]));
    const resp = await fetch(url.toString(), {
      headers: { "Access-Token": accessToken, "Content-Type": "application/json" },
    });
    const corpo = await resp.json().catch(() => ({}));
    // O TikTok devolve 200 mesmo recusando; quem manda é o `code`.
    if (corpo?.code !== 0) {
      return json({
        ok: false,
        error: `O TikTok recusou essa combinação (code ${corpo?.code ?? "?"}): ${corpo?.message || "verifique o ID da conta e o token"}.`,
      }, 400);
    }
    const info = corpo?.data?.list?.[0] ?? {};

    const { error: upErr } = await admin.from("tiktok_ad_accounts").upsert({
      advertiser_id: advertiserId,
      advertiser_name: info.name ?? null,
      currency: info.currency ?? null,
      timezone: info.timezone ?? null,
      access_token: accessToken,
      origem: "manual",
      ativo: true,
      ultimo_erro: null,
      conectado_por: u.user.id,
      updated_at: new Date().toISOString(),
    }, { onConflict: "advertiser_id" });
    if (upErr) return json({ ok: false, error: `Não consegui salvar a conta: ${upErr.message}` }, 500);

    return json({
      ok: true,
      advertiser_id: advertiserId,
      advertiser_name: info.name ?? null,
      currency: info.currency ?? null,
    });
  } catch (e) {
    console.error("[tiktok-ads-connect] POST:", e);
    return json({ ok: false, error: err(e) }, 500);
  }
});
