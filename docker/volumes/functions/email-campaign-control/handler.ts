import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { consultarCapacidadesCampanhas } from "../_shared/emailCampanhasCapacidades.ts";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
interface Dependencias {
  criarCliente: (authorization: string) => SupabaseClient; url: string; apikey?: string; buscar?: typeof fetch;
}
export function criarHandlerControleCampanha(deps: Dependencias) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    const json = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });
    if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);
    try {
      const auth = req.headers.get("Authorization");
      if (!auth) return json({ error: "Sessão necessária." }, 401);
      const cliente = deps.criarCliente(auth);
      const { data: { user }, error: erroAuth } = await cliente.auth.getUser(auth.replace(/^Bearer /i, ""));
      if (erroAuth || !user || user.is_anonymous) return json({ error: "Sessão inválida." }, 401);
      const corpo = await req.json();
      if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) return json({ error: "Pedido inválido." }, 400);
      const { action, campanha_id, usuario_esperado } = corpo;
      if (usuario_esperado !== undefined && usuario_esperado !== user.id) return json({ error: "Sua conta mudou. Atualize a tela." }, 403);
      if (action === "consultar_capacidades") {
        if (usuario_esperado !== user.id) return json({ error: "Confirme a conta antes de consultar as campanhas." }, 403);
        const { data: perfil, error } = await cliente.from("profiles").select("ativo").eq("id", user.id).maybeSingle();
        if (error) return json({ error: "Não foi possível confirmar o acesso." }, 503);
        if (perfil?.ativo !== true) return json({ error: "Sua conta está sem acesso." }, 403);
        // Só lê as capacidades efetivamente publicadas. Nenhuma campanha, fila,
        // destinatário ou provedor é consultado ou acionado por esta operação.
        return json(await consultarCapacidadesCampanhas({ url: deps.url, authorization: auth, apikey: deps.apikey, buscar: deps.buscar }));
      }
      if (!["pausar", "retomar", "cancelar"].includes(action) || !campanha_id) return json({ error: "Pedido inválido." }, 400);
      const { error } = await cliente.rpc("email_campanha_controlar", { p_usuario_esperado: usuario_esperado ?? user.id, p_campanha: campanha_id, p_acao: action });
      if (error) return json({ error: error.message }, error.code === "42501" ? 403 : 400);
      return json({ ok: true });
    } catch { return json({ error: "Não foi possível atualizar a campanha." }, 500); }
  };
}
