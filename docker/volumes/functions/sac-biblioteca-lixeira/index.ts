// sac-biblioteca-lixeira
// ----------------------------------------------------------------------------
// PURGA da lixeira da Biblioteca de mídias (15/09/2026): o que foi excluído há mais de
// N dias (padrão 30) some de vez — primeiro o OBJETO no bucket (Storage API, que apaga o
// arquivo no backend `file` da VPS), depois a linha. A ordem é de propósito: se o arquivo
// não sair, a linha fica e o cron tenta de novo amanhã; linha sem arquivo seria um card
// quebrado, arquivo sem linha seria lixo invisível no disco.
//
// Chamado por pg_cron (job `sac-biblioteca-lixeira-purgar`, diário) com Bearer service_role.
// Manual: POST ?dias=30 (mínimo 1) — nunca purga o que está há menos tempo na lixeira.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
/** Mesmo bucket do front (`BIBLIOTECA_BUCKET` em useSacBibliotecaMidias.ts). */
const BUCKET = "sac-biblioteca-midias";
/** Mesmo prazo do front (`LIXEIRA_DIAS`) — o que a tela promete é o que o cron cumpre. */
const DIAS_PADRAO = 30;
const LOTE = 50;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  // Gate: só service role (cron interno / operação manual). Nunca anon nem usuário logado:
  // apagar arquivo do acervo do time não é ação de tela. Aceita as DUAS chaves (env do
  // container e vault) — o cron manda a do vault.
  const auth = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!auth || auth !== SERVICE_ROLE) {
    let vaultKey: string | null = null;
    try {
      const r = await admin.rpc("_get_service_role_key");
      vaultKey = (r.data as string | null) ?? null;
    } catch (err) {
      console.error("[sac-biblioteca-lixeira] falha ao ler a key do vault", String(err));
    }
    if (!vaultKey || auth !== vaultKey) return json({ error: "forbidden" }, 403);
  }

  const diasParam = Number(new URL(req.url).searchParams.get("dias") ?? DIAS_PADRAO);
  const dias = Number.isFinite(diasParam) && diasParam >= 1 ? Math.floor(diasParam) : DIAS_PADRAO;
  const limite = new Date(Date.now() - dias * 86_400_000).toISOString();

  const { data: rows, error } = await admin
    .from("sac_biblioteca_midias")
    .select("id, storage_path, url, nome, excluido_em")
    .not("excluido_em", "is", null)
    .lt("excluido_em", limite)
    .order("excluido_em", { ascending: true })
    .limit(500);
  if (error) return json({ error: error.message }, 500);

  const candidatas = rows ?? [];
  let purgadas = 0;
  let falhas = 0;
  for (let i = 0; i < candidatas.length; i += LOTE) {
    const lote = candidatas.slice(i, i + LOTE);
    // 1) o arquivo. Objeto que já não existe no bucket não é erro — a linha sai igual.
    const { error: rmErr } = await admin.storage.from(BUCKET).remove(lote.map((r) => r.storage_path));
    if (rmErr) {
      falhas += lote.length;
      console.error(`[sac-biblioteca-lixeira] storage.remove falhou (${lote.length} arquivos):`, rmErr.message);
      continue;
    }
    // 2) a linha.
    const { error: delErr } = await admin.from("sac_biblioteca_midias").delete().in("id", lote.map((r) => r.id));
    if (delErr) {
      falhas += lote.length;
      console.error(`[sac-biblioteca-lixeira] delete falhou (${lote.length} linhas):`, delErr.message);
      continue;
    }
    // 3) o cache de media_id da Meta é por URL (crm_whatsapp_media_cache) — URL morta, cache morto.
    const { error: cacheErr } = await admin.from("crm_whatsapp_media_cache").delete().in("url", lote.map((r) => r.url));
    if (cacheErr) console.error("[sac-biblioteca-lixeira] limpar media cache falhou:", cacheErr.message);
    purgadas += lote.length;
  }

  console.log(`[sac-biblioteca-lixeira] dias=${dias} candidatas=${candidatas.length} purgadas=${purgadas} falhas=${falhas}`);
  return json({ ok: true, dias, candidatas: candidatas.length, purgadas, falhas });
});
