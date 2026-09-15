import { describe, expect, it, vi } from 'vitest'
import { recuperarListaAutomatica } from './recuperacao-lista'

const cfg = { nome: 'Não compareceu', campanha_id: '123', lista_id: '10' }
const lista = (id: string, ajustes: Record<string, unknown> = {}) => ({
  id, name: `Lista ${id}`, weight: 1, total: 5, created_at: '2026-09-15 10:00:00', ...ajustes,
})
const pagina = (linhas: unknown[], atual: number, paginas: number, total = 2) => ({
  data: linhas,
  meta: { pagination: { current_page: atual, total_pages: paginas, total, per_page: 1, count: linhas.length } },
})
const responder = (corpo: unknown, status = 200) => Response.json(corpo, { status })

describe('recuperação da lista automática no 3C', () => {
  it('consulta todas as páginas e conserva o ID salvo mesmo quando há uma lista automática mais nova', async () => {
    const api = vi.fn()
      .mockResolvedValueOnce(responder(pagina([lista('20', { name: 'auto | Não compareceu' })], 1, 2)))
      .mockResolvedValueOnce(responder(pagina([lista('10')], 2, 2)))
    const renovarLease = vi.fn(async () => {})

    await expect(recuperarListaAutomatica(cfg, { api, renovarLease })).resolves.toEqual({
      listaId: '10', criada: false, anteriorExcluida: false, reativada: false,
    })
    expect(api.mock.calls.map(([caminho]) => caminho)).toEqual([
      '/campaigns/123/lists?page=1', '/campaigns/123/lists?page=2',
    ])
    expect(renovarLease).toHaveBeenCalledTimes(2)
    expect(api.mock.calls.every(([, init]) => init.signal instanceof AbortSignal)).toBe(true)
  })

  it('falha sem mutações se a segunda página falha, mesmo tendo localizado o ID na primeira', async () => {
    const api = vi.fn()
      .mockResolvedValueOnce(responder(pagina([lista('10')], 1, 2)))
      .mockResolvedValueOnce(responder({ detail: 'segredo' }, 503))
    await expect(recuperarListaAutomatica(cfg, { api })).rejects.toThrow('HTTP 503')
    expect(api.mock.calls.every(([, init]) => !init.method)).toBe(true)
  })

  it('recria uma lista excluída somente após consultar a coleção inteira, sem adotar lista manual', async () => {
    const api = vi.fn()
      .mockResolvedValueOnce(responder(pagina([lista('20')], 1, 2)))
      .mockResolvedValueOnce(responder(pagina([lista('30')], 2, 2)))
      .mockResolvedValueOnce(responder({ data: { id: 40 } }))
    await expect(recuperarListaAutomatica(cfg, { api })).resolves.toEqual({
      listaId: '40', criada: true, anteriorExcluida: true, reativada: false,
    })
    expect(api.mock.calls[2]).toEqual(['/campaigns/123/lists', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ name: 'auto | Não compareceu' }),
    })])
  })

  it('recupera o nome automático determinístico quando o POST anterior foi aceito mas a resposta se perdeu', async () => {
    const remoto: ReturnType<typeof lista>[] = []
    const api = vi.fn(async (_caminho: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        remoto.push(lista('20', { name: 'auto | Não compareceu' }))
        throw new Error('Timeout na URL https://threec.invalid?api_token=segredo')
      }
      return responder({ data: remoto })
    })
    await expect(recuperarListaAutomatica(cfg, { api })).rejects.toThrow('sem resposta conclusiva')
    await expect(recuperarListaAutomatica(cfg, { api })).resolves.toEqual({
      listaId: '20', criada: false, anteriorExcluida: true, reativada: false,
    })
    expect(api.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })

  it('não confunde cópias reprocessadas com o nome exato da lista automática', async () => {
    const api = vi.fn()
      .mockResolvedValueOnce(responder({ data: [lista('20', { name: 'auto | Não compareceu - reprocessada' })] }))
      .mockResolvedValueOnce(responder({ data: { id: '30' } }))
    await expect(recuperarListaAutomatica(cfg, { api })).resolves.toMatchObject({ listaId: '30', criada: true })
    expect(api.mock.calls[1][1].method).toBe('POST')
  })

  it('na primeira configuração adota a manual mais recente sem criar outra', async () => {
    const api = vi.fn().mockResolvedValueOnce(responder([
      lista('20', { created_at: '2026-09-15 11:00:00' }),
      lista('30', { created_at: '2026-09-15 10:00:00' }),
    ]))
    await expect(recuperarListaAutomatica({ ...cfg, lista_id: null }, { api })).resolves.toEqual({
      listaId: '20', criada: false, anteriorExcluida: false, reativada: false,
    })
    expect(api).toHaveBeenCalledOnce()
  })

  it('também recupera uma criação sem persistência quando o primeiro ponteiro ainda é nulo', async () => {
    const api = vi.fn().mockResolvedValueOnce(responder({ data: [
      lista('20', { name: 'auto | Não compareceu' }), lista('30'),
    ] }))
    await expect(recuperarListaAutomatica({ ...cfg, lista_id: null }, { api })).resolves.toMatchObject({
      listaId: '20', criada: false, anteriorExcluida: false,
    })
  })

  it('cria uma primeira lista vazia sem exigir peso positivo antes do abastecimento', async () => {
    const api = vi.fn()
      .mockResolvedValueOnce(responder({ data: [] }))
      .mockResolvedValueOnce(responder({ data: { id: '20', weight: 0, total: 0 } }))
    await expect(recuperarListaAutomatica({ ...cfg, lista_id: null }, { api })).resolves.toEqual({
      listaId: '20', criada: true, anteriorExcluida: false, reativada: false,
    })
    expect(api).toHaveBeenCalledTimes(2)
  })

  it.each([undefined, 3])('reativa estoque com peso zero e confirma na releitura (peso configurado %s)', async (peso) => {
    const api = vi.fn()
      .mockResolvedValueOnce(responder({ data: [lista('10', { weight: '0' })] }))
      .mockResolvedValueOnce(responder({ data: { id: '10', weight: peso ?? 1 } }))
      .mockResolvedValueOnce(responder({ data: [lista('10', { weight: peso ?? 1 })] }))
    await expect(recuperarListaAutomatica({ ...cfg, peso }, { api })).resolves.toEqual({
      listaId: '10', criada: false, anteriorExcluida: false, reativada: true,
    })
    expect(api.mock.calls[1]).toEqual(['/campaigns/123/lists/10/updateWeight', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ weight: peso ?? 1 }),
    })])
    expect(api.mock.calls[2][0]).toBe('/campaigns/123/lists?page=1')
  })

  it('preserva peso positivo definido pelo usuário', async () => {
    const api = vi.fn().mockResolvedValueOnce(responder({ data: [lista('10', { weight: 5 })] }))
    await expect(recuperarListaAutomatica({ ...cfg, peso: 2 }, { api })).resolves.toMatchObject({ reativada: false })
    expect(api).toHaveBeenCalledOnce()
  })

  it.each([
    { weight: 0, total: 0 },
    { weight: 0, total: 50, dial: 0, redial: 0 },
  ])('não confunde lista vazia ou concluída com desativação: %j', async (estoque) => {
    const api = vi.fn().mockResolvedValueOnce(responder({ data: [lista('10', estoque)] }))
    await expect(recuperarListaAutomatica(cfg, { api })).resolves.toMatchObject({ listaId: '10', reativada: false })
    expect(api).toHaveBeenCalledOnce()
  })

  it('permite adiar a reativação enquanto o expurgo ainda está pendente', async () => {
    const api = vi.fn().mockResolvedValueOnce(responder({ data: [lista('10', { weight: 0 })] }))
    await expect(recuperarListaAutomatica({ ...cfg, reativar: false }, { api })).resolves.toMatchObject({ reativada: false })
    expect(api).toHaveBeenCalledOnce()
  })

  it.each([{ releitura: [] }, { releitura: [lista('10', { weight: 0 })] }])('não afirma reativação apenas pelo HTTP 200', async ({ releitura }) => {
    const api = vi.fn()
      .mockResolvedValueOnce(responder({ data: [lista('10', { weight: 0 })] }))
      .mockResolvedValueOnce(responder({ status: 200 }))
      .mockResolvedValueOnce(responder({ data: releitura }))
    await expect(recuperarListaAutomatica(cfg, { api })).rejects.toThrow('reativação de lista não confirmada')
    expect(api.mock.calls.some(([, init]) => init.method === 'POST')).toBe(false)
  })

  it.each([
    null,
    {},
    { data: {} },
    { status: 422, data: [] },
    { data: [], meta: null },
    { data: [], meta: { pagination: null } },
    { data: [lista('20', { id: '' })] },
    { data: [lista('20', { weight: null })] },
    { data: [lista('20', { total: 'desconhecido' })] },
    { data: [lista('20', { dial: -1 })] },
    { data: [lista('20', { name: null })] },
    { data: [lista('20'), lista('20')] },
    pagina([], 1, 2),
    pagina([lista('20')], 2, 2),
    pagina([lista('20')], 1, 1, 2),
    { ...pagina([lista('20')], 1, 1, 1), meta: { pagination: { current_page: 1, total_pages: 1, count: 0 } } },
    { data: [], meta: { pagination: { current_page: 1, total_pages: 201 } } },
    { data: [], meta: { pagination: { current_page: 1, links: { next: 'https://outro.invalid/?api_token=segredo' } } } },
  ])('nunca cria nem altera após coleção inválida/inconclusiva: %j', async (corpo) => {
    const api = vi.fn().mockResolvedValueOnce(responder(corpo))
    await expect(recuperarListaAutomatica(cfg, { api })).rejects.toThrow('3C:')
    expect(api).toHaveBeenCalledOnce()
    expect(api.mock.calls[0][1].method).toBeUndefined()
  })

  it.each([
    pagina([lista('30')], 2, 3, 3),
    { data: [lista('30')] },
    pagina([lista('20')], 2, 2),
  ])('interrompe se a coleção muda durante a paginação', async (segundaPagina) => {
    const api = vi.fn()
      .mockResolvedValueOnce(responder(pagina([lista('20')], 1, 2)))
      .mockResolvedValueOnce(responder(segundaPagina))
    await expect(recuperarListaAutomatica(cfg, { api })).rejects.toThrow('durante a consulta')
    expect(api.mock.calls.every(([, init]) => !init.method)).toBe(true)
  })

  it.each([
    new Error('Falhou https://threec.invalid/?api_token=segredo'),
    new DOMException('Timeout https://threec.invalid/?api_token=segredo', 'TimeoutError'),
  ])('não expõe URL/token em erros de rede ou timeout', async (erro) => {
    const api = vi.fn().mockRejectedValueOnce(erro)
    const resultado = await recuperarListaAutomatica(cfg, { api }).catch((e: Error) => e)
    expect(resultado).toBeInstanceOf(Error)
    expect((resultado as Error).message).toBe('3C: falha ao consultar listas; requisição sem resposta conclusiva')
    expect(api).toHaveBeenCalledOnce()
  })

  it('interrompe antes de chamar a API quando perdeu a exclusividade da lista', async () => {
    const erro = new Error('Posse da lista perdida')
    const api = vi.fn()
    const renovarLease = vi.fn().mockRejectedValueOnce(erro)
    await expect(recuperarListaAutomatica(cfg, { api, renovarLease })).rejects.toBe(erro)
    expect(api).not.toHaveBeenCalled()
  })

  it('recusa corpo não JSON sem carregar HTML com credenciais para o erro', async () => {
    const api = vi.fn().mockResolvedValueOnce(new Response('<html>api_token=segredo</html>'))
    await expect(recuperarListaAutomatica(cfg, { api })).rejects.toThrow('resposta JSON inválida')
    expect(api).toHaveBeenCalledOnce()
  })

  it.each([{ data: {} }, { data: { id: 0 } }, { data: { id: '20' } }, { status: 500, data: { id: '30' } }])(
    'não persiste criação sem um identificador novo confirmado: %j', async (corpo) => {
      const api = vi.fn()
        .mockResolvedValueOnce(responder({ data: [lista('20')] }))
        .mockResolvedValueOnce(responder(corpo))
      await expect(recuperarListaAutomatica(cfg, { api })).rejects.toThrow('3C:')
      expect(api).toHaveBeenCalledTimes(2)
    },
  )
})
