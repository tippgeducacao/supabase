// Worker de sincronização 3C+ (FluxoTI) → threec_daily_performance.
//
// Espelha o caminho de "performance" do callix-sync, mas para o 3C:
//   • Auth por query param ?api_token=... (secret 3C_TOKEN_API).
//   • Datas no formato Y-m-d (NÃO ISO-Z — ver threec-api-docs.ts).
//   • Endpoint GET /agents/status/metrics/total (AgentStatusMetrics).
//
// pg_cron chama a cada 60s com {"mode":"sync"} pra manter o dia de hoje fresco.
// O botão "Atualizar" do dashboard chama {"mode":"status_now"} (síncrono).
//
// MAPEAMENTO confirmado no Swagger (3c.json). AgentStatusMetrics traz as métricas
// num SUB-OBJETO `metrics`:
//   metrics.idle (int seg)             → available_time (tempo disponível, HERO)
//   metrics.speaking (STRING mm:ss)    → in_call_time   (toSeconds parse)
//   metrics.acw (int seg)              → acw_time
//   metrics.manual_calls_answered(int) → answered_calls (atendidas, manual mode)
//   metrics.calls (int)                → total_calls / outgoing (discadas)
//   metrics.manual_calls_made (int)    → outgoing_calls
// NÃO existem neste endpoint: missed/reject/incoming/break/login acumulado → 0.
// raw_json guarda a resposta crua pra auditoria.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

// CORS inline (sem depender de ../_shared/cors.ts) — deploy self-hosted via
// docker cp é frágil; manter a função num único arquivo evita boot error por
// dependência relativa ausente.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const THREEC_BASE_URL = Deno.env.get('THREEC_BASE_URL') ?? 'https://3c.fluxoti.com/api/v1'
const THREEC_TOKEN =
  Deno.env.get('3C_TOKEN_API') ??
  Deno.env.get('THREEC_API_TOKEN') ??
  Deno.env.get('THREEC_TOKEN') ??
  ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// Hoje no fuso do tenant (BRT = UTC-3), no formato Y-m-d que o 3C espera.
function todayStr(): string {
  const now = new Date()
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000)
  return brt.toISOString().slice(0, 10)
}

type AnyRec = Record<string, unknown>

// Duração 3C → segundos. Aceita INT (segundos) ou STRING "hh:mm:ss"/"mm:ss".
function toSeconds(v: unknown): number {
  if (v === null || v === undefined) return 0
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : 0
  if (typeof v === 'string') {
    const s = v.trim()
    if (s === '') return 0
    if (/^\d+$/.test(s)) return parseInt(s, 10)
    const parts = s.split(':').map((p) => Number(p))
    if (parts.length && parts.every((n) => Number.isFinite(n))) {
      return parts.reduce((acc, n) => acc * 60 + n, 0)
    }
    const n = Number(s)
    return Number.isFinite(n) ? Math.round(n) : 0
  }
  return 0
}

function num(obj: AnyRec, key: string): number {
  const v = obj?.[key]
  if (v === null || v === undefined) return 0
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

function str(obj: AnyRec, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj?.[k]
    if (v === null || v === undefined) continue
    if (typeof v === 'object') {
      const inner = v as AnyRec
      const id = inner.id ?? inner.name
      if (id !== undefined && id !== null) return String(id)
      continue
    }
    return String(v)
  }
  return null
}

interface SyncResult {
  count: number
  error?: string
}

// Busca AgentStatusMetrics do dia e faz upsert em threec_daily_performance.
async function syncPerformance(dateStr: string): Promise<SyncResult> {
  const url = new URL(`${THREEC_BASE_URL}/agents/status/metrics/total`)
  url.searchParams.set('start_date', dateStr)
  url.searchParams.set('end_date', dateStr)
  url.searchParams.set('api_token', THREEC_TOKEN)

  let resp: Response
  try {
    resp = await fetch(url.toString(), { method: 'GET', headers: { Accept: 'application/json' } })
  } catch (err) {
    return { count: 0, error: `fetch failed: ${String(err)}` }
  }

  const text = await resp.text()
  if (!resp.ok) {
    return { count: 0, error: `3C ${resp.status}: ${text.slice(0, 300)}` }
  }

  let parsed: AnyRec
  try {
    parsed = JSON.parse(text) as AnyRec
  } catch {
    return { count: 0, error: 'invalid JSON from 3C' }
  }

  // Envelope { status, data: [...] } — data pode ser array direto ou aninhado.
  const dataField = (parsed.data ?? parsed) as unknown
  let list: AnyRec[] = []
  if (Array.isArray(dataField)) list = dataField as AnyRec[]
  else if (dataField && typeof dataField === 'object') {
    const d = dataField as AnyRec
    const nested = (d.agents ?? d.data ?? d.metrics) as unknown
    if (Array.isArray(nested)) list = nested as AnyRec[]
    else list = [d]
  }

  if (list.length === 0) return { count: 0 }

  const rows = list.map((a) => {
    const m = (a.metrics ?? {}) as AnyRec
    const threec_agent_id = str(a, ['id', 'agent_id']) ?? str(m, ['_id']) ?? 'unknown'
    const agent_name = str(a, ['name', 'agent_name'])
    return {
      report_date: dateStr,
      threec_agent_id,
      agent_name,
      // durações (segundos) — idle/acw/interval são int; speaking é string mm:ss
      login_time: 0,
      available_time: toSeconds(m.idle ?? a.idle),       // idle = tempo disponível (HERO)
      break_time: toSeconds(m.interval ?? a.interval),   // interval = pausa/intervalo
      in_call_time: toSeconds(m.speaking ?? a.speaking), // speaking = tempo em chamada
      acw_time: toSeconds(m.acw ?? a.acw),
      // chamadas — operação PREDITIVA: "atendidas" = total de chamadas do agente
      // (total_calls), não manual_calls_answered (só o subconjunto manual; subestima).
      total_calls: num(a, 'total_calls') || num(m, 'calls'),
      answered_calls: num(a, 'total_calls') || num(m, 'calls'),
      missed_calls: 0,
      reject_count: 0,
      outgoing_calls: num(m, 'manual_calls_made'),
      incoming_calls: 0,
      raw_json: a,
      synced_at: new Date().toISOString(),
    }
  })

  const { error } = await supabase
    .from('threec_daily_performance')
    .upsert(rows, { onConflict: 'report_date,threec_agent_id' })

  if (error) return { count: 0, error: `upsert failed: ${error.message}` }
  return { count: rows.length }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  if (!THREEC_TOKEN) {
    return new Response(
      JSON.stringify({ error: '3C_TOKEN_API not configured on server' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  let mode = 'sync'
  try {
    const body = await req.json()
    if (body && typeof body.mode === 'string') mode = body.mode
  } catch {
    // sem body → mode default 'sync'
  }

  const dateStr = todayStr()
  const result = await syncPerformance(dateStr)

  const payload = {
    mode,
    date: dateStr,
    perfCount: result.count,
    perfError: result.error ?? null,
  }

  return new Response(JSON.stringify(payload), {
    status: result.error ? 207 : 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
})
