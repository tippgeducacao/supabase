// Edge Function: ies-portal-acessos — Portal da Unidade Certificadora (03/11/2026).
//
// A PPGVET (admin/diretor com a tela "Unidades certificadoras" liberada — pode_gerir_certificadoras)
// convida as pessoas de uma IES, reenvia o link de senha, desativa e reativa. Ver docs/Portal da IES.md.
//
// A conta nasce no Auth com role = 'ies_portal' (papel próprio do banco, sem grant em tabela nenhuma;
// a trava antes de cada pedido só deixa esse papel chamar /rpc/ies_portal_*), SEM profile (não é
// colaborador) e com uma senha aleatória que ninguém conhece: a pessoa cria a dela pelo link.
// Desativar corta na hora (as RPCs exigem a conta ativa) e bane o login no Auth.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { exigirAcesso, respostaAcessoNegado } from "../_shared/acesso.ts";
import { gerarSenhaForte } from "../_shared/senhaForte.ts";
import {
  emailValido, enviarEmailDoLink, hashToken, novoToken, origemDoPortal, PAPEIS_IES,
  VALIDADE_CONVITE_MS, VALIDADE_NOVA_SENHA_MS, type PapelIes,
} from "../_shared/iesPortal.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface Corpo {
  acao?: "convidar" | "reenviar" | "desativar" | "reativar";
  certificadora_id?: string;
  nome?: string;
  email?: string;
  papel?: string;
  user_id?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** E-mail como padrão do ilike: `_` e `%` são curingas e casariam outro endereço. */
