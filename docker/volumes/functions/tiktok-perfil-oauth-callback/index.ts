// tiktok-perfil-oauth-callback — volta da autorização do DONO DO PERFIL (TikTok account
// holder) e grava a conta em `tiktok_business_accounts`, que é quem pode publicar.
//
// ⚠️ É o TERCEIRO callback de TikTok da casa, e eles não se misturam:
//   • tiktok-oauth-callback        → perfil pelo Display API (app antigo, Sandbox)
//   • tiktok-ads-oauth-callback    → conta de ANÚNCIO (Marketing API)
//   • este                         → perfil pela Accounts API, o único que publica
//
// O endereço abaixo é o que está cadastrado no app "PPGVet Sistema — Publicacao", no campo
// **TikTok account holder redirect URL** (não no de advertiser). Divergir daqui devolve
// "Redirect Url Not Match" na hora de autorizar.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { erroDe, trocarCodigoPorToken } from "../_shared/tiktokAccountsApi.ts";

const REDIRECT_URI = "https://api.ppgeducacao.site/functions/v1/tiktok-perfil-oauth-callback";

function pagina(titulo: string, msg: string, ok: boolean): Response {
  const cor = ok ? "#36AE9C" : "#dc2626";
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${titulo}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0b0c;color:#fff;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{max-width:440px;text-align:center;background:#161618;border:1px solid #2a2a2e;border-radius:20px;padding:36px}
.dot{width:56px;height:56px;border-radius:16px;background:${cor};margin:0 auto 18px;display:flex;align-items:center;justify-content:center;font-size:28px}
h1{font-size:20px;margin:0 0 8px}p{color:#a1a1aa;font-size:14px;line-height:1.5;margin:0}</style></head>
<body><div class="card"><div class="dot">${ok ? "✓" : "✕"}</div><h1>${titulo}</h1><p>${msg}</p></div></body></html>`;
  return new Response(html, { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const erro = url.searchParams.get("error") || url.searchParams.get("error_description");
    if (erro) return pagina("Autorização cancelada", `O TikTok retornou: ${erro}. Pode fechar e tentar de novo.`, false);

    const authCode = url.searchParams.get("auth_code") || url.searchParams.get("code");
    if (!authCode) return pagina("Link inválido", "Faltou o código de autorização do TikTok. Abra o link de conexão de novo.", false);

    const appId = Deno.env.get("TIKTOK_PERFIL_APP_ID");
    const secret = Deno.env.get("TIKTOK_PERFIL_SECRET");
    if (!appId || !secret) {
      return pagina("Configuração ausente", "Faltam TIKTOK_PERFIL_APP_ID / TIKTOK_PERFIL_SECRET no servidor.", false);
    }

    const t = await trocarCodigoPorToken(appId, secret, authCode, REDIRECT_URI);

    // O identificador da conta muda de nome conforme o exemplo da documentação. Em vez de
    // apostar num, aceita o primeiro que vier — e só falha se NENHUM vier.
    const businessId = String(t.business_id ?? t.open_id ?? t.user_id ?? t.tt_user_id ?? "");
    if (!businessId) {
      console.error("[tiktok-perfil-oauth-callback] resposta sem id:", JSON.stringify(t).slice(0, 400));
      return pagina("Quase lá", "O TikTok autorizou, mas não devolveu o identificador da conta. Avise a TI.", false);
    }

    const agora = Date.now();
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { error: upErr } = await supabase.from("tiktok_business_accounts").upsert({
      business_id: businessId,
      username: (t.username as string) ?? null,
      display_name: (t.display_name as string) ?? null,
      avatar_url: (t.profile_image as string) ?? (t.avatar_url as string) ?? null,
      access_token: t.access_token as string,
      refresh_token: (t.refresh_token as string) ?? null,
      token_expires_at: t.expires_in ? new Date(agora + Number(t.expires_in) * 1000).toISOString() : null,
      refresh_expires_at: t.refresh_expires_in ? new Date(agora + Number(t.refresh_expires_in) * 1000).toISOString() : null,
      scope: Array.isArray(t.scope) ? (t.scope as string[]).join(",") : ((t.scope as string) ?? null),
      ativo: true,
      ultimo_erro: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "business_id" });
    if (upErr) {
      console.error("[tiktok-perfil-oauth-callback] upsert:", upErr.message);
      return pagina("Quase lá", "Autorizou no TikTok, mas não consegui salvar o perfil. Avise a TI.", false);
    }

    const nome = t.username ? `@${t.username}` : (t.display_name as string) || "o perfil";
    return pagina("Perfil conectado! 🎉", `${nome} já pode receber os posts agendados no Planner. Pode fechar esta aba.`, true);
  } catch (e) {
    console.error("[tiktok-perfil-oauth-callback]", e);
    return pagina("Erro ao conectar", `Algo deu errado: ${erroDe(e)}`, false);
  }
});
