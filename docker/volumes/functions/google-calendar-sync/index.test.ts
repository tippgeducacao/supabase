import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { erroDeTokenDaAgenda } from './erroDeToken'

// 20/10/2026: com `invalid_grant`, o erro só ia para a resposta do cron e
// `calendar_token_error` seguia NULL — ninguém era levado a reconectar. Aqui o Google e o
// banco são falsos: nada sai da máquina.

type Chamada = [string, unknown[]]
type Linha = Record<string, unknown>

const f = vi.hoisted(() => ({
  integracoes: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ id: unknown; patch: Record<string, unknown> }>,
  fetch: vi.fn(),
}))

// PostgREST falso: aplica eq/neq/not-is-null sobre `f.integracoes` e registra os UPDATEs.
function resolver(tabela: string, chamadas: Chamada[]) {
  const nomes = chamadas.map(([n]) => n)
  if (tabela !== 'calendar_integrations') return { data: [], error: null } // cache de eventos
  if (nomes.includes('update')) {
    const patch = chamadas.find(([n]) => n === 'update')![1][0] as Record<string, unknown>
    const id = chamadas.find(([n, a]) => n === 'eq' && a[0] === 'id')?.[1][1]
    f.updates.push({ id, patch })
    return { data: null, error: null }
  }
  let linhas = [...f.integracoes]
  for (const [n, a] of chamadas) {
    const [coluna, valor] = a as [string, unknown]
    if (n === 'eq') linhas = linhas.filter((l) => l[coluna] === valor)
    if (n === 'neq') linhas = linhas.filter((l) => l[coluna] !== valor)
    if (n === 'not') linhas = linhas.filter((l) => l[coluna] != null)
  }
  return nomes.includes('maybeSingle') ? { data: linhas[0] ?? null, error: null } : { data: linhas, error: null }
}

function consulta(tabela: string) {
  const chamadas: Chamada[] = []
  const builder: unknown = new Proxy({}, {
    get(_alvo, prop) {
      if (prop === 'then') {
        const r = resolver(tabela, chamadas)
        return (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) => Promise.resolve(r).then(ok, falha)
      }
      return (...args: unknown[]) => { chamadas.push([String(prop), args]); return builder }
    },
  })
  return builder
}

// Cofre e Auth falsos: só 'segredo-do-cron' passa no calendar_b2b_validar_cron, e só
// 'jwt-de-usuario' é sessão de verdade (a chave anon, por exemplo, não é usuário).
vi.mock('https://esm.sh/@supabase/supabase-js@2.45.0', () => ({
  createClient: () => ({
    from: (tabela: string) => consulta(tabela),
    rpc: async (nome: string, args: Record<string, unknown>) =>
      ({ data: nome === 'calendar_b2b_validar_cron' && args.p_secret === 'segredo-do-cron', error: null }),
    auth: {
      getUser: async (jwt: string) => jwt === 'jwt-de-usuario'
        ? { data: { user: { id: 'usuario-1' } }, error: null }
        : { data: { user: null }, error: { message: 'invalid JWT' } },
    },
  }),
}))

// Google falso: o refresh token decide a resposta do /token; o access token, a dos eventos.
const RESPOSTA_DO_TOKEN: Record<string, () => Response> = {
  'rt-revogado': () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Bad Request' }), { status: 400 }),
  'rt-instavel': () => new Response(JSON.stringify({ error: 'internal_failure' }), { status: 500 }),
  'rt-ok': () => Response.json({ access_token: 'at-ok', expires_in: 3600 }),
  'rt-sem-escopo': () => Response.json({ access_token: 'at-sem-escopo', expires_in: 3600 }),
}
const SEM_ESCOPO = {
  error: {
    code: 403, message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED',
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
  },
}

type Handler = (req: Request) => Promise<Response>
let handler: Handler

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: {
      get: (chave: string) => ({
        GOOGLE_CALENDAR_CLIENT_ID: 'cliente-teste',
        GOOGLE_CALENDAR_CLIENT_SECRET: 'segredo-teste',
        SUPABASE_URL: 'https://supabase.invalid',
        SUPABASE_SERVICE_ROLE_KEY: 'servico-teste',
      })[chave],
    },
    serve: (callback: Handler) => { handler = callback },
  })
  vi.stubGlobal('fetch', f.fetch)
  await import('./index')
})
afterAll(() => vi.unstubAllGlobals())

