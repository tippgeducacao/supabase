import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// 20/10/2026: o portão desta edge só conferia se o header COMEÇAVA com "Bearer " — qualquer
// texto passava e, com o wa_message_id, qualquer um editava/apagava a mensagem no WhatsApp do
// cliente. Estes testes fixam o portão novo: sessão real (getUser) + usuário ATIVO (a régua
// `pode_gerenciar_wa_conexoes`, a mesma da wa-uazapi-admin), ANTES de ler mensagem ou token.

const f = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpc: vi.fn(),
  editMessage: vi.fn(),
  deleteMessage: vi.fn(),
  clientes: [] as Array<{ chave: string; authorization?: string }>,
  leituras: [] as string[],
  updates: [] as Array<{ tabela: string; patch: Record<string, unknown>; filtro: [string, unknown] }>,
}))

const DADOS: Record<string, unknown> = {
  crm_whatsapp_messages: { id: 'm1', provider: 'uazapi', direcao: 'outbound', wa_conexao_id: 'c1', wa_message_id: 'WAID-1' },
  wa_conexoes: { server_url: 'https://uazapi.invalid', provider: 'uazapi' },
  wa_conexoes_secrets: { token: 'token-da-linha' },
}

function tabela(nome: string) {
  return {
    select: () => ({
      eq: () => ({
        maybeSingle: async () => {
          f.leituras.push(nome)
          return { data: DADOS[nome] ?? null, error: null }
        },
      }),
    }),
    update: (patch: Record<string, unknown>) => ({
      eq: async (coluna: string, valor: unknown) => {
        f.updates.push({ tabela: nome, patch, filtro: [coluna, valor] })
        return { error: null }
      },
    }),
  }
}

vi.mock('https://esm.sh/@supabase/supabase-js@2.49.4', () => ({
  createClient: (_url: string, chave: string, opcoes?: { global?: { headers?: Record<string, string> } }) => {
    const authorization = opcoes?.global?.headers?.Authorization
    f.clientes.push({ chave, authorization })
    if (chave === 'servico-teste') return { auth: { getUser: f.getUser }, from: tabela }
    return { rpc: (nome: string) => f.rpc(nome, authorization) }
  },
}))
vi.mock('../_shared/waProviders.ts', () => ({
  getWaProvider: () => ({ editMessage: f.editMessage, deleteMessage: f.deleteMessage }),
}))

type Handler = (req: Request) => Promise<Response>
let handler: Handler

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: {
      get: (chave: string) => ({
        SUPABASE_URL: 'https://supabase.invalid',
        SUPABASE_SERVICE_ROLE_KEY: 'servico-teste',
        SUPABASE_ANON_KEY: 'anon-teste',
      })[chave],
    },
    serve: (callback: Handler) => { handler = callback },
  })
  await import('./index')
})
afterAll(() => vi.unstubAllGlobals())

beforeEach(() => {
  vi.resetAllMocks()
  f.clientes.length = 0
  f.leituras.length = 0
  f.updates.length = 0
  vi.spyOn(console, 'log').mockImplementation(() => {})
  // Só as duas sessões de teste existem no Auth; qualquer outro texto (inclusive as chaves
  // anon e de serviço, que não têm usuário) é recusado — como o GoTrue faz.
  f.getUser.mockImplementation(async (jwt: string) => {
    if (jwt === 'jwt-ativo') return { data: { user: { id: 'u-ativo', is_anonymous: false } }, error: null }
    if (jwt === 'jwt-inativo') return { data: { user: { id: 'u-inativo', is_anonymous: false } }, error: null }
    return { data: { user: null }, error: { message: 'invalid JWT' } }
  })
  f.rpc.mockImplementation(async (nome: string, authorization?: string) => {
    if (nome !== 'pode_gerenciar_wa_conexoes') throw new Error(`RPC inesperada: ${nome}`)
    return { data: authorization === 'Bearer jwt-ativo', error: null }
  })
  f.editMessage.mockResolvedValue({ ok: true, raw: {} })
  f.deleteMessage.mockResolvedValue({ ok: true, raw: {} })
})

const chamar = (body: unknown, authorization?: string) => handler(new Request('https://supabase.invalid/functions/v1/wa-message-action', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
  body: JSON.stringify(body),
}))
const apagar = { action: 'delete', wa_message_id: 'WAID-1' }

