// tiktok-publish — publica no TikTok os posts que chegaram a hora, espelhando o motor que
// já publica no Instagram (`ig-publish`): claim atômico, orçamento de tempo por rodada,
// devolução do excedente à fila e vigia de post preso.
//
// ⚠️ CREDENCIAL DO APP: só por ENV do edge-runtime (Dokploy) —
//   TIKTOK_PERFIL_APP_ID / TIKTOK_PERFIL_SECRET
// De propósito NÃO vai para `ped_configuracoes`, como fizeram as credenciais do app antigo:
// aquela tabela tem policy de leitura `USING(true)` e todo colaborador logado enxerga o que
// está nela. O token de cada CONTA fica em `tiktok_business_accounts`, service-role-only.
//
// ⚠️ Esta função é INERTE até existir conta conectada: sem linha ativa em
// `tiktok_business_accounts` ela retorna no primeiro passo, sem tocar em nada.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  conferirUrlDoVideo,
  consultarStatus,
  erroDe,
  publicarVideo,
  renovarToken,
} from "../_shared/tiktokAccountsApi.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const MAX_POR_RODADA = 3;
const MAX_TENTATIVAS = 3;
const ORCAMENTO_MS = 110_000;
/** Teto do próprio TikTok, por conta. Estourar não devolve erro bonito — devolve recusa seca. */
const MAX_POR_DIA_POR_CONTA = 15;

