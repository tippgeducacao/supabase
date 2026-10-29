// tiktok-perfil-connect — gera o link SEGURO que conecta o perfil do TikTok que publica.
//
//  • POST (logado, marketing/diretoria) { url_portal } → { url, expira_em }
//    `url_portal` é o link de autorização que o portal do TikTok mostra para o app
//    "PPGVet Sistema — Publicacao" (www.tiktok.com/v2/auth/authorize?client_key=…). A edge
//    confere que é do NOSSO app e volta para o NOSSO callback, e troca o `state` por um
//    assinado (24 h, uso único). Quem abre o link é o dono do perfil, no navegador em que ELE
//    está logado no TikTok — ver o aviso de 12/10/2026 em docs/Marketing — Portal e Conteúdo.md.
//
// Por que colar o link do portal em vez de montar aqui: os escopos são os que o app tem
// aprovados no portal, e pedir um escopo a mais faz o TikTok recusar a autorização inteira.
// O portal é a fonte da verdade deles; a edge só acrescenta a trava.
//
// Por que existe (29/10/2026): antes o link do portal ia direto, com state fixo, e o callback
// aceitava qualquer código — quem tivesse o link conectava o PRÓPRIO perfil como destino dos
// posts. Ver _shared/tiktokState.ts e docs/SECURITY.md → "Edge functions: quem chama".
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { exigirAcesso, respostaAcessoNegado } from "../_shared/acesso.ts";
import { getSegredo } from "../_shared/segredos.ts";
import { criarState } from "../_shared/tiktokState.ts";

const REDIRECT_URI = "https://api.ppgeducacao.site/functions/v1/tiktok-perfil-oauth-callback";
const PRAZO_MS = 24 * 60 * 60 * 1000;
const HOSTS_DO_PORTAL = new Set(["www.tiktok.com", "business-api.tiktok.com"]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
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

    const body = await req.json().catch(() => ({}));
    let portal: URL;
    try {
      portal = new URL(String(body.url_portal ?? "").trim());
    } catch {
      return json({ error: "Cole o link de autorização que o portal do TikTok mostra (começa com https://www.tiktok.com/v2/auth/authorize)." }, 400);
    }
    if (portal.protocol !== "https:" || !HOSTS_DO_PORTAL.has(portal.hostname)) {
      return json({ error: "Esse link não é do TikTok. Copie o link de autorização do app no portal do TikTok." }, 400);
    }

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const [appId, segredo] = await Promise.all([
      getSegredo(admin, "TIKTOK_PERFIL_APP_ID"),
      getSegredo(admin, "TIKTOK_PERFIL_SECRET"),
    ]);
    if (!appId || !segredo) return json({ error: "O app de publicação do TikTok não está cadastrado no servidor. Fale com a TI." }, 500);

    const chaveDoApp = portal.searchParams.get("client_key") ?? portal.searchParams.get("app_id");
    if (chaveDoApp !== appId) {
      return json({ error: "Esse link é de outro app do TikTok. Use o do app \"PPGVet Sistema — Publicacao\"." }, 400);
    }
    const retorno = portal.searchParams.get("redirect_uri");
    if (retorno && retorno !== REDIRECT_URI) {
      return json({ error: "Esse link volta para outro endereço. No portal, o redirect do titular do perfil tem de ser o callback do sistema." }, 400);
    }
    portal.searchParams.set("redirect_uri", REDIRECT_URI);
    portal.searchParams.set("state", await criarState(segredo, "perfil", usuarioId, PRAZO_MS));

    return json({ url: portal.toString(), expira_em: new Date(Date.now() + PRAZO_MS).toISOString() });
  } catch (e) {
    console.error("[tiktok-perfil-connect]", e);
    return json({ error: "Não consegui gerar o link agora. Tente de novo em instantes." }, 500);
  }
});
