// acesso: publico — página da agenda que a empresa-cliente abre por link com token aleatório de 256 bits (revogável, uma agenda por token); só lê e comenta a agenda daquele token
//
// agenda-cliente-publica — a ponte entre a página pública da agenda (`/agenda-do-cliente/<token>`) e o banco.
// A empresa não tem login: o TOKEN do link é a única credencial. Tudo o que decide o que entra e o que sai está em
// `_shared/agendaClientePublica.ts` (testado); aqui só se liga ao banco com a service_role.
//
//   POST { acao: "ler", token }                                   → { ok, cliente, agenda, secoes, comentarios }
//   POST { acao: "comentar", token, nome, texto, item_id? }       → { ok, comentario }
//   erro: { ok:false, motivo: link_invalido | pedido_invalido | nome_invalido | texto_invalido | muitos_comentarios }
//
// ⚠️ A service_role NUNCA sai daqui, e toda consulta é amarrada ao `agenda_id` que o token resolveu.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.50.0";
import {
  MAX_BYTES_DO_PEDIDO,
  MAX_COMENTARIOS_NA_TELA,
  tratarPedido,
  type Banco,
  type ComentarioPublico,
  type DadosDaAgenda,
} from "../_shared/agendaClientePublica.ts";

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

const COLUNAS_COMENTARIO = "id, item_id, autor_tipo, autor_nome, texto, created_at";

function criarBanco(): Banco {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return {
    async agendaDoToken(token) {
      const { data, error } = await sb.from("crm_empresa_agenda_link_cliente").select("agenda_id").eq("token", token).maybeSingle();
      if (error) throw error;
      return (data?.agenda_id as string | undefined) ?? null;
    },

    async carregarAgenda(agendaId): Promise<DadosDaAgenda | null> {
      const { data, error } = await sb
        .from("crm_empresa_agendas")
        .select(
          "task_id, projeto, inicio, termino, ultima_reuniao, proxima_reuniao, logo, " +
            "secoes:crm_empresa_agenda_secoes(id, titulo, ordem, " +
            "itens:crm_empresa_agenda_itens(id, titulo, detalhe, status, prazo, entregue_em, links, ordem))",
        )
        .eq("id", agendaId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const a = data as unknown as {
        task_id: string;
        projeto: string;
        inicio: string | null;
        termino: string | null;
        ultima_reuniao: string | null;
        proxima_reuniao: string | null;
        logo: string | null;
        secoes: DadosDaAgenda["secoes"] | null;
      };
      const { data: card, error: e2 } = await sb.from("gt_tasks").select("title").eq("id", a.task_id).maybeSingle();
      if (e2) throw e2;
      return {
        cliente: (card?.title as string | undefined) ?? "",
        agenda: {
          projeto: a.projeto,
          inicio: a.inicio,
          termino: a.termino,
          ultima_reuniao: a.ultima_reuniao,
          proxima_reuniao: a.proxima_reuniao,
          logo: a.logo,
        },
        secoes: (a.secoes ?? []).map((s) => ({ ...s, itens: s.itens ?? [] })),
      };
    },

    async listarComentarios(agendaId) {
      const { data, error } = await sb
        .from("crm_empresa_agenda_comentarios")
        .select(COLUNAS_COMENTARIO)
        .eq("agenda_id", agendaId)
        .order("created_at", { ascending: false })
        .limit(MAX_COMENTARIOS_NA_TELA);
      if (error) throw error;
      // Pegou os mais recentes; a tela lê do mais antigo para o mais novo.
      return ((data ?? []) as ComentarioPublico[]).reverse();
    },

    async contarComentariosDeClientes(agendaId, desdeIso) {
      const { count, error } = await sb
        .from("crm_empresa_agenda_comentarios")
        .select("id", { count: "exact", head: true })
        .eq("agenda_id", agendaId)
        .eq("autor_tipo", "cliente")
        .gte("created_at", desdeIso);
      if (error) throw error;
      return count ?? 0;
    },

    async inserirComentario({ agendaId, itemId, nome, texto }) {
      const { data, error } = await sb
        .from("crm_empresa_agenda_comentarios")
        .insert({ agenda_id: agendaId, item_id: itemId, autor_tipo: "cliente", autor_id: null, autor_nome: nome, texto })
        .select(COLUNAS_COMENTARIO)
        .single();
      // 23514 = o gatilho recusou o item (de outra agenda). Qualquer outro erro é falha de verdade.
      if (error?.code === "23514") return "item_invalido";
      if (error) throw error;
      return data as ComentarioPublico;
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, motivo: "pedido_invalido" }, 405);

  let corpo: unknown;
  try {
    const texto = await req.text();
    if (texto.length > MAX_BYTES_DO_PEDIDO) return json({ ok: false, motivo: "pedido_invalido" }, 413);
    corpo = JSON.parse(texto);
  } catch {
    return json({ ok: false, motivo: "pedido_invalido" }, 400);
  }

  try {
    const r = await tratarPedido(corpo, criarBanco());
    return json(r.corpo, r.status);
  } catch (e) {
    console.error("agenda-cliente-publica:", e instanceof Error ? e.message : e);
    // Sem detalhe para quem está de fora; o motivo fica no log da edge.
    return json({ ok: false, motivo: "erro_interno" }, 503);
  }
});
