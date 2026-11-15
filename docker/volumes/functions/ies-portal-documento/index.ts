// Edge Function: ies-portal-documento — Portal da Unidade Certificadora (15/11/2026).
//
// Abre um documento do aluno (venda_documentos, bucket PRIVADO documentos-alunos) para a unidade.
// Quem AUTORIZA é o banco: a RPC ies_portal_documento_abrir, chamada com o token de quem pediu,
// confere a conta ativa, confere que a venda do documento é da unidade (a mesma régua da lista)
// e registra "abriu_documento" (LGPD). Só depois esta edge gera o link de 5 minutos com a
// service_role — o papel ies_portal continua sem ler Storage nem tabela.
//
// Chamadores: a ficha do aluno no portal (conta ies_portal) e a visão da PPGVET (colaborador que
// opera o portal, pelo ies_admin_ver_como da unidade do aluno). Ver docs/Portal da IES.md.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { exigirAcesso, respostaAcessoNegado } from "../_shared/acesso.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKET = "documentos-alunos";
const VALIDADE_S = 300;
const PUBLIC_SUPABASE_URL = Deno.env.get("PUBLIC_SUPABASE_URL") || "https://api.ppgeducacao.site";
/** URL interna do Kong → host público (o navegador da unidade não enxerga `kong:8000`). Mesma regra de waMediaInbound. */
const urlPublica = (u: string) => u.replace(/^https?:\/\/(?:supabase-)?kong:8000/i, PUBLIC_SUPABASE_URL);

interface Corpo {
  documento_id?: string;
  /** Só na visão da PPGVET: a unidade (certificadora) do aluno. A conta da IES não manda (é a dela). */
  unidade_id?: string;
  baixar?: boolean;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  let token: string;
  let papel: "authenticated" | "ies_portal";
  try {
    const quem = await exigirAcesso(req, { usuario: true, contaIes: true });
    if (quem.tipo !== "usuario") return json({ error: "Só pelo portal." }, 403);
    token = quem.token;
    papel = quem.papel;
  } catch (e) {
    return respostaAcessoNegado(e, corsHeaders);
  }

  try {
    const corpo = (await req.json().catch(() => ({}))) as Corpo;
    const documentoId = corpo.documento_id ?? "";
    if (!UUID.test(documentoId)) return json({ error: "Documento inválido." }, 400);

    // A conta da IES chama a RPC dela; o colaborador só pela visão da PPGVET, como a unidade do aluno
    // (ies_admin_ver_como confere pode_operar_portal_ies e a unidade).
    let rpc: string;
    let args: Record<string, unknown>;
    if (papel === "ies_portal") {
      rpc = "ies_portal_documento_abrir";
      args = { p_documento: documentoId };
    } else {
      if (!corpo.unidade_id || !UUID.test(corpo.unidade_id)) return json({ error: "Unidade inválida." }, 400);
      rpc = "ies_admin_ver_como";
      args = { p_cert: corpo.unidade_id, p_rpc: "ies_portal_documento_abrir", p_args: { p_documento: documentoId } };
    }

    const url = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
    const apikey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const r = await fetch(`${url}/rest/v1/rpc/${rpc}`, {
      method: "POST",
      headers: { apikey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    const resposta = await r.json().catch(() => null) as
      | { storage_path?: string; nome_arquivo?: string | null; mime_type?: string | null; message?: string }
      | null;
    if (!r.ok) {
      // PT403/PT404 do banco viram 403/404 no PostgREST: repassa a mensagem dele, sem detalhe interno.
      const status = r.status === 403 || r.status === 404 ? r.status : 502;
      return json({ error: resposta?.message ?? "Não foi possível abrir o documento." }, status);
    }
    if (!resposta?.storage_path) return json({ error: "Documento não encontrado nesta unidade." }, 404);

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(
      resposta.storage_path,
      VALIDADE_S,
      corpo.baixar ? { download: resposta.nome_arquivo || true } : undefined,
    );
    if (error || !data?.signedUrl) return json({ error: "O arquivo não está disponível no momento." }, 404);
    return json({ url: urlPublica(data.signedUrl), nome_arquivo: resposta.nome_arquivo ?? null, mime_type: resposta.mime_type ?? null });
  } catch (e) {
    console.error("[ies-portal-documento]", e);
    return json({ error: "Erro inesperado." }, 500);
  }
});
