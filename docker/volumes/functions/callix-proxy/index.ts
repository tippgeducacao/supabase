// Proxy para a API Callix com cache server-side compartilhado.
//
// Por que existe:
//  - A API Callix não envia CORS para chamadas browser. O proxy contorna isso.
//  - O token Callix não pode ir pro frontend. Fica como secret na edge function.
//  - Adiciona uma allowlist de paths para reduzir blast radius caso o JWT vaze.
//  - Mantém cache server-side em `public.callix_cache` — todos os usuários
//    do dashboard compartilham a mesma resposta, evitando explodir o rate
//    limit (1-2 req/min em vários endpoints, POR TOKEN).
//
// Comportamento de cache:
//  - GET no cache. Se entrada existe e está fresca (≤60s), serve cache.
//  - Se stale ou inexistente, vai na Callix.
//    - Sucesso: upsert no cache + retorna fresh.
//    - 429: se temos cache (mesmo stale), serve stale com header
//      `X-Callix-Cache: stale-after-429` e status 200. Senão, repassa o 429.
//    - Outros erros: repassa como veio (sem mexer no cache).
//
// Headers de resposta:
//  - `X-Callix-Cache: hit|miss|stale-after-429` — útil pro frontend e debug.
//  - `X-Callix-Cache-Age` — idade da resposta servida, em segundos.
//
// Como chamar (do frontend):
//   supabase.functions.invoke('callix-proxy', {
//     body: { path: 'users', query: { 'page[limit]': 5000 } }
//   })

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'
import { corsHeaders } from '../_shared/cors.ts'

const CALLIX_BASE_URL = Deno.env.get('CALLIX_BASE_URL') ?? 'https://ppgeducacao.callix.com.br/api/v1'
const CALLIX_TOKEN = Deno.env.get('CALLIX_API_TOKEN') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// TTL do cache "fresco". Acima disso, tentamos refrescar; em 429, devolvemos
// stale do mesmo jeito.
const FRESH_TTL_SECONDS = 60

const ALLOWED_PATHS: RegExp[] = [
  /^teams$/,
  /^teams\/\d+$/,
  /^users$/,
  /^users\/\d+$/,
  /^breaks$/,
  /^breaks\/\d+$/,
  /^qualifications$/,
  /^qualifications\/\d+$/,
  /^call_queues$/,
  /^call_queues\/\d+$/,
  /^ivrs$/,
  /^ivrs\/\d+$/,
  /^user_performance_reports$/,
  /^user_service_status_change_reports$/,
  /^campaign_call_summaries$/,
  /^outgoing_call_summaries$/,
  /^call_summaries$/,
  /^campaign_completed_calls$/,
  /^campaign_missed_calls$/,
  /^outgoing_completed_calls$/,
  /^outgoing_missed_calls$/,
  /^incoming_completed_calls$/,
  /^incoming_missed_calls$/,
  /^campaigns$/,
  /^campaigns\/\d+$/,
]

const isPathAllowed = (path: string): boolean => ALLOWED_PATHS.some(re => re.test(path))

interface ProxyRequest {
  path: string
  query?: Record<string, string | number | boolean | undefined | null>
}

const buildUrl = (path: string, query?: ProxyRequest['query']): string => {
  const url = new URL(`${CALLIX_BASE_URL}/${path}`)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue
      url.searchParams.set(k, String(v))
    }
  }
  return url.toString()
}

// Hash estável dos query params — chave secundária no cache.
// Ordem dos params não importa, valores são serializados como strings.
async function hashQuery(query: ProxyRequest['query']): Promise<string> {
  if (!query) return 'noquery'
  const entries = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => [k, String(v)] as const)
    .sort((a, b) => a[0].localeCompare(b[0]))
  const text = JSON.stringify(entries)
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32)
}

const PASSTHROUGH_RESPONSE_HEADERS = [
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
]

interface CacheEntry {
  response_body: string
  status: number
  content_type: string | null
  fetched_at: string
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
})

async function readCache(path: string, queryHash: string): Promise<CacheEntry | null> {
  const { data, error } = await supabase
    .from('callix_cache')
    .select('response_body, status, content_type, fetched_at')
    .eq('path', path)
    .eq('query_hash', queryHash)
    .maybeSingle()
  if (error) {
    console.error('[callix-proxy] cache read failed', error)
    return null
  }
  return data as CacheEntry | null
}

