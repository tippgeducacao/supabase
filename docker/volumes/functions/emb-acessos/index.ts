// Edge Function: emb-acessos — Programa de Embaixadores (23/11/2026).
//
// A tela Gestão de Embaixadores (colaborador com a tela "embaixadores" liberada — emb_pode_gerir)
// cria e desliga LINKS DE CADASTRO, CONVIDA uma pessoa pelo e-mail, REENVIA o link e ANEXA o contrato
// assinado. O token do link aparece uma vez só, na resposta; no banco fica o hash. A conta do
// embaixador é criada pela edge emb-cadastro-publico, quando ele preenche o cadastro.
// Ver docs/Embaixadores.md.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { exigirAcesso, respostaAcessoNegado } from "../_shared/acesso.ts";
import {
  emailValido, enviarEmailDoEmbaixador, hashToken, linkDoToken, novoToken, origemDoPortal,
  VALIDADE_CONVITE_MS, VALIDADE_NOVA_SENHA_MS,
} from "../_shared/embaixadores.ts";
import { normalizarWhatsapp } from "../_shared/embaixadorCadastro.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface Corpo {
  acao?: "criar_link" | "convidar" | "reenviar" | "anexar_contrato";
  rotulo?: string;
  usos_max?: number | null;
  validade_dias?: number | null;
  nome?: string;
  email?: string;
  whatsapp?: string;
  embaixador_id?: string;
  arquivo?: string;
  data?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const literalIlike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  let usuarioId: string;
  try {
    const quem = await exigirAcesso(req, { usuario: true, rpcPermissao: "emb_pode_gerir" });
    if (quem.tipo !== "usuario") return json({ error: "Só pela tela Gestão de Embaixadores." }, 403);
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
    const registrar = (embaixadorId: string | null, acao: string, alvo: string | null, detalhe?: Record<string, unknown>) =>
      admin.from("emb_registros").insert({ embaixador_id: embaixadorId, user_id: usuarioId, quem: "ppgvet", acao, alvo, detalhe: detalhe ?? {} });

    // --- Link de cadastro (multiuso, desligável) ---------------------------------------------------
    if (corpo.acao === "criar_link") {
      const rotulo = (corpo.rotulo ?? "").trim().replace(/\s+/g, " ");
      if (rotulo.length < 3 || rotulo.length > 80) return json({ error: "Dê um nome ao link (ex.: Lote 1 · médicos veterinários)." }, 400);
      const usosMax = corpo.usos_max == null ? null : Math.floor(Number(corpo.usos_max));
      if (usosMax !== null && (!Number.isFinite(usosMax) || usosMax < 1 || usosMax > 10000)) return json({ error: "Limite de cadastros inválido." }, 400);
      const dias = corpo.validade_dias == null ? null : Math.floor(Number(corpo.validade_dias));
      if (dias !== null && (!Number.isFinite(dias) || dias < 1 || dias > 365)) return json({ error: "Validade inválida (1 a 365 dias)." }, 400);
      const token = novoToken();
      const { data, error } = await admin.from("emb_convites").insert({
        token_hash: await hashToken(token), motivo: "cadastro", rotulo, usos_max: usosMax,
        expira_em: dias ? new Date(Date.now() + dias * 86400000).toISOString() : null, criado_por: usuarioId,
      }).select("id").single();
      if (error) return json({ error: error.message }, 500);
      await registrar(null, "criou_link_cadastro", data.id, { rotulo, usos_max: usosMax, validade_dias: dias });
      return json({ ok: true, id: data.id, link: linkDoToken(origem, "cadastro", token) });
    }

    // --- Convite pessoal ---------------------------------------------------------------------------
    if (corpo.acao === "convidar") {
      const nome = (corpo.nome ?? "").trim().replace(/\s+/g, " ");
      const email = (corpo.email ?? "").trim().toLowerCase();
      const whatsapp = corpo.whatsapp ? normalizarWhatsapp(corpo.whatsapp) : null;
      if (nome.length < 5 || !nome.includes(" ")) return json({ error: "Informe o nome completo." }, 400);
      if (!emailValido(email)) return json({ error: "E-mail inválido." }, 400);
      if (corpo.whatsapp && !whatsapp) return json({ error: "WhatsApp inválido (use DDD)." }, 400);
      for (const [tabela, coluna, msg] of [
        ["profiles", "id", "Este e-mail é de um colaborador da PPGVET."],
        ["ies_portal_usuarios", "user_id", "Este e-mail já tem acesso ao Portal da IES."],
        ["emb_embaixadores", "id", "Este e-mail já está no programa. Use Reenviar link."],
      ] as const) {
        const { data, error } = await admin.from(tabela).select(coluna).ilike("email", literalIlike(email)).limit(1);
        if (error) return json({ error: "Não foi possível conferir o e-mail. Tente de novo." }, 503);
        if (data?.length) return json({ error: msg }, 409);
      }
      const { data: emb, error: e1 } = await admin.from("emb_embaixadores").insert({
        nome, email, whatsapp, status: "convidado", convidado_em: new Date().toISOString(), convidado_por: usuarioId,
      }).select("id").single();
      if (e1) return json({ error: e1.message }, 500);
      const r = await novoConvitePessoal(emb.id, nome, email);
      await registrar(emb.id, "convidou", nome, { email_enviado: r.email_enviado });
      return json({ ok: true, embaixador_id: emb.id, ...r });
    }

    // --- Reenviar: convite (ainda não se cadastrou) ou nova senha (já tem conta) -------------------
    if (corpo.acao === "reenviar") {
      if (!corpo.embaixador_id || !UUID.test(corpo.embaixador_id)) return json({ error: "Embaixador inválido." }, 400);
      const { data: emb } = await admin.from("emb_embaixadores").select("id, nome, email, status, user_id")
        .eq("id", corpo.embaixador_id).maybeSingle();
      if (!emb) return json({ error: "Embaixador não encontrado." }, 404);
      if (emb.status === "convidado") {
        const r = await novoConvitePessoal(emb.id, emb.nome, emb.email);
        await registrar(emb.id, "reenviou_convite", emb.nome, { email_enviado: r.email_enviado });
        return json({ ok: true, ...r });
      }
      if (!emb.user_id) return json({ error: "Este embaixador ainda não tem conta." }, 409);
      await admin.from("emb_convites").update({ ativo: false }).eq("embaixador_id", emb.id).eq("motivo", "nova_senha").eq("usos", 0);
      const token = novoToken();
      const { data: conv, error } = await admin.from("emb_convites").insert({
        token_hash: await hashToken(token), motivo: "nova_senha", embaixador_id: emb.id, usos_max: 1, criado_por: usuarioId,
        expira_em: new Date(Date.now() + VALIDADE_NOVA_SENHA_MS).toISOString(),
      }).select("id").single();
      if (error) return json({ error: error.message }, 500);
      const link = linkDoToken(origem, "nova_senha", token);
      const enviado = await enviarEmailDoEmbaixador(admin, { para: emb.email, nome: emb.nome, link, motivo: "nova_senha", chave: conv.id });
      await registrar(emb.id, "reenviou_senha", emb.nome, { email_enviado: enviado });
      return json({ ok: true, link, email_enviado: enviado });
    }

    // --- Contrato assinado (PDF) -------------------------------------------------------------------
    if (corpo.acao === "anexar_contrato") {
      if (!corpo.embaixador_id || !UUID.test(corpo.embaixador_id)) return json({ error: "Embaixador inválido." }, 400);
      const m = /^data:(application\/pdf|image\/jpeg|image\/png);base64,([A-Za-z0-9+/=]+)$/.exec(corpo.arquivo ?? "");
      if (!m) return json({ error: "Envie o contrato em PDF (ou foto JPG/PNG)." }, 400);
      const bytes = Uint8Array.from(atob(m[2]), (ch) => ch.charCodeAt(0));
      if (bytes.length > 10 * 1024 * 1024) return json({ error: "Arquivo acima de 10 MB." }, 400);
      const data = /^\d{4}-\d{2}-\d{2}$/.test(corpo.data ?? "") ? corpo.data! : null;
      const { data: emb } = await admin.from("emb_embaixadores").select("id, nome, status").eq("id", corpo.embaixador_id).maybeSingle();
      if (!emb || !["onboarding", "ativo"].includes(emb.status)) return json({ error: "Só depois do formulário respondido." }, 409);
      const ext = m[1] === "application/pdf" ? "pdf" : m[1] === "image/png" ? "png" : "jpg";
      const path = `${emb.id}/contrato-${Date.now()}.${ext}`;
      const { error: eUp } = await admin.storage.from("emb-docs").upload(path, bytes, { contentType: m[1] });
      if (eUp) return json({ error: "Não foi possível guardar o arquivo." }, 500);
      const { error } = await admin.from("emb_embaixadores").update({
        contrato_path: path, contrato_assinado_em: data ?? new Date().toISOString().slice(0, 10), atualizado_em: new Date().toISOString(),
      }).eq("id", emb.id);
      if (error) return json({ error: error.message }, 500);
      await registrar(emb.id, "anexou_contrato", emb.nome, { data });
      return json({ ok: true, path });
    }

    return json({ error: "Ação desconhecida." }, 400);

    async function novoConvitePessoal(embaixadorId: string, nome: string, email: string) {
      await admin.from("emb_convites").update({ ativo: false }).eq("embaixador_id", embaixadorId).eq("motivo", "convite").eq("usos", 0);
      const token = novoToken();
      const { data: conv, error } = await admin.from("emb_convites").insert({
        token_hash: await hashToken(token), motivo: "convite", embaixador_id: embaixadorId, usos_max: 1, criado_por: usuarioId,
        expira_em: new Date(Date.now() + VALIDADE_CONVITE_MS).toISOString(),
      }).select("id").single();
      if (error) throw error;
      const link = linkDoToken(origem, "convite", token);
      const email_enviado = await enviarEmailDoEmbaixador(admin, { para: email, nome, link, motivo: "convite", chave: conv.id });
      return { link, email_enviado };
    }
  } catch (e) {
    console.error("[emb-acessos]", e);
    return json({ error: e instanceof Error ? e.message : "Erro inesperado." }, 500);
  }
});
