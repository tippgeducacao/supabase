import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fronteiras = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), fetch: vi.fn() }))
vi.mock('https://esm.sh/@supabase/supabase-js@2.45.0', () => ({
  createClient: () => ({ from: fronteiras.from, rpc: fronteiras.rpc }),
}))

type Handler = (req: Request) => Promise<Response>
const handlers: Record<string, Handler> = {}
const leads = [
  {
    lead_id: 'lead-1', canon: '11999990001', telefone: '11999990001',
    nome: '  Ana\u200B   Silva  ', email: '  ana@example.invalid  ',
    formacao: 'medico_veterinario_(a)', curso: 'SANIDADE AVÍCOLA', criado_em: '2026-09-09T10:00:00Z',
  },
  {
    lead_id: 'lead-2', canon: '21999990002', telefone: '21999990002',
    nome: 'Bruno Lima', email: '', formacao: '', curso: '', criado_em: '2026-09-09T10:00:00Z',
  },
]
const campanhas = [
  { funcao: 'threec-mailing-listas', identifier: '11999990001', curso: 'SANIDADE AVÍCOLA' },
  { funcao: 'threec-mailing-sync', identifier: 'Ana Silva - Sanidade Avícola', curso: 'Sanidade Avícola' },
]

beforeAll(async () => {
  let handler: Handler
  vi.stubGlobal('Deno', {
    env: { get: (chave: string) => ({
      SUPABASE_URL: 'https://supabase.invalid', SUPABASE_SERVICE_ROLE_KEY: 'servico-teste',
      THREEC_BASE_URL: 'https://threec.invalid/api/v1', THREEC_API_TOKEN: 'token-teste',
    })[chave] },
    serve: (callback: Handler) => { handler = callback },
  })
  // Importa os handlers publicados; só banco, runtime e HTTP são simulados.
  // O mock de fetch nunca chama a rede, nem mesmo com uma URL inesperada.
  vi.stubGlobal('fetch', fronteiras.fetch)
  await import('./index')
  handlers['threec-mailing-listas'] = handler!
  await import('../threec-mailing-sync/index')
  handlers['threec-mailing-sync'] = handler!
})
afterAll(() => vi.unstubAllGlobals())
afterEach(() => vi.restoreAllMocks())
beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  fronteiras.rpc.mockImplementation(async (nome: string) => {
    if (['threec_sdr_travar', 'threec_sdr_destravar'].includes(nome)) return { data: true, error: null }
    if (nome === 'threec_sdr_lote_iniciar') return { data: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', error: null }
    if (nome === 'threec_sdr_lote_confirmar') return { data: leads.length, error: null }
    if (['threec_mailing_selecionar_lista', 'threec_mailing_selecionar'].includes(nome)) {
      return { data: leads, error: null }
    }
    if (['threec_mailing_marcar_enviados_lista', 'threec_mailing_marcar'].includes(nome)) {
      return { data: leads.length, error: null }
    }
    if (nome === 'threec_mailing_rodada_registrar') return { data: null, error: null }
    throw new Error(`RPC inesperada: ${nome}`)
  })
  fronteiras.from.mockImplementation((tabela: string) => {
    if (tabela === 'threec_mailing_config') return {
      select: () => ({ maybeSingle: async () => ({ data: {
        campanha_id: 'campanha-teste', lista_quente_id: 'lista-teste', lista_base_id: 'base-teste',
        ativo: true, limite_por_rodada: 300,
      }, error: null }) }),
    }
    if (tabela === 'threec_mailing_listas') return {
      select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: [{
        id: 'config-teste', nome: 'Sanidade Avícola | AUTOMATICA', campanha_id: 'campanha-teste',
        lista_id: 'lista-teste', recorte: 'interesse', limite_por_rodada: 300,
      }], error: null }) }) }) }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }
    throw new Error(`Tabela inesperada: ${tabela}`)
  })
  fronteiras.fetch.mockImplementation(async (url: string, init: RequestInit) => {
    if (url !== 'https://threec.invalid/api/v1/campaigns/campanha-teste/lists/lista-teste/mailing?api_token=token-teste'
      || init.method !== 'POST') throw new Error('Request inesperado no teste')
    return Response.json({ imported_lines: 1 })
  })
})

async function chamar(funcao: string, dry = false) {
  return handlers[funcao](new Request(`https://supabase.invalid/functions/v1/${funcao}${dry ? '?dry=1' : ''}`, {
    method: 'POST', headers: { Authorization: 'Bearer servico-teste' },
  }))
}

describe.each(campanhas)('$funcao: dados visíveis no atendimento do 3C', ({ funcao, identifier, curso }) => {
  it('envia nome e demais campos em mailing.data, preservando identificação e contagem de descartes', async () => {
    const resposta = await chamar(funcao)
    expect(resposta.status).toBe(200)
    expect(fronteiras.fetch).toHaveBeenCalledOnce()
    const corpo = JSON.parse(fronteiras.fetch.mock.calls[0][1].body)
    const mailing = corpo.mailing[0]

    // A tela Ligação Discador enumera somente mailing.data. Campos na raiz
    // podem ser armazenados pelo 3C e, ainda assim, ficar invisíveis ao agente.
    expect(Object.entries(mailing.data ?? {})).toEqual([
      ['nome', 'Ana Silva'], ['email', 'ana@example.invalid'],
      ['formacao', 'Medico veterinario (a)'], ['curso', curso],
    ])
    expect(mailing).toEqual({ identifier, areacode: '11', phone: '11999990001', data: mailing.data })
    expect(corpo.mailing[1].data).toEqual({ nome: 'Bruno Lima', email: '', formacao: '', curso: '' })

    const resultado = await resposta.json()
    expect(resultado).toMatchObject({ enviados: 2, marcados: 2 })
    if (funcao === 'threec-mailing-sync') {
      expect(resultado).toMatchObject({ submetidos_confirmados: 2, imported_lines: 1, descartados_agregados: 1 })
      expect(resultado).not.toHaveProperty('descartados_duplicata_campanha')
    } else expect(resultado.descartados_duplicata_campanha).toBe(1)
    if (funcao === 'threec-mailing-sync') expect(resultado.com_curso).toBe(1)
  })

  it('mostra na simulação o mesmo nome dentro de data sem enviar nem marcar leads', async () => {
    const resposta = await chamar(funcao, true)
    expect(resposta.status).toBe(200)
    expect(await resposta.json()).toMatchObject({ dry: true, total: 2, amostra: [
      { identifier, data: { nome: 'Ana Silva', curso } },
      { data: { nome: 'Bruno Lima' } },
    ] })
    expect(fronteiras.fetch).not.toHaveBeenCalled()
    expect(fronteiras.rpc.mock.calls.every(([nome]) => nome.startsWith('threec_mailing_selecionar'))).toBe(true)
  })
})
