// pages-capi-token — entrega o token da Conversions API do Meta ao Gerador de Prompt (Pages).
//
// 29/10/2026: o token estava fixo em src/components/pages/geradorPrompt.ts, e todo arquivo JS do
// site é público (a varredura do bundle o achou em PagesApp-*.js). Agora mora no cofre
// (`app_secrets.META_CAPI_TOKEN_PAGES`) e só sai daqui para quem está logado e é do Marketing ou da
// diretoria — é quem gera o prompt das landing pages, onde o token vai para o backend da LP.
//   POST (logado) {} → { token }
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { exigirAcesso, respostaAcessoNegado } from "../_shared/acesso.ts";
import { getSegredo } from "../_shared/segredos.ts";

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

  let token: string;
  try {
    const quem = await exigirAcesso(req, { usuario: true });
    if (quem.tipo !== "usuario") return json({ error: "Acesso restrito." }, 403);
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
    if (mkt.data !== true && dir.data !== true) return json({ error: "Só o Marketing e a diretoria." }, 403);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const capi = await getSegredo(admin, "META_CAPI_TOKEN_PAGES");
    return json({ token: capi ?? "" });
  } catch (e) {
    console.error("[pages-capi-token]", e);
    return json({ error: "Não consegui buscar o token agora." }, 500);
  }
});
