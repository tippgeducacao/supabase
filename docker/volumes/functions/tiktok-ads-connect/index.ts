// tiktok-ads-connect — conecta uma conta do TikTok Ads Manager (Marketing API).
//
// Dois caminhos, os dois LOGADOS (marketing/diretoria):
//  • POST { acao: "autorizar" } → { url } do portal de autorização do TikTok for Business, com
//    `state` ASSINADO (30 min, uso único). O callback `tiktok-ads-oauth-callback` só aceita esse
//    state. Precisa de TIKTOK_ADS_APP_ID/TIKTOK_ADS_SECRET e da nossa URL registrada no app.
//  • POST { advertiser_id, access_token } → salva o par colado à mão. É o caminho de quem já
//    tem um app autorizado (o do gestor de tráfego, por exemplo): não exige mexer no app
//    nem registrar redirect. O token é VALIDADO contra a API antes de ser gravado.
//
// ⚠️ Até 29/10/2026 havia um GET sem login que redirecionava para o portal com state fixo
// ("ppgvet"), e o callback aceitava qualquer código: quem tivesse o endereço plantava a PRÓPRIA
// conta de anúncio aqui. O GET agora só explica que o link mudou. Ver _shared/tiktokState.ts.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { exigirAcesso, respostaAcessoNegado } from "../_shared/acesso.ts";
import { getSegredo } from "../_shared/segredos.ts";
import { criarState } from "../_shared/tiktokState.ts";

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
const PRAZO_AUTORIZAR_MS = 30 * 60 * 1000;



Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // ── GET: o link antigo (sem login) não autoriza mais nada ─────────────────────
  if (req.method === "GET") {
    return new Response(
      "Este link de conexão do TikTok Ads não vale mais. Abra o sistema, vá em TikTok Ads > Conectar conta > Autorizar pelo TikTok.",
      { status: 410, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }

  if (req.method !== "POST") return json({ error: "Método não suportado." }, 405);

  // ── POST: link de autorização OU token colado (só marketing/diretoria) ─────────
  let usuarioId: string;
  let tokenSessao: string;
  try {
    const quem = await exigirAcesso(req, { usuario: true });
    if (quem.tipo !== "usuario") return json({ ok: false, error: "Acesso restrito." }, 403);
    usuarioId = quem.usuarioId;
    tokenSessao = quem.token;
  } catch (e) {
    return respostaAcessoNegado(e, corsHeaders);
  }

  try {
    const comoUsuario = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: `Bearer ${tokenSessao}` } },
    });

    const [mkt, dir] = await Promise.all([
      comoUsuario.rpc("is_marketing_user"),
      comoUsuario.rpc("is_admin_ou_diretor_user"),
    ]);
    if (mkt.data !== true && dir.data !== true) {
      return json({ ok: false, error: "Sem permissão para conectar contas de anúncio." }, 403);
    }

    const body = await req.json().catch(() => ({}));

    if (body.acao === "autorizar") {
      const [appId, segredo] = await Promise.all([
        getSegredo(admin, "TIKTOK_ADS_APP_ID"),
        getSegredo(admin, "TIKTOK_ADS_SECRET"),
      ]);
      if (!appId || !segredo) {
        return json({ ok: false, error: "O app do TikTok Ads não está cadastrado no servidor. Use \"Colar token\" ou fale com a TI." }, 500);
      }
      const state = await criarState(segredo, "ads", usuarioId, PRAZO_AUTORIZAR_MS);
      const url = `https://business-api.tiktok.com/portal/auth?app_id=${encodeURIComponent(appId)}`
        + `&state=${encodeURIComponent(state)}`
        + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
      return json({ ok: true, url });
    }

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
      conectado_por: usuarioId,
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