/** Garante um token válido da CONTA. Renova quando falta menos de 10 min. */
async function tokenValido(supabase: any, conta: any): Promise<string> {
  const expira = conta.token_expires_at ? new Date(conta.token_expires_at).getTime() : 0;
  if (conta.access_token && expira - Date.now() > 10 * 60 * 1000) return conta.access_token;

  const appId = Deno.env.get("TIKTOK_PERFIL_APP_ID");
  const secret = Deno.env.get("TIKTOK_PERFIL_SECRET");
  if (!appId || !secret) {
    throw new Error("Faltam TIKTOK_PERFIL_APP_ID / TIKTOK_PERFIL_SECRET no edge-runtime.");
  }
  if (!conta.refresh_token) {
    throw new Error("Conta sem refresh_token — reconecte o perfil.");
  }

  const t = await renovarToken(appId, secret, conta.refresh_token);
  const agora = Date.now();
  await supabase.from("tiktok_business_accounts").update({
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? conta.refresh_token,
    token_expires_at: t.expires_in ? new Date(agora + t.expires_in * 1000).toISOString() : null,
    refresh_expires_at: t.refresh_expires_in ? new Date(agora + t.refresh_expires_in * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  }).eq("id", conta.id);
  return t.access_token;
}

/** Quantos já saíram hoje por esta conta (fuso de Brasília, que é o do calendário do time). */
async function publicadosHoje(supabase: any, contaId: string): Promise<number> {
  const hoje = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const { count } = await supabase
    .from("tiktok_scheduled_posts")
    .select("id", { count: "exact", head: true })
    .eq("account_id", contaId)
    .eq("status", "published")
    .gte("published_at", `${hoje}T00:00:00-03:00`);
  return count ?? 0;
}

/** Manda publicar UM post. Guarda o protocolo — e NÃO marca publicado. */
async function dispararPost(supabase: any, post: any, conta: any) {
  const agora = () => new Date().toISOString();
  try {
    if (await publicadosHoje(supabase, conta.id) >= MAX_POR_DIA_POR_CONTA) {
      throw new Error(`Teto de ${MAX_POR_DIA_POR_CONTA} publicações por dia desta conta já foi atingido no TikTok.`);
    }
    await conferirUrlDoVideo(post.media_url);

    const token = await tokenValido(supabase, conta);
    const { publish_id } = await publicarVideo(token, conta.business_id, post.media_url, post.caption || "");

    // ⚠️ Segue em 'publishing' de propósito: protocolo recebido NÃO é publicado. Quem
    // decide é a consulta de status, na rodada seguinte.
    await supabase.from("tiktok_scheduled_posts")
      .update({ publish_id, error_message: null, updated_at: agora() })
      .eq("id", post.id);
    return { post_id: post.id, situacao: "enviado", publish_id };
  } catch (e) {
    const msg = erroDe(e);
    // updated_at é a âncora do backoff do retry (ver tiktok_claim_due_posts).
    await supabase.from("tiktok_scheduled_posts")
      .update({ status: "failed", error_message: msg, updated_at: agora() })
      .eq("id", post.id);
    return { post_id: post.id, situacao: "falhou", erro: msg };
  }
}

/** Fecha o ciclo: consulta o desfecho de quem já tem protocolo. */
async function conferirPendentes(supabase: any) {
  const { data: pendentes } = await supabase
    .from("tiktok_scheduled_posts")
    .select("*, tiktok_business_accounts(*)")
    .eq("status", "publishing")
    .not("publish_id", "is", null)
    .limit(20);

  const fechados: Record<string, unknown>[] = [];
  for (const p of pendentes ?? []) {
    const conta = p.tiktok_business_accounts;
    if (!conta) continue;
    try {
      const token = await tokenValido(supabase, conta);
      const s = await consultarStatus(token, conta.business_id, p.publish_id);
      if (s.situacao === "publicado") {
        await supabase.from("tiktok_scheduled_posts").update({
          status: "published", published_at: new Date().toISOString(),
          tiktok_post_id: s.post_id ?? null, error_message: null, updated_at: new Date().toISOString(),
        }).eq("id", p.id);
        fechados.push({ post_id: p.id, situacao: "publicado" });
      } else if (s.situacao === "falhou") {
        await supabase.from("tiktok_scheduled_posts").update({
          status: "failed",
          error_message: `O TikTok recusou depois de aceitar: ${s.motivo ?? "sem motivo informado"}`,
          updated_at: new Date().toISOString(),
        }).eq("id", p.id);
        fechados.push({ post_id: p.id, situacao: "falhou", motivo: s.motivo });
      }
      // 'processando' = segue esperando; a próxima rodada consulta de novo.
    } catch (e) {
      console.error("[tiktok-publish] status:", erroDe(e));
    }
  }
  return fechados;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { count: contasAtivas } = await supabase
      .from("tiktok_business_accounts")
      .select("id", { count: "exact", head: true })
      .eq("ativo", true);
    if (!contasAtivas) {
      return json({ ok: true, aviso: "Nenhum perfil do TikTok conectado para publicação.", processados: 0 });
    }

    // 1) Fecha o ciclo do que já foi enviado antes.
    const fechados = await conferirPendentes(supabase);

    // 2) Reivindica o que venceu. O claim é atômico (FOR UPDATE SKIP LOCKED): duas rodadas
    //    sobrepostas nunca pegam o mesmo post — foi assim que o Instagram republicava Reels.
    const { data: reivindicados } = await supabase.rpc("tiktok_claim_due_posts", {
      p_limit: MAX_POR_RODADA,
      p_max_attempts: MAX_TENTATIVAS,
    });
    let posts: any[] = reivindicados || [];
    if (posts.length) {
      const ids = posts.map((p: any) => p.id);
      const { data: comConta } = await supabase
        .from("tiktok_scheduled_posts")
        .select("*, tiktok_business_accounts(*)")
        .in("id", ids);
      posts = comConta || posts;
    }

    const inicio = Date.now();
    const resultados: Record<string, unknown>[] = [];
    const sobra: string[] = [];
    for (const post of posts) {
      // Sempre processa ao menos um; a partir daí, estourado o orçamento, devolve à fila
      // SEM queimar tentativa, em vez de arriscar a função morrer no meio.
      if (resultados.length > 0 && Date.now() - inicio > ORCAMENTO_MS) {
        sobra.push(post.id);
        continue;
      }
      resultados.push(await dispararPost(supabase, post, post.tiktok_business_accounts));
    }
    if (sobra.length) await supabase.rpc("tiktok_release_posts", { p_ids: sobra });

    // 3) Vigia de post preso, na mesma ordem do Instagram (a ordem importa):
    //    (a) sem protocolo = nunca chegou ao TikTok ⇒ volta para a fila sozinho, sem risco
    //        de duplicar; (b) o que sobrar preso JÁ pode ter virado post lá ⇒ erro para
    //        revisão humana, porque publicar duas vezes é pior que não publicar.
    const corte = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    await supabase.from("tiktok_scheduled_posts")
      .update({ status: "scheduled", updated_at: new Date().toISOString() })
      .eq("status", "publishing").lt("updated_at", corte)
      .is("publish_id", null).lt("publish_attempts", MAX_TENTATIVAS);
    await supabase.from("tiktok_scheduled_posts")
      .update({ status: "failed", error_message: "Publicação interrompida — confira no TikTok antes de reenviar" })
      .eq("status", "publishing").lt("updated_at", corte);

    return json({ ok: true, processados: resultados.length, resultados, fechados, devolvidos: sobra.length });
  } catch (e) {
    console.error("[tiktok-publish]", e);
    return json({ error: erroDe(e) }, 500);
  }
});