async function writeCache(
  path: string,
  queryHash: string,
  responseBody: string,
  status: number,
  contentType: string | null,
): Promise<void> {
  const { error } = await supabase
    .from('callix_cache')
    .upsert({
      path,
      query_hash: queryHash,
      response_body: responseBody,
      status,
      content_type: contentType,
      fetched_at: new Date().toISOString(),
    }, { onConflict: 'path,query_hash' })
  if (error) console.error('[callix-proxy] cache write failed', error)
}

const ageSeconds = (fetchedAt: string): number =>
  Math.max(0, Math.floor((Date.now() - new Date(fetchedAt).getTime()) / 1000))

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  if (!CALLIX_TOKEN) {
    return new Response(
      JSON.stringify({ error: 'CALLIX_API_TOKEN not configured on server' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  let body: ProxyRequest
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const path = (body.path ?? '').replace(/^\/+/, '').replace(/\/+$/, '')
  if (!path) {
    return new Response(JSON.stringify({ error: '`path` is required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  if (!isPathAllowed(path)) {
    return new Response(
      JSON.stringify({ error: `Path not allowed: ${path}` }),
      { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  const queryHash = await hashQuery(body.query)
  const cached = await readCache(path, queryHash)

  // 1) Cache fresco? Devolve direto.
  if (cached && cached.status >= 200 && cached.status < 300) {
    const age = ageSeconds(cached.fetched_at)
    if (age <= FRESH_TTL_SECONDS) {
      return new Response(cached.response_body, {
        status: cached.status,
        headers: {
          ...corsHeaders,
          'Content-Type': cached.content_type ?? 'application/vnd.api+json',
          'X-Callix-Cache': 'hit',
          'X-Callix-Cache-Age': String(age),
        },
      })
    }
  }

  // 2) Tenta refrescar.
  const targetUrl = buildUrl(path, body.query)
  let upstream: Response
  try {
    upstream = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${CALLIX_TOKEN}`,
        'Content-Type': 'application/vnd.api+json',
        Accept: 'application/vnd.api+json',
      },
    })
  } catch (err) {
    console.error('[callix-proxy] upstream fetch failed', err)
    // Se temos QUALQUER cache (mesmo stale), servimos.
    if (cached) {
      return new Response(cached.response_body, {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': cached.content_type ?? 'application/vnd.api+json',
          'X-Callix-Cache': 'stale-after-network-error',
          'X-Callix-Cache-Age': String(ageSeconds(cached.fetched_at)),
        },
      })
    }
    return new Response(
      JSON.stringify({ error: 'Failed to reach Callix API', detail: String(err) }),
      { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  const upstreamBody = await upstream.text()
  const upstreamContentType = upstream.headers.get('Content-Type')

  const responseHeaders: Record<string, string> = {
    ...corsHeaders,
    'Content-Type': upstreamContentType ?? 'application/vnd.api+json',
  }
  for (const h of PASSTHROUGH_RESPONSE_HEADERS) {
    const v = upstream.headers.get(h)
    if (v) responseHeaders[h] = v
  }

  // 3) Sucesso: atualiza cache e retorna fresh.
  if (upstream.status >= 200 && upstream.status < 300) {
    await writeCache(path, queryHash, upstreamBody, upstream.status, upstreamContentType)
    responseHeaders['X-Callix-Cache'] = 'miss'
    return new Response(upstreamBody, { status: upstream.status, headers: responseHeaders })
  }

  // 4) 429 (rate limit): se temos cache, serve stale como sucesso.
  if (upstream.status === 429 && cached) {
    console.warn('[callix-proxy] 429 hit, serving stale cache', { path, age: ageSeconds(cached.fetched_at) })
    return new Response(cached.response_body, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': cached.content_type ?? 'application/vnd.api+json',
        'X-Callix-Cache': 'stale-after-429',
        'X-Callix-Cache-Age': String(ageSeconds(cached.fetched_at)),
        // Repassa Retry-After pra UI poder mostrar "próxima atualização real em Ns"
        ...(upstream.headers.get('retry-after') ? { 'retry-after': upstream.headers.get('retry-after')! } : {}),
      },
    })
  }

  // 5) Outros erros: log pra debug + repassa como veio.
  if (upstream.status >= 400) {
    console.error('[callix-proxy] upstream error', {
      path,
      status: upstream.status,
      body: upstreamBody.slice(0, 500),
    })
  }

  return new Response(upstreamBody, { status: upstream.status, headers: responseHeaders })
})
