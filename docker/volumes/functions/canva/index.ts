// canva — «Abrir com Canva» da proposta B2B: a proposta abre JÁ DENTRO do Canva (11/11/2026).
//
// Só colaborador logado com o Construtor de Proposta (is_b2b_proposta_user).
//
//  • POST JSON {acao:'status'}        → { configurado, conectado, nome }
//  • POST JSON {acao:'conectar'}      → { url }  (autorização do Canva; volta em canva-oauth-callback)
//  • POST JSON {acao:'desconectar'}   → { ok }
//  • POST JSON {acao:'job', job_id}   → { status, edit_url, erro }
//  • POST binário (o .pptx), cabeçalho x-canva-titulo (encodeURIComponent)
//                                     → { job_id, status, edit_url, erro }
//
// Erro 409 com { reconectar: true } = a conexão do Canva morreu (token revogado ou refresh
// recusado): a tela manda conectar de novo.
//
// ⚠️ Credenciais em `app_secrets` (CANVA_CLIENT_ID / CANVA_CLIENT_SECRET). Sem elas
// `configurado: false` e a tela segue o fluxo antigo (baixa o .pptx e abre o Canva).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { exigirAcesso, respostaAcessoNegado } from "../_shared/acesso.ts";
import { getSegredo } from "../_shared/segredos.ts";
import {
  consultarImport, criarImport, ErroCanva, gerarPkce, renovarToken, stateNovo, urlDeAutorizacao,
} from "../_shared/canvaApi.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-canva-titulo, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const PRAZO_STATE_MS = 15 * 60 * 1000;
/** Renova se faltar menos que isto para vencer. */
const FOLGA_RENOVACAO_MS = 2 * 60 * 1000;
/** Teto do .pptx (o deck tem ~22 slides de JPEG; folga de sobra). */
const MAX_BYTES = 60 * 1024 * 1024;

type Admin = ReturnType<typeof createClient>;

class Reconectar extends Error {}