function nadaFoiTocado() {
  expect(f.leituras).toEqual([])
  expect(f.updates).toEqual([])
  expect(f.editMessage).not.toHaveBeenCalled()
  expect(f.deleteMessage).not.toHaveBeenCalled()
}

describe('wa-message-action: portão de verdade (20/10/2026)', () => {
  it('sem Authorization (ou malformado) recusa antes de consultar o Auth', async () => {
    for (const authorization of [undefined, 'Basic abc', 'Bearer ', 'Bearer duas palavras']) {
      expect((await chamar(apagar, authorization)).status, String(authorization)).toBe(401)
    }
    expect(f.getUser).not.toHaveBeenCalled()
    nadaFoiTocado()
  })

  // O defeito: antes, todos estes passavam e apagavam a mensagem no WhatsApp do cliente.
  it.each(['Bearer qualquer-coisa', 'Bearer anon-teste', 'Bearer servico-teste'])(
    'recusa %s: não é sessão de usuário', async (authorization) => {
      const r = await chamar(apagar, authorization)
      expect(r.status).toBe(401)
      expect(await r.json()).toMatchObject({ error: expect.stringContaining('sessão inválida') })
      expect(f.rpc).not.toHaveBeenCalled()
      nadaFoiTocado()
    },
  )

  it('recusa sessão anônima', async () => {
    f.getUser.mockResolvedValue({ data: { user: { id: 'u-anon', is_anonymous: true } }, error: null })
    expect((await chamar(apagar, 'Bearer jwt-anonimo')).status).toBe(401)
    nadaFoiTocado()
  })

  it('usuário desativado recebe 403 — a régua roda como ELE, com a anon + o JWT dele', async () => {
    const r = await chamar(apagar, 'Bearer jwt-inativo')
    expect(r.status).toBe(403)
    expect(f.rpc).toHaveBeenCalledWith('pode_gerenciar_wa_conexoes', 'Bearer jwt-inativo')
    expect(f.clientes).toContainEqual({ chave: 'anon-teste', authorization: 'Bearer jwt-inativo' })
    nadaFoiTocado()
  })

  it('falha ao checar a régua ou o Auth não deixa passar (500, sem 502/504)', async () => {
    f.rpc.mockResolvedValueOnce({ data: null, error: { message: 'banco fora' } })
    expect((await chamar(apagar, 'Bearer jwt-ativo')).status).toBe(500)
    f.getUser.mockRejectedValueOnce(new Error('auth fora'))
    expect((await chamar(apagar, 'Bearer jwt-ativo')).status).toBe(500)
    nadaFoiTocado()
  })

  it('preflight OPTIONS continua livre', async () => {
    const r = await handler(new Request('https://supabase.invalid/functions/v1/wa-message-action', { method: 'OPTIONS' }))
    expect(r.status).toBe(200)
    expect(f.getUser).not.toHaveBeenCalled()
  })
})

describe('wa-message-action: uso normal da tela (usuário ativo)', () => {
  it('apaga para todos: provider + inbox + espelho do SAC', async () => {
    const r = await chamar(apagar, 'Bearer jwt-ativo')
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ ok: true, action: 'delete' })
    expect(f.deleteMessage).toHaveBeenCalledWith('https://uazapi.invalid', 'token-da-linha', 'WAID-1')
    expect(f.updates.map((u) => [u.tabela, u.patch.anexos, u.filtro])).toEqual([
      ['crm_whatsapp_messages', [], ['wa_message_id', 'WAID-1']],
      ['sac_mensagens', [], ['wa_message_id', 'WAID-1']],
    ])
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('delete por u-ativo'))
  })

  it('edita: o texto novo vai ao provider e às duas cópias', async () => {
    const r = await chamar({ action: 'edit', wa_message_id: 'WAID-1', text: ' texto novo ' }, 'Bearer jwt-ativo')
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ ok: true, action: 'edit', conteudo: 'texto novo' })
    expect(f.editMessage).toHaveBeenCalledWith('https://uazapi.invalid', 'token-da-linha', 'WAID-1', 'texto novo')
    expect(f.updates.map((u) => [u.tabela, u.patch.conteudo])).toEqual([
      ['crm_whatsapp_messages', 'texto novo'],
      ['sac_mensagens', 'texto novo'],
    ])
  })
})
