import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fronteiras = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), fetch: vi.fn(), bloqueios: vi.fn() }))
vi.mock('https://esm.sh/@supabase/supabase-js@2.45.0', () => ({
  createClient: () => ({ from: fronteiras.from, rpc: fronteiras.rpc }),
}))
vi.mock('./bloqueios.ts', () => ({ atualizarBloqueios3C: fronteiras.bloqueios }))
type Handler = (req: Request) => Promise<Response>
let handler: Handler
const loteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const lead = { lead_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', canon: '1199990001', telefone: '11999990001',
  nome: '  João\u200B  Ávila ', email: '', formacao: '', curso: 'SANIDADE AVÍCOLA', criado_em: '2020-01-01T00:00:00Z' }
let linhas: typeof lead[]
let expurgo: Array<typeof lead & { motivo: string }>
let eventos: string[]
let preparado: boolean
let ocupado: boolean
let falhaConfirmar: boolean
let ativo: boolean
let itensPreparados: number

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
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
beforeEach(() => {
  vi.resetAllMocks()
  linhas = [lead, { ...lead, lead_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', canon: '2199990002', telefone: '21999990002' }]
  expurgo = []
  eventos = []
  preparado = false; ocupado = false; falhaConfirmar = false; ativo = true; itensPreparados = 0
  fronteiras.bloqueios.mockImplementation(async () => { eventos.push('bloqueios'); return { ok: true } })
  fronteiras.from.mockReturnValue({ select: () => ({ maybeSingle: async () => ({ data: {
    campanha_id: '272970', lista_quente_id: 'quente', lista_base_id: 'base', ativo, limite_por_rodada: 300,
  }, error: null }) }) })
  fronteiras.rpc.mockImplementation(async (nome: string, args: Record<string, unknown>) => {
    eventos.push(nome)
    if (nome === 'threec_sdr_travar') return { data: !ocupado && !preparado, error: null }
    if (nome === 'threec_sdr_destravar') return { data: true, error: null }
    if (nome === 'threec_mailing_selecionar') return { data: linhas, error: null }
    if (nome === 'threec_mailing_a_expurgar') return { data: expurgo, error: null }
    if (nome === 'threec_mailing_marcar_removidos') return { data: (args.p_canons as string[]).length, error: null }
    if (nome === 'threec_sdr_lote_iniciar') {
      preparado = true; itensPreparados = (args.p_itens as unknown[]).length
      return { data: loteId, error: null }
    }
    if (nome === 'threec_sdr_lote_confirmar') {
      if (falhaConfirmar) return { data: null, error: { message: 'banco indisponível' } }
      preparado = false
      return { data: itensPreparados, error: null }
    }
    if (nome === 'threec_sdr_lote_recusar') { preparado = false; return { data: true, error: null } }
    throw new Error(`RPC inesperada: ${nome}`)
  })
  fronteiras.fetch.mockImplementation(async (_url: string, init: RequestInit) => {
    eventos.push(init.method!)
    return init.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ imported_lines: 1 })
  })
})
const chamar = (query = '') => handler(new Request(`https://supabase.invalid/functions/v1/threec-mailing-sync${query}`, {
  method: 'POST', headers: { Authorization: 'Bearer servico-teste' },
}))
const rpcChamadas = (nome: string) => fronteiras.rpc.mock.calls.filter(([n]) => n === nome)

