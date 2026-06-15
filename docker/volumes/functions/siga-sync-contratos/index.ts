// siga-sync-contratos
// Recebe POST do n8n com payload { contratos: [...] } e faz upsert em
// public.siga_alunos + public.siga_contratos.
// Chaves de conflito: siga_aluno_id (alunos) e siga_contrato_id (contratos).
// Sync repetido = update idempotente.
// Auth via header x-webhook-secret (mesma var SIGA_WEBHOOK_SECRET).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { z } from "https://esm.sh/zod@3.23.8";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-webhook-secret, x-trigger",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const EXPECTED_SECRET = Deno.env.get("SIGA_WEBHOOK_SECRET") ?? "";

// Schema flexível — campos opcionais tolerantes a null. passthrough() permite
// ao Siga adicionar campos novos sem quebrar o sync.
const TurmaSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    nome: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
  })
  .passthrough();

const ContratoSchema = z
  .object({
    id_contrato: z.coerce.number().int(),
    situacao_contrato: z.string().nullable().optional(),
    situacao_aluno: z.string().nullable().optional(),
    aluno: z
      .object({
        id: z.coerce.number().int(),
        nome: z.string().min(1),
        ultimo_acesso: z.string().nullable().optional(),
        link_portal: z.string().nullable().optional(),
      })
      .passthrough(),
    curso: z
      .object({
        id: z.coerce.number().int().nullable().optional(),
        nome: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    turmas: z.array(TurmaSchema).optional(),
    vigencia: z
      .object({
        inicial: z.string().nullable().optional(),
        final: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    cadastro: z.string().nullable().optional(),
    alterado: z.string().nullable().optional(),
    instituicao: z.string().nullable().optional(),
  })
  .passthrough();

const PayloadSchema = z.object({
  contratos: z.array(ContratoSchema),
});

type ParsedContrato = z.infer<typeof ContratoSchema>;

/** "DD/MM/YYYY" → "YYYY-MM-DD" (ou null se inválido). */
function parseBrDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  const [, d, mo, y] = m;
  return `${y}-${mo}-${d}`;
}

/** "DD/MM/YYYY HH:MM" ou "DD/MM/YYYY HH:MM:SS" → ISO. */
function parseBrDateTime(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [, d, mo, y, hh, mi, ss] = m;
  return `${y}-${mo}-${d}T${hh}:${mi}:${ss ?? "00"}-03:00`;
}

/** Extrai CPF (11 dígitos) do link do portal: .../processar/CPF/HASH */
function extractCpf(link: string | null | undefined): string | null {
  if (!link) return null;
  const m = link.match(/\/processar\/(\d{11})\//);
  return m ? m[1] : null;
}

interface AlunoRow {
  siga_aluno_id: number;
  nome: string;
  cpf: string | null;
  link_portal: string | null;
  ultimo_acesso: string | null;
  synced_at: string;
}

interface ContratoRow {
  siga_contrato_id: number;
  siga_aluno_id: number;
  aluno_nome: string;
  situacao_contrato: string | null;
  situacao_aluno: string | null;
  curso_id: number | null;
  curso_nome: string | null;
  turmas: unknown;
  instituicao: string | null;
  vigencia_inicial: string | null;
  vigencia_final: string | null;
  cadastro_audit: string | null;
  alteracao_audit: string | null;
  raw: ParsedContrato;
  synced_at: string;
}

function toRows(c: ParsedContrato): { aluno: AlunoRow; contrato: ContratoRow } {
  const now = new Date().toISOString();
  const link = c.aluno.link_portal ?? null;
  return {
    aluno: {
      siga_aluno_id: c.aluno.id,
      nome: c.aluno.nome.trim(),
      cpf: extractCpf(link),
      link_portal: link,
      ultimo_acesso: parseBrDateTime(c.aluno.ultimo_acesso),
      synced_at: now,
    },
    contrato: {
      siga_contrato_id: c.id_contrato,
      siga_aluno_id: c.aluno.id,
      aluno_nome: c.aluno.nome.trim(),
      situacao_contrato: c.situacao_contrato ?? null,
      situacao_aluno: c.situacao_aluno ?? null,
      curso_id: c.curso?.id ?? null,
      curso_nome: c.curso?.nome ?? null,
      turmas: c.turmas ?? [],
      instituicao: c.instituicao ?? null,
      vigencia_inicial: parseBrDate(c.vigencia?.inicial),
      vigencia_final: parseBrDate(c.vigencia?.final),
      cadastro_audit: c.cadastro ?? null,
      alteracao_audit: c.alterado ?? null,
      raw: c,
      synced_at: now,
    },
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

  const { data: logRow } = await supabase
    .from("siga_sync_log")
    .insert({ sync_type: "contratos", triggered_by: triggeredBy, status: "running" })
    .select()
    .single();
  const logId = logRow?.id ?? null;

  try {
    const body = await req.json();
    const parsed = PayloadSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(`Payload inválido: ${parsed.error.message}`);
    }

    const contratos = parsed.data.contratos;
    const rowsReceived = contratos.length;

    // Monta rows e dedupa
    const alunosMap = new Map<number, AlunoRow>();
    const contratosMap = new Map<number, ContratoRow>();
    for (const c of contratos) {
      const { aluno, contrato } = toRows(c);
      // último aluno vence (ordem do payload)
      alunosMap.set(aluno.siga_aluno_id, aluno);
      contratosMap.set(contrato.siga_contrato_id, contrato);
    }

    const alunosArr = Array.from(alunosMap.values());
    const contratosArr = Array.from(contratosMap.values());

    // Upsert em lotes
    const BATCH = 200;
    let alunosUpserted = 0;
    let contratosUpserted = 0;

    for (let i = 0; i < alunosArr.length; i += BATCH) {
      const batch = alunosArr.slice(i, i + BATCH);
      const { error } = await supabase
        .from("siga_alunos")
        .upsert(batch, { onConflict: "siga_aluno_id", ignoreDuplicates: false });
      if (error) throw error;
      alunosUpserted += batch.length;
    }

    for (let i = 0; i < contratosArr.length; i += BATCH) {
      const batch = contratosArr.slice(i, i + BATCH);
      const { error } = await supabase
        .from("siga_contratos")
        .upsert(batch, { onConflict: "siga_contrato_id", ignoreDuplicates: false });
      if (error) throw error;
      contratosUpserted += batch.length;
    }

    const duration = Date.now() - startedAt;
    if (logId) {
      await supabase
        .from("siga_sync_log")
        .update({
          status: "success",
          rows_received: rowsReceived,
          alunos_upserted: alunosUpserted,
          contratos_upserted: contratosUpserted,
          finished_at: new Date().toISOString(),
        })
        .eq("id", logId);
    }

    return new Response(
      JSON.stringify({
        success: true,
        sync_log_id: logId,
        rows_received: rowsReceived,
        alunos_upserted: alunosUpserted,
        contratos_upserted: contratosUpserted,
        duration_ms: duration,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[siga-sync-contratos]", message);
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
