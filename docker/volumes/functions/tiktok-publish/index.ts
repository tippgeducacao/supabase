// tiktok-publish — publica no TikTok os posts que chegaram a hora, espelhando o motor que
// já publica no Instagram (`ig-publish`): claim atômico, orçamento de tempo por rodada,
// devolução do excedente à fila e vigia de post preso.
//
// ⚠️ CREDENCIAL DO APP: em `app_secrets` (service-role-only), chaves
//   TIKTOK_PERFIL_APP_ID / TIKTOK_PERFIL_SECRET — ver `_shared/segredos.ts`.
// De propósito NÃO vai para `ped_configuracoes`, como fizeram as credenciais do app antigo
// (aquela tabela tem leitura `USING(true)`, todo logado enxerga), e nem só para env: trocar
// env no Dokploy pede redeploy do serviço, e redeploy do stack do Supabase APAGA edge
// function. O token de cada CONTA fica em `tiktok_business_accounts`, também service-role-only.
//
// ⚠️ Esta função é INERTE até existir conta conectada: sem linha ativa em
// `tiktok_business_accounts` ela retorna no primeiro passo, sem tocar em nada.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getSegredo } from "../_shared/segredos.ts";
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

/**
 * Erro que REPETIR não resolve. Sem isto, as 3 tentativas queimam em 9 minutos contra uma
 * recusa determinística (domínio não verificado, arquivo que não é vídeo, credencial
 * ausente) e o post morre com a cota esgotada, sem ninguém ter lido o motivo. Limite de taxa
 * do TikTok e erro de rede NÃO entram aqui: esses valem tentar de novo.
 */
function ehErroDeterministico(msg: string): boolean {
  return /ownership|verif\w*\s+(a|the)?\s*url|não é vídeo|nao e video|redireciona|precisa ser https|Credenciais do app|sem refresh_token|Teto de \d+ publica/i
    .test(msg);
}

/**
 * Grava o motivo NA CONTA, não só na linha da fila.
 * ⚠️ `tiktok_scheduled_posts.error_message` não tem leitor em tela nenhuma; `ultimo_erro` da
 * conta é o campo que a view `_pub` expõe e que o hook `useTikTokPerfis` já tipa — é por ele
 * que a pessoa que escolhe o perfil no Planner enxerga que tem coisa quebrada. É o mesmo
 * caminho que o `sync-tiktok-ads` usa há semanas.
 */
async function anotarErroNaConta(supabase: any, contaId: string | undefined, msg: string) {
  if (!contaId) return;
  await supabase.from("tiktok_business_accounts")
    .update({ ultimo_erro: msg.slice(0, 500), updated_at: new Date().toISOString() })
    .eq("id", contaId);
}

/**
 * Propaga o desfecho para o CARD do Planner (`marketing_posts`), que é a tela que as pessoas
 * de fato abrem. O enum já tem 'error' e o Planner já sabe desenhar card com erro — sem isto
 * o card fica 'scheduled' para sempre enquanto o post nunca saiu.
 */
async function marcarCard(supabase: any, postId: string, status: "error" | "published") {
  const campos: Record<string, unknown> = { status };
  if (status === "published") campos.published_at = new Date().toISOString();
  await supabase.from("marketing_posts").update(campos).eq("tiktok_scheduled_post_id", postId);
}

