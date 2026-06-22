import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const INTEGRATIONS_URL = Deno.env.get('INTEGRATIONS_URL') || 'http://integrations:3001';

function normalize(a: any) {
  return {
    siga_id:         a.id ? String(a.id) : null,
    status_aluno:    a.status ?? null,
    matricula:       a.matricula ?? null,
    nome:            (a.nome ?? '').toString().trim(),
    cpf:             a.cpf ?? null,
    data_nascimento: a.dataNascimento ?? null,
    celular:         a.celular ?? null,
    telefone:        a.telefone ?? null,
    email:           a.email?.toLowerCase() ?? null,
    turmas:          Array.isArray(a.turmas) ? a.turmas : [],
    raw:             a,
    synced_at:       new Date().toISOString(),
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const startedAt = Date.now();

  const { data: logRow } = await supabase
    .from('siga_alunos_sync_log')
    .insert({
      triggered_by: req.headers.get('x-trigger') || 'manual',
      status: 'running',
    })
    .select()
    .single();

  const logId = logRow?.id;

  try {
    const upstream = await fetch(`${INTEGRATIONS_URL}/siga/alunos-ativos`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    '{}',
    });

    if (!upstream.ok) {
      throw new Error(`Integrations service retornou ${upstream.status}: ${await upstream.text()}`);
    }

    const alunos: any[] = await upstream.json();
    if (!Array.isArray(alunos)) throw new Error('Resposta inesperada: não é um array');

    console.log(`[siga-alunos-ativos] Recebidos ${alunos.length} alunos`);

    const rows = alunos.filter((a) => a.nome).map(normalize);

    // Upsert em lotes de 200
    let upserted = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const batch = rows.slice(i, i + 200);
      const { error } = await supabase
        .from('siga_alunos_cache')
        .upsert(batch, { onConflict: 'siga_id' });
      if (error) throw error;
      upserted += batch.length;
    }

    // Remove alunos que não vieram mais no retorno
    const sigaIds = rows.map((r) => r.siga_id).filter(Boolean);
    const { count: removidosCount } = await supabase
      .from('siga_alunos_cache')
      .delete({ count: 'exact' })
      .not('siga_id', 'in', `(${sigaIds.map((id) => `'${id}'`).join(',')})`);

    const duration = Date.now() - startedAt;

    if (logId) {
      await supabase.from('siga_alunos_sync_log').update({
        status:         'success',
        total_received: alunos.length,
        total_inserted: upserted,
        total_updated:  upserted,
        total_removed:  removidosCount ?? 0,
        duration_ms:    duration,
        finished_at:    new Date().toISOString(),
      }).eq('id', logId);
    }

    return new Response(
      JSON.stringify({
        success:     true,
        total:       alunos.length,
        upserted,
        removed:     removidosCount ?? 0,
        duration_ms: duration,
        fetched_at:  new Date().toISOString(),
        // Mantém compatibilidade: devolve os alunos para o frontend usar imediatamente
        alunos,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[siga-alunos-ativos]', message);
    if (logId) {
      await supabase.from('siga_alunos_sync_log').update({
        status:        'error',
        error_message: message,
        duration_ms:   Date.now() - startedAt,
        finished_at:   new Date().toISOString(),
      }).eq('id', logId);
    }
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