/** Token válido do usuário, renovando se precisar. O refresh é de uso único: grava o novo. */
async function tokenDoUsuario(admin: Admin, userId: string, clientId: string, segredo: string): Promise<string> {
  const { data: conta } = await admin
    .from("canva_contas")
    .select("access_token, refresh_token, token_expires_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (!conta) throw new Reconectar("Conecte sua conta do Canva.");
  if (new Date(conta.token_expires_at as string).getTime() - Date.now() > FOLGA_RENOVACAO_MS) {
    return conta.access_token as string;
  }
  try {
    const novo = await renovarToken(clientId, segredo, conta.refresh_token as string);
    await admin.from("canva_contas").update({
      access_token: novo.access_token,
      refresh_token: novo.refresh_token,
      token_expires_at: new Date(Date.now() + novo.expires_in * 1000).toISOString(),
      scope: novo.scope ?? null,
      ultimo_erro: null,
      updated_at: new Date().toISOString(),
    }).eq("user_id", userId).eq("refresh_token", conta.refresh_token as string);
    return novo.access_token;
  } catch (e) {
    // Dois pedidos ao mesmo tempo: o outro já renovou e gravou — o nosso refresh "velho" foi
    // recusado. Relê: se o refresh mudou, usa o token que o outro gravou.
    const { data: atual } = await admin
      .from("canva_contas").select("access_token, refresh_token").eq("user_id", userId).maybeSingle();
    if (atual && atual.refresh_token !== conta.refresh_token) return atual.access_token as string;
    if (e instanceof ErroCanva && e.status >= 400 && e.status < 500) {
      await admin.from("canva_contas").delete().eq("user_id", userId);
      throw new Reconectar("A conexão com o Canva expirou. Conecte de novo.");
    }
    throw e;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método não suportado." }, 405);

  let userId: string;
  try {
    const quem = await exigirAcesso(req, { usuario: true, rpcPermissao: "is_b2b_proposta_user" });
    if (quem.tipo !== "usuario") return json({ error: "Só para colaborador logado." }, 403);
    userId = quem.usuarioId;
  } catch (e) {
    return respostaAcessoNegado(e, corsHeaders);
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    const [clientId, segredo] = await Promise.all([
      getSegredo(admin, "CANVA_CLIENT_ID"),
      getSegredo(admin, "CANVA_CLIENT_SECRET"),
    ]);
    const configurado = !!clientId && !!segredo;
    const tipo = req.headers.get("content-type") || "";

    // ── Import: o corpo é o .pptx ────────────────────────────────────────────
    if (!tipo.includes("application/json")) {
      if (!configurado) return json({ error: "O Canva ainda não foi ligado no sistema.", configurado: false }, 409);
      const arquivo = await req.arrayBuffer();
      if (arquivo.byteLength === 0) return json({ error: "Arquivo vazio." }, 400);
      if (arquivo.byteLength > MAX_BYTES) return json({ error: "Arquivo grande demais para o Canva." }, 413);
      let titulo = "Proposta PPGVET";
      try { titulo = decodeURIComponent(req.headers.get("x-canva-titulo") || "") || titulo; } catch { /* mantém */ }
      const token = await tokenDoUsuario(admin, userId, clientId!, segredo!);
      const job = await criarImport(token, arquivo, titulo);
      return json({ job_id: job.id, status: job.status, edit_url: job.edit_url, erro: job.erro });
    }

    const corpo = await req.json().catch(() => ({}));
    const acao = String(corpo?.acao ?? "");

    if (acao === "status") {
      if (!configurado) return json({ configurado: false, conectado: false, nome: null });
      const { data: conta } = await admin
        .from("canva_contas").select("nome_canva").eq("user_id", userId).maybeSingle();
      return json({ configurado: true, conectado: !!conta, nome: conta?.nome_canva ?? null });
    }

    if (!configurado) return json({ error: "O Canva ainda não foi ligado no sistema.", configurado: false }, 409);

    if (acao === "conectar") {
      // Faxina barata: states vencidos não servem para nada.
      await admin.from("canva_conexoes_pendentes").delete().lt("expira_em", new Date().toISOString());
      const state = stateNovo();
      const { verifier, challenge } = await gerarPkce();
      const { error } = await admin.from("canva_conexoes_pendentes").insert({
        state,
        user_id: userId,
        code_verifier: verifier,
        expira_em: new Date(Date.now() + PRAZO_STATE_MS).toISOString(),
      });
      if (error) return json({ error: `Não consegui iniciar a conexão: ${error.message}` }, 500);
      return json({ url: urlDeAutorizacao(clientId!, state, challenge) });
    }

    if (acao === "desconectar") {
      await admin.from("canva_contas").delete().eq("user_id", userId);
      return json({ ok: true });
    }

    if (acao === "job") {
      const jobId = String(corpo?.job_id ?? "");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) return json({ error: "Job inválido." }, 400);
      const token = await tokenDoUsuario(admin, userId, clientId!, segredo!);
      const job = await consultarImport(token, jobId);
      return json({ status: job.status, edit_url: job.edit_url, erro: job.erro });
    }

    return json({ error: "Ação desconhecida." }, 400);
  } catch (e) {
    if (e instanceof Reconectar) return json({ error: e.message, reconectar: true }, 409);
    if (e instanceof ErroCanva) {
      console.error("[canva] API:", e.status, e.codigo, e.message);
      if (e.status === 401) {
        await admin.from("canva_contas").delete().eq("user_id", userId);
        return json({ error: "A conexão com o Canva expirou. Conecte de novo.", reconectar: true }, 409);
      }
      if (e.status === 429) return json({ error: "O Canva pediu para esperar um pouco. Tente de novo em 1 minuto." }, 429);
      return json({ error: `O Canva recusou: ${e.message}` }, 502);
    }
    console.error("[canva]", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
