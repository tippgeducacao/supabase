// wa-uazapi-monitor
// ----------------------------------------------------------------------------
// Backstop do status das linhas (provider-agnóstico). O webhook `connection` já
// atualiza o status em tempo real; este cron varre TODAS as linhas ativas a cada
// X min e reconcilia o status pelo provider — pega quedas cujo webhook se perdeu
// (mesma ideia do fluxo n8n "Aviso de Desconexão"). Quando uma linha cai, o status
// vira 'desconectado' e o BANNER no CRM aparece (some quando o usuário dá OK).
//
// Chamado por pg_cron com Authorization: Bearer <anon> (mesmo padrão dos outros
// crons do projeto). Não recebe dados sensíveis no corpo.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { getWaProvider } from "../_shared/waProviders.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!req.headers.get("Authorization")?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  // Linhas ativas + token (service_role lê o segredo)
  const { data: conexoes, error } = await admin
    .from("wa_conexoes")
    .select("id, provider, server_url, status_conexao, wa_conexoes_secrets(token)")
    .eq("ativo", true);
  if (error) return json({ error: error.message }, 500);

  let checadas = 0, mudancas = 0, caiu = 0;
  for (const c of conexoes ?? []) {
    const token = (c as any)?.wa_conexoes_secrets?.token ?? (Array.isArray((c as any)?.wa_conexoes_secrets) ? (c as any).wa_conexoes_secrets[0]?.token : null);
    if (!token) continue;
    try {
      const provider = getWaProvider(c.provider);
      const s = await provider.status(c.server_url, token);
      checadas++;
      if (s.status !== c.status_conexao) {
        mudancas++;
        if (s.status === "desconectado") caiu++;
        const patch: Record<string, unknown> = { status_conexao: s.status, ultimo_status_em: new Date().toISOString() };
        if (s.numero) patch.numero = s.numero;
        if (s.status === "conectado") { patch.qrcode = null; patch.paircode = null; }
        await admin.from("wa_conexoes").update(patch).eq("id", c.id);
      }
    } catch (e) {
      console.log(`[wa-uazapi-monitor] status falhou p/ ${c.id}:`, e instanceof Error ? e.message : String(e));
    }
  }
  console.log(`[wa-uazapi-monitor] checadas=${checadas} mudancas=${mudancas} caiu=${caiu}`);
  return json({ ok: true, checadas, mudancas, caiu });
});