describe('manutenção da Novo Lead SDR', () => {
  it('remove e confirma a remoção antes de selecionar e adicionar sob um único lease', async () => {
    expurgo = [{ ...lead, motivo: 'arquivado em cadastro com mesmo telefone' }]
    const r = await chamar('?acao=manter')
    expect(r.status).toBe(200)
    expect(eventos).toEqual(['threec_sdr_travar', 'bloqueios', 'threec_mailing_a_expurgar', 'DELETE',
      'threec_mailing_marcar_removidos', 'threec_mailing_selecionar', 'threec_sdr_lote_iniciar', 'POST',
      'threec_sdr_lote_confirmar', 'threec_sdr_destravar'])
    expect(rpcChamadas('threec_mailing_marcar_removidos')[0][1]).toMatchObject({ p_campanha_id: '272970', p_canons: [lead.canon] })
  })

  it('suspende a entrada quando não consegue atualizar os bloqueios explícitos do 3C', async () => {
    fronteiras.bloqueios.mockRejectedValue(new Error('falha sanitizada'))
    expect((await chamar('?acao=manter')).status).toBe(502)
    expect(fronteiras.fetch).not.toHaveBeenCalled()
    expect(rpcChamadas('threec_mailing_selecionar')).toHaveLength(0)
    expect(rpcChamadas('threec_sdr_destravar')).toHaveLength(1)
  })

  it('não marca nem alimenta quando o DELETE falha', async () => {
    expurgo = [{ ...lead, motivo: 'bloqueado' }]
    fronteiras.fetch.mockResolvedValue(new Response('falha', { status: 503 }))
    expect((await chamar('?acao=manter')).status).toBe(502)
    expect(rpcChamadas('threec_mailing_marcar_removidos')).toHaveLength(0)
    expect(rpcChamadas('threec_mailing_selecionar')).toHaveLength(0)
    expect(rpcChamadas('threec_sdr_destravar')).toHaveLength(1)
  })

  it('recusa concorrência sem chamar o 3C nem liberar lease de outra execução', async () => {
    ocupado = true
    const r = await chamar()
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ ocupado: true })
    expect(fronteiras.fetch).not.toHaveBeenCalled()
    expect(rpcChamadas('threec_sdr_destravar')).toHaveLength(0)
  })

  it('mantém lote durável e bloqueia a rodada seguinte se a marcação falhar após o POST', async () => {
    falhaConfirmar = true
    const r = await chamar()
    expect(r.status).toBe(500)
    expect(await r.json()).toMatchObject({ submetidos_confirmados: 2, marcados: 0, retry_bloqueado: true, lote_id: loteId })
    expect(preparado).toBe(true)
    expect((await chamar()).status).toBe(409)
    expect(fronteiras.fetch).toHaveBeenCalledOnce()
    expect(rpcChamadas('threec_sdr_lote_confirmar')).toHaveLength(1)
  })

  it('conta submissões e importação parcial sem atribuir o descarte a duplicidade', async () => {
    const r = await chamar()
    const body = await r.json()
    expect(body).toMatchObject({ ok: true, submetidos_confirmados: 2, enviados: 2, marcados: 2, imported_lines: 1, descartados_agregados: 1 })
    expect(body).not.toHaveProperty('descartados_duplicata_campanha')
    expect(rpcChamadas('threec_sdr_lote_confirmar')[0][1]).toMatchObject({ p_lote_id: loteId, p_importados: 1 })
    const payload = JSON.parse(fronteiras.fetch.mock.calls[0][1].body).mailing[0]
    expect(payload.data.nome).toBe('João Ávila')
    expect(payload.identifier).toBe('João Ávila - Sanidade Avícola')
  })

  it('mantém importação desconhecida como null quando o JSON não informa imported_lines', async () => {
    fronteiras.fetch.mockResolvedValue(Response.json({ status: 200 }))
    const body = await (await chamar()).json()
    expect(body).toMatchObject({ ok: true, submetidos_confirmados: 2, marcados: 2, imported_lines: null, descartados_agregados: null })
    expect(rpcChamadas('threec_sdr_lote_confirmar')[0][1].p_importados).toBeNull()
  })

  it.each([['5xx', () => new Response('falha', { status: 503 })],
    ['2xx sem JSON', () => new Response('resposta inesperada')],
    ['contagem impossível', () => Response.json({ imported_lines: 900 })]] as const)('preserva pendência em %s', async (_nome, resposta) => {
    fronteiras.fetch.mockImplementation(async () => resposta())
    const r = await chamar()
    expect(r.status).toBe(502)
    expect(await r.json()).toMatchObject({ retry_bloqueado: true, lote_id: loteId })
    expect(preparado).toBe(true)
    expect(rpcChamadas('threec_sdr_lote_confirmar')).toHaveLength(0)
    expect(rpcChamadas('threec_sdr_lote_recusar')).toHaveLength(0)
  })

  it('libera a pendência somente quando o 3C recusa explicitamente com 4xx', async () => {
    fronteiras.fetch.mockResolvedValue(new Response('inválido', { status: 422 }))
    expect((await chamar()).status).toBe(422)
    expect(preparado).toBe(false)
    expect(rpcChamadas('threec_sdr_lote_recusar')[0][1]).toMatchObject({ p_lote_id: loteId, p_detalhe: 'HTTP 422' })
  })

  it('aborta transporte aos 20 segundos e preserva lote para reconciliação', async () => {
    vi.useFakeTimers()
    fronteiras.fetch.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('URL privada que não deve aparecer')), { once: true })
    }))
    const pending = chamar()
    await vi.advanceTimersByTimeAsync(20_001)
    const body = await (await pending).json()
    expect(body).toMatchObject({ ok: false, retry_bloqueado: true })
    expect(JSON.stringify(body)).not.toContain('URL privada')
    expect(preparado).toBe(true)
  })

  it('simula manter sem lease, lotes duráveis ou chamadas externas', async () => {
    const r = await chamar('?acao=manter&dry=1')
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ dry: true, expurgo: { dry: true } })
    expect(eventos).toEqual(['threec_mailing_a_expurgar', 'threec_mailing_selecionar'])
    expect(fronteiras.fetch).not.toHaveBeenCalled()
  })

  it('expurga mesmo com entrada pausada e não envia contatos', async () => {
    ativo = false; expurgo = [{ ...lead, motivo: 'aluno' }]
    expect((await chamar('?acao=manter')).status).toBe(200)
    expect(fronteiras.fetch).toHaveBeenCalledOnce()
    expect(fronteiras.fetch.mock.calls[0][1].method).toBe('DELETE')
    expect(rpcChamadas('threec_mailing_selecionar')).toHaveLength(0)
  })

  it('limita toda a rodada a 300 e preserva o fallback de nome', async () => {
    linhas = Array.from({ length: 601 }, () => ({ ...lead, nome: ' \u200B ' }))
    const r = await chamar('?lista=base&limite=900')
    expect(r.status).toBe(200)
    expect(rpcChamadas('threec_mailing_selecionar')[0][1].p_limite).toBe(300)
    expect(fronteiras.fetch).toHaveBeenCalledOnce()
    const corpo = JSON.parse(fronteiras.fetch.mock.calls[0][1].body)
    expect(corpo.mailing).toHaveLength(300)
    expect(corpo.mailing[0].data.nome).toBe('Lead')
    expect(new URL(fronteiras.fetch.mock.calls[0][0]).pathname).toContain('/lists/base/')
  })

  it('encerra com contagens zero quando não há elegíveis', async () => {
    linhas = []
    expect(await (await chamar()).json()).toMatchObject({ ok: true, submetidos_confirmados: 0, imported_lines: 0, marcados: 0 })
    expect(rpcChamadas('threec_sdr_lote_iniciar')).toHaveLength(0)
    expect(fronteiras.fetch).not.toHaveBeenCalled()
  })
})
