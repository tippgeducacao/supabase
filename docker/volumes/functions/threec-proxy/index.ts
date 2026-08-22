// Proxy para a API 3C+ (FluxoTI) com cache server-side compartilhado.
//
// Espelha o callix-proxy, mas com as 3 diferenças do 3C (ver
// src/data/threec-api-docs.ts):
//   • Base URL: https://app.3c.plus/api/v1 (era 3c.fluxoti.com até 22/08/2026)
//   • Auth: query param `?api_token=...` em TODA requisição (NÃO Bearer header).
//           O token fica no secret 3C_TOKEN_API (server-side; nunca no front).
//   • Envelope JSON normal { status, data, meta } — o proxy só repassa, não parseia.
//
// Por que existe:
//   • O browser não pode falar direto com o 3C (CORS + segredo). O proxy contorna.
//   • Allowlist de paths reduz o blast radius caso o JWT anon vaze.
//   • Cache em public.threec_cache (TTL curto, ~15s) protege de rate limit e dá
//     "tempo real" sem martelar a API a cada poll de agente.
//
// Como chamar (do frontend):
//   supabase.functions.invoke('threec-proxy', {
//     body: { path: 'agents/status', query: { start_date: '2026-06-04' } }
//   })

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

// CORS inline (sem depender de ../_shared/cors.ts) — deploy self-hosted via
// docker cp é frágil; manter a função num único arquivo evita boot error por
// dependência relativa ausente.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ⚠️ HOST NOVO desde 22/08/2026: a FluxoTI virou **3C Plus** e aposentou o domínio.
// `fluxoti.com` não resolve mais (sem DNS) e `3c.fluxoti.com`, embora ainda responda
// pelo Cloudflare, devolve o MESMO 404 de nginx em todo path — raiz, /login, /api,
// /health. Não é token nem rede: não há nada servido ali.
// Medido com o token real, de dentro da VPS:
//     3c.fluxoti.com/api/v1/agents/status  -> 404
//     app.3c.plus/api/v1/agents/status     -> 200 OK
// O token continua o mesmo; só o endereço mudou. Parou tudo entre 21h46 e 21h48 BRT
// de 21/08/2026 — Dash Ligação, TV, mailing quente (0 lead no discador) e as listas
// de cobrança, todos de uma vez, porque as quatro functions caem neste default
// (THREEC_BASE_URL não está definida na VPS).
const THREEC_BASE_URL = Deno.env.get('THREEC_BASE_URL') ?? 'https://app.3c.plus/api/v1'
// Token do 3C. O usuário cadastrou o secret com este nome (começa com dígito,
// o que é válido pra Deno.env.get). Aceita aliases por segurança.
const THREEC_TOKEN =
  Deno.env.get('3C_TOKEN_API') ??
  Deno.env.get('THREEC_API_TOKEN') ??
  Deno.env.get('THREEC_TOKEN') ??
  ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// TTL do cache "fresco". Curto pra dar sensação de tempo real, mas o suficiente
// pra evitar martelar a API quando vários clients estão com a tela aberta.
const FRESH_TTL_SECONDS = 15
// Endpoints "ao vivo" do Dash Ligação — cache bem curto (4s) pra reagirem quase
// em tempo real, na mesma cadência das bordas dos cards de agente. Inclui o
// status dos agentes E os 3 endpoints do "Resumo do dia" (Completamento / Pessoa
// Certa / Conversão = statistics/by_agent + calls/total; Ociosidade média =
// status/metrics/total). Mantê-los junto do status evita o painel destoar.
const LIVE_TTL_SECONDS = 4
const LIVE_PATHS = new Set([
  'agents/status',
  'agents/online',
  'agents/status/metrics/total',
  'agents/statistics/by_agent',
  'calls/total',
])
const freshTtlFor = (path: string): number =>
  LIVE_PATHS.has(path) ? LIVE_TTL_SECONDS : FRESH_TTL_SECONDS

const ALLOWED_PATHS: RegExp[] = [
  /^agents$/,
  /^agents\/status$/,
  /^agents\/online$/,
  /^agents\/status\/metrics\/total$/,
  /^agents\/statistics\/by_agent$/,
  /^users$/,
  /^calls$/,
  /^calls\/total$/,
  /^campaigns$/,
  /^campaigns\/\d+$/,
  /^qualifications\/total$/,
]

