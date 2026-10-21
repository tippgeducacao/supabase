// linkedin-connect — o link que conecta um LinkedIn PESSOAL ao Agendar Post.
//
//  • POST (logado, marketing/diretoria) { profile_key } → { url, expira_em }
//    Gera um link de autorização de USO ÚNICO, válido por 7 dias, amarrado ao perfil de marca.
//    Quem gera quase nunca é o dono do LinkedIn: o marketing gera e manda para o Rafael abrir no
//    navegador onde ELE está logado no LinkedIn.
//  • GET ?s=<state> (clique de navegador, sem login) → confere o state e redireciona (302) para a
//    autorização do LinkedIn. O state vai junto e volta no callback (`linkedin-oauth-callback`).
//
// ⚠️ O `verify_jwt` do config.toml NÃO vale neste servidor (o runtime não lê o arquivo — ver
// docs/Infraestrutura e Deploy.md). Por isso o POST confere a sessão e o cargo AQUI.
//
// ⚠️ Credencial do app: `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` em `app_secrets`
// (service-role-only), lidas por `getSegredo`. Nunca em `ped_configuracoes` (leitura aberta).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getSegredo } from "../_shared/segredos.ts";
import { escaparHtml } from "../_shared/escaparHtml.ts";
import { paginaLinkedIn } from "../_shared/linkedinPagina.ts";
import { CALLBACK_URI, urlDeAutorizacao } from "../_shared/linkedinApi.ts";

const BASE_PUBLICA = "https://api.ppgeducacao.site/functions/v1";
const PRAZO_DO_LINK_MS = 7 * 24 * 60 * 60 * 1000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const stateNovo = () => {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
};

// Texto para QUEM USA (aparece no diálogo). O que falta, para quem constrói: LINKEDIN_CLIENT_ID
// e LINKEDIN_CLIENT_SECRET em app_secrets — passo a passo em docs/Marketing — Portal e Conteúdo.md
// ("Pré-requisito único: o app do LinkedIn").
const SEM_APP =
  "O LinkedIn ainda não foi liberado no sistema: falta o cadastro do app da PPGVET no LinkedIn " +
  "(é feito uma vez só). Fale com a TI.";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // ── GET: o link que a pessoa abre ─────────────────────────────────────────────
  if (req.method === "GET") {
    try {
      const state = new URL(req.url).searchParams.get("s") || "";
      if (!/^[0-9a-f]{64}$/.test(state)) {
        return paginaLinkedIn("Link inválido", "Este link de conexão está incompleto. Peça um novo a quem enviou.", false);
      }
      const { data: pend } = await admin
        .from("linkedin_conexoes_pendentes")
        .select("state, profile_key, expira_em, usado_em")
        .eq("state", state)
        .maybeSingle();
      if (!pend) return paginaLinkedIn("Link inválido", "Não reconheço este link de conexão. Peça um novo a quem enviou.", false);
      if (pend.usado_em) {
        return paginaLinkedIn("Link já usado", "Este link já conectou um LinkedIn e vale uma vez só. Se precisa reconectar, peça um novo.", false);
      }
      if (new Date(pend.expira_em).getTime() < Date.now()) {
        return paginaLinkedIn("Link vencido", "Este link de conexão passou do prazo de 7 dias. Peça um novo a quem enviou.", false);
      }
      const clientId = await getSegredo(admin, "LINKEDIN_CLIENT_ID");
      if (!clientId) return paginaLinkedIn("Configuração ausente", escaparHtml(SEM_APP), false, 500);
      return new Response(null, { status: 302, headers: { Location: urlDeAutorizacao(clientId, CALLBACK_URI, state) } });
    } catch (e) {
      console.error("[linkedin-connect] GET:", e);
      return paginaLinkedIn("Erro ao abrir o LinkedIn", "Algo deu errado do nosso lado. Tente de novo em instantes.", false, 500);
    }
  }

  if (req.method !== "POST") return json({ error: "Método não suportado." }, 405);

  // ── POST: gerar o link (só marketing/diretoria) ───────────────────────────────
  try {
    const auth = req.headers.get("Authorization") || "";
    if (!auth) return json({ error: "Não autenticado." }, 401);
    const comoUsuario = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    const { data: u } = await comoUsuario.auth.getUser();
    if (!u?.user) return json({ error: "Não autenticado." }, 401);
    const [mkt, ger, dir] = await Promise.all([
      comoUsuario.rpc("is_marketing_user"),
      comoUsuario.rpc("is_management_user"),
      comoUsuario.rpc("is_admin_ou_diretor_user"),
    ]);
    if (mkt.data !== true && ger.data !== true && dir.data !== true) {
      return json({ error: "Sem permissão para conectar contas do LinkedIn." }, 403);
    }

    const corpo = await req.json().catch(() => ({}));
    const profileKey = String(corpo?.profile_key ?? "").trim();
    if (!profileKey) return json({ error: "Escolha de qual perfil de marca é este LinkedIn." }, 400);
    const { data: perfil } = await admin
      .from("marketing_profiles").select("key, label").eq("key", profileKey).maybeSingle();
    if (!perfil) return json({ error: `Perfil de marca "${profileKey}" não existe.` }, 400);

    // Sem o app cadastrado o link levaria a uma página de erro do LinkedIn — melhor dizer já.
    const [clientId, segredo] = await Promise.all([
      getSegredo(admin, "LINKEDIN_CLIENT_ID"),
      getSegredo(admin, "LINKEDIN_CLIENT_SECRET"),
    ]);
    if (!clientId || !segredo) return json({ error: SEM_APP, sem_app: true }, 409);

    const state = stateNovo();
    const expiraEm = new Date(Date.now() + PRAZO_DO_LINK_MS).toISOString();
    const { error: eIns } = await admin.from("linkedin_conexoes_pendentes").insert({
      state, profile_key: profileKey, criado_por: u.user.id, expira_em: expiraEm,
    });
    if (eIns) return json({ error: `Não consegui gerar o link: ${eIns.message}` }, 500);

    return json({ ok: true, url: `${BASE_PUBLICA}/linkedin-connect?s=${state}`, expira_em: expiraEm, perfil: perfil.label });
  } catch (e) {
    console.error("[linkedin-connect] POST:", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
