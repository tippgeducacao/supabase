// linkedin-oauth-callback — volta da autorização do LinkedIn e grava a conta que vai publicar.
//
// Recebe ?code&state (ou ?error&error_description&state). O `state` é o de
// `linkedin_conexoes_pendentes`, gerado pelo `linkedin-connect`: só vale se for conhecido, estiver
// no prazo e ainda não tiver sido usado. É ele que diz DE QUAL perfil de marca é este LinkedIn e
// QUEM no sistema pediu a conexão.
//
// ⚠️ A página TEM de dizer QUEM conectou (nome e foto do LinkedIn): vale a conta LOGADA no
// navegador de quem abriu o link. No TikTok (12/10/2026) a primeira conexão pegou a conta errada
// e a página comemorou igual — aqui o nome vem do userinfo e é comparado ao perfil de marca.
//
// ⚠️ Reconectar com OUTRA pessoa no mesmo perfil desativa a conta anterior (índice único de uma
// conta ativa por perfil) e repassa a ela os posts que ainda não saíram.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getSegredo } from "../_shared/segredos.ts";
import { escaparHtml } from "../_shared/escaparHtml.ts";
import { nomeCombina, paginaLinkedIn } from "../_shared/linkedinPagina.ts";
import { buscarUsuario, CALLBACK_URI, trocarCodigoPorToken } from "../_shared/linkedinApi.ts";
import { dataHoraBr } from "../_shared/linkedinPost.ts";

const MOTIVO_CANCELADO: Record<string, string> = {
  user_cancelled_login: "o login no LinkedIn foi cancelado",
  user_cancelled_authorize: "a permissão foi recusada na tela do LinkedIn",
};

