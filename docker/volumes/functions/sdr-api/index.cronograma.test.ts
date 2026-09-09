import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Contrato HTTP real, com provedor e banco simulados. O aceite síncrono não pode
// virar prova de entrega; a prova pertence à mensagem identificada no CRM.
const mocks = vi.hoisted(() => ({
  from: vi.fn(), rpc: vi.fn(), fetch: vi.fn(), filtros: vi.fn(),
  mensagem: null as { status_entrega: string } | null,
  erroMensagem: null as { message: string } | null,
}))
vi.mock('https://esm.sh/@supabase/supabase-js@2.50.3', () => ({
  createClient: () => ({ from: mocks.from, rpc: mocks.rpc }),
}))

type Handler = (req: Request) => Promise<Response>
let handler: Handler
const info = {
  success: true, curso: { nome: 'Sanidade Avícola' },
  cronograma: { url: 'https://storage.invalid/sanidade.pdf', nome_arquivo: 'Sanidade.pdf' },
  valor_integral: '1000,00', valor_matricula: '100,00',
}

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: (chave: string) => chave === 'SUPABASE_URL' ? 'https://supabase.invalid' : 'chave-teste' },
    serve: (callback: Handler) => { handler = callback },
  })
  vi.stubGlobal('fetch', mocks.fetch)
  await import('./index')
})
afterAll(() => vi.unstubAllGlobals())
beforeEach(() => {
  vi.resetAllMocks()
  mocks.mensagem = null
  mocks.erroMensagem = null
  mocks.from.mockImplementation((tabela: string) => {
    const resposta = () => tabela === 'sdr_api_keys'
      ? { data: { id: 'chave-teste', sdr_id: 'sdr-teste', ativo: true, revoked_at: null }, error: null }
      : { data: mocks.mensagem, error: mocks.erroMensagem }
    const consulta = {
      select: () => consulta, update: () => consulta,
      eq: (campo: string, valor: unknown) => { mocks.filtros(tabela, campo, valor); return consulta },
      maybeSingle: async () => resposta(),
      then: (resolver: (valor: unknown) => unknown) => Promise.resolve(resposta()).then(resolver),
    }
    return consulta
  })
  mocks.rpc.mockResolvedValue({ data: info, error: null })
  mocks.fetch.mockImplementation(async () => Response.json({
    success: true, wa_message_id: 'wamid-teste', wa_account_id: 'conta-teste',
  }))
})

function chamar(extra: Record<string, unknown> = {}) {
  return handler(new Request('https://supabase.invalid/functions/v1/sdr-api/envia-informacoes', {
    method: 'POST', headers: { Authorization: 'Bearer chave-teste', 'Content-Type': 'application/json' },
    body: JSON.stringify({ whatsapp: '5500000000000', pos: 'Sanidade Avícola', conteudo: 'cronograma', ...extra }),
  }))
}
async function resultado(extra: Record<string, unknown> = {}) {
  const resposta = await chamar(extra)
  expect(resposta.status).toBe(200)
  return (await resposta.json()).data
}

describe('envia-informacoes: aceite e entrega do cronograma', () => {
  it('mantém o booleano de aceite e devolve entrega pendente com a referência da mensagem', async () => {
    expect(await resultado()).toMatchObject({
      cronograma_enviado: true, cronograma_status: 'pendente', cronograma_entregue: false,
      cronograma_wa_message_id: 'wamid-teste', cronograma_wa_account_id: 'conta-teste',
    })
    expect(mocks.filtros).toHaveBeenCalledWith('crm_whatsapp_messages', 'wa_message_id', 'wamid-teste')
    expect(mocks.filtros).toHaveBeenCalledWith('crm_whatsapp_messages', 'wa_account_id', 'conta-teste')
    expect(mocks.filtros).toHaveBeenCalledWith('crm_whatsapp_messages', 'direcao', 'outbound')
  })

  it.each(['delivered', 'read'])('reconhece %s somente na mensagem persistida', async (status) => {
    mocks.mensagem = { status_entrega: status }
    expect(await resultado()).toMatchObject({ cronograma_status: status, cronograma_entregue: true })
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })

  it('não usa um status entregue do ACK como evidência do CRM', async () => {
    mocks.fetch.mockImplementation(async () => Response.json({
      success: true, status_entrega: 'delivered', wa_message_id: 'wamid-teste', wa_account_id: 'conta-teste',
    }))
    expect(await resultado()).toMatchObject({ cronograma_status: 'pendente', cronograma_entregue: false })
  })

  it.each(['sem referência', 'erro de leitura'])('mantém pendente quando há %s, sem reenviar', async (caso) => {
    if (caso === 'sem referência') mocks.fetch.mockImplementation(async () => Response.json({ success: true }))
    else mocks.erroMensagem = { message: 'Indisponível' }
    expect(await resultado()).toMatchObject({ cronograma_enviado: true, cronograma_status: 'pendente', cronograma_entregue: false })
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })

  it('uma falha assíncrona já registrada impede confirmação de envio', async () => {
    mocks.mensagem = { status_entrega: 'failed' }
    expect(await resultado()).toMatchObject({ cronograma_enviado: false, cronograma_status: 'falhou', cronograma_entregue: false })
  })

  it.each([200, 422])('não trata recusa como sucesso com HTTP %s', async (status) => {
    mocks.fetch.mockImplementation(async () => Response.json({ success: false, error: 'Anexo indisponível' }, { status }))
    expect(await resultado()).toMatchObject({ cronograma_enviado: false, cronograma_status: 'falhou', cronograma_entregue: false })
  })

  it('o fallback do webchat conserva a referência e o status da linha Web', async () => {
    mocks.fetch.mockImplementationOnce(async () => Response.json({ error: 'Template recusado' }, { status: 422 }))
      .mockImplementationOnce(async () => Response.json({ success: true, wa_message_id: 'id-web', wa_conexao_id: 'conexao-web' }))
    expect(await resultado({ template_name: 'cronograma_teste', wa_conexao_id: 'conexao-web' })).toMatchObject({
      cronograma_enviado: true, cronograma_status: 'pendente', cronograma_entregue: false,
      cronograma_wa_message_id: 'id-web', cronograma_wa_account_id: null, cronograma_wa_conexao_id: 'conexao-web',
    })
    expect(mocks.filtros).toHaveBeenCalledWith('crm_whatsapp_messages', 'wa_conexao_id', 'conexao-web')
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
  })

  it('consulta de valor não envia nem consulta entrega de mensagem', async () => {
    expect(await resultado({ conteudo: 'valor' })).toMatchObject({
      cronograma_enviado: false, cronograma_status: 'nao_solicitado', cronograma_entregue: false,
      valor_integral: '1000,00', valor_matricula: '100,00',
    })
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.from.mock.calls.some(([tabela]) => tabela === 'crm_whatsapp_messages')).toBe(false)
  })
})
