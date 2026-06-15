// Round-robin sync worker for Callix API.
//
// Called every 60s by pg_cron. Each invocation syncs ONE resource to respect
// the Callix rate limit of ~1 request/minute. Uses an advisory lock to prevent
// concurrent execution.
//
// Resources are synced in round-robin order based on oldest `last_run` in the
// callix_sync_state table.
//
// Manual invocation:
//   POST { "mode": "reconcile", "days": 7 }  → sync last N days sequentially
//   POST { "mode": "sync" }                   → normal worker cycle (default)
//   POST { "mode": "performance_only" }       → só /user_performance_reports
//                                               do dia (sem lock, sem round-robin)
//   POST { "mode": "status_now" }             → sync síncrono de status + performance
//                                               do dia. Usado pelo botão "Atualizar" do
//                                               dashboard quando o usuário precisa do
//                                               estado atualizado AGORA (no round-robin
//                                               status toca a cada ~8 min — muito devagar
//                                               pra reagir a um agente que voltou online).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'
import { corsHeaders } from '../_shared/cors.ts'

const CALLIX_BASE_URL = Deno.env.get('CALLIX_BASE_URL') ?? 'https://ppgeducacao.callix.com.br/api/v1'
const CALLIX_TOKEN = Deno.env.get('CALLIX_API_TOKEN') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const TENANT_TZ_OFFSET = '-03:00'

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toUtcRange(dateStr: string): string {
  // A Callix interpreta `filter[date]` como date_part(start) ATÉ date_part(end).
  // Se mandamos `${dateStr}T00:00-03:00,${dateStr}T23:59-03:00` (BRT), o `end`
  // em UTC pula pro dia SEGUINTE (ex.: 24/05T23:59-03:00 = 25/05T02:59Z),
  // e a Callix devolve reports de DOIS dias (24/05 + 25/05). Quando o dia
  // alvo está vazio (ex.: domingo), só sobra o dia "errado", e o sync grava
  // dados do dia seguinte como se fossem do dia pedido.
  // Fix: ancorar ambos os bounds NO MESMO dia em UTC. Os reports da Callix
  // têm `attributes.date` como string de data pura, então o filtro fica
  // efetivamente "WHERE date = dateStr".
  const start = `${dateStr}T00:00:00.000Z`
  const end = `${dateStr}T23:59:59.999Z`
  return `${start},${end}`
}

function todayStr(): string {
  // Today in the tenant timezone (BRT = UTC-3)
  const now = new Date()
  const offsetMs = -3 * 60 * 60 * 1000
  const local = new Date(now.getTime() + offsetMs + now.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 10)
}

