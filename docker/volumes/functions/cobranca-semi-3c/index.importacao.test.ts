import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fronteiras = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), fetch: vi.fn() }))
vi.mock('https://esm.sh/@supabase/supabase-js@2.45.0', () => ({
  createClient: () => ({ from: fronteiras.from, rpc: fronteiras.rpc }),
}))

type Handler = (req: Request) => Promise<Response>
interface PessoaTeste {
  canon: string; telefone: string; nome: string; email: string
  funil: string; etapa: string; lead_id: null; oportunidade_id: null
}
interface RespostaLote { status?: number; corpo?: Record<string, unknown>; falhaTransporte?: boolean }
interface LoteRegistrado {
  enviados: number; status: number | null; transaction_id: string | null
  importados: number | null; contagem_desconhecida?: boolean; resultado: string
}

let handler: Handler
let pessoas: PessoaTeste[]
let respostas: RespostaLote[]
let indiceResposta: number
let execucao: Record<string, unknown>
let espelho: PessoaTeste[][]
const execId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const transacao = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const criarPessoas = (quantidade: number): PessoaTeste[] => Array.from({ length: quantidade }, (_, i) => ({
  canon: `11${String(i).padStart(8, '0')}`, telefone: `119${String(i).padStart(8, '0')}`,
  nome: `Pessoa ${i}`, email: 'teste@example.invalid', funil: 'FASE 03', etapa: 'Cobrança',
  lead_id: null, oportunidade_id: null,
}))

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: (chave: string) => ({
      SUPABASE_URL: 'https://supabase.invalid', SUPABASE_SERVICE_ROLE_KEY: 'servico-teste',
      THREEC_BASE_URL: 'https://threec.invalid/api/v1', THREEC_API_TOKEN: 'token-teste',
    })[chave] },
    serve: (callback: Handler) => { handler = callback },
  })
  // Executa o handler publicado com fronteiras simuladas. Nenhuma chamada sai
  // para a rede, inclusive quando o código usa uma URL inesperada.
  vi.stubGlobal('fetch', fronteiras.fetch)
  await import('./index')
})

