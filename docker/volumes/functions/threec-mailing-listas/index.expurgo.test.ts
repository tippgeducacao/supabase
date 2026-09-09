import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fronteiras = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), fetch: vi.fn() }))
vi.mock('https://esm.sh/@supabase/supabase-js@2.45.0', () => ({
  createClient: () => ({ from: fronteiras.from, rpc: fronteiras.rpc }),
}))
type Handler = (req: Request) => Promise<Response>
const handlers: Record<string, Handler> = {}
const alvo = { lead_id: 'lead-teste', canon: '1199990001', telefone: '11999990001', nome: 'Ana Silva', motivo: 'veto SDR' }
let registro: Array<{ campanha_id: string; canon: string; removido: boolean }>

beforeAll(async () => {
  let handler: Handler
  vi.stubGlobal('Deno', {
    env: { get: (chave: string) => ({
      SUPABASE_URL: 'https://supabase.invalid', SUPABASE_SERVICE_ROLE_KEY: 'servico-teste',
      THREEC_BASE_URL: 'https://threec.invalid/api/v1', THREEC_API_TOKEN: 'token-teste',
    })[chave] },
    serve: (callback: Handler) => { handler = callback },
  })
  vi.stubGlobal('fetch', fronteiras.fetch)
  await import('./index')
  handlers['threec-mailing-listas'] = handler!
  await import('../threec-mailing-sync/index')
  handlers['threec-mailing-sync'] = handler!
})
afterAll(() => vi.unstubAllGlobals())
beforeEach(() => {
  vi.resetAllMocks()
  registro = ['campanha-teste', 'outra-campanha'].map(campanha_id => ({ campanha_id, canon: alvo.canon, removido: false }))
  fronteiras.rpc.mockImplementation(async (nome: string, args: Record<string, unknown>) => {
    if (['threec_sdr_travar', 'threec_sdr_destravar'].includes(nome)) return { data: true, error: null }
    if (['threec_mailing_a_expurgar', 'threec_mailing_a_expurgar_lista'].includes(nome)) return { data: [alvo], error: null }
    if (nome === 'threec_mailing_rodada_registrar') return { data: null, error: null }
    if (nome === 'threec_mailing_marcar_removidos') {
      // Reproduz a seleção de linhas do banco: o teste falha se o caller omitir
      // a campanha e voltar à antiga marcação global do mesmo telefone.
      const linhas = registro.filter(r => (args.p_canons as string[]).includes(r.canon)
        && (!args.p_campanha_id || r.campanha_id === args.p_campanha_id))
      linhas.forEach(r => { r.removido = true })
      return { data: linhas.length, error: null }
    }
    throw new Error(`RPC inesperada: ${nome}`)
  })
  fronteiras.from.mockImplementation((tabela: string) => {
    if (tabela === 'threec_mailing_config') return {
      select: () => ({ maybeSingle: async () => ({ data: { campanha_id: 'campanha-teste', ativo: true }, error: null }) }),
    }
    if (tabela === 'threec_mailing_listas') return {
      select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: [{
        id: 'config-teste', nome: 'Campanha automática', campanha_id: 'campanha-teste', lista_id: 'lista-teste',
      }], error: null }) }) }) }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }
    throw new Error(`Tabela inesperada: ${tabela}`)
  })
  fronteiras.fetch.mockResolvedValue(new Response(null, { status: 204 }))
})

async function chamar(funcao: string) {
  return handlers[funcao](new Request(`https://supabase.invalid/functions/v1/${funcao}?acao=expurgar`, {
    method: 'POST', headers: { Authorization: 'Bearer servico-teste' },
  }))
}

describe.each(['threec-mailing-listas', 'threec-mailing-sync'])('%s: expurgo por campanha', (funcao) => {
  it('remove e registra somente a campanha chamada, preservando o mesmo telefone em outra campanha', async () => {
    const resposta = await chamar(funcao)
    expect(resposta.status).toBe(200)
    expect(await resposta.json()).toMatchObject({ ok: true, removidos_no_3c: 1, marcados: 1 })
    expect(fronteiras.fetch).toHaveBeenCalledOnce()
    const [url, init] = fronteiras.fetch.mock.calls[0]
    expect(new URL(url).pathname).toBe('/api/v1/campaigns/campanha-teste/mailing/delete')
    expect(init.method).toBe('DELETE')
    expect(JSON.parse(init.body)).toEqual({ phone: [alvo.telefone] })
    expect(fronteiras.rpc).toHaveBeenCalledWith('threec_mailing_marcar_removidos', expect.objectContaining({
      p_canons: [alvo.canon], p_campanha_id: 'campanha-teste',
    }))
    expect(registro).toEqual([
      { campanha_id: 'campanha-teste', canon: alvo.canon, removido: true },
      { campanha_id: 'outra-campanha', canon: alvo.canon, removido: false },
    ])
  })

  it('mantém ambas as campanhas no registro quando o DELETE falha', async () => {
    fronteiras.fetch.mockResolvedValue(new Response('indisponível', { status: 503 }))
    const resposta = await chamar(funcao)
    expect(await resposta.json()).toMatchObject({ ok: false, removidos_no_3c: 0, marcados: 0 })
    expect(fronteiras.rpc.mock.calls.some(([nome]) => nome === 'threec_mailing_marcar_removidos')).toBe(false)
    expect(registro.every(r => !r.removido)).toBe(true)
  })
})