const isPathAllowed = (path: string): boolean => ALLOWED_PATHS.some((re) => re.test(path))

interface ProxyRequest {
  path: string
  query?: Record<string, string | number | boolean | undefined | null>
}

const buildUrl = (path: string, query?: ProxyRequest['query']): string => {
  const url = new URL(`${THREEC_BASE_URL}/${path}`)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue
      url.searchParams.set(k, String(v))
    }
  }
  // Auth do 3C: api_token em TODA requisição. Não entra no cache hash (constante).
  url.searchParams.set('api_token', THREEC_TOKEN)
  return url.toString()
}

// Hash estável dos query params (SEM o api_token) — chave secundária no cache.
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

const PASSTHROUGH_RESPONSE_HEADERS = ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']

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
    .from('threec_cache')
    .select('response_body, status, content_type, fetched_at')
    .eq('path', path)
    .eq('query_hash', queryHash)
    .maybeSingle()
  if (error) {
    console.error('[threec-proxy] cache read failed', error)
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
    .from('threec_cache')
    .upsert({
      path,
      query_hash: queryHash,
      response_body: responseBody,
      status,
      content_type: contentType,
      fetched_at: new Date().toISOString(),
    }, { onConflict: 'path,query_hash' })
  if (error) console.error('[threec-proxy] cache write failed', error)
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

  if (!THREEC_TOKEN) {
    return new Response(
      JSON.stringify({ error: '3C_TOKEN_API not configured on server' }),
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
    if (age <= freshTtlFor(path)) {
      return new Response(cached.response_body, {
        status: cached.status,
        headers: {
          ...corsHeaders,
          'Content-Type': cached.content_type ?? 'application/json',
          'X-Threec-Cache': 'hit',
          'X-Threec-Cache-Age': String(age),
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
      headers: { Accept: 'application/json' },
    })
  } catch (err) {
    console.error('[threec-proxy] upstream fetch failed', err)
    if (cached) {
      return new Response(cached.response_body, {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': cached.content_type ?? 'application/json',
          'X-Threec-Cache': 'stale-after-network-error',
          'X-Threec-Cache-Age': String(ageSeconds(cached.fetched_at)),
        },
      })
    }
    // 422 (nunca 502/504): o Cloudflare engole 502/504 da origem sem headers CORS.
    return new Response(
      JSON.stringify({ error: 'Failed to reach 3C API', detail: String(err) }),
      { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  const upstreamBody = await upstream.text()
  const upstreamContentType = upstream.headers.get('Content-Type')

  const responseHeaders: Record<string, string> = {
    ...corsHeaders,
    'Content-Type': upstreamContentType ?? 'application/json',
  }
  for (const h of PASSTHROUGH_RESPONSE_HEADERS) {
    const v = upstream.headers.get(h)
    if (v) responseHeaders[h] = v
  }

  // 3) Sucesso: atualiza cache e retorna fresh.
  if (upstream.status >= 200 && upstream.status < 300) {
    await writeCache(path, queryHash, upstreamBody, upstream.status, upstreamContentType)
    responseHeaders['X-Threec-Cache'] = 'miss'
    return new Response(upstreamBody, { status: upstream.status, headers: responseHeaders })
  }

  // 4) 429 (rate limit): se temos cache, serve stale como sucesso.
  if (upstream.status === 429 && cached) {
    console.warn('[threec-proxy] 429 hit, serving stale cache', { path, age: ageSeconds(cached.fetched_at) })
    return new Response(cached.response_body, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': cached.content_type ?? 'application/json',
        'X-Threec-Cache': 'stale-after-429',
        'X-Threec-Cache-Age': String(ageSeconds(cached.fetched_at)),
        ...(upstream.headers.get('retry-after') ? { 'retry-after': upstream.headers.get('retry-after')! } : {}),
      },
    })
  }

  // 5) Outros erros: log + repassa.
  if (upstream.status >= 400) {
    console.error('[threec-proxy] upstream error', { path, status: upstream.status, body: upstreamBody.slice(0, 500) })
  }

  return new Response(upstreamBody, { status: upstream.status, headers: responseHeaders })
})
