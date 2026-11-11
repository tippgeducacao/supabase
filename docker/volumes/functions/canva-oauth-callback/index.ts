// acesso: publico — callback de OAuth do Canva: só grava com state conhecido, de uso único, no prazo de 15 min e amarrado a quem pediu (canva_conexoes_pendentes); o code_verifier do PKCE nunca saiu do servidor
//
// canva-oauth-callback — volta da autorização do Canva (proposta B2B → «Abrir com Canva»).
// Recebe ?code&state (ou ?error&state). O `state` foi gerado pela edge `canva` {acao:'conectar'}
// para um colaborador logado; é ele que diz DE QUEM é esta conta do Canva.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getSegredo } from "../_shared/segredos.ts";
import { escaparHtml } from "../_shared/escaparHtml.ts";
import { buscarNome, trocarCodigoPorToken } from "../_shared/canvaApi.ts";

function pagina(tituloCru: string, msg: string, ok: boolean, status?: number): Response {
  const titulo = escaparHtml(tituloCru);
  const cor = ok ? "#7D2AE8" : "#dc2626";
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${titulo}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f2fa;color:#1d1d1f;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px;box-sizing:border-box}
.card{max-width:440px;width:100%;text-align:center;background:#fff;border:1px solid #e4e0ef;border-radius:16px;padding:32px 24px;box-sizing:border-box}
.dot{width:56px;height:56px;border-radius:14px;background:${cor};margin:0 auto 18px;display:flex;align-items:center;justify-content:center;font-size:28px;color:#fff}
h1{font-size:20px;margin:0 0 10px}p{color:#55515e;font-size:14px;line-height:1.55;margin:0}</style></head>
<body><div class="card"><div class="dot">${ok ? "✓" : "✕"}</div><h1>${titulo}</h1><p>${msg}</p></div></body></html>`;
  return new Response(html, {
    status: status ?? (ok ? 200 : 400),
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

const VOLTE = "Volte para a proposta no sistema e clique de novo em <strong>Abrir com Canva</strong>.";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const state = url.searchParams.get("state") || "";
  const erro = url.searchParams.get("error");
  const code = url.searchParams.get("code");

  if (erro) {
    return pagina("Canva não conectado", `O Canva respondeu: ${escaparHtml(erro)}. Nada foi gravado. ${VOLTE}`, false);
  }
  if (!code || !/^[0-9a-f]{64}$/.test(state)) {
    return pagina("Link inválido", `Faltou o código de autorização do Canva. ${VOLTE}`, false);
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Reserva o state de forma ATÔMICA (duas abas voltando juntas não gravam duas vezes).
  const { data: reservado } = await admin
    .from("canva_conexoes_pendentes")
    .update({ usado_em: new Date().toISOString() })
    .eq("state", state)
    .is("usado_em", null)
    .gt("expira_em", new Date().toISOString())
    .select("user_id, code_verifier")
    .maybeSingle();
  if (!reservado) {
    return pagina(
      "Este link não vale mais",
      `A autorização já foi usada ou passou de 15 minutos. Se você recarregou esta página, a conexão provavelmente já está feita. ${VOLTE}`,
      false,
    );
  }

  try {
    const [clientId, segredo] = await Promise.all([
      getSegredo(admin, "CANVA_CLIENT_ID"),
      getSegredo(admin, "CANVA_CLIENT_SECRET"),
    ]);
    if (!clientId || !segredo) {
      return pagina("Configuração ausente", "As credenciais do app do Canva não estão no servidor. Avise a TI.", false, 500);
    }
    const token = await trocarCodigoPorToken(clientId, segredo, code, reservado.code_verifier as string);
    const nome = await buscarNome(token.access_token);
    const { error } = await admin.from("canva_contas").upsert({
      user_id: reservado.user_id,
      nome_canva: nome,
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      token_expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString(),
      scope: token.scope ?? null,
      conectado_em: new Date().toISOString(),
      ultimo_erro: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    if (error) {
      console.error("[canva-oauth-callback] upsert:", error.message);
      return pagina("Quase lá", "O Canva autorizou, mas não consegui salvar a conexão. Avise a TI.", false, 500);
    }
    await admin.from("canva_conexoes_pendentes").delete().eq("state", state);
    const quem = nome ? ` como <strong>${escaparHtml(nome)}</strong>` : "";
    return pagina(
      "Canva conectado!",
      `Sua conta do Canva está ligada ao sistema${quem}. Pode fechar esta aba. ${VOLTE} ` +
        "A proposta vai abrir direto no Canva, sem baixar arquivo.",
      true,
    );
  } catch (e) {
    console.error("[canva-oauth-callback]", e);
    const msg = e instanceof Error ? e.message : String(e);
    return pagina("Erro ao conectar", `Algo deu errado: ${escaparHtml(msg)}. ${VOLTE}`, false, 500);
  }
});
