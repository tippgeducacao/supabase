import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const INTEGRATIONS_URL = Deno.env.get('INTEGRATIONS_URL') || 'http://integrations:3001';
const DATE_RE = /^\d{2}-\d{2}-\d{4}$/;

function parseSigaDate(d: string | null | undefined): string | null {
  if (!d) return null;
  // DD/MM/YYYY
  const br = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  // DD-MM-YYYY
  const dash = d.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (dash) return `${dash[3]}-${dash[2]}-${dash[1]}`;
  return null;
}

function normalize(c: any) {
  return {
    id:            Number(c.id),
    nosso_numero:  c.nossoNumero ?? null,
    aluno:         (c.aluno ?? '').toString().trim(),
    aluno_id:      c.alunoId ?? null,
    contrato_id:   c.contratoId ?? null,
    curso:         c.curso ?? null,
    curso_id:      c.cursoId ?? null,
    turma:         c.turma ?? null,
    turma_id:      c.turmaId ?? null,
    caixa_destino: c.caixaDestino ?? null,
    plano_contas:  c.planoContas ?? null,
    descricao:     c.descricao ?? null,
    vencimento:    parseSigaDate(c.vencimento),
    referencia:    c.referencia ?? null,
    categoria:     c.categoria ?? null,
    parcela:       c.parcela ?? null,
    valor:         Number(c.valor ?? 0),
    multa:         Number(c.multa ?? 0),
    juros:         Number(c.juros ?? 0),
    desconto:      Number(c.desconto ?? 0),
    situacao:      c.situacao ?? null,
    baixada_banco: c.baixadaBanco ?? false,
    raw:           c,
    ultimo_sync_em: new Date().toISOString(),
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ success: false, error: 'Método não permitido' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const startedAt = Date.now();
  const body = await req.json().catch(() => ({}));
  const { dataInicio, dataFim } = body as { dataInicio?: string; dataFim?: string };

  if (!dataInicio || !DATE_RE.test(dataInicio) || !dataFim || !DATE_RE.test(dataFim)) {
    return new Response(
      JSON.stringify({ success: false, error: 'dataInicio e dataFim são obrigatórios no formato DD-MM-YYYY' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  const { data: logRow } = await supabase
    .from('siga_faturas_sync_log')
    .insert({
      triggered_by: req.headers.get('x-trigger') || 'manual',
      data_inicio:  parseSigaDate(dataInicio),
      data_fim:     parseSigaDate(dataFim),
      status:       'running',
    })
    .select()
    .single();

  try {
    const upstream = await fetch(`${INTEGRATIONS_URL}/siga/faturas-vencidas`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ dataInicio, dataFim }),
    });

    if (!upstream.ok) {
      throw new Error(`Integrations service retornou ${upstream.status}: ${await upstream.text()}`);
    }

    const result = await upstream.json();
    const cobrancas: any[] = result.cobrancas ?? [];

    // Upsert em lotes de 200
    let upserted = 0;
    for (let i = 0; i < cobrancas.length; i += 200) {
      const batch = cobrancas.slice(i, i + 200).map(normalize).filter((r) => r.id && r.aluno);
      if (!batch.length) continue;
      const { error } = await supabase
        .from('siga_faturas')
        .upsert(batch, { onConflict: 'id' });
      if (error) throw error;
      upserted += batch.length;
    }

    const duration = Date.now() - startedAt;
    await supabase.from('siga_faturas_sync_log').update({
      status:         'success',
      total_received: cobrancas.length,
      total_inserted: upserted,
      total_updated:  upserted,
      duration_ms:    duration,
      finished_at:    new Date().toISOString(),
    }).eq('id', logRow!.id);

    return new Response(
      JSON.stringify({
        success:    true,
        total:      cobrancas.length,
        upserted,
        periodo:    { dataInicio, dataFim },
        duration_ms: duration,
        fetched_at:  new Date().toISOString(),
        // Mantém compatibilidade: devolve as faturas para o frontend usar imediatamente
        faturas:    cobrancas,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[siga-vencidos]', message);
    await supabase.from('siga_faturas_sync_log').update({
      status:       'error',
      error_message: message,
      duration_ms:  Date.now() - startedAt,
      finished_at:  new Date().toISOString(),
    }).eq('id', logRow!.id);
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
