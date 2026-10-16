import { describe, expect, it, vi } from 'vitest'
import { autorDoAtor, resolverAtor, type DepsAtor } from './ator.ts'

const pedido = (headers: Record<string, string> = {}) =>
  new Request('https://api.exemplo.com/functions/v1/automation-engine', { method: 'POST', headers })

function deps(extra: Partial<DepsAtor> = {}): DepsAtor {
  return {
    chaveServico: 'chave-do-runtime',
    usuarioDoToken: vi.fn(async (t: string) => (t === 'sessao-ana' || t === 'sessao-ex' ? `id-${t}` : null)),
    perfilAtivo: vi.fn(async (id: string) => id === 'id-sessao-ana'),
    ...extra,
  }
}

describe('quem assina o que o motor escreve', () => {
  it('sem cabeçalho: ninguém, sem nem perguntar ao Auth', async () => {
    const d = deps()
    expect(await resolverAtor(pedido(), 'id-de-alguem', d)).toEqual({ tipo: 'ninguem' })
    expect(d.usuarioDoToken).not.toHaveBeenCalled()
  })

  it('o user_id do corpo NÃO vale sem token — é o que um anônimo forjaria', async () => {
    const a = await resolverAtor(pedido(), 'id-da-diretoria', deps())
    expect(autorDoAtor(a)).toBeNull()
  })

  it('chave pública do site não é sessão: ninguém', async () => {
    const a = await resolverAtor(pedido({ Authorization: 'Bearer chave-publica' }), 'id-x', deps())
    expect(a).toEqual({ tipo: 'ninguem' })
  })

  it('colaborador ativo: o id do TOKEN, mesmo que o corpo diga outro', async () => {
    const a = await resolverAtor(pedido({ Authorization: 'Bearer sessao-ana' }), 'id-da-diretoria', deps())
    expect(a).toEqual({ tipo: 'usuario', usuarioId: 'id-sessao-ana' })
  })

  it('sessão viva de ex-colaborador (perfil inativo): ninguém', async () => {
    const a = await resolverAtor(pedido({ Authorization: 'Bearer sessao-ex' }), null, deps())
    expect(a).toEqual({ tipo: 'ninguem' })
  })

  it('chave de serviço do runtime (encadeamento do próprio motor): confia no user_id repassado', async () => {
    const d = deps()
    const a = await resolverAtor(pedido({ Authorization: 'Bearer chave-do-runtime' }), 'id-sessao-ana', d)
    expect(a).toEqual({ tipo: 'interno', usuarioId: 'id-sessao-ana' })
    expect(d.usuarioDoToken).not.toHaveBeenCalled()
  })

  it('encadeamento sem usuário: interno, sem autor', async () => {
    const a = await resolverAtor(pedido({ Authorization: 'Bearer chave-do-runtime' }), null, deps())
    expect(a).toEqual({ tipo: 'interno', usuarioId: null })
    expect(autorDoAtor(a)).toBeNull()
  })

  it('user_id do corpo que não é texto não vira autor nem no encadeamento', async () => {
    const a = await resolverAtor(pedido({ Authorization: 'Bearer chave-do-runtime' }), { id: 'x' }, deps())
    expect(a).toEqual({ tipo: 'interno', usuarioId: null })
  })

  it('cabeçalho "Bearer" vazio: ninguém', async () => {
    const d = deps({ chaveServico: '' })
    expect(await resolverAtor(pedido({ Authorization: 'Bearer ' }), 'id-x', d)).toEqual({ tipo: 'ninguem' })
    expect(d.usuarioDoToken).not.toHaveBeenCalled()
  })

  it('sem chave de serviço configurada no runtime, nada passa por interno', async () => {
    const d = deps({ chaveServico: undefined })
    const a = await resolverAtor(pedido({ Authorization: 'Bearer qualquer-coisa' }), 'id-x', d)
    expect(a).toEqual({ tipo: 'ninguem' })
    expect(d.usuarioDoToken).toHaveBeenCalledWith('qualquer-coisa')
  })

  it('Auth fora do ar: ninguém (não derruba o motor)', async () => {
    const d = deps({ usuarioDoToken: vi.fn(async () => { throw new Error('auth 503') }) })
    expect(await resolverAtor(pedido({ Authorization: 'Bearer sessao-ana' }), null, d)).toEqual({ tipo: 'ninguem' })
  })

  it('aceita "bearer" minúsculo, como o fetch de qualquer cliente', async () => {
    const a = await resolverAtor(pedido({ Authorization: 'bearer sessao-ana' }), null, deps())
    expect(a).toEqual({ tipo: 'usuario', usuarioId: 'id-sessao-ana' })
  })
})