beforeEach(() => {
  vi.resetAllMocks()
  f.integracoes = []
  f.updates = []
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  f.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      const rt = (init!.body as URLSearchParams).get('refresh_token')!
      if (rt === 'rt-rede') throw new TypeError('fetch failed')
      return RESPOSTA_DO_TOKEN[rt]()
    }
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization
    if (auth === 'Bearer at-sem-escopo') return new Response(JSON.stringify(SEM_ESCOPO), { status: 403 })
    return Response.json({ items: [] })
  })
})

// Agenda "secundária" já conhecida: o sync não tenta descobrir sub-agendas.
const linha = (id: string, refreshToken: string | null, extra: Linha = {}): Linha => ({
  id, external_calendar_id: `${id}@group.calendar.google.com`, oauth_access_token: 'velho',
  oauth_refresh_token: refreshToken, oauth_token_expires_at: '2026-01-01T00:00:00Z',
  account_email: 'conta@exemplo.invalid', owner_user_id: null, scope: 'global', scopes: 'calendar',
  is_primary: false, selected: true, is_active: true, calendar_token_error: null, ...extra,
})

const chamar = (body: Record<string, unknown>, headers: Record<string, string>) =>
  handler(new Request('https://supabase.invalid/functions/v1/google-calendar-sync', {
    method: 'POST', body: JSON.stringify(body), headers,
  }))

// Rodada de sistema (edge irmã com a chave de serviço) — o caminho dos testes de token.
async function sincronizar(body: Record<string, unknown> = {}) {
  const r = await chamar(body, { Authorization: 'Bearer servico-teste' })
  expect(r.status).toBe(200)
  return (await r.json()).results as Array<Record<string, unknown>>
}
const gravacoesDoErro = () => f.updates.filter((u) => 'calendar_token_error' in u.patch)
const chamouGoogle = () => f.fetch.mock.calls.length > 0

describe('google-calendar-sync: quem pode chamar (21/10/2026)', () => {
  it('sem credencial nenhuma: 401 e nada sincroniza', async () => {
    f.integracoes = [linha('a', 'rt-ok')]
    const r = await chamar({}, {})
    expect(r.status).toBe(401)
    expect(chamouGoogle()).toBe(false)
    expect(f.updates).toEqual([])
  })

  it('chave pública (anon) ou token inválido não passam', async () => {
    f.integracoes = [linha('a', 'rt-ok')]
    for (const auth of ['Bearer chave-anon-publica', 'Bearer jwt-vencido', 'servico-teste']) {
      expect((await chamar({}, { Authorization: auth })).status, auth).toBe(401)
    }
    expect(chamouGoogle()).toBe(false)
  })

  it('cron com o segredo do cofre faz a rodada completa; segredo errado não passa', async () => {
    f.integracoes = [linha('a', 'rt-ok'), linha('b', 'rt-ok')]
    expect((await chamar({}, { 'x-calendar-cron': 'chute' })).status).toBe(401)
    const r = await chamar({}, { 'x-calendar-cron': 'segredo-do-cron' })
    expect(r.status).toBe(200)
    expect(((await r.json()).results as unknown[]).length).toBe(2)
  })

  it('usuário logado sincroniza uma agenda, mas não pede a rodada completa', async () => {
    // 'b' é de outra conta: a mesma conta entraria junto, como sub-agenda de 'a'.
    f.integracoes = [linha('a', 'rt-ok'), linha('b', 'rt-ok', { account_email: 'outra@exemplo.invalid' })]
    const tudo = await chamar({}, { Authorization: 'Bearer jwt-de-usuario' })
    expect(tudo.status).toBe(400)
    expect(chamouGoogle()).toBe(false)
    const uma = await chamar({ integration_id: 'a' }, { Authorization: 'Bearer jwt-de-usuario' })
    expect(uma.status).toBe(200)
    expect((await uma.json()).results).toEqual([expect.objectContaining({ integration_id: 'a', ok: true })])
  })
})