const literalIlike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  let usuarioId: string;
  try {
    const quem = await exigirAcesso(req, { usuario: true, rpcPermissao: "pode_gerir_certificadoras" });
    if (quem.tipo !== "usuario") return json({ error: "Só pela tela Unidades certificadoras." }, 403);
    usuarioId = quem.usuarioId;
  } catch (e) {
    return respostaAcessoNegado(e, corsHeaders);
  }

  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const corpo = (await req.json().catch(() => ({}))) as Corpo;
    const origem = origemDoPortal(req.headers.get("origin"));
    const { data: eu } = await admin.from("profiles").select("name").eq("id", usuarioId).maybeSingle();
    const meuNome = (eu?.name as string | undefined) ?? "PPGVET";

    const registrar = (certificadoraId: string, acao: string, alvo: string, detalhe?: Record<string, unknown>) =>
      admin.from("ies_portal_registros").insert({
        certificadora_id: certificadoraId, user_id: usuarioId, quem_nome: meuNome, acao, alvo, detalhe: detalhe ?? null,
      });

    /** Novo link de uso único (apaga os que não foram usados). */
    const criarLink = async (userId: string, motivo: "convite" | "nova_senha") => {
      await admin.from("ies_portal_convites").delete().eq("user_id", userId).is("usado_em", null);
      const token = novoToken();
      const validade = motivo === "convite" ? VALIDADE_CONVITE_MS : VALIDADE_NOVA_SENHA_MS;
      const { data, error } = await admin.from("ies_portal_convites").insert({
        user_id: userId, token_hash: await hashToken(token), motivo,
        expira_em: new Date(Date.now() + validade).toISOString(), criado_por: usuarioId,
      }).select("id").single();
      if (error) throw error;
      return { link: `${origem}/ies/criar-senha?c=${encodeURIComponent(token)}`, conviteId: data.id as string };
    };

    const carregarConta = async (id: string | undefined) => {
      if (!id || !UUID.test(id)) return null;
      const { data } = await admin.from("ies_portal_usuarios")
        .select("user_id, certificadora_id, nome, email, ativo, termo_aceito_em, certificadoras(sigla)")
        .eq("user_id", id).maybeSingle();
      return data as null | {
        user_id: string; certificadora_id: string; nome: string; email: string; ativo: boolean;
        termo_aceito_em: string | null; certificadoras: { sigla: string } | null;
      };
    };

    if (corpo.acao === "convidar") {
      const nome = (corpo.nome ?? "").trim().replace(/\s+/g, " ");
      const email = (corpo.email ?? "").trim().toLowerCase();
      const papel = (corpo.papel ?? "") as PapelIes;
      if (nome.length < 3 || nome.length > 120) return json({ error: "Informe o nome completo." }, 400);
      if (!emailValido(email)) return json({ error: "E-mail inválido." }, 400);
      if (!PAPEIS_IES.includes(papel)) return json({ error: "Papel inválido." }, 400);
      if (!corpo.certificadora_id || !UUID.test(corpo.certificadora_id)) return json({ error: "Unidade inválida." }, 400);

      const { data: cert } = await admin.from("certificadoras").select("id, sigla, ativa").eq("id", corpo.certificadora_id).maybeSingle();
      if (!cert) return json({ error: "Unidade certificadora não encontrada." }, 404);
      if (!cert.ativa) return json({ error: "Esta unidade está inativa no catálogo." }, 409);

      // `.limit(1)` e erro = recusa: com e-mail duplicado o `.maybeSingle()` devolvia erro e a
      // checagem passava em silêncio (revisão de acesso, 03/11/2026).
      const { data: jaIes, error: e1 } = await admin.from("ies_portal_usuarios").select("user_id").ilike("email", literalIlike(email)).limit(1);
      if (e1) return json({ error: "Não foi possível conferir o e-mail. Tente de novo." }, 503);
      if (jaIes?.length) return json({ error: "Esta pessoa já tem acesso ao portal. Use Reenviar link." }, 409);
      const { data: colaborador, error: e2 } = await admin.from("profiles").select("id").ilike("email", literalIlike(email)).limit(1);
      if (e2) return json({ error: "Não foi possível conferir o e-mail. Tente de novo." }, 503);
      if (colaborador?.length) return json({ error: "Este e-mail é de um colaborador da PPGVET. Use o e-mail da unidade." }, 409);

      // Autorização para handle_new_user não criar profile (vale 15 min, uso único).
      await admin.from("ies_portal_autorizacao").upsert({ email, criado_em: new Date().toISOString() });
      const { data: criado, error: erroCriar } = await admin.auth.admin.createUser({
        email,
        email_confirm: true,
        password: gerarSenhaForte(24),
        role: "ies_portal",
        app_metadata: { portal: "ies", certificadora_id: cert.id },
        user_metadata: { name: nome },
      });
      if (erroCriar || !criado?.user) {
        await admin.from("ies_portal_autorizacao").delete().eq("email", email);
        const jaExiste = /already|registered|exists/i.test(erroCriar?.message ?? "");
        return json({ error: jaExiste ? "Este e-mail já tem conta no sistema." : `Não foi possível criar a conta: ${erroCriar?.message}` }, jaExiste ? 409 : 500);
      }
      const novoId = criado.user.id;

      // O papel TEM de ser ies_portal; se o Auth não gravou, corrige — e se não der, desfaz tudo.
      let papelAuth = (criado.user as { role?: string }).role;
      if (papelAuth !== "ies_portal") {
        const { data: corrigido } = await admin.auth.admin.updateUserById(novoId, { role: "ies_portal" });
        papelAuth = (corrigido?.user as { role?: string } | undefined)?.role;
      }
      if (papelAuth !== "ies_portal") {
        await admin.auth.admin.deleteUser(novoId);
        return json({ error: "A conta não ficou restrita ao portal; nada foi criado. Avise o TI." }, 500);
      }
      // Rede de segurança: conta da IES nunca fica com profile de colaborador.
      await admin.from("profiles").delete().eq("id", novoId);

      const { error: erroIns } = await admin.from("ies_portal_usuarios").insert({
        user_id: novoId, certificadora_id: cert.id, nome, email, papel, convidado_por: usuarioId,
      });
      if (erroIns) {
        await admin.auth.admin.deleteUser(novoId);
        return json({ error: `Não foi possível gravar o acesso: ${erroIns.message}` }, 500);
      }

      const { link, conviteId } = await criarLink(novoId, "convite");
      const enviado = await enviarEmailDoLink(admin, { para: email, nome, sigla: cert.sigla, link, motivo: "convite", chave: conviteId });
      await registrar(cert.id, "convidou", nome, { papel, email_enviado: enviado });
      return json({ ok: true, user_id: novoId, link, email_enviado: enviado });
    }

    if (corpo.acao === "reenviar") {
      const conta = await carregarConta(corpo.user_id);
      if (!conta) return json({ error: "Acesso não encontrado." }, 404);
      if (!conta.ativo) return json({ error: "Reative o acesso antes de mandar o link." }, 409);
      const motivo = conta.termo_aceito_em ? "nova_senha" : "convite";
      const { link, conviteId } = await criarLink(conta.user_id, motivo);
      const enviado = await enviarEmailDoLink(admin, {
        para: conta.email, nome: conta.nome, sigla: conta.certificadoras?.sigla ?? "", link, motivo, chave: conviteId,
      });
      await registrar(conta.certificadora_id, "reenviou_link", conta.nome, { email_enviado: enviado });
      return json({ ok: true, link, email_enviado: enviado });
    }

    if (corpo.acao === "desativar" || corpo.acao === "reativar") {
      const conta = await carregarConta(corpo.user_id);
      if (!conta) return json({ error: "Acesso não encontrado." }, 404);
      const ativar = corpo.acao === "reativar";
      const { error } = await admin.from("ies_portal_usuarios").update(ativar
        ? { ativo: true, desativado_em: null, desativado_por: null }
        : { ativo: false, desativado_em: new Date().toISOString(), desativado_por: usuarioId },
      ).eq("user_id", conta.user_id);
      if (error) return json({ error: error.message }, 500);
      // Só conta da IES chega aqui (carregarConta lê ies_portal_usuarios): nunca bane colaborador.
      // Desativar também derruba as sessões abertas na hora (gatilho ies_portal_usuarios_desativou).
      await admin.auth.admin.updateUserById(conta.user_id, { ban_duration: ativar ? "none" : "876000h" });
      if (!ativar) await admin.from("ies_portal_convites").delete().eq("user_id", conta.user_id).is("usado_em", null);
      await registrar(conta.certificadora_id, ativar ? "reativou" : "desativou", conta.nome);
      return json({ ok: true });
    }

    return json({ error: "Ação desconhecida." }, 400);
  } catch (e) {
    console.error("[ies-portal-acessos]", e);
    return json({ error: e instanceof Error ? e.message : "Erro inesperado." }, 500);
  }
});
