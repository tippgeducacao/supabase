import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Teste de ponta do funil-email-dispatch com cliente Supabase falso: a porta de acesso
// tem de barrar ANTES de ler tarefa ou chamar o email-send, e não pode barrar o gatilho.
const ambiente = vi.hoisted(() => ({ criarCliente: vi.fn() }))
vi.mock('https://esm.sh/@supabase/supabase-js@2.50.0', () => ({ createClient: ambiente.criarCliente }))

const LISTA_TCC = 'b530b0ca-3a0e-40d3-93d7-c013a91a6dbf'
let atender: (req: Request) => Promise<Response>
let tabelas: string[]
let envios: Array<Record<string, unknown>>
let comentarios: string[]
let listaDaTarefa: string

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: (k: string) => ({ SUPABASE_URL: 'http://kong:8000', SUPABASE_SERVICE_ROLE_KEY: 'chave-do-runtime' } as Record<string, string>)[k] },
    serve: (h: typeof atender) => { atender = h },
  })
  await import('./index.ts')
})
afterAll(() => vi.unstubAllGlobals())

beforeEach(() => {
  tabelas = []; envios = []; comentarios = []; listaDaTarefa = LISTA_TCC
  ambiente.criarCliente.mockReturnValue({
    rpc: async (nome: string, args: { p_segredo?: string }) =>
      ({ data: nome === 'funil_email_validar_gatilho' && args.p_segredo === 'segredo-certo', error: null }),
    auth: {
      getUser: async (t: string) => ({ data: { user: t === 'sessao-ana' ? { id: 'u-ana' } : t === 'sessao-ex' ? { id: 'u-ex' } : null }, error: null }),
    },
    functions: { invoke: async (_n: string, o: { body: Record<string, unknown> }) => { envios.push(o.body); return { data: { ok: true }, error: null } } },
    from: (tabela: string) => {
      tabelas.push(tabela)
      const filtros: Record<string, unknown> = {}
      const resolver = () => {
        if (tabela === 'profiles') return { data: filtros.id === 'u-ana' ? { ativo: true, name: 'Ana' } : { ativo: false, name: 'Ex' }, error: null }
        if (tabela === 'funil_email_automacoes') return { data: { id: 'aut-1', template_id: 'tpl-1', idempotencia_minutos: 1440, funil_ref: 'tcc-padrao', ativo: true }, error: null }
        if (tabela === 'gt_tasks') return { data: { id: 'task-1', title: 'TCC', aluno_id: null, status_id: 's', description: '', list_id: listaDaTarefa }, error: null }
        if (tabela === 'gt_form_submissions') return { data: { payload: { alunos: [{ nome: 'Aluno', email: 'aluno@exemplo.com' }], curso: 'Curso' } }, error: null }
        return { data: null, error: null }
      }
      const q = {
        select: () => q, order: () => q, limit: () => q, gte: () => q,
        eq: (k: string, v: unknown) => { filtros[k] = v; return q },
        insert: async (v: { content: string }) => { comentarios.push(v.content); return { error: null } },
        maybeSingle: async () => resolver(), single: async () => resolver(),
      }
      return q
    },
  })
})

const chamar = (headers: Record<string, string>, extra: Record<string, unknown> = {}) =>
  atender(new Request('https://api.exemplo.com/functions/v1/funil-email-dispatch', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ task_id: 'task-1', etapa_key: 'RECEPCAO', funil_tipo: 'tcc', funil_ref: 'tcc-padrao', ...extra }),
  }))

describe('funil-email-dispatch — porta de acesso', () => {
  it('chave pública com HTML livre e destinatário estranho: 401 sem ler tarefa nem enviar', async () => {
    const r = await chamar({ Authorization: 'Bearer chave-anon' }, {
      force: true, destinatarios_override: [{ email: 'alvo@externo.com' }], assunto_override: 'x', corpo_html_override: '<a href="http://golpe">',
    })
    expect(r.status).toBe(401)
    expect(tabelas).toEqual([])
    expect(envios).toEqual([])
  })

  it('sem cabeçalho nenhum: 401', async () => {
    expect((await chamar({})).status).toBe(401)
    expect(envios).toEqual([])
  })

  it('gatilho do banco (segredo do Vault, Bearer que não bate) continua enviando o automático', async () => {
    const r = await chamar({ Authorization: 'Bearer chave-do-banco', 'x-funil-email-secret': 'segredo-certo' })
    expect(r.status).toBe(200)
    expect(envios).toHaveLength(1)
    expect(envios[0]).toMatchObject({ template_id: 'tpl-1', destinatario_email: 'aluno@exemplo.com', contexto_tipo: 'gt_task' })
    expect(comentarios[0]).not.toContain('(por ')
  })

  it('colaboradora ativa envia pela aba Comunicação e o comentário diz quem mandou', async () => {
    const r = await chamar({ Authorization: 'Bearer sessao-ana' }, { force: true })
    expect(r.status).toBe(200)
    expect(envios).toHaveLength(1)
    expect(comentarios[0]).toContain('(por Ana)')
  })

  it('tarefa de outra lista: 403 sem enviar', async () => {
    listaDaTarefa = 'outra-lista'
    expect((await chamar({ Authorization: 'Bearer sessao-ana' }, { force: true })).status).toBe(403)
    expect(envios).toEqual([])
  })

  it('ex-colaborador com sessão viva: 403 sem ler tarefa', async () => {
    expect((await chamar({ Authorization: 'Bearer sessao-ex' }, { force: true })).status).toBe(403)
    expect(tabelas).not.toContain('gt_tasks')
    expect(envios).toEqual([])
  })
})