describe('google-calendar-sync: erro de token vai para a linha (20/10/2026)', () => {
  it('invalid_grant grava token_revoked em calendar_token_error e diz na resposta', async () => {
    f.integracoes = [linha('a', 'rt-revogado')]
    const [r] = await sincronizar()
    expect(r).toMatchObject({ integration_id: 'a', ok: false, calendar_token_error: 'token_revoked' })
    expect(gravacoesDoErro()).toEqual([{ id: 'a', patch: { calendar_token_error: 'token_revoked' } }])
    expect(f.updates.some((u) => 'last_synced_at' in u.patch)).toBe(false)
  })

  // Cada escrita mexe no updated_at, que o polling da reconexão usa como "autorizou".
  it('não regrava a cada rodada quando a linha já está marcada', async () => {
    f.integracoes = [linha('a', 'rt-revogado', { calendar_token_error: 'token_revoked' })]
    const [r] = await sincronizar()
    expect(r).toMatchObject({ ok: false, calendar_token_error: 'token_revoked' })
    expect(f.updates).toEqual([])
  })

  it('sync que dá certo limpa o erro junto com o last_synced_at', async () => {
    f.integracoes = [linha('b', 'rt-ok', { calendar_token_error: 'token_revoked' })]
    const [r] = await sincronizar()
    expect(r).toMatchObject({ integration_id: 'b', ok: true })
    expect(gravacoesDoErro()).toEqual([
      { id: 'b', patch: { last_synced_at: expect.any(String), calendar_token_error: null } },
    ])
  })

  it('falha transitória (Google 500 ou rede) não marca ninguém', async () => {
    f.integracoes = [linha('c', 'rt-instavel'), linha('d', 'rt-rede')]
    const resultados = await sincronizar()
    expect(resultados).toHaveLength(2)
    for (const r of resultados) {
      expect(r.ok).toBe(false)
      expect(r).not.toHaveProperty('calendar_token_error')
    }
    expect(gravacoesDoErro()).toEqual([])
  })

  it('token que renova mas não tem escopo de Calendar vira scope_insuficiente', async () => {
    f.integracoes = [linha('e', 'rt-sem-escopo')]
    const [r] = await sincronizar()
    expect(r).toMatchObject({ ok: false, calendar_token_error: 'scope_insuficiente' })
    expect(gravacoesDoErro()).toEqual([{ id: 'e', patch: { calendar_token_error: 'scope_insuficiente' } }])
  })

  // O cenário de hoje: agendas revogadas e saudáveis na mesma rodada do cron.
  it('uma agenda revogada não atrapalha as outras da rodada', async () => {
    f.integracoes = [linha('a', 'rt-revogado'), linha('b', 'rt-ok')]
    const resultados = await sincronizar()
    expect(resultados.map((r) => [r.integration_id, r.ok, r.calendar_token_error])).toEqual([
      ['a', false, 'token_revoked'],
      ['b', true, undefined],
    ])
    expect(gravacoesDoErro().map((u) => [u.id, u.patch.calendar_token_error])).toEqual([
      ['a', 'token_revoked'],
      ['b', null],
    ])
  })

  it('sync manual (integration_id) de linha sem refresh token também marca', async () => {
    f.integracoes = [linha('f', null)]
    const [r] = await sincronizar({ integration_id: 'f' })
    expect(r).toMatchObject({ integration_id: 'f', ok: false, calendar_token_error: 'token_revoked' })
    expect(gravacoesDoErro()).toEqual([{ id: 'f', patch: { calendar_token_error: 'token_revoked' } }])
  })
})

describe('erroDeTokenDaAgenda', () => {
  it('reconhece só o que se resolve reconectando a conta', () => {
    expect(erroDeTokenDaAgenda(new Error('no_refresh_token'))).toBe('token_revoked')
    expect(erroDeTokenDaAgenda(new Error('refresh_failed: {"error":"invalid_grant","error_description":"Bad Request"}'))).toBe('token_revoked')
    expect(erroDeTokenDaAgenda(new Error(`events_fetch_failed: ${JSON.stringify(SEM_ESCOPO)}`))).toBe('scope_insuficiente')
  })

  it('transitório, credencial do app e erro de agenda NÃO são erro de token', () => {
    for (const msg of [
      'refresh_failed: {"error":"internal_failure"}',
      'refresh_failed: {"error":"invalid_client","error_description":"Unauthorized"}',
      'events_fetch_failed: {"error":{"code":404,"message":"Not Found"}}',
      'events_fetch_failed: {"error":{"code":429,"message":"Rate Limit Exceeded"}}',
      'fetch failed',
    ]) {
      expect(erroDeTokenDaAgenda(new Error(msg)), msg).toBeNull()
    }
    expect(erroDeTokenDaAgenda(undefined)).toBeNull()
    expect(erroDeTokenDaAgenda('invalid_grant')).toBeNull()
  })
})
