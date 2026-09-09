import { describe, expect, it, vi } from 'vitest'
import { coletarSnapshotListas } from './listasSnapshot'

const agora = () => new Date('2026-09-09T15:00:00.000Z')

describe('estoque atual das listas do 3C', () => {
  it('soma todas as listas, incluindo esgotadas e reprocessadas, pelo total informado', async () => {
    const resultado = await coletarSnapshotListas(async () => ({ data: [
      { id: 1, total: 11479, dial: 10738, redial: 582, completed: 159 },
      { id: 2, total: 5120, dial: 5586, redial: 285, completed: 0 },
      { id: 3, total: 5370, dial: 0, redial: 0, completed: 5370, paused: true },
    ] }), agora)

    expect(resultado).toEqual({
      total_contatos_3c: 21969,
      quantidade_listas_3c: 3,
      listas_atualizado_em: '2026-09-09T15:00:00.000Z',
    })
  })

  it('percorre páginas declaradas e não soma a mesma lista duas vezes', async () => {
    const buscar = vi.fn(async (pagina: number) => ({
      data: pagina === 1 ? [{ id: 1, total: '15' }] : [{ id: 1, total: '15' }, { id: 2, total: 27 }],
      meta: { pagination: { total_pages: 2 } },
    }))
    expect(await coletarSnapshotListas(buscar, agora)).toMatchObject({
      total_contatos_3c: 42, quantidade_listas_3c: 2,
    })
    expect(buscar.mock.calls).toEqual([[1], [2]])
  })

  it('aceita zero apenas quando a API confirma coleção vazia ou listas zeradas', async () => {
    expect(await coletarSnapshotListas(async () => ({ data: [] }), agora)).toMatchObject({
      total_contatos_3c: 0, quantidade_listas_3c: 0,
    })
    expect(await coletarSnapshotListas(async () => ({ data: [{ id: 1, total: 0 }] }), agora)).toMatchObject({
      total_contatos_3c: 0, quantidade_listas_3c: 1,
    })
  })

  it('não devolve soma parcial se outra página falhar', async () => {
    await expect(coletarSnapshotListas(async (pagina) => {
      if (pagina === 2) throw new Error('HTTP 503')
      return { data: [{ id: 1, total: 15 }], meta: { pagination: { total_pages: 2 } } }
    }, agora)).rejects.toThrow('HTTP 503')
  })

  it.each([{}, { data: null }, { data: [{ id: 1 }] }, { data: [{ id: 1, total: -1 }] },
    { data: [{ id: 1, total: 'inválido' }] }, { data: [{ id: 1, total: null }] },
    { data: [{ total: 10 }] }])('não transforma retorno inválido em zero: %j', async (corpo) => {
    await expect(coletarSnapshotListas(async () => corpo, agora)).rejects.toThrow()
  })

  it('recusa paginação incompleta ou além do limite em vez de publicar soma truncada', async () => {
    await expect(coletarSnapshotListas(async () => ({
      data: [], meta: { pagination: { total_pages: 2 } },
    }), agora)).rejects.toThrow('incompleta')
    await expect(coletarSnapshotListas(async () => ({
      data: [{ id: 1, total: 15 }], meta: { pagination: { total_pages: 201 } },
    }), agora)).rejects.toThrow('paginação')
  })
})
