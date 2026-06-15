// eduq-sync-titulos
// Recebe POST do n8n com payload { titulos: [...] } e faz upsert em public.eduq_titulos_receber.
// Chave de conflito: eduq_fatura_id (UNIQUE). Sync repetido = update idempotente.
// Auth via header x-webhook-secret (mesma var EDUQ_WEBHOOK_SECRET das outras edges).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { z } from "https://esm.sh/zod@3.23.8";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-webhook-secret, x-trigger",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const EXPECTED_SECRET = Deno.env.get("EDUQ_WEBHOOK_SECRET") ?? "";

// Schema flexível — campos opcionais são tolerantes a null/undefined.
// passthrough() permite ao Eduq adicionar campos novos sem quebrar.
const TituloSchema = z
  .object({
    eduq_fatura_id: z.coerce.number().int(),
    aluno_nome: z.string().min(1),
    cpf: z.string().nullable().optional(),
    valor: z.coerce.number().default(0),
    valor_atualizado: z.coerce.number().nullable().optional(),
    vencimento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    data_geracao: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    situacao: z.string().nullable().optional(),
    categoria: z.string().nullable().optional(),
    parcela: z.coerce.number().int().nullable().optional(),
    total_parcelas: z.coerce.number().int().nullable().optional(),
    forma_pagamento_original: z.string().nullable().optional(),
    forma_pagamento_realizada: z.string().nullable().optional(),
  })
  .passthrough();

const PayloadSchema = z.object({
  titulos: z.array(TituloSchema),
});

interface ParsedTitulo extends z.infer<typeof TituloSchema> {}

function toUpsertRow(t: ParsedTitulo) {
  return {
    eduq_fatura_id: t.eduq_fatura_id,
    aluno_nome: t.aluno_nome.trim(),
    cpf: t.cpf ?? null,
    valor: t.valor ?? 0,
    valor_atualizado: t.valor_atualizado ?? null,
    vencimento: t.vencimento,
    data_geracao: t.data_geracao ?? null,
    situacao: t.situacao ?? null,
    categoria: t.categoria ?? null,
    parcela: t.parcela ?? null,
    total_parcelas: t.total_parcelas ?? null,
    forma_pagamento_original: t.forma_pagamento_original ?? null,
    forma_pagamento_realizada: t.forma_pagamento_realizada ?? null,
    raw: t,
    synced_at: new Date().toISOString(),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Auth
  const secret = req.headers.get("x-webhook-secret") ?? "";
  if (!EXPECTED_SECRET || secret !== EXPECTED_SECRET) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const triggeredBy = req.headers.get("x-trigger") ?? "webhook";
  const startedAt = Date.now();

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Log inicial
  const { data: logRow } = await supabase
    .from("eduq_sync_log")
    .insert({ sync_type: "titulos", triggered_by: triggeredBy, status: "running" })
    .select()
    .single();
  const logId = logRow?.id ?? null;

  try {
    const body = await req.json();
    const parsed = PayloadSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(`Payload inválido: ${parsed.error.message}`);
    }

    const titulos = parsed.data.titulos;
    const rowsReceived = titulos.length;

    // Dedup local por eduq_fatura_id (último vence)
    const map = new Map<number, ReturnType<typeof toUpsertRow>>();
    for (const t of titulos) map.set(t.eduq_fatura_id, toUpsertRow(t));
    const rows = Array.from(map.values());

    // Upsert em lotes de 200
    const BATCH = 200;
    let upserted = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const { error } = await supabase
        .from("eduq_titulos_receber")
        .upsert(batch, { onConflict: "eduq_fatura_id", ignoreDuplicates: false });
      if (error) throw error;
      upserted += batch.length;
    }

    const duration = Date.now() - startedAt;
    if (logId) {
      await supabase
        .from("eduq_sync_log")
        .update({
          status: "success",
          rows_received: rowsReceived,
          matriculas_upserted: upserted, // reusa coluna existente do log pra contagem
          finished_at: new Date().toISOString(),
        })
        .eq("id", logId);
    }

    return new Response(
      JSON.stringify({
        success: true,
        sync_log_id: logId,
        rows_received: rowsReceived,
        titulos_upserted: upserted,
        duration_ms: duration,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[eduq-sync-titulos]", message);
    if (logId) {
      await supabase
        .from("eduq_sync_log")
        .update({
          status: "error",
          error_message: message,
          finished_at: new Date().toISOString(),
        })
        .eq("id", logId);
    }
    return new Response(JSON.stringify({ success: false, error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