async function fetchCallix(path: string, query: Record<string, string>): Promise<{ data: any[]; included?: any[] }> {
  const url = new URL(`${CALLIX_BASE_URL}/${path}`)
  for (const [k, v] of Object.entries(query)) {
    if (v) url.searchParams.set(k, v)
  }

  const resp = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${CALLIX_TOKEN}`,
      'Content-Type': 'application/vnd.api+json',
      Accept: 'application/vnd.api+json',
    },
  })

  if (resp.status === 429) {
    const retryAfter = resp.headers.get('retry-after') ?? '60'
    throw new Error(`Rate limit (429). Retry-After: ${retryAfter}s`)
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`Callix ${resp.status}: ${body.slice(0, 500)}`)
  }

  const json = await resp.json()
  const dataArr = Array.isArray(json.data) ? json.data : json.data ? [json.data] : []
  return { data: dataArr, included: json.included }
}

function attr(resource: any, key: string): any {
  return resource?.attributes?.[key]
}

function relId(resource: any, rel: string): string | undefined {
  const r = resource?.relationships?.[rel]
  if (!r || !r.data) return undefined
  if (Array.isArray(r.data)) return r.data[0]?.id
  return r.data.id
}

function buildIncludedMap(included: any[] | undefined): Map<string, any> {
  const map = new Map<string, any>()
  for (const r of included ?? []) map.set(`${r.type}:${r.id}`, r)
  return map
}

// ---------------------------------------------------------------------------
// Status code mapping
// ---------------------------------------------------------------------------

const STATUS_MAP: Record<number, string> = {
  1: 'Disponível',
  2: 'Em pausa',
  3: 'Em chamada',
  4: 'Pós-atendimento',
  5: 'Discagem manual',
  6: 'Offline',
  7: 'Transferência',
  8: 'Preview',
  9: 'Em chamada interna',
}

// ---------------------------------------------------------------------------
// Resource definitions
// ---------------------------------------------------------------------------

interface CallEndpoint {
  path: string
  direction: string
  status: string
  // `include` válido varia POR endpoint na API Callix. Usar relationship
  // que não existe naquele endpoint retorna 400 "is not a valid relationship".
  // Valores apurados na prática + doc oficial:
  //   - incoming_completed_calls: qualification (sem campaign, agent vem como atributo)
  //   - incoming_missed_calls:    nenhum (sem user nem campaign)
  //   - outgoing_completed_calls: qualification
  //   - outgoing_missed_calls:    nenhum
  //   - campaign_completed_calls: qualification, campaign
  //   - campaign_missed_calls:    campaign
  include: string
}

const CALL_ENDPOINTS: Record<string, CallEndpoint> = {
  incoming_completed: { path: 'incoming_completed_calls', direction: 'incoming', status: 'completed', include: 'qualification' },
  incoming_missed:    { path: 'incoming_missed_calls',    direction: 'incoming', status: 'missed',    include: '' },
  outgoing_completed: { path: 'outgoing_completed_calls', direction: 'outgoing', status: 'completed', include: 'qualification' },
  outgoing_missed:    { path: 'outgoing_missed_calls',    direction: 'outgoing', status: 'missed',    include: '' },
  campaign_completed: { path: 'campaign_completed_calls', direction: 'campaign', status: 'completed', include: 'qualification,campaign' },
  campaign_missed:    { path: 'campaign_missed_calls',    direction: 'campaign', status: 'missed',    include: 'campaign' },
}

type ResourceName =
  | 'performance'
  | 'status'
  | 'incoming_completed'
  | 'incoming_missed'
  | 'outgoing_completed'
  | 'outgoing_missed'
  | 'campaign_completed'
  | 'campaign_missed'
  | 'cadastro_users'
  | 'cadastro_teams'
  | 'cadastro_breaks'
  | 'cadastro_qualifications'
  | 'cadastro_campaigns'
  | 'status_history'

// Para cada cadastro: qual endpoint chamar, qual tabela popular, e como
// mapear cada resource JSON:API pra linha.
type CadastroDef = {
  path: string
  table: string
  // Parâmetros extras a passar pro endpoint (ex: filter[is_blocked]=true,false).
  query?: Record<string, string>
  toRow: (r: any) => Record<string, any>
}

const CADASTROS: Record<string, CadastroDef> = {
  cadastro_users: {
    path: 'users',
    table: 'callix_users',
    // Por padrão a Callix oculta is_blocked=true. Forçar trazer todos.
    query: { 'filter[is_blocked]': 'true,false' },
    toRow: (r) => ({
      id: r.id,
      name: attr(r, 'name'),
      login: attr(r, 'login'),
      email: attr(r, 'email'),
      is_blocked: attr(r, 'is_blocked') ?? false,
      team_id: relId(r, 'team'),
      access_profile_id: relId(r, 'access_profile'),
      raw_json: r,
      synced_at: new Date().toISOString(),
    }),
  },
  cadastro_teams: {
    path: 'teams',
    table: 'callix_teams',
    toRow: (r) => ({
      id: r.id,
      name: attr(r, 'name'),
      raw_json: r,
      synced_at: new Date().toISOString(),
    }),
  },
  cadastro_breaks: {
    path: 'breaks',
    table: 'callix_breaks',
    toRow: (r) => ({
      id: r.id,
      name: attr(r, 'name'),
      productive: attr(r, 'productive'),
      raw_json: r,
      synced_at: new Date().toISOString(),
    }),
  },
  cadastro_qualifications: {
    path: 'qualifications',
    table: 'callix_qualifications',
    toRow: (r) => ({
      id: r.id,
      name: attr(r, 'name'),
      positive: attr(r, 'positive'),
      raw_json: r,
      synced_at: new Date().toISOString(),
    }),
  },
  cadastro_campaigns: {
    path: 'campaigns',
    table: 'callix_campaigns',
    toRow: (r) => ({
      id: r.id,
      name: attr(r, 'name'),
      active: attr(r, 'active'),
      raw_json: r,
      synced_at: new Date().toISOString(),
    }),
  },
}

// ---------------------------------------------------------------------------
// Sync functions
// ---------------------------------------------------------------------------

async function syncPerformance(dateStr: string): Promise<number> {
  const range = toUtcRange(dateStr)
  const resp = await fetchCallix('user_performance_reports', {
    'filter[date]': range,
    'page[limit]': '5000',
    include: 'user',
  })

  const idx = buildIncludedMap(resp.included)
  const now = new Date().toISOString()

  // A API Callix pode retornar MAIS DE UMA linha por (user_id, date) — ex:
  // agente entrou na escala em períodos distintos no mesmo dia, ou logou
  // e deslogou várias vezes. Cada linha vem como um relatório separado.
  // Precisamos AGREGAR por callix_user_id antes do upsert, senão o
  // Postgres reclama: "ON CONFLICT DO UPDATE command cannot affect row a
  // second time".
  type PerfRow = {
    report_date: string
    callix_user_id: string
    user_name: string | undefined
    team_id: string | undefined
    login_time: number
    available_time: number
    break_time: number
    in_call_time: number
    acw_time: number
    total_calls: number
    answered_calls: number
    missed_calls: number
    reject_count: number
    outgoing_calls: number
    incoming_calls: number
    campaign_calls: number
    total_time: number
    raw_json: any
    synced_at: string
  }

  const byUser = new Map<string, PerfRow>()

  for (const r of resp.data as any[]) {
    const userId = (relId(r, 'user') ?? r.id) as string
    const userRes = userId ? idx.get(`users:${userId}`) : undefined
    const answered = Number(attr(r, 'answered_count') ?? 0)
    const dropped = Number(attr(r, 'droped_session_count') ?? 0)
    const rejected = Number(attr(r, 'reject_count') ?? 0)

    const existing = byUser.get(userId)
    if (existing) {
      existing.login_time += Number(attr(r, 'login_time') ?? 0)
      existing.available_time += Number(attr(r, 'available_time') ?? 0)
      existing.break_time += Number(attr(r, 'in_break_time') ?? 0)
      existing.in_call_time += Number(attr(r, 'in_call_time') ?? 0)
      existing.acw_time += Number(attr(r, 'after_call_time') ?? 0)
      existing.answered_calls += answered
      existing.missed_calls += dropped
      existing.reject_count += rejected
      existing.total_calls += answered + dropped + rejected
      existing.outgoing_calls += Number(attr(r, 'manual_calls') ?? 0)
      existing.incoming_calls += Number(attr(r, 'inbound_calls') ?? 0)
      existing.campaign_calls += Number(attr(r, 'campaign_calls') ?? 0)
      existing.total_time += Number(attr(r, 'total') ?? 0)
      // Mantém o último raw_json — não acumula JSON pra não inflar.
      existing.raw_json = r
    } else {
      byUser.set(userId, {
        report_date: dateStr,
        callix_user_id: userId,
        user_name: userRes ? attr(userRes, 'name') : attr(r, 'user_name'),
        team_id: userRes ? relId(userRes, 'team') : undefined,
        login_time: Number(attr(r, 'login_time') ?? 0),
        available_time: Number(attr(r, 'available_time') ?? 0),
        break_time: Number(attr(r, 'in_break_time') ?? 0),
        in_call_time: Number(attr(r, 'in_call_time') ?? 0),
        acw_time: Number(attr(r, 'after_call_time') ?? 0),
        total_calls: answered + dropped + rejected,
        answered_calls: answered,
        missed_calls: dropped,
        reject_count: rejected,
        outgoing_calls: Number(attr(r, 'manual_calls') ?? 0),
        incoming_calls: Number(attr(r, 'inbound_calls') ?? 0),
        campaign_calls: Number(attr(r, 'campaign_calls') ?? 0),
        total_time: Number(attr(r, 'total') ?? 0),
        raw_json: r,
        synced_at: now,
      })
    }
  }

  const rows = Array.from(byUser.values())
  if (rows.length === 0) return 0

  const { error } = await supabase
    .from('callix_daily_performance')
    .upsert(rows, { onConflict: 'report_date,callix_user_id' })

  if (error) throw new Error(`DB upsert performance: ${error.message}`)
  return rows.length
}

async function syncStatus(_dateStr: string): Promise<number> {
  const range = toUtcRange(_dateStr)
  // OBS: o endpoint exige `filter[changed_at]` (não `filter[date]`); usar
  // o filtro errado retorna 400 "Missing required filter changed_at".
  const resp = await fetchCallix('user_service_status_change_reports', {
    'filter[changed_at]': range,
    'page[limit]': '5000',
    include: 'user',
  })

  const idx = buildIncludedMap(resp.included)

  // Build latest status per agent
  const latestByAgent = new Map<string, any>()

  for (const r of resp.data) {
    const userId = relId(r, 'user')
    if (!userId) continue

    const changedAt = attr(r, 'changed_at') ?? attr(r, 'created_at') ?? ''
    const existing = latestByAgent.get(userId)

    if (!existing || changedAt > existing.changedAt) {
      const userRes = idx.get(`users:${userId}`)
      const statusCode = Number(attr(r, 'service_status') ?? 6)
      latestByAgent.set(userId, {
        changedAt,
        agent_id: userId,
        agent_name: userRes ? attr(userRes, 'name') : attr(r, 'user_name'),
        team_id: userRes ? relId(userRes, 'team') : undefined,
        status: STATUS_MAP[statusCode] ?? `Desconhecido (${statusCode})`,
        since: changedAt,
        reason: attr(r, 'reason') ?? attr(r, 'break_reason') ?? null,
        updated_at: new Date().toISOString(),
      })
    }
  }

  const rows = Array.from(latestByAgent.values()).map(({ changedAt: _, ...row }) => row)

  if (rows.length === 0) return 0

  const { error } = await supabase
    .from('callix_agent_status')
    .upsert(rows, { onConflict: 'agent_id' })

  if (error) throw new Error(`DB upsert agent_status: ${error.message}`)
  return rows.length
}

async function syncCalls(resource: string, dateStr: string): Promise<number> {
  const ep = CALL_ENDPOINTS[resource]
  if (!ep) throw new Error(`Unknown call resource: ${resource}`)

  const range = toUtcRange(dateStr)
  const query: Record<string, string> = {
    'filter[started_at]': range,
    'page[limit]': '5000',
  }
  if (ep.include) query.include = ep.include
  const resp = await fetchCallix(ep.path, query)

  const idx = buildIncludedMap(resp.included)
  const rows = resp.data.map((r: any) => {
    const userId = relId(r, 'user') ?? relId(r, 'agent')
    const userRes = userId ? idx.get(`users:${userId}`) : undefined
    const qualId = relId(r, 'qualification')
    const qualRes = qualId ? idx.get(`qualifications:${qualId}`) : undefined
    const campId = relId(r, 'campaign')
    const campRes = campId ? idx.get(`campaigns:${campId}`) : undefined

    return {
      report_date: dateStr,
      callix_call_id: r.id,
      direction: ep.direction,
      status: ep.status,
      callix_user_id: userId,
      user_name: userRes ? attr(userRes, 'name') : attr(r, 'user_name'),
      phone: attr(r, 'phone') ?? attr(r, 'caller') ?? attr(r, 'called') ?? attr(r, 'destination_phone') ?? attr(r, 'caller_phone'),
      started_at: attr(r, 'started_at') ?? attr(r, 'created_at'),
      ended_at: attr(r, 'ended_at'),
      duration_seconds: attr(r, 'duration') ?? attr(r, 'call_duration'),
      waiting_seconds: attr(r, 'waiting_time') ?? attr(r, 'wait_time'),
      qualification_id: qualId,
      qualification_name: qualRes ? attr(qualRes, 'name') : undefined,
      campaign_id: campId,
      campaign_name: campRes ? attr(campRes, 'name') : undefined,
      raw_json: r,
      synced_at: new Date().toISOString(),
    }
  })

  if (rows.length === 0) return 0

  const { error } = await supabase
    .from('callix_daily_calls')
    .upsert(rows, { onConflict: 'callix_call_id,direction,status' })

  if (error) throw new Error(`DB upsert ${ep.path}: ${error.message}`)
  return rows.length
}

// ---------------------------------------------------------------------------
// Sync — Cadastros (users/teams/breaks/qualifications/campaigns)
// ---------------------------------------------------------------------------

async function syncCadastro(resource: string): Promise<number> {
  const def = CADASTROS[resource]
  if (!def) throw new Error(`Unknown cadastro resource: ${resource}`)

  const resp = await fetchCallix(def.path, {
    'page[limit]': '5000',
    ...(def.query ?? {}),
  })

  const rows = resp.data.map(def.toRow)
  if (rows.length === 0) return 0

  const { error } = await supabase
    .from(def.table)
    .upsert(rows, { onConflict: 'id' })

  if (error) throw new Error(`DB upsert ${def.table}: ${error.message}`)
  return rows.length
}

// ---------------------------------------------------------------------------
// Sync — Histórico completo de mudanças de status
// ---------------------------------------------------------------------------
// Mantém o histórico das transições (audit trail). A API limita o filtro
// changed_at a janelas de 24h, então puxamos o dia atual.

async function syncStatusHistory(dateStr: string): Promise<number> {
  const range = toUtcRange(dateStr)
  const resp = await fetchCallix('user_service_status_change_reports', {
    'filter[changed_at]': range,
    'page[limit]': '5000',
    include: 'user,break',
    sort: '-changed_at',
  })

  const idx = buildIncludedMap(resp.included)
  const now = new Date().toISOString()

  const rows = resp.data.map((r: any) => {
    const userId = relId(r, 'user')
    const userRes = userId ? idx.get(`users:${userId}`) : undefined
    const breakId = relId(r, 'break')
    const breakRes = breakId ? idx.get(`breaks:${breakId}`) : undefined
    const statusCode = Number(attr(r, 'service_status') ?? 0)
    return {
      id: r.id,
      callix_user_id: userId,
      user_name: userRes ? attr(userRes, 'name') : attr(r, 'user_name'),
      team_id: userRes ? relId(userRes, 'team') : undefined,
      status_code: statusCode,
      status_label: STATUS_MAP[statusCode] ?? null,
      changed_at: attr(r, 'changed_at') ?? attr(r, 'created_at'),
      time_in_status: attr(r, 'time_in_status'),
      reason: attr(r, 'reason') ?? attr(r, 'break_reason') ?? null,
      break_id: breakId,
      break_name: breakRes ? attr(breakRes, 'name') : null,
      raw_json: r,
      synced_at: now,
    }
  })

  if (rows.length === 0) return 0

  const { error } = await supabase
    .from('callix_status_changes')
    .upsert(rows, { onConflict: 'id' })

  if (error) throw new Error(`DB upsert callix_status_changes: ${error.message}`)
  return rows.length
}

// ---------------------------------------------------------------------------
// Resource dispatcher
// ---------------------------------------------------------------------------

async function syncResource(resource: ResourceName, dateStr: string): Promise<number> {
  switch (resource) {
    case 'performance':
      return syncPerformance(dateStr)
    case 'status':
      return syncStatus(dateStr)
    case 'status_history':
      return syncStatusHistory(dateStr)
    case 'cadastro_users':
    case 'cadastro_teams':
    case 'cadastro_breaks':
    case 'cadastro_qualifications':
    case 'cadastro_campaigns':
      return syncCadastro(resource)
    default:
      return syncCalls(resource, dateStr)
  }
}

// ---------------------------------------------------------------------------
// Lock management
// ---------------------------------------------------------------------------

async function acquireLock(): Promise<boolean> {
  const { data, error } = await supabase.rpc('try_callix_sync_lock')
  if (error) {
    console.error('[callix-sync] Failed to acquire lock:', error.message)
    return false
  }
  return data === true
}

async function releaseLock(): Promise<void> {
  const { error } = await supabase.rpc('release_callix_sync_lock')
  if (error) {
    console.error('[callix-sync] Failed to release lock:', error.message)
  }
}

// ---------------------------------------------------------------------------
// Action queue
// ---------------------------------------------------------------------------

interface QueuedAction {
  id: string
  action: string
  payload: Record<string, any> | null
}

async function dequeueAction(): Promise<QueuedAction | null> {
  const { data, error } = await supabase.rpc('dequeue_callix_action')
  if (error) {
    console.error('[callix-sync] dequeue_callix_action error:', error.message)
    return null
  }
  if (!data || (Array.isArray(data) && data.length === 0)) return null
  // RPC may return a single row or an array with one row
  const row = Array.isArray(data) ? data[0] : data
  if (!row?.id) return null
  return { id: row.id, action: row.action, payload: row.payload }
}

async function markActionDone(actionId: string, status: 'done' | 'error', errorMsg?: string): Promise<void> {
  const update: Record<string, any> = {
    status,
    finished_at: new Date().toISOString(),
  }
  if (errorMsg) update.error_message = errorMsg
  await supabase.from('callix_action_queue').update(update).eq('id', actionId)
}

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

async function getNextResource(): Promise<ResourceName | null> {
  const { data, error } = await supabase
    .from('callix_sync_state')
    .select('resource')
    .order('last_run', { ascending: true, nullsFirst: true })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('[callix-sync] Failed to get next resource:', error.message)
    return null
  }
  return data?.resource as ResourceName | null
}

async function updateSyncState(resource: string, success: boolean, errorMsg?: string): Promise<void> {
  const now = new Date().toISOString()
  if (success) {
    await supabase
      .from('callix_sync_state')
      .update({ last_run: now, error_count: 0, last_error: null })
      .eq('resource', resource)
  } else {
    await supabase.rpc('increment_callix_sync_error', {
      p_resource: resource,
      p_error: errorMsg ?? 'Unknown error',
    }).then(({ error }) => {
      // Fallback if RPC doesn't exist
      if (error) {
        supabase
          .from('callix_sync_state')
          .update({
            last_run: now,
            last_error: errorMsg ?? 'Unknown error',
            error_count: supabase.rpc ? undefined : 1,
          })
          .eq('resource', resource)
      }
    })
    // Direct update as fallback
    const { error: updateErr } = await supabase
      .from('callix_sync_state')
      .update({
        last_run: now,
        last_error: errorMsg ?? 'Unknown error',
      })
      .eq('resource', resource)
    if (updateErr) console.error('[callix-sync] updateSyncState error:', updateErr.message)

    // Increment error_count via raw SQL if possible
    await supabase.rpc('increment_sync_error_count', { p_resource: resource }).catch(() => {
      // If RPC doesn't exist, just log
      console.warn('[callix-sync] Could not increment error_count for', resource)
    })
  }
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

async function executeAction(action: QueuedAction): Promise<{ count: number }> {
  const date = todayStr()

  switch (action.action) {
    case 'refresh_performance':
      return { count: await syncPerformance(action.payload?.date ?? date) }

    case 'refresh_status':
      return { count: await syncStatus(action.payload?.date ?? date) }

    case 'refresh_calls':
      // Sync first call endpoint (incoming_completed) or whatever is specified
      return { count: await syncCalls(action.payload?.resource ?? 'incoming_completed', action.payload?.date ?? date) }

    case 'force_sync_date': {
      const targetDate = action.payload?.date ?? date
      let total = 0
      // Sync all resources for the given date
      total += await syncPerformance(targetDate)
      total += await syncStatus(targetDate)
      for (const res of Object.keys(CALL_ENDPOINTS)) {
        total += await syncCalls(res, targetDate)
      }
      return { count: total }
    }

    default:
      throw new Error(`Unknown action: ${action.action}`)
  }
}

// ---------------------------------------------------------------------------
// Reconciliation mode (multi-day backfill)
// ---------------------------------------------------------------------------

async function reconcile(days: number): Promise<Record<string, any>> {
  const results: Record<string, any> = {}
  const today = todayStr()

  // Cadastros são snapshots atuais (não fazem sentido por dia) — uma vez só.
  const cadastrosResult: Record<string, any> = {}
  for (const resource of Object.keys(CADASTROS)) {
    try {
      cadastrosResult[resource] = await syncCadastro(resource)
    } catch (err) {
      cadastrosResult[resource] = { error: err instanceof Error ? err.message : String(err) }
    }
  }
  results.cadastros = cadastrosResult

  for (let i = 0; i < days; i++) {
    const d = new Date(`${today}T12:00:00.000${TENANT_TZ_OFFSET}`)
    d.setDate(d.getDate() - i)
    const dateStr = d.toISOString().slice(0, 10)

    const dayResult: Record<string, any> = {}

    try {
      dayResult.performance = await syncPerformance(dateStr)
    } catch (err) {
      dayResult.performance = { error: err instanceof Error ? err.message : String(err) }
    }

    try {
      dayResult.status = await syncStatus(dateStr)
    } catch (err) {
      dayResult.status = { error: err instanceof Error ? err.message : String(err) }
    }

    try {
      dayResult.status_history = await syncStatusHistory(dateStr)
    } catch (err) {
      dayResult.status_history = { error: err instanceof Error ? err.message : String(err) }
    }

    for (const res of Object.keys(CALL_ENDPOINTS)) {
      try {
        dayResult[res] = await syncCalls(res, dateStr)
      } catch (err) {
        dayResult[res] = { error: err instanceof Error ? err.message : String(err) }
      }
    }

    results[dateStr] = dayResult
  }

  return results
}

// ---------------------------------------------------------------------------
// Worker cycle (normal mode)
// ---------------------------------------------------------------------------

async function workerCycle(): Promise<Record<string, any>> {
  // 1. Acquire advisory lock
  const locked = await acquireLock()
  if (!locked) {
    return { skipped: 'lock held' }
  }

  try {
    const today = todayStr()

    // 1.5 PRIORIDADE: dados de HOJE devem sempre estar frescos.
    // O round-robin sozinho leva ~70 min pra tocar `performance` de novo,
    // o que deixa o `available_time` defasado durante o dia. Forçamos uma
    // sincronização extra de `performance` do dia atual em toda execução.
    // Cabe no rate limit (user_performance_reports = 2/min, executamos a
    // cada 5 min). NÃO atualiza callix_sync_state — o round-robin segue
    // sua lógica normal para reconciliar dias passados.
    let priorityResult: Record<string, any> | undefined
    try {
      const count = await syncPerformance(today)
      priorityResult = { resource: 'performance', date: today, count, priority: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      priorityResult = { resource: 'performance', date: today, error: msg, priority: true }
      console.warn('[callix-sync] priority sync failed:', msg)
    }

    // 2. Check action queue
    const action = await dequeueAction()
    if (action) {
      try {
        const result = await executeAction(action)
        await markActionDone(action.id, 'done')
        return { action: action.action, result, priority: priorityResult }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await markActionDone(action.id, 'error', msg)
        return { action: action.action, error: msg, priority: priorityResult }
      }
    }

    // 3. No action → round-robin: pick resource with oldest last_run
    const resource = await getNextResource()
    if (!resource) {
      return { skipped: 'no resources in callix_sync_state', priority: priorityResult }
    }

    // 4. Sync that resource for today
    const dateStr = todayStr()
    try {
      const count = await syncResource(resource, dateStr)
      // 5. Update state on success
      await updateSyncState(resource, true)
      return { resource, date: dateStr, count, status: 'success', priority: priorityResult }
    } catch (err) {
      // 6. Update state on error
      const msg = err instanceof Error ? err.message : String(err)
      await updateSyncState(resource, false, msg)
      return { resource, date: dateStr, error: msg, status: 'error', priority: priorityResult }
    }
  } finally {
    // 7. Always release lock
    await releaseLock()
  }
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  if (!CALLIX_TOKEN) {
    return new Response(
      JSON.stringify({ error: 'CALLIX_API_TOKEN not configured on server' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  // Parse request body for mode
  let mode = 'sync'
  let days = 7

  if (req.method === 'POST') {
    try {
      const body = await req.json()
      if (body.mode) mode = body.mode
      if (body.days) days = Number(body.days)
    } catch {
      // defaults
    }
  }

  let result: Record<string, any>

  switch (mode) {
    case 'reconcile':
      result = await reconcile(days)
      break

    case 'performance_only': {
      // Cron dedicado: sincroniza só performance do dia, sem advisory lock.
      // Garante que o dashboard fique no máximo ~1 min atrás mesmo se o
      // worker principal estiver bloqueado ou rodando outro recurso.
      const today = todayStr()
      try {
        const count = await syncPerformance(today)
        result = { resource: 'performance', date: today, count, dedicated: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        result = { resource: 'performance', date: today, error: msg, dedicated: true }
      }
      break
    }

    case 'status_now': {
      // Sincroniza status + performance do dia AGORA, em paralelo, sem lock.
      // Usado pelo botão "Atualizar" do dashboard quando o usuário precisa
      // do estado atualizado imediatamente (round-robin é lento demais).
      const today = todayStr()
      const [statusOut, perfOut] = await Promise.allSettled([
        syncStatus(today),
        syncPerformance(today),
      ])
      result = {
        date: today,
        synced_at: new Date().toISOString(),
        status:
          statusOut.status === 'fulfilled'
            ? { count: statusOut.value }
            : { error: statusOut.reason instanceof Error ? statusOut.reason.message : String(statusOut.reason) },
        performance:
          perfOut.status === 'fulfilled'
            ? { count: perfOut.value }
            : { error: perfOut.reason instanceof Error ? perfOut.reason.message : String(perfOut.reason) },
      }
      break
    }

    case 'sync':
    default:
      result = await workerCycle()
      break
  }

  return new Response(
    JSON.stringify({ mode, timestamp: new Date().toISOString(), ...result }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  )
})