afterAll(() => vi.unstubAllGlobals())
beforeEach(() => {
  vi.resetAllMocks()
  pessoas = criarPessoas(5)
  respostas = [{ corpo: { imported_lines: 5, transaction_id: transacao } }]
  indiceResposta = 0
  execucao = {}
  espelho = []
  fronteiras.rpc.mockImplementation(async (nome: string) => {
    if (nome === 'cob_semi_3c_selecionar') return { data: {
      cards: pessoas.length, pessoas: pessoas.length + 1, bloqueados: 0, bloqueados_temporarios: 0,
      sem_telefone: 1, elegiveis: pessoas,
    }, error: null }
    throw new Error(`RPC inesperada: ${nome}`)
  })
  fronteiras.from.mockImplementation((tabela: string) => {
    if (tabela === 'cob_semi_3c_config') return {
      select: () => ({ eq: () => ({ maybeSingle: async () => ({
        data: { id: 1, ativo: true, campanha_id: 'campanha-teste' }, error: null,
      }) }) }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }
    if (tabela === 'cob_semi_3c_execucoes') {
      const consulta = { eq: () => consulta, gte: () => consulta, limit: async () => ({ data: [], error: null }) }
      return {
        select: () => consulta,
        insert: async (linha: Record<string, unknown>) => { execucao = { ...linha }; return { error: null } },
        update: (patch: Record<string, unknown>) => ({ eq: async () => {
          execucao = { ...execucao, ...patch }; return { error: null }
        } }),
      }
    }
    if (tabela === 'cob_semi_3c_itens') return {
      select: async () => ({ data: [], error: null }),
      delete: () => ({ neq: async () => ({ error: null }) }),
      upsert: async (linhas: PessoaTeste[]) => { espelho.push(linhas); return { error: null } },
    }
    throw new Error(`Tabela inesperada: ${tabela}`)
  })
  fronteiras.fetch.mockImplementation(async (url: string, init: RequestInit) => {
    const caminho = new URL(url).pathname
    if (init.method === 'GET' && caminho === '/api/v1/campaigns/campanha-teste/lists') {
      return Response.json({ data: [{ id: 'anterior' }], meta: { current_page: 1, last_page: 1 } })
    }
    if (init.method === 'DELETE' && caminho === '/api/v1/campaigns/campanha-teste/lists/anterior') {
      return new Response(null, { status: 204 })
    }
    if (init.method === 'POST' && caminho === '/api/v1/campaigns/campanha-teste/lists') {
      return Response.json({ data: { id: 'nova' } })
    }
    if (init.method === 'POST' && caminho === '/api/v1/campaigns/campanha-teste/lists/nova/mailing') {
      const resposta = respostas[indiceResposta++]
      if (!resposta) throw new Error('Reenvio inesperado no teste')
      if (resposta.falhaTransporte) throw new Error('URL privada: token-teste, telefone 11999999999')
      return Response.json(resposta.corpo ?? {}, { status: resposta.status ?? 200 })
    }
    throw new Error('Request inesperado no teste')
  })
})

const chamar = () => handler(new Request('https://supabase.invalid/functions/v1/cobranca-semi-3c?acao=atualizar', {
  method: 'POST', headers: { Authorization: 'Bearer servico-teste', 'Content-Type': 'application/json' },
  body: JSON.stringify({ exec_id: execId }),
}))
const envios = () => fronteiras.fetch.mock.calls.filter(([url, init]) =>
  init.method === 'POST' && new URL(url).pathname.endsWith('/mailing'))
const detalhe = () => execucao.detalhe as {
  falhas_envio: number; importacao_desconhecida: number; lotes: LoteRegistrado[]
}

describe('cobrança semiautomática: confirmação da importação no 3C', () => {
  it('fecha 402 enviados, 115 importados e 287 não importados sem inventar aceite nominal', async () => {
    pessoas = criarPessoas(402)
    respostas = [20, 30, 31, 32, 2].map((imported_lines) => ({ corpo: {
      imported_lines, transaction_id: transacao, phone: '11999999999', api_token: 'token-teste',
    } }))
    const resposta = await chamar()
    expect(resposta.status).toBe(200)
    expect(await resposta.json()).toMatchObject({ ok: true, total: 402, entraram: 115, recusados_3c: 287, na_lista: 115 })
    expect(execucao).toMatchObject({ status: 'ok', fase: 'Lista atualizada', processados: 402, sem_telefone: 1 })
    expect(detalhe()).toMatchObject({ falhas_envio: 0, importacao_desconhecida: 0 })
    expect(detalhe().lotes.map((l) => l.enviados)).toEqual([100, 100, 100, 100, 2])
    expect(detalhe().lotes.every((l) => l.status === 200 && l.transaction_id === transacao && l.resultado === 'confirmado')).toBe(true)
    expect(JSON.stringify(detalhe())).not.toMatch(/11999999999|token-teste|api_token|phone/)
    expect(envios()).toHaveLength(5)
    expect(espelho.flat()).toHaveLength(402)
    const primeiro = JSON.parse(envios()[0][1].body as string).mailing[0]
    expect(primeiro).toMatchObject({ phone: pessoas[0].telefone, areacode: '11', data: { nome: 'Pessoa 0', etapa: 'Cobrança' } })
  })

  it('trata 2xx sem imported_lines como desconhecido e preserva a submissão sem reenviar', async () => {
    respostas = [{ corpo: { transaction_id: transacao } }]
    const resposta = await chamar()
    expect(await resposta.json()).toMatchObject({ ok: false, entraram: 0, recusados_3c: 0, na_lista: 0 })
    expect(execucao).toMatchObject({ status: 'erro', fase: 'Importação sem contagem confirmada', processados: 5 })
    expect(detalhe()).toMatchObject({ falhas_envio: 0, importacao_desconhecida: 5, lotes: [{
      enviados: 5, status: 200, transaction_id: transacao, importados: null, contagem_desconhecida: true,
    }] })
    expect(espelho.flat()).toHaveLength(5)
    expect(envios()).toHaveLength(1)
  })

  it('aceita zero como contagem confirmada sem confundir recusa integral com falha do envio', async () => {
    respostas = [{ corpo: { imported_lines: 0 } }]
    expect(await (await chamar()).json()).toMatchObject({ ok: true, entraram: 0, recusados_3c: 5 })
    expect(execucao.status).toBe('ok')
    expect(detalhe()).toMatchObject({ importacao_desconhecida: 0, lotes: [{ importados: 0, contagem_desconhecida: false }] })
    expect(espelho.flat()).toHaveLength(5)
  })

  it('mantém separadas as contagens confirmadas e desconhecidas da mesma atualização', async () => {
    pessoas = criarPessoas(105)
    respostas = [{ corpo: { imported_lines: 40 } }, { corpo: {} }]
    expect(await (await chamar()).json()).toMatchObject({ ok: false, total: 105, entraram: 40, recusados_3c: 60 })
    expect(execucao).toMatchObject({ status: 'erro', fase: 'Atualização parcial: confira as pendências' })
    expect(detalhe()).toMatchObject({ importacao_desconhecida: 5, falhas_envio: 0 })
    expect(envios()).toHaveLength(2)
    expect(espelho.flat()).toHaveLength(105)
  })

  it.each([-1, 1.5, 6, '3', null, true])('não aceita contador inválido %s nem o converte em recusa', async (imported_lines) => {
    respostas = [{ corpo: { imported_lines, transaction_id: 'telefone=11999999999&api_token=token-teste' } }]
    const resposta = await chamar()
    expect(await resposta.json()).toMatchObject({ ok: false, entraram: 0, recusados_3c: 0 })
    expect(execucao.status).toBe('erro')
    expect(detalhe()).toMatchObject({ importacao_desconhecida: 5, lotes: [{
      importados: null, transaction_id: null, contagem_desconhecida: true,
    }] })
    expect(JSON.stringify(execucao)).not.toMatch(/11999999999|token-teste/)
    expect(envios()).toHaveLength(1)
  })

  it('distingue falha HTTP parcial de recusa, preservando os aceites confirmados e o rastreio seguro', async () => {
    pessoas = criarPessoas(250)
    respostas = [
      { corpo: { imported_lines: 100 } },
      { status: 503, corpo: { transaction_id: transacao, detail: 'token-teste 11999999999' } },
      { corpo: { imported_lines: 25 } },
    ]
    const resposta = await chamar()
    expect(await resposta.json()).toMatchObject({ ok: false, total: 250, entraram: 125, recusados_3c: 25, na_lista: 125 })
    expect(execucao).toMatchObject({ status: 'erro', fase: 'Atualização parcial: confira as pendências', processados: 250 })
    expect(detalhe()).toMatchObject({ falhas_envio: 100, importacao_desconhecida: 0 })
    expect(detalhe().lotes[1]).toEqual({ enviados: 100, status: 503, transaction_id: transacao, importados: null, resultado: 'falha_envio' })
    expect(JSON.stringify(execucao)).not.toMatch(/11999999999|token-teste/)
    expect(envios()).toHaveLength(3)
    expect(espelho.flat()).toHaveLength(150)
  })

  it('não repete lote com erro de transporte nem registra a exceção privada', async () => {
    respostas = [{ falhaTransporte: true }]
    const resposta = await chamar()
    expect(await resposta.json()).toMatchObject({ ok: false, entraram: 0, recusados_3c: 0 })
    expect(execucao).toMatchObject({ status: 'erro', fase: 'O envio ao 3C falhou' })
    expect(detalhe()).toMatchObject({ falhas_envio: 5, lotes: [{ status: null, transaction_id: null, resultado: 'falha_envio' }] })
    expect(JSON.stringify(execucao)).not.toMatch(/11999999999|token-teste|URL privada/)
    expect(envios()).toHaveLength(1)
    expect(espelho).toHaveLength(0)
  })
})
