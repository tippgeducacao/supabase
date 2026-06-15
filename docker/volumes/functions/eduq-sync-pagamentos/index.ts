// Recebe POST do n8n com array já normalizado (campos snake_case) das faturas
// liquidadas do Eduq, valida shape, deduplica e upserta em eduq_pagamentos.
// Schedule: 15 min (cron crítico — conciliação diária da Fabi).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { z } from 'https://esm.sh/zod@3.23.8';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-webhook-secret, x-trigger',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Payload já vem normalizado do Code node do n8n.
const NumericLike = z.union([z.number(), z.string(), z.null()]).optional()
  .transform((v) => {
    if (v === null || v === undefined || v === '') return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  });

const DateLike = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional();

const RawPagamento = z.object({
  eduq_fatura_id: z.number().int(),
  eduq_pessoa_id: z.number().int().nullable().optional(),
  aluno_nome: z.string().min(1),

  categoria: z.string().nullable().optional(),
  categoria_id: z.number().int().nullable().optional(),
  forma_pagamento_descricao: z.string().nullable().optional(),
  forma_pagamento_tipo: z.string().nullable().optional(),
  forma_pagamento_id: z.number().int().nullable().optional(),

  banco_descricao: z.string().nullable().optional(),
  banco_id: z.number().int().nullable().optional(),
  conta_contabil: z.string().nullable().optional(),

  valor: NumericLike,
  valor_liquido: NumericLike,
  total_pago: NumericLike,
  desconto: NumericLike,
  juros: NumericLike,
  multa: NumericLike,

  vencimento: DateLike,
  data_pagamento: DateLike,
  data_geracao: DateLike,

  parcela: z.number().int().nullable().optional(),
  total_parcelas: z.number().int().nullable().optional(),

  link_boleto: z.string().nullable().optional(),
  id_integracao_asaas: z.string().nullable().optional(),
  token_cartao: z.string().nullable().optional(),

  situacao: z.string().nullable().optional(),

  raw: z.any().optional(),
}).passthrough();

const Payload = z.object({ pagamentos: z.array(RawPagamento) });

function toUpsertRow(p: z.infer<typeof RawPagamento>) {
  return {
    eduq_fatura_id: p.eduq_fatura_id,
    eduq_pessoa_id: p.eduq_pessoa_id ?? null,
    aluno_nome: p.aluno_nome.trim(),

    categoria: p.categoria ?? null,
    categoria_id: p.categoria_id ?? null,
    forma_pagamento_descricao: p.forma_pagamento_descricao ?? null,
    forma_pagamento_tipo: p.forma_pagamento_tipo ?? null,
    forma_pagamento_id: p.forma_pagamento_id ?? null,

    banco_descricao: p.banco_descricao ?? null,
    banco_id: p.banco_id ?? null,
    conta_contabil: p.conta_contabil ?? null,

    valor: p.valor,
    valor_liquido: p.valor_liquido,
    total_pago: p.total_pago,
    desconto: p.desconto,
    juros: p.juros,
    multa: p.multa,

    vencimento: p.vencimento ?? null,
    data_pagamento: p.data_pagamento ?? null,
    data_geracao: p.data_geracao ?? null,

    parcela: p.parcela ?? null,
    total_parcelas: p.total_parcelas ?? null,

    link_boleto: p.link_boleto ?? null,
    id_integracao_asaas: p.id_integracao_asaas ?? null,
    token_cartao: p.token_cartao ?? null,

    situacao: p.situacao ?? null,

    raw: p.raw ?? null,
    synced_at: new Date().toISOString(),
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
    .insert({ sync_type: 'pagamentos', triggered_by: triggeredBy, status: 'running' })
    .select()
    .single();
  if (logErr) console.error('[eduq-sync-pagamentos] não criou sync_log:', logErr.message);
  const logId = logRow?.id;

  try {
    const body = await req.json().catch(() => null);
    const parsed = Payload.safeParse(body);
    if (!parsed.success) {
      throw new Error(`Payload inválido: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }

    const rowsReceived = parsed.data.pagamentos.length;
    console.log(`[eduq-sync-pagamentos] Recebidos ${rowsReceived} (trigger=${triggeredBy})`);

    // Dedup por eduq_fatura_id (defensivo — n8n não deveria mandar duplicado, mas garante)
    const map = new Map<number, ReturnType<typeof toUpsertRow>>();
    for (const p of parsed.data.pagamentos) map.set(p.eduq_fatura_id, toUpsertRow(p));
    const rows = Array.from(map.values());

    // Upsert em lotes de 200, preservando colunas de conciliação (não sobrescreve
    // status_conciliacao, confirmado_por, confirmado_em, observacao já gravados).
    const UPDATE_COLS = [
      'eduq_pessoa_id', 'aluno_nome',
      'categoria', 'categoria_id',
      'forma_pagamento_descricao', 'forma_pagamento_tipo', 'forma_pagamento_id',
      'banco_descricao', 'banco_id', 'conta_contabil',
      'valor', 'valor_liquido', 'total_pago', 'desconto', 'juros', 'multa',
      'vencimento', 'data_pagamento', 'data_geracao',
      'parcela', 'total_parcelas',
      'link_boleto', 'id_integracao_asaas', 'token_cartao',
      'situacao', 'raw', 'synced_at',
    ];

    let upserted = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const batch = rows.slice(i, i + 200);
      const { error } = await supabase
        .from('eduq_pagamentos')
        .upsert(batch, {
          onConflict: 'eduq_fatura_id',
          ignoreDuplicates: false,
        });
      if (error) throw new Error(`upsert eduq_pagamentos: ${error.message}`);
      upserted += batch.length;
    }

    const durationMs = Date.now() - startedAt;
    if (logId) {
      await supabase.from('eduq_sync_log').update({
        status: 'success',
        rows_received: rowsReceived,
        matriculas_upserted: upserted, // reaproveitando coluna do log (pagamentos contam aqui)
        finished_at: new Date().toISOString(),
      }).eq('id', logId);
    }

    return new Response(
      JSON.stringify({
        success: true,
        sync_log_id: logId,
        rows_received: rowsReceived,
        pagamentos_upserted: upserted,
        duration_ms: durationMs,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[eduq-sync-pagamentos]', message);
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
