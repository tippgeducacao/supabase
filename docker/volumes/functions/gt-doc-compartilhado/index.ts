// acesso: publico — o token de 64 hex é a credencial; modo 'logado' exige JWT de usuário ativo
//
// gt-doc-compartilhado — a ponte entre a página `/d/<token>` (descrição de uma tarefa do Gestor aberta por
// link) e o banco. Quem decide se o link vale e o que sai está em `_shared/gtDocCompartilhado.ts` (testado);
// aqui só se liga ao banco com a service_role.
//
//   POST { token }  → 200 { ok, titulo, html, atualizado_em, modo }
//                   → 404 { ok:false, erro:'link_invalido' }  (inexistente, desligado, tarefa sumida ou de liderança)
//                   → 401 { ok:false, erro:'precisa_login' }  (modo 'logado' sem sessão de colaborador ativo)
//
// Quem cria, troca o modo, renova ou desliga o link é a RPC `gt_doc_link_definir` (só quem edita a tarefa).
// ⚠️ A service_role NUNCA sai daqui, e toda leitura é amarrada à tarefa que o token resolveu.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.50.0";
import { AcessoNegado, exigirAcesso } from "../_shared/acesso.ts";
import {
  BUCKET_PRIVADO,
  MAX_BYTES_DO_PEDIDO,
  VALIDADE_ASSINATURA_S,
  tratarPedido,
  type Banco,
  type LinkDoc,
  type TarefaDoLink,
} from "../_shared/gtDocCompartilhado.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const PUBLIC_SUPABASE_URL = Deno.env.get("PUBLIC_SUPABASE_URL") || "https://api.ppgeducacao.site";
/** URL interna do Kong → host público (o navegador de quem abre o link não enxerga `kong:8000`). */
const urlPublica = (u: string) => u.replace(/^https?:\/\/(?:supabase-)?kong:8000/i, PUBLIC_SUPABASE_URL);

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const banco: Banco = {
  async linkDoToken(token) {
    const { data, error } = await sb.from("gt_doc_links").select("task_id, modo").eq("token", token).maybeSingle();
    if (error) throw error;
    return (data as LinkDoc | null) ?? null;
  },
  async carregarTarefa(taskId) {
    const { data, error } = await sb
      .from("gt_tasks")
      .select("title, description, updated_at, leader_scope")
      .eq("id", taskId)
      .maybeSingle();
    if (error) throw error;
    return (data as TarefaDoLink | null) ?? null;
  },
  async caminhosVinculados(taskId) {
    const { data, error } = await sb
      .from("gt_arquivos_vinculos")
      .select("caminho")
      .eq("tabela", "gt_tasks")
      .eq("registro_id", taskId)
      .eq("bucket_id", BUCKET_PRIVADO);
    if (error) throw error;
    return new Set(((data ?? []) as { caminho: string }[]).map((v) => v.caminho));
  },
  async assinar(caminhos) {
    const mapa = new Map<string, string>();
    const { data, error } = await sb.storage.from(BUCKET_PRIVADO).createSignedUrls(caminhos, VALIDADE_ASSINATURA_S);
    if (error) {
      console.error("gt-doc-compartilhado: assinatura falhou:", error.message);
      return mapa; // sem link assinado a foto fica quebrada, mas o texto abre
    }
    for (const item of data ?? []) {
      if (item.path && item.signedUrl && !item.error) mapa.set(item.path, urlPublica(item.signedUrl));
    }
    return mapa;
  },
};

/** Só no modo 'logado': sessão de colaborador (não a chave anon) com perfil ATIVO. */
async function usuarioAtivo(req: Request): Promise<boolean> {
  try {
    const quem = await exigirAcesso(req, { usuario: true });
    if (quem.tipo !== "usuario" || quem.papel !== "authenticated") return false;
    const { data, error } = await sb.from("profiles").select("ativo").eq("id", quem.usuarioId).maybeSingle();
    if (error) throw error;
    return data?.ativo === true;
  } catch (e) {
    if (e instanceof AcessoNegado) return false;
    throw e;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, erro: "pedido_invalido" }, 405);

  // Pedido grande é recusado ANTES de ler o corpo (a edge é pública e sem limite de pedidos).
  const tamanho = Number(req.headers.get("content-length") ?? "0");
  if (tamanho > MAX_BYTES_DO_PEDIDO) return json({ ok: false, erro: "pedido_invalido" }, 413);

  let corpo: unknown;
  try {
    const texto = await req.text();
    if (texto.length > MAX_BYTES_DO_PEDIDO) return json({ ok: false, erro: "pedido_invalido" }, 413);
    corpo = JSON.parse(texto);
  } catch {
    return json({ ok: false, erro: "pedido_invalido" }, 400);
  }

  try {
    const r = await tratarPedido(corpo, banco, () => usuarioAtivo(req));
    return json(r.corpo, r.status);
  } catch (e) {
    console.error("gt-doc-compartilhado:", e instanceof Error ? e.message : e);
    return json({ ok: false, erro: "erro_interno" }, 503);
  }
});
