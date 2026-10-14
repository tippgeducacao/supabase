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
// Linhas da aba Atividade (gt_activity_log) — separadas dos comentários que ninguém lê.
let atividades: Array<Record<string, unknown>>
let listaDaTarefa: string
let falhaNoEnvio: boolean

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: (k: string) => ({ SUPABASE_URL: 'http://kong:8000', SUPABASE_SERVICE_ROLE_KEY: 'chave-do-runtime' } as Record<string, string>)[k] },
    serve: (h: typeof atender) => { atender = h },
  })
  await import('./index.ts')
})
afterAll(() => vi.unstubAllGlobals())

beforeEach(() => {
  tabelas = []; envios = []; comentarios = []; atividades = []; listaDaTarefa = LISTA_TCC; falhaNoEnvio = false
  ambiente.criarCliente.mockReturnValue({
    rpc: async (nome: string, args: { p_segredo?: string }) =>
      ({ data: nome === 'funil_email_validar_gatilho' && args.p_segredo === 'segredo-certo', error: null }),
    auth: {
      getUser: async (t: string) => ({ data: { user: t === 'sessao-ana' ? { id: 'u-ana' } : t === 'sessao-ex' ? { id: 'u-ex' } : null }, error: null }),
    },
    functions: {
      invoke: async (_n: string, o: { body: Record<string, unknown> }) => {
        envios.push(o.body)
        return falhaNoEnvio
          ? { data: null, error: { message: 'non-2xx', context: { json: async () => ({ error: 'Caixa Gmail desconectada' }) } } }
          : { data: { ok: true }, error: null }
      },
    },
    from: (tabela: string) => {
      tabelas.push(tabela)
      const filtros: Record<string, unknown> = {}
      const resolver = () => {
        if (tabela === 'profiles') return { data: filtros.id === 'u-ana' ? { ativo: true, name: 'Ana' } : { ativo: false, name: 'Ex' }, error: null }
        if (tabela === 'funil_email_automacoes') return { data: { id: 'aut-1', template_id: 'tpl-1', idempotencia_minutos: 1440, funil_ref: 'tcc-padrao', ativo: true }, error: null }
        if (tabela === 'gt_tasks') return { data: { id: 'task-1', title: 'TCC', aluno_id: null, status_id: 's', description: '', list_id: listaDaTarefa }, error: null }
        if (tabela === 'gt_form_submissions') return { data: { payload: { alunos: [{ nome: 'Aluno', email: 'aluno@exemplo.com' }], curso: 'Curso' } }, error: null }
        if (tabela === 'email_templates') return { data: { remetente_id: 'rem-tcc' }, error: null }
        return { data: null, error: null }
      }
      const q = {
        select: () => q, order: () => q, limit: () => q, gte: () => q,
        eq: (k: string, v: unknown) => { filtros[k] = v; return q },
        insert: async (v: Record<string, unknown>) => {
          if (tabela === 'gt_activity_log') atividades.push(v)
          else comentarios.push(String(v.content))
          return { error: null }
        },
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

describe('funil-email-dispatch — o que o pedido pode pedir', () => {
  const ana = { Authorization: 'Bearer sessao-ana' }

  it('modelo de outro remetente (marketing) com HTML livre: 403 antes de ler automação ou tarefa', async () => {
    const r = await chamar(ana, {
      etapa_key: 'DOCUMENTOS_PENDENTES', force: true, template_id_override: '59002b7b-ad24-4b9a-8aff-09709d1f0197',
      assunto_override: 'x', corpo_html_override: '<a href="http://golpe">', destinatarios_override: [{ email: 'alvo@externo.com' }],
    })
    expect(r.status).toBe(403)
    expect(tabelas).not.toContain('funil_email_automacoes')
    expect(tabelas).not.toContain('gt_tasks')
    expect(envios).toEqual([])
  })

  it('modelo manual da Aprovação continua saindo pela aba', async () => {
    const r = await chamar(ana, { etapa_key: 'APROVACAO', force: true, template_id_override: '4b600a23-11e0-49f5-8316-506afe5846df' })
    expect(r.status).toBe(200)
    expect(envios[0]).toMatchObject({ template_id: '4b600a23-11e0-49f5-8316-506afe5846df' })
  })

  it('11 destinatários: 400 sem enviar', async () => {
    const lista = Array.from({ length: 11 }, (_, i) => ({ email: `a${i}@exemplo.com` }))
    expect((await chamar(ana, { force: true, destinatarios_override: lista })).status).toBe(400)
    expect(envios).toEqual([])
  })

  it('"Reenviar" de Documentos pendentes sem lista: recusa legível, nada sai e nada vai para a tarefa', async () => {
    const r = await chamar(ana, { etapa_key: 'DOCUMENTOS_PENDENTES', force: true, destinatarios_override: [{ email: 'aluno@exemplo.com' }] })
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ ok: false })
    expect(envios).toEqual([])
    expect(comentarios).toEqual([])
  })

  it('gatilho de Documentos pendentes sem lista: nada sai e o motivo fica comentado na tarefa', async () => {
    const r = await chamar({ 'x-funil-email-secret': 'segredo-certo' }, { etapa_key: 'DOCUMENTOS_PENDENTES' })
    expect(r.status).toBe(200)
    expect(envios).toEqual([])
    expect(comentarios[0]).toContain('⚠️ Automação de email (DOCUMENTOS_PENDENTES) não disparada')
  })

  it('Cobrar documentos com a lista sai com <ul> montado no servidor e marcado como HTML', async () => {
    const r = await chamar(ana, { etapa_key: 'DOCUMENTOS_PENDENTES', force: true, variaveis_override: { docs_faltantes: 'Termo de Aceite\nFicha do <Orientador>' } })
    expect(r.status).toBe(200)
    expect(envios[0]).toMatchObject({ variaveis_html: ['docs_faltantes'] })
    expect((envios[0].variaveis as Record<string, string>).docs_faltantes)
      .toBe('<ul><li>Termo de Aceite</li><li>Ficha do &lt;Orientador&gt;</li></ul>')
  })
})

describe('funil-email-dispatch — o envio aparece na aba Atividade', () => {
  // 14/10/2026: o registro ia só para gt_task_comments, que nenhuma tela lê — quem testou
  // "não viu nada nos comentários". A aba Atividade lê o gt_activity_log.
  const ana = { Authorization: 'Bearer sessao-ana' }

  it('envio manual: linha "email_sent" com o autor, a etapa e o destinatário', async () => {
    expect((await chamar(ana, { force: true })).status).toBe(200)
    expect(atividades).toEqual([expect.objectContaining({
      task_id: 'task-1', user_id: 'u-ana', action: 'email_sent', field_changed: 'RECEPCAO', new_value: 'aluno@exemplo.com',
    })])
  })

  it('envio automático do gatilho: linha sem autor (a tela mostra "Automação")', async () => {
    await chamar({ 'x-funil-email-secret': 'segredo-certo' })
    expect(atividades).toEqual([expect.objectContaining({ action: 'email_sent', user_id: null, field_changed: 'RECEPCAO' })])
  })

  it('e-mail personalizado aparece como personalizado, não como Documentos pendentes', async () => {
    await chamar(ana, { etapa_key: 'DOCUMENTOS_PENDENTES', etapa_key_log: 'EMAIL_PERSONALIZADO', force: true, assunto_override: 'Oi', corpo_html_override: '<p>Oi</p>' })
    expect(atividades[0]).toMatchObject({ action: 'email_sent', field_changed: 'EMAIL_PERSONALIZADO', user_id: 'u-ana' })
  })

  it('falha do envio: linha "email_failed" com o motivo real', async () => {
    falhaNoEnvio = true
    await chamar(ana, { force: true })
    expect(atividades).toEqual([expect.objectContaining({ action: 'email_failed', user_id: 'u-ana', new_value: 'aluno@exemplo.com' })])
    expect((atividades[0].metadata as { motivo: string }).motivo).toContain('Caixa Gmail desconectada')
  })

  it('gatilho recusado (Documentos pendentes sem lista): linha "email_not_sent" com o motivo', async () => {
    await chamar({ 'x-funil-email-secret': 'segredo-certo' }, { etapa_key: 'DOCUMENTOS_PENDENTES' })
    expect(atividades).toEqual([expect.objectContaining({ action: 'email_not_sent', user_id: null, field_changed: 'DOCUMENTOS_PENDENTES' })])
    expect((atividades[0].metadata as { motivo: string }).motivo).toContain('Cobrar documentos')
  })

  it('recusa pela tela (vira toast) e acesso negado não deixam linha', async () => {
    await chamar(ana, { etapa_key: 'DOCUMENTOS_PENDENTES', force: true })
    await chamar({ Authorization: 'Bearer chave-anon' }, { force: true })
    expect(atividades).toEqual([])
  })
})
