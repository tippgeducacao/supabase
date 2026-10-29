// midia-recebida-renovar — link novo para mídia RECEBIDA cujo link assinado venceu (29/10/2026).
//
// A mídia recebida (de lead, aluno, candidato) mora no bucket PRIVADO `whatsapp-recebidos`; a
// mensagem guarda um link assinado de 7 dias (ver _shared/midiaRecebida.ts). Quem abre uma
// conversa antiga pede aqui um link novo. O bucket não dá leitura a ninguém do app — nem para
// listar —, então a ÚNICA porta é esta:
//   POST (logado) { tabela, itens: [{ id, caminho }] } → { links: { [caminho]: url } }
// Para cada item, a mensagem `id` é lida COM O TOKEN DA PESSOA (vale a RLS da conversa) e o
// `caminho` tem de estar nos anexos dela. Só então assina, pela service role, por 24 h.
import { exigirAcesso, respostaAcessoNegado } from "../_shared/acesso.ts";
import { assinarCaminho, caminhoRecebido } from "../_shared/midiaRecebida.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const TABELAS = new Set(["sac_mensagens", "crm_whatsapp_messages", "ped_conversas_mensagens"]);
const MAX_ITENS = 200;
const VALIDADE_S = 24 * 60 * 60;

type Anexo = { url?: string | null; url_storage?: string | null; caminho?: string | null };

function caminhosDaMensagem(anexos: unknown): Set<string> {
  const s = new Set<string>();
  for (const a of (Array.isArray(anexos) ? anexos : []) as Anexo[]) {
    if (typeof a?.caminho === "string") s.add(a.caminho);
    for (const u of [a?.url, a?.url_storage]) {
      const c = caminhoRecebido(u);
      if (c) s.add(c);
    }
  }
  return s;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método não suportado." }, 405);

  let token: string;
  try {
    const quem = await exigirAcesso(req, { usuario: true });
    if (quem.tipo !== "usuario") return json({ error: "Acesso restrito." }, 403);
    token = quem.token;
  } catch (e) {
    return respostaAcessoNegado(e, corsHeaders);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const tabela = String(body?.tabela ?? "");
    const itens = (Array.isArray(body?.itens) ? body.itens : []) as Array<{ id?: unknown; caminho?: unknown }>;
    if (!TABELAS.has(tabela)) return json({ error: "Tabela não permitida." }, 400);
    const validos = itens
      .map((i) => ({ id: String(i?.id ?? ""), caminho: String(i?.caminho ?? "") }))
      .filter((i) => /^[0-9a-f-]{36}$/i.test(i.id) && i.caminho && !i.caminho.includes(".."))
      .slice(0, MAX_ITENS);
    if (!validos.length) return json({ links: {} });

    const base = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
    const chaveServico = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const chaveAnon = Deno.env.get("SUPABASE_ANON_KEY") ?? chaveServico;
    const ids = [...new Set(validos.map((i) => i.id))];

    // Leitura COMO A PESSOA: só volta a mensagem que a RLS deixa ela ver.
    const r = await fetch(`${base}/rest/v1/${tabela}?select=id,anexos&id=in.(${ids.join(",")})`, {
      headers: { apikey: chaveAnon, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return json({ error: "Não consegui conferir as mensagens." }, 502);
    const linhas = (await r.json()) as Array<{ id: string; anexos: unknown }>;
    const permitidos = new Map(linhas.map((l) => [l.id, caminhosDaMensagem(l.anexos)]));

    const links: Record<string, string> = {};
    const publico = (Deno.env.get("PUBLIC_SUPABASE_URL") ?? Deno.env.get("SUPABASE_PUBLIC_URL") ?? "").replace(/\/$/, "");
    for (const { id, caminho } of validos) {
      if (links[caminho] || !permitidos.get(id)?.has(caminho)) continue;
      try {
        const url = await assinarCaminho(caminho, VALIDADE_S, { base, chave: chaveServico });
        // O navegador não alcança o endereço interno do Kong: troca pelo público.
        links[caminho] = publico ? url.replace(base, publico) : url;
      } catch (e) {
        console.warn("[midia-recebida-renovar] assinar:", e instanceof Error ? e.message : e);
      }
    }
    return json({ links });
  } catch (e) {
    console.error("[midia-recebida-renovar]", e);
    return json({ error: "Não consegui renovar os links agora." }, 500);
  }
});
