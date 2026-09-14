import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fronteiras = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), fetch: vi.fn() }))
vi.mock('https://esm.sh/@supabase/supabase-js@2.45.0', () => ({
  createClient: () => ({ from: fronteiras.from, rpc: fronteiras.rpc }),
}))
type Handler = (req: Request) => Promise<Response>
let handler: Handler
type Config = Record<string, unknown> & { id: string }
let configs: Config[]
let eventos: string[]
let updates: Array<{ id: string; valores: Record<string, unknown> }>
let expurgos: Record<string, unknown>[]
let entradas: Record<string, unknown>[]
let falhaRpc: string | null
let renovaAte: number
let aquisicoes: number
const lead = { lead_id: 'lead-ficticio', canon: '1199990001', telefone: '11999990001',
  nome: 'Contato fictício', email: '', formacao: '', curso: 'Reunião', motivo: 'reunião remarcada' }

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: (chave: string) => ({ SUPABASE_URL: 'https://supabase.invalid',
      SUPABASE_SERVICE_ROLE_KEY: 'servico-teste', THREEC_BASE_URL: 'https://threec.invalid/api/v1',
      THREEC_API_TOKEN: 'token-teste' })[chave] },
    serve: (callback: Handler) => { handler = callback },
  })
  vi.stubGlobal('fetch', fronteiras.fetch)
  await import('./index')
})
afterAll(() => vi.unstubAllGlobals())
beforeEach(() => {
  vi.resetAllMocks()
  eventos = []; updates = []; expurgos = []; entradas = []; falhaRpc = null
  renovaAte = Infinity; aquisicoes = 0
  configs = ['primeira', 'segunda'].map(id => ({ id, nome: id, campanha_id: id, lista_id: `lista-${id}`,
    recorte: 'resultado_reuniao', ativo: true, limite_por_rodada: 1000,
    ultimo_expurgo_em: null, ultima_sync_em: null }))
  fronteiras.from.mockImplementation((tabela: string) => {
    if (tabela !== 'threec_mailing_listas') throw new Error(`Tabela inesperada: ${tabela}`)
    return {
      select: () => {
        let candidatas = [...configs]
        const query = {
          eq: (campo: string, valor: unknown) => { candidatas = candidatas.filter(c => c[campo] === valor); return query },
          order: (campo: string) => {
            candidatas.sort((a, b) => String(a[campo] ?? '').localeCompare(String(b[campo] ?? '')))
            return query
          },
          limit: async (n: number) => ({ data: candidatas.slice(0, n), error: null }),
        }
        return query
      },
      update: (valores: Record<string, unknown>) => ({ eq: async (_campo: string, id: string) => {
        updates.push({ id, valores }); Object.assign(configs.find(c => c.id === id)!, valores)
        return { error: null }
      } }),
    }
  })
  fronteiras.rpc.mockImplementation(async (nome: string, args: Record<string, unknown>) => {
    eventos.push(nome)
    if (nome === falhaRpc) return { data: null, error: { message: 'falha simulada' } }
    if (nome === 'threec_mailing_lista_travar') return { data: ++aquisicoes <= renovaAte, error: null }
    if (nome === 'threec_mailing_lista_destravar') return { data: true, error: null }
    if (nome === 'threec_mailing_a_expurgar_lista') return { data: expurgos, error: null }
    if (nome === 'threec_mailing_selecionar_lista') return { data: entradas, error: null }
    if (nome === 'threec_mailing_marcar_removidos') return { data: (args.p_canons as string[]).length, error: null }
    if (nome === 'threec_mailing_marcar_enviados_lista') return { data: (args.p_canons as string[]).length, error: null }
    if (nome === 'threec_mailing_rodada_registrar') return { data: null, error: null }
    throw new Error(`RPC inesperada: ${nome}`)
  })
  fronteiras.fetch.mockImplementation(async (_url: string, init: RequestInit) => {
    eventos.push(String(init.method))
    return init.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ imported_lines: 1 })
  })
})
const chamar = (params: string) => handler(new Request(`https://supabase.invalid/functions/v1/threec-mailing-listas?${params}`, {
  method: 'POST', headers: { Authorization: 'Bearer servico-teste' },
}))
const nomesRpc = () => fronteiras.rpc.mock.calls.map(([nome]) => nome)

