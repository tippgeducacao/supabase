import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// Inicia o OAuth do TikTok: lê o client_key do servidor (ped_configuracoes) e
// redireciona o navegador pra tela de autorização do TikTok. O botão "Conectar"
// do dashboard só abre esta URL — assim o front nunca manuseia a client_key e o
// mesmo fluxo serve pra Sandbox e Produção (basta trocar a chave no servidor).
const REDIRECT_URI = "https://api.ppgeducacao.site/functions/v1/tiktok-oauth-callback";
const SCOPES = "user.info.basic,user.info.profile,user.info.stats,video.list";

serve(async (req) => {
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data } = await supabase.from("ped_configuracoes").select("valor").eq("chave", "TIKTOK_CLIENT_KEY").maybeSingle();
    const clientKey = (data?.valor as string) || Deno.env.get("TIKTOK_CLIENT_KEY");
    if (!clientKey) return new Response("Credenciais do TikTok não configuradas.", { status: 500 });

    // state simples (anti-CSRF leve); o callback não depende dele hoje.
    const state = new URL(req.url).searchParams.get("state") || "ppgvet";
    const authUrl = `https://www.tiktok.com/v2/auth/authorize/?client_key=${encodeURIComponent(clientKey)}`
      + `&scope=${encodeURIComponent(SCOPES)}`
      + `&response_type=code`
      + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
      + `&state=${encodeURIComponent(state)}`;
    return new Response(null, { status: 302, headers: { Location: authUrl } });
  } catch (e) {
    console.error("tiktok-connect:", e);
    return new Response("Erro ao iniciar conexão com o TikTok.", { status: 500 });
  }
});
