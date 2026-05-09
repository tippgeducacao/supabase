import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const WEBHOOK_ABERTAS = 'https://auto.ppgeducacao.site/webhook/eduq-faturas-em-aberto';
const WEBHOOK_LIQUIDADAS = 'https://auto.ppgeducacao.site/webhook/eduq-faturas-liquidadas';

// "01/04/2026" -> "2026-04-01"  | aceita também "yyyy-mm-dd"
function parseBrDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = String(value).trim();
  const br = v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return null;
}

function formatBrDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

async function fetchFaturas(url: string, vencimentoInicio: string, vencimentoFim: string) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vencimentoInicio, vencimentoFim }),
    });
    if (!res.ok) {
      console.warn(`Webhook ${url} ${vencimentoInicio}-${vencimentoFim}: ${res.status}`);
      return [];
    }
    const text = await res.text();
    if (!text || text.trim() === '') return [];
    try {
      const json = JSON.parse(text);
      return Array.isArray(json) ? json : [];
    } catch {
      return [];
    }
  } catch (e) {
    console.warn(`Erro ao buscar ${url} ${vencimentoInicio}-${vencimentoFim}:`, e);
    return [];
  }
}

function normalize(item: any, status: 'em_aberto' | 'liquidada') {
  return {
    id: Number(item.id),
    aluno_id: item.alunoId ?? item.aluno_id ?? null,
    aluno: (item.aluno || item.nome || '').toString().trim(),
    categoria: item.categoria ?? null,
    parcela: item.parcela ?? null,
    valor: Number(item.valor ?? 0),
    valor_atualizado: item.valorAtualizado != null ? Number(item.valorAtualizado) : null,
    total_pago: Number(item.totalPago ?? 0),
    desconto: Number(item.desconto ?? 0),
    juros: Number(item.juros ?? 0),
    multa: Number(item.multa ?? 0),
    vencimento: parseBrDate(item.vencimento),
    vencimento_original: parseBrDate(item.vencimentoOriginal),
    data_pagamento: parseBrDate(item.dataPagamento),
    data_geracao: parseBrDate(item.dataDeGeracao),
    situacao: item.situacao ?? (status === 'liquidada' ? 'Liquidada (Paga)' : 'Em Aberto'),
    status,
    forma_pagamento: item.formaDePagamento ?? item.formaPagamento ?? null,
    conta_bancaria: item.contaBancaria ?? null,
    link_boleto: item.linkBoleto ?? null,
    id_asaas: item.idAsaas ?? null,
    raw: item,
    ultimo_sync_em: new Date().toISOString(),
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  const startedAt = Date.now();
  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }

  // Modo: 'incremental' (padrão) busca janela curta; 'backfill' aceita período arbitrário
  const mode: 'incremental' | 'backfill' = body.mode === 'backfill' ? 'backfill' : 'incremental';
  const hoje = new Date();
  const fim = new Date(hoje); fim.setDate(fim.getDate() + 60);

  // Defaults conforme modo
  let defaultInicio: string;
  if (mode === 'incremental') {
    const ini = new Date(hoje); ini.setDate(ini.getDate() - 90);
    defaultInicio = formatBrDate(ini);
  } else {
    defaultInicio = '01/01/2020';
  }
  const inicioStr = body.vencimentoInicio || defaultInicio;
  const fimStr = body.vencimentoFim || formatBrDate(fim);
  const triggeredBy = body.triggered_by || (mode === 'backfill' ? 'backfill' : 'manual');

  // Quebra o período em janelas de 15 dias (Eduq retorna até 100 por chamada)
  const inicioISO = parseBrDate(inicioStr)!;
  const fimISO = parseBrDate(fimStr)!;
  const janelaDias = Number(body.janela_dias ?? 15);
  const janelas: Array<{ ini: string; fim: string }> = [];
  const cursor = new Date(inicioISO + 'T00:00:00');
  const fimDate = new Date(fimISO + 'T00:00:00');
  while (cursor <= fimDate) {
    const jIni = new Date(cursor);
    const jFim = new Date(cursor);
    jFim.setDate(jFim.getDate() + (janelaDias - 1));
    if (jFim > fimDate) jFim.setTime(fimDate.getTime());
    janelas.push({ ini: formatBrDate(jIni), fim: formatBrDate(jFim) });
    cursor.setDate(cursor.getDate() + janelaDias);
  }

  const { data: logRow } = await supabase
    .from('eduq_faturas_sync_log')
    .insert({
      triggered_by: triggeredBy,
      tipo: 'ambos',
      vencimento_inicio: inicioISO,
      vencimento_fim: fimISO,
      status: 'running',
    })
    .select()
    .single();

  try {
    let totalAbertas = 0, totalLiquidadas = 0;
    let upserted = 0;
    let statusChanged = 0;

    // Processa janela a janela e persiste imediatamente (resiliente a timeout)
    for (const j of janelas) {
      const [abertas, liquidadas] = await Promise.all([
        fetchFaturas(WEBHOOK_ABERTAS, j.ini, j.fim),
        fetchFaturas(WEBHOOK_LIQUIDADAS, j.ini, j.fim),
      ]);
      totalAbertas += abertas.length;
      totalLiquidadas += liquidadas.length;

      const winMap = new Map<number, any>();
      for (const it of abertas) {
        const n = normalize(it, 'em_aberto');
        if (n.id) winMap.set(n.id, n);
      }
      for (const it of liquidadas) {
        const n = normalize(it, 'liquidada'); // liquidada sobrescreve
        if (n.id) winMap.set(n.id, n);
      }
      const winRecords = Array.from(winMap.values()).filter((r) => r.aluno);
      if (!winRecords.length) continue;

      // Detecta mudança de status para essa janela
      const ids = winRecords.map((r) => r.id);
      const { data: existentes } = await supabase
        .from('eduq_faturas')
        .select('id, status')
        .in('id', ids);
      const prev = new Map<number, string>();
      for (const e of existentes ?? []) prev.set((e as any).id, (e as any).status);
      for (const r of winRecords) {
        const old = prev.get(r.id);
        if (old && old !== r.status) statusChanged++;
      }

      // Upsert em lotes da janela
      const batchSize = 200;
      for (let i = 0; i < winRecords.length; i += batchSize) {
        const batch = winRecords.slice(i, i + batchSize);
        const { error } = await supabase
          .from('eduq_faturas')
          .upsert(batch, { onConflict: 'id' });
        if (error) throw error;
        upserted += batch.length;
      }
    }

    const duration = Date.now() - startedAt;
    await supabase.from('eduq_faturas_sync_log').update({
      status: 'success',
      total_recebido_aberto: totalAbertas,
      total_recebido_liquidadas: totalLiquidadas,
      total_inserted: upserted,
      total_updated: upserted,
      total_status_changed: statusChanged,
      duration_ms: duration,
      finished_at: new Date().toISOString(),
    }).eq('id', logRow!.id);

    return new Response(JSON.stringify({
      success: true,
      periodo: { inicio: inicioStr, fim: fimStr },
      janelas: janelas.length,
      abertas_total: totalAbertas,
      liquidadas_total: totalLiquidadas,
      total_unico: upserted,
      status_changed: statusChanged,
      duration_ms: duration,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await supabase.from('eduq_faturas_sync_log').update({
      status: 'error',
      error_message: msg,
      duration_ms: Date.now() - startedAt,
      finished_at: new Date().toISOString(),
    }).eq('id', logRow!.id);
    return new Response(JSON.stringify({ success: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