describe('manutenção das listas automáticas', () => {
  it('avança a fila mesmo vazia, permitindo que a rodada seguinte alcance outra campanha', async () => {
    await chamar('acao=expurgar'); await chamar('acao=expurgar')
    expect(fronteiras.rpc.mock.calls.filter(([n]) => n === 'threec_mailing_a_expurgar_lista').map(([, a]) => a.p_lista))
      .toEqual(['primeira', 'segunda'])
    expect(configs.every(c => typeof c.ultimo_expurgo_em === 'string')).toBe(true)
    expect(nomesRpc().filter(n => n === 'threec_mailing_rodada_registrar')).toHaveLength(2)
  })

  it('retira e confirma a retirada antes de selecionar e enviar, liberando o mesmo token', async () => {
    expurgos = [lead]; entradas = [lead]
    const resposta = await chamar('acao=manter&recorte=resultado_reuniao')
    expect(await resposta.json()).toMatchObject({ ok: true, expurgo: { marcados: 1 }, sincronizacao: { marcados: 1 } })
    expect(eventos.indexOf('DELETE')).toBeLessThan(eventos.indexOf('threec_mailing_selecionar_lista'))
    expect(eventos.indexOf('threec_mailing_marcar_removidos')).toBeLessThan(eventos.indexOf('POST'))
    const locks = fronteiras.rpc.mock.calls.filter(([n]) => n === 'threec_mailing_lista_travar')
    expect(locks).toHaveLength(3)
    expect(new Set(locks.map(([, args]) => args.p_token)).size).toBe(1)
    expect(locks[0][1].p_segundos).toBe(180)
    expect(fronteiras.rpc).toHaveBeenLastCalledWith('threec_mailing_lista_destravar', {
      p_lista: 'primeira', p_token: locks[0][1].p_token,
    })
  })

  it.each(['rpc', 'delete', 'marcacao'])('falha no expurgo (%s) registra, cede a vez e impede abastecimento', async (falha) => {
    expurgos = [lead]; entradas = [lead]
    if (falha === 'rpc') falhaRpc = 'threec_mailing_a_expurgar_lista'
    if (falha === 'marcacao') falhaRpc = 'threec_mailing_marcar_removidos'
    if (falha === 'delete') fronteiras.fetch.mockResolvedValue(new Response(null, { status: 503 }))
    expect((await chamar('acao=manter')).status).toBeGreaterThanOrEqual(500)
    expect(nomesRpc()).not.toContain('threec_mailing_selecionar_lista')
    expect(eventos).not.toContain('POST')
    expect(configs[0].ultimo_expurgo_em).not.toBeNull()
    expect(nomesRpc()).toContain('threec_mailing_rodada_registrar')
    expect(nomesRpc().at(-1)).toBe('threec_mailing_lista_destravar')
  })

  it.each(['', 'threec_mailing_a_expurgar_lista', 'threec_mailing_selecionar_lista'])(
    'dry não altera fila, histórico ou lease, inclusive com erro %s', async (rpc) => {
    expurgos = [lead]; entradas = [lead]; falhaRpc = rpc || null
    await chamar('acao=manter&dry=1')
    expect(updates).toEqual([])
    expect(fronteiras.fetch).not.toHaveBeenCalled()
    expect(nomesRpc().every(n => ['threec_mailing_a_expurgar_lista', 'threec_mailing_selecionar_lista'].includes(n))).toBe(true)
  })

  it('expurgo vazio em simulação também preserva o próximo item da fila', async () => {
    expect(await (await chamar('acao=expurgar&dry=1')).json()).toMatchObject({ ok: true, dry: true, expurgados: 0 })
    expect(updates).toEqual([])
    expect(nomesRpc()).toEqual(['threec_mailing_a_expurgar_lista'])
  })

  it('combina o recorte com a lista específica e não alcança outra fonte', async () => {
    configs[0].recorte = 'grupo_segmento'
    const resposta = await chamar('acao=manter&recorte=resultado_reuniao&lista=primeira')
    expect(await resposta.json()).toHaveProperty('skip')
    expect(fronteiras.rpc).not.toHaveBeenCalled()
    await chamar('acao=manter&recorte=resultado_reuniao')
    expect(fronteiras.rpc).toHaveBeenCalledWith('threec_mailing_a_expurgar_lista', expect.objectContaining({ p_lista: 'segunda' }))
  })

  it('outra execução com lease impede API e alterações, sem liberar o token alheio', async () => {
    renovaAte = 0; entradas = [lead]
    expect(await (await chamar('acao=manter')).json()).toMatchObject({ skip: 'campanha em processamento' })
    expect(fronteiras.fetch).not.toHaveBeenCalled(); expect(updates).toEqual([])
    expect(nomesRpc()).toEqual(['threec_mailing_lista_travar'])
  })

  it('perder o lease entre lotes interrompe novos DELETEs e preserva a confirmação do primeiro lote', async () => {
    expurgos = Array.from({ length: 101 }, (_, i) => ({ ...lead, canon: `canon-${i}` }))
    entradas = [lead]; renovaAte = 2
    const resposta = await chamar('acao=manter')
    expect(await resposta.json()).toMatchObject({ ok: false, etapa: 'expurgar', expurgo: { marcados: 100 } })
    expect(fronteiras.fetch).toHaveBeenCalledOnce()
    expect(nomesRpc()).not.toContain('threec_mailing_selecionar_lista')
    expect(nomesRpc().at(-1)).toBe('threec_mailing_lista_destravar')
  })

  it('perder o lease entre lotes interrompe novos POSTs e mantém a marcação do lote submetido', async () => {
    entradas = Array.from({ length: 301 }, (_, i) => ({ ...lead, canon: `canon-${i}` }))
    renovaAte = 2
    expect(await (await chamar('acao=sincronizar')).json()).toMatchObject({ ok: false, enviados: 300, marcados: 300 })
    expect(fronteiras.fetch).toHaveBeenCalledOnce()
    expect(nomesRpc().at(-1)).toBe('threec_mailing_lista_destravar')
  })

  it.each(['http', 'json', 'formato', 'pagina seguinte'])('consulta de listas inconclusiva (%s) não cria lista nem envia', async (falha) => {
    configs[0].lista_id = null; entradas = [lead]
    fronteiras.fetch.mockImplementation(async (url: string) => {
      if (falha === 'http') return new Response(null, { status: 500 })
      if (falha === 'json') return new Response('corpo inválido', { status: 200 })
      if (falha === 'formato') return Response.json({ outra_chave: [] })
      return new URL(url).searchParams.get('page') === '1'
        ? Response.json({ data: [{ id: 'antiga' }], meta: { pagination: { total_pages: 2 } } })
        : new Response(null, { status: 500 })
    })
    expect((await chamar('acao=sincronizar&lista=primeira')).status).toBe(502)
    expect(fronteiras.fetch.mock.calls.every(([, init]) => !init.method || init.method === 'GET')).toBe(true)
    expect(configs[0].lista_id).toBeNull()
    expect(nomesRpc()).not.toContain('threec_mailing_marcar_enviados_lista')
  })

  it('adota a lista mais recente de todas as páginas, sem criar outra lista', async () => {
    configs[0].lista_id = null; entradas = [lead]
    fronteiras.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      if (init.method === 'POST') return Response.json({ imported_lines: 1 })
      const pagina = new URL(url).searchParams.get('page')
      return Response.json({ data: [{ id: pagina === '1' ? 'antiga' : 'recente',
        created_at: pagina === '1' ? '2026-09-13T00:00:00Z' : '2026-09-14T00:00:00Z' }],
        meta: { pagination: { total_pages: 2 } } })
    })
    expect((await chamar('acao=sincronizar&lista=primeira')).status).toBe(200)
    expect(configs[0].lista_id).toBe('recente')
    const envios = fronteiras.fetch.mock.calls.filter(([, init]) => init.method === 'POST')
    expect(envios).toHaveLength(1)
    expect(new URL(envios[0][0]).pathname).toBe('/api/v1/campaigns/primeira/lists/recente/mailing')
  })

  it('cria lista apenas após confirmar a coleção vazia', async () => {
    configs[0].lista_id = null; entradas = [lead]
    fronteiras.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      if (!init.method) return Response.json({ data: [] })
      return new URL(url).pathname.endsWith('/mailing')
        ? Response.json({ imported_lines: 1 }) : Response.json({ data: { id: 'nova' } })
    })
    expect((await chamar('acao=sincronizar&lista=primeira')).status).toBe(200)
    expect(configs[0].lista_id).toBe('nova')
    expect(fronteiras.fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/api/v1/campaigns/primeira/lists', '/api/v1/campaigns/primeira/lists', '/api/v1/campaigns/primeira/lists/nova/mailing',
    ])
  })
})
