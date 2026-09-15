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
let remotas: Record<string, Array<Record<string, unknown>>>
let liberadosTroca: number
let trocaAntesDoLease: boolean
const listaRemota = (id: string, ajustes: Record<string, unknown> = {}) => ({
  id, name: id, weight: 1, total: 5, ...ajustes,
})
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
  liberadosTroca = 0
  trocaAntesDoLease = false
  configs = ['primeira', 'segunda'].map(id => ({ id, nome: id, campanha_id: id, lista_id: `lista-${id}`,
    recorte: 'resultado_reuniao', ativo: true, limite_por_rodada: 1000,
    ultimo_expurgo_em: null, ultima_sync_em: null }))
  remotas = Object.fromEntries(configs.map(c => [String(c.campanha_id), [listaRemota(String(c.lista_id))]]))
  fronteiras.from.mockImplementation((tabela: string) => {
    if (tabela !== 'threec_mailing_listas') throw new Error(`Tabela inesperada: ${tabela}`)
    return {
      select: () => {
        // A leitura de PostgREST entrega cópias: mutar cfg no handler não persiste.
        let candidatas = configs.map(c => ({ ...c }))
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
    if (nome === 'threec_mailing_lista_travar') {
      if (trocaAntesDoLease && aquisicoes === 0) configs[0].lista_id = 'substituida-por-outra-rodada'
      return { data: ++aquisicoes <= renovaAte, error: null }
    }
    if (nome === 'threec_mailing_lista_destravar') return { data: true, error: null }
    if (nome === 'threec_mailing_a_expurgar_lista') return { data: expurgos.slice(0, Number(args.p_limite)), error: null }
    if (nome === 'threec_mailing_selecionar_lista') return { data: entradas, error: null }
    if (nome === 'threec_mailing_marcar_removidos') {
      expurgos = expurgos.filter(e => !(args.p_canons as string[]).includes(String(e.canon)))
      return { data: (args.p_canons as string[]).length, error: null }
    }
    if (nome === 'threec_mailing_lista_substituir') {
      const persistida = configs.find(c => c.id === args.p_lista)!
      if (persistida.lista_id !== args.p_lista_anterior) return { data: null, error: { message: 'configuração alterada' } }
      if (persistida.lista_id === args.p_lista_nova) return { data: 0, error: null }
      persistida.lista_id = args.p_lista_nova
      return { data: liberadosTroca, error: null }
    }
    if (nome === 'threec_mailing_marcar_enviados_lista') return { data: (args.p_canons as string[]).length, error: null }
    if (nome === 'threec_mailing_rodada_registrar') return { data: null, error: null }
    throw new Error(`RPC inesperada: ${nome}`)
  })
  fronteiras.fetch.mockImplementation(async (url: string, init: RequestInit) => {
    eventos.push(String(init.method ?? 'GET'))
    const caminho = new URL(url).pathname
    const campanha = caminho.split('/')[4]
    if (!init.method || init.method === 'GET') return Response.json({ data: remotas[campanha] })
    if (init.method === 'DELETE') return new Response(null, { status: 204 })
    if (caminho.endsWith('/mailing')) return Response.json({ imported_lines: 1 })
    if (init.method === 'POST' && caminho.endsWith('/lists')) {
      const nova = listaRemota(`nova-${campanha}`, { name: JSON.parse(String(init.body)).name, total: 0, weight: 0 })
      remotas[campanha].push(nova)
      return Response.json({ data: nova })
    }
    if (init.method === 'PUT' && caminho.endsWith('/updateWeight')) {
      const lista = remotas[campanha].find(l => l.id === caminho.split('/')[6])!
      lista.weight = JSON.parse(String(init.body)).weight
      return Response.json({ data: lista })
    }
    throw new Error('Chamada 3C inesperada no teste')
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
    expect(locks).toHaveLength(5)
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
    renovaAte = 4
    expect(await (await chamar('acao=sincronizar')).json()).toMatchObject({ ok: false, enviados: 300, marcados: 300 })
    expect(fronteiras.fetch).toHaveBeenCalledTimes(2)
    expect(fronteiras.fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1)
    expect(nomesRpc().at(-1)).toBe('threec_mailing_lista_destravar')
  })

  it.each(['http', 'json', 'formato', 'pagina seguinte'])('consulta de listas inconclusiva (%s) não cria lista nem envia', async (falha) => {
    configs[0].lista_id = null; entradas = [lead]
    fronteiras.fetch.mockImplementation(async (url: string) => {
      if (falha === 'http') return new Response(null, { status: 500 })
      if (falha === 'json') return new Response('corpo inválido', { status: 200 })
      if (falha === 'formato') return Response.json({ outra_chave: [] })
      return new URL(url).searchParams.get('page') === '1'
        ? Response.json({ data: [listaRemota('antiga')], meta: { pagination: { total_pages: 2, current_page: 1 } } })
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
      return Response.json({ data: [listaRemota(pagina === '1' ? 'antiga' : 'recente', {
        created_at: pagina === '1' ? '2026-09-13T00:00:00Z' : '2026-09-14T00:00:00Z' })],
        meta: { pagination: { total_pages: 2, current_page: Number(pagina) } } })
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

  it('recupera o ID apagado e libera seu histórico atomicamente antes de selecionar novamente', async () => {
    remotas.primeira = [listaRemota('manual')]; entradas = [lead]; liberadosTroca = 7
    const resposta = await chamar('acao=sincronizar&lista=primeira')
    expect(resposta.status).toBe(200)
    expect(await resposta.json()).toMatchObject({ lista_id: 'nova-primeira', recuperacao: {
      criada: true, anteriorExcluida: true, liberados_para_reavaliacao: 7,
    } })
    expect(fronteiras.rpc).toHaveBeenCalledWith('threec_mailing_lista_substituir', {
      p_lista: 'primeira', p_token: expect.any(String), p_lista_anterior: 'lista-primeira',
      p_lista_nova: 'nova-primeira', p_anterior_excluida: true,
    })
    expect(eventos.indexOf('threec_mailing_lista_substituir')).toBeLessThan(eventos.indexOf('threec_mailing_selecionar_lista'))
    expect(configs[0].lista_id).toBe('nova-primeira')
    expect(fronteiras.fetch.mock.calls.filter(([url]) => new URL(url).pathname.endsWith('/mailing')))
      .toEqual([[expect.stringContaining('/lists/nova-primeira/mailing'), expect.any(Object)]])
    expect(remotas.primeira.map(l => l.id)).toEqual(['manual', 'nova-primeira'])
  })

  it('não envia sem confirmar a troca no banco e na próxima rodada adota a criação já feita', async () => {
    remotas.primeira = []; entradas = [lead]; falhaRpc = 'threec_mailing_lista_substituir'
    const primeira = await chamar('acao=sincronizar&lista=primeira')
    expect(primeira.status).toBeGreaterThanOrEqual(500)
    expect(await primeira.json()).toMatchObject({ detail: expect.stringContaining('confirmacao local pendente') })
    expect(configs[0].lista_id).toBe('lista-primeira')
    expect(nomesRpc()).not.toContain('threec_mailing_selecionar_lista')
    expect(fronteiras.fetch.mock.calls.some(([url]) => new URL(url).pathname.endsWith('/mailing'))).toBe(false)
    expect(nomesRpc().at(-1)).toBe('threec_mailing_lista_destravar')

    falhaRpc = null
    expect((await chamar('acao=sincronizar&lista=primeira')).status).toBe(200)
    expect(configs[0].lista_id).toBe('nova-primeira')
    expect(fronteiras.fetch.mock.calls.filter(([url, init]) => init.method === 'POST'
      && new URL(url).pathname.endsWith('/lists'))).toHaveLength(1)
    expect(fronteiras.rpc.mock.calls.filter(([nome]) => nome === 'threec_mailing_lista_substituir'))
      .toHaveLength(2)
  })

  it('recupera lista desaparecida mesmo quando não existem contatos novos para entrar', async () => {
    remotas.primeira = []; liberadosTroca = 3
    const resposta = await chamar('acao=sincronizar&lista=primeira')
    expect(resposta.status).toBe(200)
    expect(await resposta.json()).toMatchObject({ enviados: 0, recuperacao: {
      listaId: 'nova-primeira', criada: true, anteriorExcluida: true, liberados_para_reavaliacao: 3,
    } })
    expect(configs[0].lista_id).toBe('nova-primeira')
    expect(eventos.indexOf('threec_mailing_lista_substituir')).toBeLessThan(eventos.indexOf('threec_mailing_selecionar_lista'))
    expect(fronteiras.fetch.mock.calls.some(([url]) => new URL(url).pathname.endsWith('/mailing'))).toBe(false)
  })

  it('expurgo restante bloqueia reativação e abastecimento até concluir a retirada na rodada seguinte', async () => {
    remotas.primeira[0].weight = 0
    expurgos = [lead, { ...lead, canon: 'outro-telefone', telefone: '21999990002' }]
    entradas = [lead]
    const primeira = await chamar('acao=manter&lista=primeira&limite=1')
    expect(primeira.status).toBe(409)
    expect(await primeira.json()).toMatchObject({ ok: false, sincronizacao: { error: 'retirada de contatos ainda pendente' } })
    expect(nomesRpc()).not.toContain('threec_mailing_selecionar_lista')
    expect(fronteiras.fetch.mock.calls.every(([, init]) => init.method === 'DELETE')).toBe(true)
    expect(remotas.primeira[0].weight).toBe(0)

    const segunda = await chamar('acao=manter&lista=primeira&limite=1')
    expect(segunda.status).toBe(200)
    expect(await segunda.json()).toMatchObject({ ok: true, sincronizacao: { recuperacao: { reativada: true } } })
    expect(remotas.primeira[0].weight).toBe(1)
    expect(eventos.lastIndexOf('threec_mailing_marcar_removidos')).toBeLessThan(eventos.indexOf('PUT'))
    expect(eventos.indexOf('PUT')).toBeLessThan(eventos.indexOf('threec_mailing_selecionar_lista'))
  })

  it('confere o ID preservado antes de enviar se outra rodada alterou a configuração entre a leitura e o lease', async () => {
    trocaAntesDoLease = true; entradas = [lead]
    const resposta = await chamar('acao=sincronizar&lista=primeira')
    expect(resposta.status).toBeGreaterThanOrEqual(500)
    expect(await resposta.json()).toMatchObject({ detail: expect.stringContaining('confirmacao local pendente') })
    expect(fronteiras.rpc).toHaveBeenCalledWith('threec_mailing_lista_substituir', expect.objectContaining({
      p_lista_anterior: 'lista-primeira', p_lista_nova: 'lista-primeira', p_anterior_excluida: false,
    }))
    expect(configs[0].lista_id).toBe('substituida-por-outra-rodada')
    expect(nomesRpc()).not.toContain('threec_mailing_selecionar_lista')
    expect(fronteiras.fetch.mock.calls.some(([, init]) => init.method === 'POST')).toBe(false)
  })
})
