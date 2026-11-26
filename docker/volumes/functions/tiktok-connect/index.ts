// tiktok-connect — gera o link de autorização do perfil ORGÂNICO (Display API, app antigo).
//
//  • POST (logado, marketing/diretoria) → { url }: link do TikTok com `state` ASSINADO
//    (30 min, uso único) com o TIKTOK_CLIENT_SECRET. O `tiktok-oauth-callback` só aceita esse state.
//  • GET: o link antigo (sem login) não vale mais — só explica.
//
// ⚠️ Até 25/11/2026 o GET era público com state fixo ("ppgvet") e o callback aceitava qualquer
// código: quem tivesse o endereço plantava o PRÓPRIO perfil como conta ativa. Mesma trava de
// tiktok-ads-connect e tiktok-perfil-connect; ver _shared/tiktokState.ts.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { exigirAcesso, respostaAcessoNegado } from "../_shared/acesso.ts";
import { getSegredo } from "../_shared/segredos.ts";
import { criarState } from "../_shared/tiktokState.ts";

const REDIRECT_URI = "https://api.ppgeducacao.site/functions/v1/tiktok-oauth-callback";
const SCOPES = "user.info.basic,user.info.profile,user.info.stats,video.list";
const PRAZO_MS = 30 * 60 * 1000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method === "GET") {
    return new Response(
      "Este link de conexão do TikTok não vale mais. Abra o sistema, vá em Métricas > TikTok > Conectar conta.",
      { status: 410, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }
  if (req.method !== "POST") return json({ error: "Método não suportado." }, 405);

  let usuarioId: string;
  let token: string;
  try {
    const quem = await exigirAcesso(req, { usuario: true });
    if (quem.tipo !== "usuario") return json({ error: "Acesso restrito." }, 403);
    usuarioId = quem.usuarioId;
    token = quem.token;
  } catch (e) {
    return respostaAcessoNegado(e, corsHeaders);
  }

  try {
    const comoUsuario = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const [mkt, dir] = await Promise.all([
      comoUsuario.rpc("is_marketing_user"),
      comoUsuario.rpc("is_admin_ou_diretor_user"),
    ]);
    if (mkt.data !== true && dir.data !== true) {
      return json({ error: "Só o Marketing e a diretoria conectam perfis do TikTok." }, 403);
    }

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const [clientKey, segredo] = await Promise.all([
      getSegredo(admin, "TIKTOK_CLIENT_KEY"),
      getSegredo(admin, "TIKTOK_CLIENT_SECRET"),
    ]);
    if (!clientKey || !segredo) return json({ error: "Credenciais do TikTok não configuradas no servidor." }, 500);

    const state = await criarState(segredo, "organico", usuarioId, PRAZO_MS);
    const url = `https://www.tiktok.com/v2/auth/authorize/?client_key=${encodeURIComponent(clientKey)}`
      + `&scope=${encodeURIComponent(SCOPES)}`
      + `&response_type=code`
      + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
      + `&state=${encodeURIComponent(state)}`;
    return json({ url });
  } catch (e) {
    console.error("tiktok-connect:", e);
    return json({ error: "Não consegui gerar o link agora. Tente de novo em instantes." }, 500);
  }
});
