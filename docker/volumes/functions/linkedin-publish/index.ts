// linkedin-publish — publica no LinkedIn PESSOAL os posts que chegaram a hora.
//
// Espelha o motor do TikTok (`tiktok-publish`), que passou por auditoria adversarial:
// claim atômico (FOR UPDATE SKIP LOCKED), orçamento de tempo por rodada com devolução do
// excedente, carimbo `enviado_em` ANTES da chamada que publica, e vigia de post preso.
//
// A diferença que importa: no LinkedIn o POST /rest/posts é SÍNCRONO — volta 201 com a URN, ou
// recusa. Então a régua de "pode ter saído?" fica mais fina (ver `desfechoDoPost`):
//   • 4xx  = recusou ⇒ o post NÃO existe ⇒ limpa o carimbo e pode tentar de novo;
//   • 5xx ou sem resposta = NÃO SE SABE ⇒ fica para revisão humana, nunca reenvia sozinho.
// Publicar duas vezes no perfil pessoal do diretor é pior do que não publicar.
//
// ⚠️ Quem chama: o cron `linkedin-publish-scheduler` (header X-Cron-Token, segredo em
// app_secrets — ver 20261021134114) e o botão "Publicar agora" (JWT de quem é do marketing).
// O `verify_jwt` do config.toml não vale neste servidor: o portão é este código.
//
// ⚠️ O acesso vive 60 dias e NÃO renova sozinho (sem refresh token no produto self-serve).
// Token vencido é erro definitivo com a instrução de reconectar.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getSegredo } from "../_shared/segredos.ts";
import {
  corpoDoPost, criarPost, ErroLinkedIn, esperarVideo, subirImagem, subirVideo,
  type ConteudoDoPost,
} from "../_shared/linkedinApi.ts";
import {
  dataHoraBr, desfechoDoPost, escaparTextoLinkedIn, formatoPelaAssinatura,
  VIDEO_MAX_BYTES, VIDEO_MIN_BYTES,
} from "../_shared/linkedinPost.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const MAX_POR_RODADA = 3;
const MAX_TENTATIVAS = 3;
/** Vídeo grande sobe pela própria edge (o LinkedIn não baixa URL): o orçamento é generoso. */
const ORCAMENTO_MS = 100_000;
/** Bem abaixo do teto do LinkedIn (150 chamadas/dia por membro, e cada post gasta 2 a 25). */
const MAX_POR_DIA_POR_CONTA = 20;
const PREFIXO_STORAGE = "https://api.ppgeducacao.site/storage/v1/object/public/";

/** Erro que repetir não resolve: sai com a cota cheia e o motivo legível, sem queimar 9 min. */
class Definitivo extends Error {}

// Host INTERNO do storage (kong) visto de dentro do container — mesmo truque do
// `generate-caption`: baixar pela URL pública bate no hairpin do Cloudflare.
const INTERNO = Deno.env.get("SUPABASE_URL") || "";
function internalizar(url: string): string {
  try {
    const u = new URL(url);
    if (u.pathname.startsWith("/storage/v1/") && INTERNO) {
      const base = new URL(INTERNO);
      u.protocol = base.protocol;
      u.host = base.host;
      return u.toString();
    }
  } catch { /* URL inválida → como veio */ }
  return url;
}