/** Garante um token válido da CONTA. Renova quando falta menos de 10 min. */
async function tokenValido(supabase: any, conta: any): Promise<string> {
  const expira = conta.token_expires_at ? new Date(conta.token_expires_at).getTime() : 0;
  if (conta.access_token && expira - Date.now() > 10 * 60 * 1000) return conta.access_token;

  const appId = await getSegredo(supabase, "TIKTOK_PERFIL_APP_ID");
  const secret = await getSegredo(supabase, "TIKTOK_PERFIL_SECRET");
  if (!appId || !secret) {
    throw new Error("Credenciais do app de publicação não configuradas (app_secrets).");
  }
  if (!conta.refresh_token) {
    throw new Error("Conta sem refresh_token — reconecte o perfil.");
  }

  let t;
  try {
    t = await renovarToken(appId, secret, conta.refresh_token);
  } catch (e) {
    // Sem isto o perfil continua "saudável" no seletor do Planner e TUDO que for agendado
    // nele morre, um post por vez, sem sinal nenhum.
    await anotarErroNaConta(supabase, conta.id, `Não consegui renovar o token: ${erroDe(e)}`);
    throw e;
  }
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
  const inicio = `${hoje}T00:00:00-03:00`;
  // ⚠️ Contar só 'published' subestima: post EM VOO (já enviado, aguardando desfecho) também
  // ocupa a cota do TikTok. Com 3 por rodada e cron de minuto, a fila estourava o teto antes
  // de o primeiro desfecho chegar — e o TikTok não devolve erro bonito, devolve recusa seca.
  const { count } = await supabase
    .from("tiktok_scheduled_posts")
    .select("id", { count: "exact", head: true })
    .eq("account_id", contaId)
    .or(`and(status.eq.published,published_at.gte.${inicio}),and(status.eq.publishing,enviado_em.gte.${inicio})`);
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

    // ⚠️ O CARIMBO VEM ANTES DA CHAMADA, e isso não é detalhe: se o UPDATE do protocolo
    // falhar depois de o TikTok já ter aceitado, a linha não pode voltar para a fila — senão
    // o mesmo vídeo sai duas, três vezes, público e sem desfazer. É o claim/vigia que leem
    // `enviado_em` (ver migration 20261012220000). O `ig-publish` já fazia nessa ordem; a
    // versão do TikTok tinha invertido.
    await supabase.from("tiktok_scheduled_posts")
      .update({ enviado_em: agora(), updated_at: agora() })
      .eq("id", post.id);

    const { publish_id } = await publicarVideo(token, conta.business_id, post.media_url, post.caption || "");

    // ⚠️ Segue em 'publishing' de propósito: protocolo recebido NÃO é publicado. Quem
    // decide é a consulta de status, na rodada seguinte.
    await supabase.from("tiktok_scheduled_posts")
      .update({ publish_id, error_message: null, updated_at: agora() })
      .eq("id", post.id);
    return { post_id: post.id, situacao: "enviado", publish_id };
  } catch (e) {
    const msg = erroDe(e);
    const definitivo = ehErroDeterministico(msg);
    console.error(`[tiktok-publish] post ${post.id} falhou${definitivo ? " (definitivo)" : ""}: ${msg}`);
    // updated_at é a âncora do backoff do retry (ver tiktok_claim_due_posts). Erro
    // determinístico já sai com a cota cheia: repetir não resolve e só atrasa o aviso.
    await supabase.from("tiktok_scheduled_posts")
      .update({
        status: "failed",
        error_message: msg,
        updated_at: agora(),
        ...(definitivo ? { publish_attempts: MAX_TENTATIVAS } : {}),
      })
      .eq("id", post.id);
    await anotarErroNaConta(supabase, conta?.id, msg);
    await marcarCard(supabase, post.id, "error");
    return { post_id: post.id, situacao: "falhou", erro: msg, definitivo };
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
        await marcarCard(supabase, p.id, "published");
        await anotarErroNaConta(supabase, conta.id, "");
        fechados.push({ post_id: p.id, situacao: "publicado" });
      } else if (s.situacao === "falhou") {
        await supabase.from("tiktok_scheduled_posts").update({
          status: "failed",
          error_message: `O TikTok recusou depois de aceitar: ${s.motivo ?? "sem motivo informado"}`,
          updated_at: new Date().toISOString(),
        }).eq("id", p.id);
        await anotarErroNaConta(supabase, conta.id, `O TikTok recusou depois de aceitar: ${s.motivo ?? "sem motivo"}`);
        await marcarCard(supabase, p.id, "error");
        fechados.push({ post_id: p.id, situacao: "falhou", motivo: s.motivo });
      } else {
        // ⚠️ 'processando' carimba `updated_at`: é PROVA DE VIDA. Sem isso o vigia de post
        // preso (abaixo) contava os 15 min desde o disparo e declarava "interrompida" uma
        // publicação que o TikTok ainda estava baixando — o `PROCESSING_DOWNLOAD` foi medido
        // numa publicação real. O vigia passa a pegar só o caso em que ninguém mais consulta.
        await supabase.from("tiktok_scheduled_posts")
          .update({ updated_at: new Date().toISOString() })
          .eq("id", p.id);
      }
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

    // ⚠️ `verify_jwt = false` no config.toml (o cron do Postgres não tem JWT de usuário), e
    // por isso o portão é MANUAL. Sem ele qualquer pessoa na internet dispara a fila à
    // vontade — e o limite de taxa do TikTok é curto. Vale o cron (service role) ou gente
    // logada no sistema (o botão "Publicar Agora").
    const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const ehCron = bearer === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!ehCron) {
      const { data: quem } = bearer ? await supabase.auth.getUser(bearer) : { data: null };
      if (!quem?.user) return json({ error: "Não autorizado." }, 401);
    }

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
      const { data: comConta, error: erroJoin } = await supabase
        .from("tiktok_scheduled_posts")
        .select("*, tiktok_business_accounts(*)")
        .in("id", ids);
      // ⚠️ `comConta || posts` deixava seguir SEM a conta: `dispararPost` tomava um TypeError
      // em `conta.id` e os 3 posts morriam com "cannot read properties of undefined" como
      // explicação. Falha de leitura devolve à fila (sem queimar tentativa) e encerra a rodada.
      if (erroJoin || !comConta) {
        await supabase.rpc("tiktok_release_posts", { p_ids: ids });
        return json({ ok: true, processados: 0, aviso: `Não consegui ler as contas dos posts: ${erroJoin?.message ?? "retorno vazio"}` });
      }
      posts = comConta;
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
    // (a) NUNCA chegou ao TikTok (sem carimbo de envio) ⇒ volta para a fila sozinho, sem
    //     risco de duplicar. A guarda é `enviado_em`, não `publish_id`: o protocolo só é
    //     gravado DEPOIS da chamada, então ele não distingue "não enviei" de "enviei e não
    //     consegui guardar".
    await supabase.from("tiktok_scheduled_posts")
      .update({ status: "scheduled", updated_at: new Date().toISOString() })
      .eq("status", "publishing").lt("updated_at", corte)
      .is("enviado_em", null).lt("publish_attempts", MAX_TENTATIVAS);
    // (b) Já pode ter virado post lá ⇒ erro para revisão humana, porque publicar duas vezes é
    //     pior que não publicar. O prazo aqui é o do PRÓPRIO TikTok: a documentação diz que o
    //     download da URL expira em 1 HORA, então declarar falha antes disso é chutar.
    const corteEnviado = new Date(Date.now() - 70 * 60 * 1000).toISOString();
    await supabase.from("tiktok_scheduled_posts")
      .update({
        status: "failed",
        error_message: "Publicação interrompida sem desfecho — confira no TikTok ANTES de reenviar (pode ter saído)",
        publish_attempts: MAX_TENTATIVAS,
        updated_at: new Date().toISOString(),
      })
      .eq("status", "publishing").lt("updated_at", corteEnviado);
    // (c) Atrasado demais: o claim só pega o que venceu nas últimas 6 h (ver migration
    //     20261012220000). Sem esta varredura, post de perfil que ficou fora do ar some da
    //     fila para sempre, 'scheduled' e invisível.
    const velho = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const { data: desistidos } = await supabase.from("tiktok_scheduled_posts")
      .update({
        status: "failed",
        error_message: "Passou mais de 6 h da hora marcada e não foi publicado — reagende se ainda fizer sentido",
        publish_attempts: MAX_TENTATIVAS,
        updated_at: new Date().toISOString(),
      })
      .eq("status", "scheduled").lt("scheduled_at", velho).select("id");
    for (const d of desistidos ?? []) await marcarCard(supabase, d.id, "error");

    return json({ ok: true, processados: resultados.length, resultados, fechados, devolvidos: sobra.length });
  } catch (e) {
    console.error("[tiktok-publish]", e);
    return json({ error: erroDe(e) }, 500);
  }
});
