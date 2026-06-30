// crm-whatsapp-broadcast
// ----------------------------------------------------------------------------
// Disparo em LOTE de um template (Meta) para os interessados da coluna "Abertura de
// Turma" do funil de recontato. Resolve a lista (RPC crm_broadcast_abertura_turma_lista,
// já com anti-duplicação 12h), mapeia {{1}} = primeiro nome do lead, e envia chamando o
// crm-whatsapp-send por lead (que persiste em crm_whatsapp_messages -> mirror cria o
// atendimento do número PPGVET com o responsável do card de recontato). Throttle entre envios.
//
// Gate: service-role (trigger interno via pg_net) OU admin/diretor (JWT). NÃO é tela.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(d: unknown, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "use POST" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  // Gate: service-role (pg_net) ou admin/diretor (JWT de usuário).
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  let autorizado = token === SERVICE_ROLE;
  if (!autorizado && token) {
    const u = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
    const { data: isAdmin } = await u.rpc("is_admin_ou_diretor_user");
    autorizado = isAdmin === true;
  }
  if (!autorizado) return json({ error: "não autorizado" }, 403);

  const b = await req.json().catch(() => ({}));
  const waAccountId = String(b?.wa_account_id ?? "").trim();
  const templateName = String(b?.template_name ?? "").trim();
  const templateLang = String(b?.template_lang ?? "pt_BR").trim();
  const funilId = String(b?.funil_id ?? "").trim();
  const interesses: string[] = Array.isArray(b?.interesses) ? b.interesses.map(String) : [];
  const throttleMs = Math.max(50, Math.min(2000, Number(b?.throttle_ms ?? 120)));
  const max = Math.max(1, Math.min(2000, Number(b?.max ?? 2000)));
  if (!waAccountId || !templateName || !funilId || interesses.length === 0) {
    return json({ error: "wa_account_id, template_name, funil_id e interesses são obrigatórios" }, 400);
  }

  const { data: leads, error } = await admin.rpc("crm_broadcast_abertura_turma_lista", {
    p_funil: funilId, p_interesses: interesses, p_template: templateName, p_max: max,
  });
  if (error) return json({ error: `lista: ${error.message}` }, 500);
  const lista = (leads ?? []) as { contato_id: string; lead_id: string; telefone: string; primeiro_nome: string }[];
  console.log(`[crm-whatsapp-broadcast] iniciando: ${lista.length} leads, template=${templateName}, conta=${waAccountId}`);

  let ok = 0, falha = 0;
  const erros: string[] = [];
  for (const l of lista) {
    try {
      const r = await fetch(`${SUPABASE_URL}/functions/v1/crm-whatsapp-send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${SERVICE_ROLE}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          wa_account_id: waAccountId,
          telefone: l.telefone,
          tipo: "template",
          template_name: templateName,
          template_lang: templateLang,
          template_components: [{ type: "body", parameters: [{ type: "text", text: l.primeiro_nome }] }],
          lead_id: l.lead_id ?? undefined,
        }),
      });
      const resp = await r.json().catch(() => ({}));
      if (r.ok && !(resp as any)?.error) ok++;
      else { falha++; if (erros.length < 8) erros.push(`${l.telefone}: ${(resp as any)?.error ?? r.status}`); }
    } catch (e) {
      falha++; if (erros.length < 8) erros.push(`${l.telefone}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await sleep(throttleMs);
  }
  console.log(`[crm-whatsapp-broadcast] fim: ok=${ok} falha=${falha} erros=${JSON.stringify(erros)}`);
  return json({ ok: true, total: lista.length, enviados: ok, falhas: falha, erros });
});
