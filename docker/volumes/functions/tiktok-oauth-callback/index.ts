import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// Callback do OAuth do TikTok. O perfil autoriza o app e o TikTok redireciona pra cá
// com ?code=...  Trocamos o code por access/refresh token, buscamos o perfil e salvamos
// em public.tiktok_accounts (service role). É um redirect de navegador, então respondemos
// com uma página HTML simples (sucesso/erro).
const REDIRECT_URI = "https://api.ppgeducacao.site/functions/v1/tiktok-oauth-callback";
const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const USERINFO_URL = "https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name,username";

function page(titulo: string, msg: string, ok: boolean): Response {
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

async function getConfig(supabase: ReturnType<typeof createClient>, chave: string): Promise<string | null> {
  const { data } = await supabase.from("ped_configuracoes").select("valor").eq("chave", chave).maybeSingle();
  return (data?.valor as string) || Deno.env.get(chave) || null;
}

serve(async (req) => {
  try {
    const url = new URL(req.url);
    const erro = url.searchParams.get("error");
    const erroDesc = url.searchParams.get("error_description");
    if (erro) return page("Autorização cancelada", `O TikTok retornou: ${erroDesc || erro}. Você pode fechar e tentar de novo.`, false);

    const code = url.searchParams.get("code");
    if (!code) return page("Link inválido", "Faltou o código de autorização do TikTok. Abra o link de conexão de novo.", false);

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const clientKey = await getConfig(supabase, "TIKTOK_CLIENT_KEY");
    const clientSecret = await getConfig(supabase, "TIKTOK_CLIENT_SECRET");
    if (!clientKey || !clientSecret) return page("Configuração ausente", "As credenciais do TikTok não estão configuradas no servidor.", false);

    // 1) Troca o code por tokens.
    const tokenResp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
      body: new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
      }),
    });
    const token = await tokenResp.json();
    if (!tokenResp.ok || token.error || !token.access_token) {
      console.error("TikTok token error:", JSON.stringify(token));
      return page("Falha ao conectar", `O TikTok recusou a troca do código: ${token.error_description || token.error || tokenResp.status}.`, false);
    }

    const now = Date.now();
    const tokenExpiresAt = token.expires_in ? new Date(now + token.expires_in * 1000).toISOString() : null;
    const refreshExpiresAt = token.refresh_expires_in ? new Date(now + token.refresh_expires_in * 1000).toISOString() : null;

    // 2) Busca o perfil (username/nome/avatar).
    let username: string | null = null, displayName: string | null = null, avatarUrl: string | null = null, unionId: string | null = null;
    try {
      const uResp = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${token.access_token}` } });
      const u = await uResp.json();
      const user = u?.data?.user;
      if (user) { username = user.username ?? null; displayName = user.display_name ?? null; avatarUrl = user.avatar_url ?? null; unionId = user.union_id ?? null; }
    } catch (_) { /* segue mesmo sem perfil */ }

    // 3) Salva/atualiza a conta (chave = open_id).
    const { error: upErr } = await supabase.from("tiktok_accounts").upsert({
      open_id: token.open_id,
      union_id: unionId,
      username,
      display_name: displayName,
      avatar_url: avatarUrl,
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? null,
      scope: token.scope ?? null,
      token_expires_at: tokenExpiresAt,
      refresh_expires_at: refreshExpiresAt,
      ativo: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: "open_id" });
    if (upErr) { console.error("upsert tiktok_accounts:", upErr.message); return page("Quase lá", "Conectou no TikTok, mas não consegui salvar a conta. Avise a TI.", false); }

    const nome = username ? `@${username}` : (displayName || "perfil");
    return page("TikTok conectado! 🎉", `O ${nome} foi conectado à PPGVet com sucesso. Pode fechar esta aba e voltar ao sistema.`, true);
  } catch (e) {
    console.error("tiktok-oauth-callback:", e);
    return page("Erro inesperado", "Algo deu errado ao conectar. Tente o link de novo em alguns instantes.", false);
  }
});