/** Baixa do NOSSO storage (interno primeiro, público depois). 404 é definitivo: o arquivo sumiu. */
async function baixar(url: string, init?: RequestInit): Promise<Response> {
  if (!url.startsWith(PREFIXO_STORAGE)) throw new Definitivo(`Mídia fora do armazenamento do sistema: ${url}`);
  let ultimo = "";
  for (const alvo of [internalizar(url), url].filter((v, i, a) => a.indexOf(v) === i)) {
    try {
      const r = await fetch(alvo, init);
      if (r.ok) return r;
      await r.body?.cancel().catch(() => {});
      if (r.status === 404 || r.status === 400) {
        throw new Definitivo(`A mídia não existe mais no armazenamento (HTTP ${r.status}): ${url.split("/").pop()}. Anexe de novo e reagende.`);
      }
      ultimo = `HTTP ${r.status}`;
    } catch (e) {
      if (e instanceof Definitivo) throw e;
      ultimo = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`Não consegui baixar a mídia ${url.split("/").pop()} (${ultimo}).`);
}

const nomeDoArquivo = (url: string) => decodeURIComponent(url.split(/[?#]/)[0].split("/").pop() || "arquivo");

/**
 * Os primeiros `n` bytes de uma resposta, cancelando o resto.
 * ⚠️ Não use `arrayBuffer()` aqui: se o servidor ignorar o `Range` e mandar 200 com o arquivo
 * inteiro, isso baixaria 500 MB para ler 16 bytes.
 */
async function primeirosBytes(r: Response, n: number): Promise<Uint8Array> {
  const saida = new Uint8Array(n);
  let cheio = 0;
  const leitor = r.body?.getReader();
  if (!leitor) return saida.subarray(0, 0);
  try {
    while (cheio < n) {
      const { done, value } = await leitor.read();
      if (done || !value) break;
      const usar = Math.min(n - cheio, value.length);
      saida.set(value.subarray(0, usar), cheio);
      cheio += usar;
    }
  } finally {
    await leitor.cancel().catch(() => {});
  }
  return saida.subarray(0, cheio);
}

async function anotarErroNaConta(supabase: any, contaId: string | undefined, msg: string) {
  if (!contaId) return;
  await supabase.from("linkedin_accounts")
    .update({ ultimo_erro: msg ? msg.slice(0, 500) : null, updated_at: new Date().toISOString() })
    .eq("id", contaId);
}

/** Leva o desfecho ao CARD do Planner, que é a tela que as pessoas abrem. */
async function marcarCard(supabase: any, postId: string, status: "error" | "published") {
  const campos: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  if (status === "published") campos.published_at = new Date().toISOString();
  await supabase.from("marketing_posts").update(campos).eq("linkedin_scheduled_post_id", postId);
}

async function publicadosHoje(supabase: any, contaId: string): Promise<number> {
  const hoje = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const inicio = `${hoje}T00:00:00-03:00`;
  const { count } = await supabase
    .from("linkedin_scheduled_posts")
    .select("id", { count: "exact", head: true })
    .eq("account_id", contaId)
    .or(`and(status.eq.published,published_at.gte.${inicio}),and(status.eq.publishing,enviado_em.gte.${inicio})`);
  return count ?? 0;
}

/** Sobe as mídias do post e devolve as URNs, na MESMA ordem das URLs. */
async function subirMidias(post: any, conta: any): Promise<string[]> {
  const urns: string[] = [];
  for (const url of post.media_urls as string[]) {
    const nome = nomeDoArquivo(url);
    if (post.tipo === "video") {
      // Primeiro os 16 bytes do começo (Range): confere que é MP4 sem baixar 500 MB à toa.
      const cabeca = await primeirosBytes(await baixar(url, { headers: { Range: "bytes=0-15" } }), 16);
      if (formatoPelaAssinatura(cabeca) !== "video/mp4") {
        throw new Definitivo(`O vídeo ${nome} não é MP4 (o LinkedIn só aceita MP4). Exporte em MP4 e reagende.`);
      }
      const r = await baixar(url);
      const tamanho = Number(r.headers.get("content-length") || 0);
      if (!tamanho || !r.body) {
        await r.body?.cancel().catch(() => {});
        throw new Error(`O armazenamento não informou o tamanho do vídeo ${nome}.`);
      }
      if (tamanho < VIDEO_MIN_BYTES || tamanho > VIDEO_MAX_BYTES) {
        await r.body.cancel().catch(() => {});
        throw new Definitivo(
          `O vídeo ${nome} tem ${(tamanho / 1024 / 1024).toFixed(2).replace(".", ",")} MB — o LinkedIn aceita de 0,07 MB a 500,00 MB.`,
        );
      }
      urns.push(await subirVideo(conta.access_token, conta.person_urn, tamanho, r.body));
    } else {
      const bytes = new Uint8Array(await (await baixar(url)).arrayBuffer());
      const formato = formatoPelaAssinatura(bytes);
      if (formato !== "image/jpeg" && formato !== "image/png" && formato !== "image/gif") {
        throw new Definitivo(
          `A imagem ${nome} é ${formato === "image/webp" ? "WebP" : "de um formato"} que o LinkedIn não aceita. Salve em JPG ou PNG e reagende.`,
        );
      }
      urns.push(await subirImagem(conta.access_token, conta.person_urn, bytes, formato));
    }
  }
  return urns;
}

async function dispararPost(supabase: any, post: any, conta: any, fimDoOrcamento: number) {
  const agora = () => new Date().toISOString();
  // Depois do carimbo, nada neste caminho pode limpar `enviado_em` às cegas (ver o catch).
  let carimbado = false;
  try {
    if (!conta || !conta.ativo) {
      throw new Definitivo("A conta do LinkedIn deste post foi desconectada. Reconecte em Agendar Post > LinkedIn e reagende.");
    }
    if (!conta.access_token || (conta.token_expires_at && new Date(conta.token_expires_at).getTime() <= Date.now())) {
      const msg = `O acesso ao LinkedIn de ${conta.nome || "esta conta"} venceu${conta.token_expires_at ? ` em ${dataHoraBr(conta.token_expires_at)}` : ""}. ` +
        "O LinkedIn não renova sozinho: reconecte em Agendar Post > LinkedIn e reenvie.";
      await anotarErroNaConta(supabase, conta.id, msg);
      throw new Definitivo(msg);
    }
    if (await publicadosHoje(supabase, conta.id) >= MAX_POR_DIA_POR_CONTA) {
      throw new Definitivo(`Teto de ${MAX_POR_DIA_POR_CONTA} posts por dia neste LinkedIn atingido. Reagende para amanhã.`);
    }

    // 1) Mídia — reaproveita o que uma tentativa anterior já subiu.
    let urns: string[] = Array.isArray(post.linkedin_media_urns) ? post.linkedin_media_urns : [];
    if (post.tipo !== "texto" && urns.length !== (post.media_urls?.length ?? 0)) {
      urns = await subirMidias(post, conta);
      await supabase.from("linkedin_scheduled_posts")
        .update({ linkedin_media_urns: urns, updated_at: agora() }).eq("id", post.id);
    }
    if (post.tipo === "video") {
      const espera = Math.min(40_000, Math.max(0, fimDoOrcamento - Date.now() - 15_000));
      const s = await esperarVideo(conta.access_token, urns[0], espera, fetch, 5_000);
      if (s === "PROCESSING_FAILED") {
        // O ativo está morto: a próxima tentativa tem de subir o arquivo de novo.
        await supabase.from("linkedin_scheduled_posts").update({ linkedin_media_urns: null }).eq("id", post.id);
        throw new Definitivo("O LinkedIn não conseguiu processar o vídeo. Exporte de novo em MP4 (H.264) e reenvie.");
      }
      // "processando"/"sem_leitura": segue — se o vídeo não estiver pronto, o POST recusa com
      // 4xx (o post não existe) e a próxima rodada tenta de novo com a mesma URN.
    }

    // 2) O post. ⚠️ O CARIMBO VEM ANTES DA CHAMADA e, se não gravar, NÃO publica: sem ele, uma
    // resposta perdida faria a fila reenviar um post que já saiu.
    const { error: eCarimbo } = await supabase.from("linkedin_scheduled_posts")
      .update({ enviado_em: agora(), updated_at: agora() }).eq("id", post.id);
    if (eCarimbo) throw new Error(`Não consegui marcar o envio antes de publicar: ${eCarimbo.message}`);
    carimbado = true;

    const conteudo: ConteudoDoPost = post.tipo === "texto"
      ? { tipo: "texto" }
      : post.tipo === "multi_imagem"
        ? { tipo: "multi_imagem", urns }
        : { tipo: post.tipo, urns: [urns[0]] } as ConteudoDoPost;
    const r = await criarPost(conta.access_token, corpoDoPost(conta.person_urn, escaparTextoLinkedIn(post.caption || ""), conteudo));
    const d = desfechoDoPost(r.status, r.urn, r.corpo);

    if (d.situacao === "publicado") {
      await supabase.from("linkedin_scheduled_posts").update({
        status: "published", published_at: agora(), linkedin_post_urn: d.urn || null, error_message: null, updated_at: agora(),
      }).eq("id", post.id);
      await marcarCard(supabase, post.id, "published");
      await anotarErroNaConta(supabase, conta.id, "");
      return { post_id: post.id, situacao: "publicado", urn: d.urn };
    }

    const definitivo = d.situacao === "incerto" || d.definitivo;
    await supabase.from("linkedin_scheduled_posts").update({
      status: "failed",
      error_message: d.mensagem,
      updated_at: agora(),
      // Recusa EXPLÍCITA (4xx) = o post não existe ⇒ o carimbo sai e o retry fica liberado.
      // Incerto = mantém o carimbo: só uma pessoa, olhando o perfil, decide reenviar.
      ...(d.situacao === "recusado" ? { enviado_em: null } : {}),
      ...(definitivo ? { publish_attempts: MAX_TENTATIVAS } : {}),
    }).eq("id", post.id);
    if (definitivo || post.publish_attempts >= MAX_TENTATIVAS) {
      await marcarCard(supabase, post.id, "error");
      await anotarErroNaConta(supabase, conta.id, d.mensagem);
    }
    return { post_id: post.id, situacao: d.situacao === "incerto" ? "incerto" : "falhou", erro: d.mensagem, definitivo };
  } catch (e) {
    // Falha ANTES do POST (download, upload de mídia, conta): o post certamente não saiu.
    // Se por algum caminho a exceção vier DEPOIS do carimbo, trata como incerto: mantém o
    // carimbo e manda para revisão humana, nunca para o retry automático.
    const definitivo = carimbado || e instanceof Definitivo
      || (e instanceof ErroLinkedIn && e.status !== null && e.status >= 400 && e.status < 500 && e.status !== 429);
    const cru = e instanceof Error ? e.message : String(e);
    const msg = carimbado ? `${cru} — confira no LinkedIn antes de reenviar, o post pode ter saído.` : cru;
    console.error(`[linkedin-publish] post ${post.id} falhou${carimbado ? " depois do envio" : " antes de publicar"}${definitivo ? " (definitivo)" : ""}: ${msg}`);
    await supabase.from("linkedin_scheduled_posts").update({
      status: "failed",
      error_message: msg,
      ...(carimbado ? {} : { enviado_em: null }),
      updated_at: agora(),
      ...(definitivo ? { publish_attempts: MAX_TENTATIVAS } : {}),
    }).eq("id", post.id);
    if (definitivo || post.publish_attempts >= MAX_TENTATIVAS) {
      await marcarCard(supabase, post.id, "error");
      await anotarErroNaConta(supabase, conta?.id, msg);
    }
    return { post_id: post.id, situacao: "falhou", erro: msg, definitivo };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Portão: o cron por segredo compartilhado; gente pelo JWT, e só quem é do marketing.
    let autorizado = false;
    const tokenDoCron = req.headers.get("X-Cron-Token") || "";
    if (tokenDoCron) {
      const esperado = await getSegredo(supabase, "LINKEDIN_PUBLISH_CRON_TOKEN");
      autorizado = !!esperado && tokenDoCron === esperado;
    }
    const auth = req.headers.get("Authorization") || "";
    if (!autorizado && auth && !tokenDoCron) {
      const comoUsuario = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: auth } },
      });
      const { data: u } = await comoUsuario.auth.getUser();
      if (u?.user) {
        const [mkt, ger, dir] = await Promise.all([
          comoUsuario.rpc("is_marketing_user"),
          comoUsuario.rpc("is_management_user"),
          comoUsuario.rpc("is_admin_ou_diretor_user"),
        ]);
        autorizado = mkt.data === true || ger.data === true || dir.data === true;
      }
    }
    if (!autorizado) return json({ error: "Não autorizado." }, 401);

    const inicio = Date.now();
    const fimDoOrcamento = inicio + ORCAMENTO_MS;

    // 1) Reivindica o que venceu. Atômico: duas rodadas sobrepostas nunca pegam o mesmo post.
    const { data: reivindicados, error: eClaim } = await supabase.rpc("linkedin_claim_due_posts", {
      p_limit: MAX_POR_RODADA,
      p_max_attempts: MAX_TENTATIVAS,
    });
    if (eClaim) return json({ error: `Não consegui ler a fila: ${eClaim.message}` }, 500);
    let posts: any[] = reivindicados || [];
    if (posts.length) {
      const ids = posts.map((p: any) => p.id);
      const { data: comConta, error: erroJoin } = await supabase
        .from("linkedin_scheduled_posts")
        .select("*, linkedin_accounts(*)")
        .in("id", ids);
      // Sem a conta não há como publicar: devolve à fila sem queimar tentativa.
      if (erroJoin || !comConta) {
        await supabase.rpc("linkedin_release_posts", { p_ids: ids });
        return json({ ok: true, processados: 0, aviso: `Não consegui ler as contas dos posts: ${erroJoin?.message ?? "retorno vazio"}` });
      }
      posts = comConta;
    }

    const resultados: Record<string, unknown>[] = [];
    const sobra: string[] = [];
    for (const post of posts) {
      // Sempre ao menos um; estourado o orçamento, devolve à fila SEM queimar tentativa.
      if (resultados.length > 0 && Date.now() > fimDoOrcamento - 20_000) {
        sobra.push(post.id);
        continue;
      }
      resultados.push(await dispararPost(supabase, post, post.linkedin_accounts, fimDoOrcamento));
    }
    if (sobra.length) await supabase.rpc("linkedin_release_posts", { p_ids: sobra });

    // 2) Vigia de post preso (a ordem importa):
    //    (a) sem carimbo de envio = nunca chegou ao POST ⇒ volta para a fila, sem risco.
    const corte = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    await supabase.from("linkedin_scheduled_posts")
      .update({ status: "scheduled", updated_at: new Date().toISOString() })
      .eq("status", "publishing").lt("updated_at", corte)
      .is("enviado_em", null).lt("publish_attempts", MAX_TENTATIVAS);
    //    (b) com carimbo e ainda 'publishing' 15 min depois = a função morreu no meio do POST.
    //        Pode ter saído ⇒ revisão humana.
    const { data: presos } = await supabase.from("linkedin_scheduled_posts")
      .update({
        status: "failed",
        error_message: "Publicação interrompida no meio — confira no LinkedIn ANTES de reenviar (pode ter saído).",
        publish_attempts: MAX_TENTATIVAS,
        updated_at: new Date().toISOString(),
      })
      .eq("status", "publishing").lt("enviado_em", corte).select("id");
    for (const p of presos ?? []) await marcarCard(supabase, p.id, "error");
    //    (c) atrasado demais: o claim só pega o que venceu nas últimas 6 h. Sem isto o post de
    //        uma conta que ficou fora do ar some da fila para sempre, 'scheduled' e invisível.
    const velho = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const { data: desistidos } = await supabase.from("linkedin_scheduled_posts")
      .update({
        status: "failed",
        error_message: "Passou mais de 6 h da hora marcada e não foi publicado — reagende se ainda fizer sentido.",
        publish_attempts: MAX_TENTATIVAS,
        updated_at: new Date().toISOString(),
      })
      .eq("status", "scheduled").lt("scheduled_at", velho).select("id");
    for (const d of desistidos ?? []) await marcarCard(supabase, d.id, "error");

    return json({ ok: true, processados: resultados.length, resultados, devolvidos: sobra.length });
  } catch (e) {
    console.error("[linkedin-publish]", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
