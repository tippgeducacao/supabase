// siga-sync-titulos
// Recebe POST do n8n com payload { titulos: [...] } (cobranças do Siga em qualquer status)
// e faz upsert em public.siga_titulos_receber. Chave: siga_titulo_id.
// Funciona pra Vencida / Quitada / Aguardando — o campo `situacao` discrimina.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { z } from "https://esm.sh/zod@3.23.8";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-webhook-secret, x-trigger",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const EXPECTED_SECRET = Deno.env.get("SIGA_WEBHOOK_SECRET") ?? "";

const TituloSchema = z
  .object({
    id: z.coerce.number().int(),
    nossoNumero: z.string().nullable().optional(),
    aluno: z.string().min(1),
    alunoId: z.coerce.number().int().nullable().optional(),
    contratoId: z.coerce.number().int().nullable().optional(),
    curso: z.string().nullable().optional(),
    cursoId: z.coerce.number().int().nullable().optional(),
    turma: z.string().nullable().optional(),
    turmaId: z.coerce.number().int().nullable().optional(),
    caixaDestino: z.string().nullable().optional(),
    planoContas: z.string().nullable().optional(),
    descricao: z.string().nullable().optional(),
    vencimento: z.string().nullable().optional(),
    dataPagamento: z.string().nullable().optional(),
    referencia: z.string().nullable().optional(),
    categoria: z.string().nullable().optional(),
    parcela: z.coerce.number().int().nullable().optional(),
    valor: z.coerce.number().default(0),
    multa: z.coerce.number().default(0),
    juros: z.coerce.number().default(0),
    desconto: z.coerce.number().default(0),
    situacao: z.string().nullable().optional(),
    baixadaBanco: z.boolean().nullable().optional(),
  })
  .passthrough();

const PayloadSchema = z.object({
  titulos: z.array(TituloSchema),
});

type ParsedTitulo = z.infer<typeof TituloSchema>;

/** "DD/MM/YYYY" → "YYYY-MM-DD" (ou null). */
function parseBrDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  const [, d, mo, y] = m;
  return `${y}-${mo}-${d}`;
}

function toRow(t: ParsedTitulo) {
  return {
    siga_titulo_id: t.id,
    nosso_numero: t.nossoNumero ?? null,
    siga_aluno_id: t.alunoId ?? null,
    aluno_nome: t.aluno.trim(),
    siga_contrato_id: t.contratoId ?? null,
    siga_curso_id: t.cursoId ?? null,
    curso_nome: t.curso ?? null,
    siga_turma_id: t.turmaId ?? null,
    turma_nome: t.turma ?? null,
    caixa_destino: t.caixaDestino ?? null,
    plano_contas: t.planoContas ?? null,
    descricao: t.descricao ?? null,
    vencimento: parseBrDate(t.vencimento),
    data_pagamento: parseBrDate(t.dataPagamento),
    referencia: t.referencia ?? null,
    categoria: t.categoria ?? null,
    parcela: t.parcela ?? null,
    valor: t.valor ?? 0,
    multa: t.multa ?? 0,
    juros: t.juros ?? 0,
    desconto: t.desconto ?? 0,
    situacao: t.situacao ?? null,
    baixada_banco: t.baixadaBanco ?? false,
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

  const { data: logRow } = await supabase
    .from("siga_sync_log")
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

    // Dedup local por siga_titulo_id (último vence)
    const map = new Map<number, ReturnType<typeof toRow>>();
    for (const t of titulos) map.set(t.id, toRow(t));
    const rows = Array.from(map.values());

    // Upsert em lotes de 200
    const BATCH = 200;
    let upserted = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const { error } = await supabase
        .from("siga_titulos_receber")
        .upsert(batch, { onConflict: "siga_titulo_id", ignoreDuplicates: false });
      if (error) throw error;
      upserted += batch.length;
    }

    const duration = Date.now() - startedAt;
    if (logId) {
      await supabase
        .from("siga_sync_log")
        .update({
          status: "success",
          rows_received: rowsReceived,
          titulos_upserted: upserted,
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
    console.error("[siga-sync-titulos]", message);
    if (logId) {
      await supabase
        .from("siga_sync_log")
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
