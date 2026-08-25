// Recebe POST do n8n com array bruto do endpoint emissao-dinamica-alunos-matriculados
// do Eduq, valida shape, deduplica e upserta em eduq_alunos + eduq_matriculas.
// Regime "estado atual" (Opção A da Fase 2): UPSERT por (eduq_aluno_id, turma)
// sobrescreve a situação anterior. Pré-requisito: data 'Dt Inicio' já normalizada
// pra 'YYYY-MM-DD' pelo Code node do n8n (string dd/mm/yyyy OR serial Excel).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { z } from 'https://esm.sh/zod@3.23.8';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-webhook-secret, x-trigger',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Campos de texto vindos do XLSX podem chegar como NUMBER (celular/CPF sem formatacao na
// celula) - z.string() seco derrubava o lote inteiro (incidente 25/08/2026, docs/Modulo-Eduq.md 5.6).
const RawAlunoEduq = z.object({
  'Id aluno':      z.number().int(),
  'Id pessoa':     z.number().int().nullable().optional(),
  'Aluno(a)':      z.string().min(1),
  'E-mail':        z.union([z.string(), z.number()]).nullable().optional(),
  'CPF':           z.union([z.string(), z.number()]).nullable().optional(),
  'Celular':       z.union([z.string(), z.number()]).nullable().optional(),
  'Endereço':      z.union([z.string(), z.number()]).nullable().optional(),
  'Situação':      z.string().min(1),
  'Dt Inicio':     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  'Turma Montada': z.string().min(1),
}).passthrough();

const Payload = z.object({ alunos: z.array(RawAlunoEduq) });

function normalizeAluno(a: z.infer<typeof RawAlunoEduq>) {
  return {
    eduq_aluno_id:  a['Id aluno'],
    eduq_pessoa_id: a['Id pessoa'] ?? null,
    nome:           a['Aluno(a)'].toString().trim(),
    email:          a['E-mail'] ? a['E-mail'].toString().trim().toLowerCase() : null,
    cpf:            a['CPF']?.toString().trim() || null,
    celular:        a['Celular']?.toString().trim() || null,
    endereco:       a['Endereço']?.toString().trim() || null,
    synced_at:      new Date().toISOString(),
  };
}

function normalizeMatricula(a: z.infer<typeof RawAlunoEduq>) {
  return {
    eduq_aluno_id: a['Id aluno'],
    turma:         a['Turma Montada'].toString().trim(),
    situacao:      a['Situação'].toString().trim(),
    data_inicio:   a['Dt Inicio'] ?? null,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ success: false, error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const expectedSecret = Deno.env.get('EDUQ_WEBHOOK_SECRET');
  const providedSecret = req.headers.get('x-webhook-secret');
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const startedAt = Date.now();
  const triggeredBy = req.headers.get('x-trigger') || 'n8n-webhook';

  const { data: logRow, error: logErr } = await supabase
    .from('eduq_sync_log')
    .insert({ sync_type: 'alunos', triggered_by: triggeredBy, status: 'running' })
    .select()
    .single();
  if (logErr) console.error('[eduq-sync-alunos] não criou sync_log:', logErr.message);
  const logId = logRow?.id;

  try {
    const body = await req.json().catch(() => null);
    const parsed = Payload.safeParse(body);
    if (!parsed.success) {
      throw new Error(`Payload inválido: ${parsed.error.issues.slice(0, 3).map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }

    const rowsReceived = parsed.data.alunos.length;
    console.log(`[eduq-sync-alunos] Recebidos ${rowsReceived} registros (trigger=${triggeredBy})`);

    // Dedup alunos por eduq_aluno_id (várias matrículas do mesmo aluno → 1 linha em eduq_alunos)
    const alunosMap = new Map<number, ReturnType<typeof normalizeAluno>>();
    for (const a of parsed.data.alunos) alunosMap.set(a['Id aluno'], normalizeAluno(a));
    const alunosRows = Array.from(alunosMap.values());

    // Dedup matrículas por (aluno, turma) — fica a última do payload (assume ordem cronológica do Eduq)
    const matMap = new Map<string, ReturnType<typeof normalizeMatricula>>();
    for (const a of parsed.data.alunos) matMap.set(`${a['Id aluno']}|${a['Turma Montada'].trim()}`, normalizeMatricula(a));
    const matriculasRows = Array.from(matMap.values());

    // Upsert alunos PRIMEIRO (FK matriculas → alunos), em lotes de 200
    let alunosUpserted = 0;
    for (let i = 0; i < alunosRows.length; i += 200) {
      const batch = alunosRows.slice(i, i + 200);
      const { error } = await supabase
        .from('eduq_alunos')
        .upsert(batch, { onConflict: 'eduq_aluno_id' });
      if (error) throw new Error(`upsert eduq_alunos: ${error.message}`);
      alunosUpserted += batch.length;
    }

    let matriculasUpserted = 0;
    for (let i = 0; i < matriculasRows.length; i += 200) {
      const batch = matriculasRows.slice(i, i + 200);
      const { error } = await supabase
        .from('eduq_matriculas')
        .upsert(batch, { onConflict: 'eduq_aluno_id,turma' });
      if (error) throw new Error(`upsert eduq_matriculas: ${error.message}`);
      matriculasUpserted += batch.length;
    }

    const durationMs = Date.now() - startedAt;
    if (logId) {
      await supabase.from('eduq_sync_log').update({
        status: 'success',
        rows_received: rowsReceived,
        alunos_upserted: alunosUpserted,
        matriculas_upserted: matriculasUpserted,
        finished_at: new Date().toISOString(),
      }).eq('id', logId);
    }

    return new Response(
      JSON.stringify({
        success: true,
        sync_log_id: logId,
        rows_received: rowsReceived,
        alunos_upserted: alunosUpserted,
        matriculas_upserted: matriculasUpserted,
        duration_ms: durationMs,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[eduq-sync-alunos]', message);
    if (logId) {
      await supabase.from('eduq_sync_log').update({
        status: 'error',
        error_message: message,
        finished_at: new Date().toISOString(),
      }).eq('id', logId);
    }
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