Deno.serve(async (req) => {
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const url = new URL(req.url);
  const state = url.searchParams.get("state") || "";
  const erro = url.searchParams.get("error");
  const code = url.searchParams.get("code");

  if (erro) {
    const motivo = MOTIVO_CANCELADO[erro] || url.searchParams.get("error_description") || erro;
    return paginaLinkedIn(
      "Conexão não feita",
      `O LinkedIn respondeu: ${escaparHtml(motivo)}. Nada foi gravado. Pode abrir o mesmo link de novo enquanto ele estiver no prazo.`,
      false,
    );
  }
  if (!code || !/^[0-9a-f]{64}$/.test(state)) {
    return paginaLinkedIn("Link inválido", "Faltou o código de autorização do LinkedIn. Abra o link de conexão de novo, do começo.", false);
  }

  // Reserva o state de forma ATÔMICA: duas abas voltando ao mesmo tempo não gravam duas vezes.
  const { data: reservado } = await admin
    .from("linkedin_conexoes_pendentes")
    .update({ usado_em: new Date().toISOString() })
    .eq("state", state)
    .is("usado_em", null)
    .gt("expira_em", new Date().toISOString())
    .select("state, profile_key, criado_por")
    .maybeSingle();
  if (!reservado) {
    const { data: visto } = await admin
      .from("linkedin_conexoes_pendentes").select("usado_em, expira_em").eq("state", state).maybeSingle();
    const msg = !visto
      ? "Não reconheço este link de conexão. Peça um novo a quem enviou."
      : visto.usado_em
        ? "Este link já conectou um LinkedIn (vale uma vez só). Se você recarregou a página, a conexão já está feita."
        : "Este link passou do prazo de 7 dias. Peça um novo a quem enviou.";
    return paginaLinkedIn("Link não vale mais", msg, false);
  }
  // Falhou daqui para frente ⇒ devolve o link, para a pessoa poder tentar de novo sem pedir outro.
  const devolverLink = () =>
    admin.from("linkedin_conexoes_pendentes").update({ usado_em: null }).eq("state", state);

  try {
    const [clientId, segredo] = await Promise.all([
      getSegredo(admin, "LINKEDIN_CLIENT_ID"),
      getSegredo(admin, "LINKEDIN_CLIENT_SECRET"),
    ]);
    if (!clientId || !segredo) {
      await devolverLink();
      return paginaLinkedIn("Configuração ausente", "As credenciais do app do LinkedIn não estão no servidor. Avise a TI.", false, 500);
    }

    const token = await trocarCodigoPorToken(clientId, segredo, code, CALLBACK_URI);
    const quem = await buscarUsuario(token.access_token);
    const personUrn = `urn:li:person:${quem.sub}`;
    const expiraEm = new Date(Date.now() + token.expires_in * 1000).toISOString();
    const profileKey = reservado.profile_key as string;

    const { data: perfil } = await admin
      .from("marketing_profiles").select("label, handle").eq("key", profileKey).maybeSingle();

    // Quem estava ligado a este perfil e NÃO é esta pessoa sai de cena — antes do upsert, por
    // causa do índice único de uma conta ativa por perfil.
    const { data: anteriores } = await admin
      .from("linkedin_accounts")
      .select("id, nome")
      .eq("profile_key", profileKey)
      .eq("ativo", true)
      .neq("person_urn", personUrn);
    const idsAnteriores = (anteriores ?? []).map((a: { id: string }) => a.id);
    if (idsAnteriores.length) {
      await admin.from("linkedin_accounts")
        .update({ ativo: false, ultimo_erro: "Substituída por outra conexão deste perfil.", updated_at: new Date().toISOString() })
        .in("id", idsAnteriores);
    }

    const { data: conta, error: eUp } = await admin.from("linkedin_accounts").upsert({
      person_urn: personUrn,
      nome: quem.nome,
      foto_url: quem.foto,
      profile_key: profileKey,
      access_token: token.access_token,
      token_expires_at: expiraEm,
      scope: token.scope,
      ativo: true,
      conectado_por: reservado.criado_por,
      conectado_em: new Date().toISOString(),
      ultimo_erro: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "person_urn" }).select("id").single();
    if (eUp || !conta) {
      console.error("[linkedin-oauth-callback] upsert:", eUp?.message);
      await devolverLink();
      return paginaLinkedIn("Quase lá", "O LinkedIn autorizou, mas não consegui salvar a conta. Avise a TI.", false, 500);
    }

    // Posts que ainda não saíram pela conta antiga passam para esta (nada que possa já ter saído).
    let repassados = 0;
    if (idsAnteriores.length) {
      const { data: movidos } = await admin.from("linkedin_scheduled_posts")
        .update({ account_id: conta.id, updated_at: new Date().toISOString() })
        .in("account_id", idsAnteriores)
        .in("status", ["scheduled", "failed"])
        .is("enviado_em", null)
        .select("id");
      repassados = movidos?.length ?? 0;
    }

    const nome = escaparHtml(quem.nome || "(o LinkedIn não informou o nome)");
    const foto = quem.foto ? `<img src="${escaparHtml(quem.foto)}" alt="">` : "";
    const rotulo = escaparHtml(perfil?.label || profileKey);
    const suspeito = !nomeCombina(quem.nome, `${perfil?.label ?? ""} ${perfil?.handle ?? ""}`);
    const aviso = suspeito
      ? `<span class="alerta"><strong>Confira se é a conta certa.</strong> O nome do LinkedIn não lembra o perfil "${rotulo}". ` +
        "Vale a conta que estava logada NESTE navegador. Se não for, saia do LinkedIn aqui, entre com a conta certa " +
        "e peça um link novo — a conexão nova substitui esta.</span>"
      : "";
    const troca = idsAnteriores.length
      ? `<span class="info">Substituiu a conexão anterior (${escaparHtml((anteriores ?? []).map((a: { nome: string | null }) => a.nome || "sem nome").join(", "))}). ` +
        `${repassados} post(s) da fila passaram para esta conta.</span>`
      : "";
    return paginaLinkedIn(
      "LinkedIn conectado!",
      `<span class="quem">${foto}<span>${nome}</span></span>` +
      `Os posts do perfil <strong>${rotulo}</strong> agendados no sistema vão sair neste LinkedIn. ` +
      `<span class="info"><strong>O acesso vale até ${escaparHtml(dataHoraBr(expiraEm))}</strong> (60 dias). O LinkedIn não renova ` +
      "sozinho: o sistema avisa no sino 7 dias antes, e aí é só gerar um link novo em Agendar Post &gt; LinkedIn.</span>" +
      troca + aviso,
      true,
    );
  } catch (e) {
    console.error("[linkedin-oauth-callback]", e);
    await devolverLink();
    const msg = e instanceof Error ? e.message : String(e);
    return paginaLinkedIn(
      "Erro ao conectar",
      `Algo deu errado: ${escaparHtml(msg)}. Se você recarregou esta página, o código do LinkedIn já foi usado — abra o link de conexão de novo.`,
      false,
    );
  }
});
