import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.2";
import { ErroMaterialEmailIA, importarUrlMaterialEmailIA, validarUrlMaterialEmailIA, type RedeMaterialEmailIA } from "./url.ts";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Expose-Headers": "Retry-After" };
const json = (dados: unknown, status = 200) => new Response(JSON.stringify(dados), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store", ...(status === 429 ? { "Retry-After": "60" } : {}) } });
export function criarHandlerImportarMaterialEmailIA(cliente: SupabaseClient, rede: RedeMaterialEmailIA) {
  // Limite por instância, separado da cota de IA: importar texto não gera IA.
  const usos = new Map<string, number[]>(); let simultaneos = 0;
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);
    let reservado = false;
    try {
      const token = req.headers.get("Authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];
      if (!token) throw new ErroMaterialEmailIA(401, "Entre no sistema para importar material.");
      const { data, error } = await cliente.auth.getUser(token);
      if (error || !data.user?.id || data.user.is_anonymous) throw new ErroMaterialEmailIA(401, "Sessão inválida. Entre novamente.");
      const usuarioId = data.user.id;
      const [perfil, admin, diretor] = await Promise.all([
        cliente.from("profiles").select("ativo").eq("id", usuarioId).maybeSingle(),
        cliente.rpc("has_role", { user_id: usuarioId, role_name: "admin" }),
        cliente.rpc("has_role", { user_id: usuarioId, role_name: "diretor" }),
      ]);
      if (perfil.error || admin.error || diretor.error) throw new ErroMaterialEmailIA(503, "Não foi possível verificar seu acesso.");
      if (perfil.data?.ativo !== true || !(admin.data === true || diretor.data === true)) throw new ErroMaterialEmailIA(403, "Você não tem permissão para editar templates de e-mail.");
      const reader = req.body?.getReader(); if (!reader) throw new ErroMaterialEmailIA(400, "Informe a URL da página.");
      let corpo = ""; let total = 0; const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          total += value.length;
          if (total > 4096) { await reader.cancel(); throw new ErroMaterialEmailIA(413, "O pedido de importação é muito grande."); }
          corpo += decoder.decode(value, { stream: true });
        }
        corpo += decoder.decode();
      } finally { reader.releaseLock(); }
      let pedido: Record<string, unknown>;
      try { pedido = JSON.parse(corpo); } catch { throw new ErroMaterialEmailIA(400, "Pedido inválido."); }
      if (!pedido || typeof pedido !== "object" || Array.isArray(pedido) || Object.keys(pedido).some(k => !["url", "usuario_esperado"].includes(k))) throw new ErroMaterialEmailIA(400, "Pedido inválido.");
      if (pedido.usuario_esperado !== usuarioId) throw new ErroMaterialEmailIA(409, "A conta mudou. Reabra a importação na conta atual.");
      const url = validarUrlMaterialEmailIA(pedido.url);
      const agora = Date.now();
      for (const [id, lista] of usos) if (!lista.some(t => t > agora - 60000)) usos.delete(id);
      const recentes = (usos.get(usuarioId) ?? []).filter(t => t > agora - 60000);
      if (recentes.length >= 5 || simultaneos >= 4) throw new ErroMaterialEmailIA(429, "Muitas importações em andamento. Aguarde um minuto para tentar novamente.");
      usos.set(usuarioId, [...recentes, agora]); simultaneos++; reservado = true;
      return json({ material: await importarUrlMaterialEmailIA(url.href, rede) });
    } catch (e) {
      return e instanceof ErroMaterialEmailIA ? json({ error: e.message }, e.status) : json({ error: "Não foi possível acessar a página com segurança. Tente outra URL ou copie seu texto." }, 422);
    } finally { if (reservado) simultaneos--; }
  };
}
