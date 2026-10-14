import { describe, expect, it, vi } from 'vitest'
import { autorizarDispatch, ErroAcesso, type DepsAcesso } from './acesso.ts'

const pedido = (headers: Record<string, string> = {}) =>
  new Request('https://api.exemplo.com/functions/v1/funil-email-dispatch', { method: 'POST', headers })

function deps(extra: Partial<DepsAcesso> = {}): DepsAcesso {
  return {
    chaveServico: 'chave-do-runtime',
    validarGatilho: vi.fn(async (s: string) => s === 'segredo-certo'),
    usuarioDoToken: vi.fn(async (t: string) => (t === 'sessao-ana' || t === 'sessao-ex' ? `id-${t}` : null)),
    perfil: vi.fn(async (id: string) => (id === 'id-sessao-ana' ? { ativo: true, name: 'Ana' } : { ativo: false, name: 'Ex' })),
    ...extra,
  }
}

const recusa = async (p: Promise<unknown>) => {
  const e = await p.catch((x) => x)
  expect(e).toBeInstanceOf(ErroAcesso)
  return (e as ErroAcesso).status
}

describe('quem pode disparar o e-mail do TCC', () => {
  it('sem credencial nenhuma: 401, sem nem perguntar ao Auth', async () => {
    const d = deps()
    expect(await recusa(autorizarDispatch(pedido(), d))).toBe(401)
    expect(d.usuarioDoToken).not.toHaveBeenCalled()
  })

  it('chave pública do site não é sessão: 401', async () => {
    expect(await recusa(autorizarDispatch(pedido({ Authorization: 'Bearer chave-anon' }), deps()))).toBe(401)
  })

  it('gatilho do banco com o segredo do Vault passa, mesmo com o Bearer que não bate', async () => {
    // É o caso real: o banco manda uma chave de serviço diferente da do runtime.
    const r = await autorizarDispatch(pedido({ Authorization: 'Bearer chave-do-banco', 'x-funil-email-secret': 'segredo-certo' }), deps())
    expect(r).toEqual({ tipo: 'gatilho' })
  })

  it('segredo errado é recusado, não cai para outra porta', async () => {
    const d = deps()
    expect(await recusa(autorizarDispatch(pedido({ Authorization: 'Bearer sessao-ana', 'x-funil-email-secret': 'chute' }), d))).toBe(401)
    expect(d.usuarioDoToken).not.toHaveBeenCalled()
  })

  it('chave de serviço do próprio runtime passa como interna', async () => {
    expect(await autorizarDispatch(pedido({ Authorization: 'Bearer chave-do-runtime' }), deps())).toEqual({ tipo: 'interno' })
  })

  it('colaborador ativo passa, com nome para assinar o comentário', async () => {
    expect(await autorizarDispatch(pedido({ Authorization: 'Bearer sessao-ana' }), deps()))
      .toEqual({ tipo: 'usuario', usuarioId: 'id-sessao-ana', nome: 'Ana' })
  })

  it('ex-colaborador com sessão ainda viva: 403', async () => {
    expect(await recusa(autorizarDispatch(pedido({ Authorization: 'Bearer sessao-ex' }), deps()))).toBe(403)
  })
})
