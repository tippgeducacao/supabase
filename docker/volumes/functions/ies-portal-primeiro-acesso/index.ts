// acesso: publico — o link de uso único é a credencial (token de 32 bytes, só o hash SHA-256 no banco, vale 7 dias o convite e 1 h a nova senha); o "esqueci" só manda e-mail ao dono de uma conta ATIVA da IES e no máximo 1 a cada 10 min.
//
// Edge Function: ies-portal-primeiro-acesso — Portal da Unidade Certificadora (03/11/2026).
// A pessoa da IES abre o link que a PPGVET mandou (/ies/criar-senha?c=…), confere quem é, cria a
// senha e aceita o termo de confidencialidade. Também atende o "Esqueci minha senha" da tela de
// login do portal. Nunca toca em conta de colaborador: só em contas de ies_portal_usuarios.
// Ver docs/Portal da IES.md.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { problemaDaSenha } from "../_shared/senhaForte.ts";
import {
  emailValido, enviarEmailDoLink, hashToken, novoToken, origemDoPortal, VALIDADE_NOVA_SENHA_MS,
} from "../_shared/iesPortal.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface Corpo {
  acao?: "conferir" | "criar_senha" | "esqueci";
  token?: string;
  senha?: string;
  aceite?: boolean;
  email?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);

  try {
    const corpo = (await req.json().catch(() => ({}))) as Corpo;
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    /** Convite válido pelo token (não usado, no prazo, conta ativa). */
    const conviteDoToken = async (token: string | undefined) => {
      const t = (token ?? "").trim();
      if (t.length < 30 || t.length > 100) return null;
      const { data } = await admin.from("ies_portal_convites")
        .select("id, user_id, motivo, expira_em, usado_em")
        .eq("token_hash", await hashToken(t)).maybeSingle();
      if (!data || data.usado_em || new Date(data.expira_em).getTime() < Date.now()) return null;
      const { data: conta } = await admin.from("ies_portal_usuarios")
        .select("user_id, certificadora_id, nome, email, ativo, termo_aceito_em, certificadoras(sigla, nome)")
        .eq("user_id", data.user_id).maybeSingle();
      if (!conta?.ativo) return null;
      return { convite: data, conta: conta as unknown as {
        user_id: string; certificadora_id: string; nome: string; email: string; termo_aceito_em: string | null;
        certificadoras: { sigla: string; nome: string } | null;
      } };
    };

    if (corpo.acao === "conferir") {
      const achado = await conviteDoToken(corpo.token);
      if (!achado) return json({ error: "Este link não vale mais. Peça um novo à coordenação da PPGVET." }, 410);
      return json({
        ok: true,
        nome: achado.conta.nome,
        email: achado.conta.email,
        sigla: achado.conta.certificadoras?.sigla ?? "",
        motivo: achado.convite.motivo,
        precisa_aceite: !achado.conta.termo_aceito_em,
      });
    }

    if (corpo.acao === "criar_senha") {
      const achado = await conviteDoToken(corpo.token);
      if (!achado) return json({ error: "Este link não vale mais. Peça um novo à coordenação da PPGVET." }, 410);
      const problema = problemaDaSenha(corpo.senha);
      if (problema) return json({ error: problema }, 400);
      if (!achado.conta.termo_aceito_em && corpo.aceite !== true) {
        return json({ error: "Aceite o termo de confidencialidade para continuar." }, 400);
      }
      // Marca o link como usado ANTES de trocar a senha: um segundo clique não troca de novo.
      const { data: marcado } = await admin.from("ies_portal_convites")
        .update({ usado_em: new Date().toISOString() })
        .eq("id", achado.convite.id).is("usado_em", null).select("id");
      if (!marcado?.length) return json({ error: "Este link já foi usado." }, 410);

      const { error } = await admin.auth.admin.updateUserById(achado.conta.user_id, { password: corpo.senha });
      if (error) {
        await admin.from("ies_portal_convites").update({ usado_em: null }).eq("id", achado.convite.id);
        return json({ error: "Não foi possível gravar a senha. Tente de novo." }, 500);
      }
      const agora = new Date().toISOString();
      const registros: Array<Record<string, unknown>> = [{
        certificadora_id: achado.conta.certificadora_id, user_id: achado.conta.user_id, quem_nome: achado.conta.nome,
        acao: achado.convite.motivo === "convite" ? "criou_senha" : "trocou_senha", alvo: null,
      }];
      if (!achado.conta.termo_aceito_em) {
        await admin.from("ies_portal_usuarios").update({ termo_aceito_em: agora }).eq("user_id", achado.conta.user_id);
        registros.push({
          certificadora_id: achado.conta.certificadora_id, user_id: achado.conta.user_id, quem_nome: achado.conta.nome,
          acao: "aceitou_termo", alvo: null,
        });
      }
      await admin.from("ies_portal_registros").insert(registros);
      // Senha nova derruba as sessões antigas (quem pediu pode estar fugindo de um acesso indevido).
      if (achado.convite.motivo === "nova_senha") {
        await admin.rpc("ies_encerrar_sessoes", { p_user: achado.conta.user_id, p_motivo: "ies_portal_nova_senha" });
      }
      return json({ ok: true, email: achado.conta.email });
    }

    if (corpo.acao === "esqueci") {
      // Resposta sempre igual e IMEDIATA: nem o texto nem o tempo revelam se o e-mail tem conta
      // (o envio roda depois da resposta — revisão de acesso, 03/11/2026).
      const email = (corpo.email ?? "").trim().toLowerCase();
      const tarefa = mandarNovaSenha(email, origemDoPortal(req.headers.get("origin"))).catch((e) =>
        console.error("[ies-portal-primeiro-acesso] esqueci", e));
      const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
      if (rt?.waitUntil) rt.waitUntil(tarefa); else await tarefa;
      return json({ ok: true });
    }

    return json({ error: "Ação desconhecida." }, 400);

    async function mandarNovaSenha(email: string, origem: string): Promise<void> {
      if (!emailValido(email)) return;
      const { data: contas } = await admin.from("ies_portal_usuarios")
        .select("user_id, certificadora_id, nome, email, ativo, certificadoras(sigla)")
        .eq("ativo", true);
      const conta = ((contas ?? []) as unknown as Array<{
        user_id: string; certificadora_id: string; nome: string; email: string; certificadoras: { sigla: string } | null;
      }>).find((c) => c.email.toLowerCase() === email);
      if (!conta) return;
      const { data: recente } = await admin.from("ies_portal_convites").select("id")
        .eq("user_id", conta.user_id).gt("criado_em", new Date(Date.now() - 10 * 60 * 1000).toISOString()).limit(1);
      if (recente?.length) return;

      await admin.from("ies_portal_convites").delete().eq("user_id", conta.user_id).is("usado_em", null);
      const token = novoToken();
      const { data: conv } = await admin.from("ies_portal_convites").insert({
        user_id: conta.user_id, token_hash: await hashToken(token), motivo: "nova_senha",
        expira_em: new Date(Date.now() + VALIDADE_NOVA_SENHA_MS).toISOString(),
      }).select("id").single();
      if (!conv) return;
      const link = `${origem}/ies/criar-senha?c=${encodeURIComponent(token)}`;
      const enviado = await enviarEmailDoLink(admin, {
        para: conta.email, nome: conta.nome, sigla: conta.certificadoras?.sigla ?? "", link, motivo: "nova_senha", chave: conv.id,
      });
      await admin.from("ies_portal_registros").insert({
        certificadora_id: conta.certificadora_id, user_id: conta.user_id, quem_nome: conta.nome,
        acao: "pediu_nova_senha", alvo: null, detalhe: { email_enviado: enviado },
      });
    }
  } catch (e) {
    console.error("[ies-portal-primeiro-acesso]", e);
    return json({ error: "Erro inesperado. Tente de novo em instantes." }, 500);
  }
});
