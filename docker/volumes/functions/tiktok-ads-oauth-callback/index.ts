// tiktok-ads-oauth-callback — volta do portal do TikTok for Business com ?auth_code=...
// Troca o código por um Access-Token, lista os advertisers autorizados e grava cada um em
// public.tiktok_ad_accounts. É um redirect de navegador ⇒ responde HTML.
//
// ⚠️ Não confundir com `tiktok-oauth-callback` (sem "-ads-"), que é o do PERFIL ORGÂNICO:
// outro app, outro domínio de API e outro formato de token.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const API = "https://business-api.tiktok.com/open_api/v1.3";

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

/**
 * Troca o auth_code por token.
 *
 * ⚠️ UMA tentativa só, e SEM `grant_type`. Este endpoint da Marketing API aceita apenas
 * `app_id` + `secret` + `auth_code` (JSON; form-urlencoded não serve) — `grant_type` é de
 * OUTRA API do TikTok, a de conta orgânica. A versão anterior tentava três valores de
 * `grant_type` em sequência "por segurança", e isso era o contrário de seguro: o
 * `auth_code` da Marketing API vale UMA HORA e é de **uso único**, então uma primeira
 * tentativa recusada pode QUEIMAR o código e derrubar as outras duas — a pessoa teria de
 * refazer a autorização inteira sem entender por quê (achado em 24/09/2026, antes de
 * qualquer uso real; o fluxo OAuth nunca chegou a rodar contra o TikTok).
 *
 * `return_advertiser_ids` faz o próprio TikTok já devolver as contas autorizadas, o que
 * salva o fluxo quando /oauth2/advertiser/get/ falha.
 */
async function trocarCodigo(appId: string, secret: string, authCode: string) {
  const resp = await fetch(`${API}/oauth2/access_token/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: appId,
      secret,
      auth_code: authCode,
      return_advertiser_ids: true,
    }),
  });
  const corpo = await resp.json().catch(() => ({}));
  if (corpo?.code === 0 && corpo?.data?.access_token) return corpo.data;
  throw new Error(
    `code ${corpo?.code ?? "?"}: ${corpo?.message || "o TikTok não devolveu token"}`,
  );
}

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const erro = url.searchParams.get("error") || url.searchParams.get("error_description");
    if (erro) return page("Autorização cancelada", `O TikTok retornou: ${erro}. Pode fechar e tentar de novo.`, false);

    const authCode = url.searchParams.get("auth_code") || url.searchParams.get("code");
    if (!authCode) return page("Link inválido", "Faltou o código de autorização do TikTok. Abra o link de conexão de novo.", false);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const appId = await getConfig(admin, "TIKTOK_ADS_APP_ID");
    const secret = await getConfig(admin, "TIKTOK_ADS_SECRET");
    if (!appId || !secret) return page("Configuração ausente", "O app do TikTok Ads não está cadastrado no servidor (TIKTOK_ADS_APP_ID / TIKTOK_ADS_SECRET).", false);

    const token = await trocarCodigo(appId, secret, authCode);
    const accessToken: string = token.access_token;
    const escopo = Array.isArray(token.scope) ? token.scope.join(",") : (token.scope ?? null);

    // Quais contas esse token enxerga. `advertiser_ids` já vem na troca, mas /advertiser/get/
    // traz o NOME junto — e conta sem nome na tela é conta que ninguém reconhece.
    const advertisers: Array<{ advertiser_id: string; advertiser_name?: string }> = [];
    try {
      const u = new URL(`${API}/oauth2/advertiser/get/`);
      u.searchParams.set("app_id", appId);
      u.searchParams.set("secret", secret);
      const resp = await fetch(u.toString(), { headers: { "Access-Token": accessToken, "Content-Type": "application/json" } });
      const corpo = await resp.json().catch(() => ({}));
      if (corpo?.code === 0) advertisers.push(...(corpo?.data?.list ?? []));
    } catch (e) {
      console.warn("[tiktok-ads-oauth-callback] advertiser/get falhou:", e);
    }
    if (!advertisers.length) {
      for (const id of (token.advertiser_ids ?? [])) advertisers.push({ advertiser_id: String(id) });
    }
    if (!advertisers.length) return page("Quase lá", "O TikTok autorizou, mas não veio nenhuma conta de anúncios junto. Confira se o app tem acesso ao Ads Manager.", false);

    const agora = new Date().toISOString();
    const { error: upErr } = await admin.from("tiktok_ad_accounts").upsert(
      advertisers.map((a) => ({
        advertiser_id: String(a.advertiser_id),
        advertiser_name: a.advertiser_name ?? null,
        access_token: accessToken,
        scope: escopo,
        origem: "oauth",
        ativo: true,
        ultimo_erro: null,
        updated_at: agora,
      })),
      { onConflict: "advertiser_id" },
    );
    if (upErr) {
      console.error("[tiktok-ads-oauth-callback] upsert:", upErr.message);
      return page("Quase lá", "Autorizou no TikTok, mas não consegui salvar a conta. Avise a TI.", false);
    }

    const quantas = advertisers.length;
    return page(
      "TikTok Ads conectado! 🎉",
      `${quantas} conta${quantas > 1 ? "s" : ""} de anúncios ligada${quantas > 1 ? "s" : ""} à PPGVet. Volte ao sistema e clique em Sincronizar.`,
      true,
    );
  } catch (e) {
    console.error("[tiktok-ads-oauth-callback]", e);
    return page("Erro ao conectar", `Algo deu errado: ${e instanceof Error ? e.message : String(e)}`, false);
  }
});
