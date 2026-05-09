import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const WEBHOOK_URL =
  "https://auto.ppgeducacao.site/webhook/busca-alunos-ativos-eduq";

interface AlunoRaw {
  sequencial: string | number;
  nome: string;
  email?: string;
  celular?: string;
  cpf?: string;
  endereco?: string;
  situacao?: string;
  dataInicio?: string;
  turma?: string;
}

// "Rua X, Bairro - CIDADE/UF - 12345-678"
function parseEndereco(endereco: string) {
  if (!endereco) return { logradouro_bairro: null, cidade: null, uf: null, cep: null };
  const m = endereco.match(/^(.+?)\s*-\s*(.+?)\/([A-Z]{2})\s*-\s*(\d{5}-?\d{0,3})\s*$/);
  if (!m) return { logradouro_bairro: endereco.trim(), cidade: null, uf: null, cep: null };
  return {
    logradouro_bairro: m[1].trim(),
    cidade: m[2].trim(),
    uf: m[3],
    cep: m[4],
  };
}

// "30/12/2025" → "2025-12-30"
function parseData(d?: string): string | null {
  if (!d) return null;
  const m = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const startedAt = Date.now();
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // 1. Cria log
  const { data: logRow } = await supabase
    .from("alunos_ativos_sync_log")
    .insert({ status: "running", triggered_by: req.headers.get("x-trigger") || "manual" })
    .select()
    .single();

  const logId = logRow?.id;

  try {
    // 2. Chama webhook n8n
    const webhookRes = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    if (!webhookRes.ok) {
      throw new Error(`Webhook retornou ${webhookRes.status}: ${await webhookRes.text()}`);
    }

    const alunos: AlunoRaw[] = await webhookRes.json();
    if (!Array.isArray(alunos)) throw new Error("Webhook não retornou um array");

    console.log(`[sync-alunos-ativos] Recebidos ${alunos.length} alunos`);

    // 3. Normaliza
    const rows = alunos
      .filter((a) => a.sequencial != null && a.nome)
      .map((a) => {
        const end = parseEndereco(a.endereco || "");
        return {
          sequencial: parseInt(String(a.sequencial), 10),
          nome: a.nome.trim(),
          email: a.email?.trim() || null,
          celular: a.celular?.trim() || null,
          cpf: a.cpf?.trim() || null,
          endereco_completo: a.endereco?.trim() || null,
          ...end,
          situacao: a.situacao?.trim() || "Confirmada",
          data_inicio: parseData(a.dataInicio),
          turma: a.turma?.trim() || null,
          raw: a,
          synced_at: new Date().toISOString(),
        };
      });

    // 4. Conta antes / Upsert / Remove os que sumiram
    const { count: countBefore } = await supabase
      .from("alunos_ativos_cache")
      .select("*", { count: "exact", head: true });

    // Upsert em lotes de 200
    let upserted = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const batch = rows.slice(i, i + 200);
      const { error } = await supabase
        .from("alunos_ativos_cache")
        .upsert(batch, { onConflict: "sequencial" });
      if (error) throw error;
      upserted += batch.length;
    }

    // Remove sequenciais que não vieram
    const seqsRecebidos = rows.map((r) => r.sequencial);
    const { count: removidosCount } = await supabase
      .from("alunos_ativos_cache")
      .delete({ count: "exact" })
      .not("sequencial", "in", `(${seqsRecebidos.join(",")})`);

    const { count: countAfter } = await supabase
      .from("alunos_ativos_cache")
      .select("*", { count: "exact", head: true });

    const inserted = Math.max(0, (countAfter || 0) - ((countBefore || 0) - (removidosCount || 0)));
    const updated = upserted - inserted;

    // 5. Finaliza log
    if (logId) {
      await supabase
        .from("alunos_ativos_sync_log")
        .update({
          status: "success",
          finished_at: new Date().toISOString(),
          total_received: alunos.length,
          total_inserted: inserted,
          total_updated: updated,
          total_removed: removidosCount || 0,
          duration_ms: Date.now() - startedAt,
        })
        .eq("id", logId);
    }

    return new Response(
      JSON.stringify({
        success: true,
        received: alunos.length,
        inserted,
        updated,
        removed: removidosCount || 0,
        duration_ms: Date.now() - startedAt,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[sync-alunos-ativos] Erro:", msg);

    if (logId) {
      await supabase
        .from("alunos_ativos_sync_log")
        .update({
          status: "error",
          finished_at: new Date().toISOString(),
          error_message: msg,
          duration_ms: Date.now() - startedAt,
        })
        .eq("id", logId);
    }

    return new Response(JSON.stringify({ success: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
