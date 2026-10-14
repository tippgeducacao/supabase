import { describe, expect, it } from 'vitest'
import { MAX_DESTINATARIOS, MODELOS_MANUAIS, recusarPedido } from './regrasEnvio.ts'

const pessoas = (n: number) => Array.from({ length: n }, (_, i) => ({ email: `a${i}@exemplo.com` }))

describe('o que um pedido ao funil do TCC pode pedir', () => {
  it('envio comum de etapa passa', () => {
    expect(recusarPedido({ etapa_key: 'CORRECAO_V1', destinatarios_override: pessoas(2) })).toBeNull()
  })

  it('modelo manual da Aprovação passa; qualquer outro modelo é recusado', () => {
    expect(recusarPedido({ etapa_key: 'APROVACAO', template_id_override: MODELOS_MANUAIS.APROVACAO })).toBeNull()
    // Modelo de marketing (remetente do Resend) — o caminho do achado de 14/10.
    expect(recusarPedido({ etapa_key: 'DOCUMENTOS_PENDENTES', template_id_override: '59002b7b-ad24-4b9a-8aff-09709d1f0197', corpo_html_override: '<p>x</p>' }))
      .toMatchObject({ status: 403 })
    // O manual da Aprovação não vale em outra etapa.
    expect(recusarPedido({ etapa_key: 'CORRECAO_V1', template_id_override: MODELOS_MANUAIS.APROVACAO })).toMatchObject({ status: 403 })
  })

  it(`até ${MAX_DESTINATARIOS} destinatários por envio`, () => {
    expect(recusarPedido({ etapa_key: 'CORRECAO_V1', destinatarios_override: pessoas(MAX_DESTINATARIOS) })).toBeNull()
    expect(recusarPedido({ etapa_key: 'CORRECAO_V1', destinatarios_override: pessoas(MAX_DESTINATARIOS + 1) })).toMatchObject({ status: 400 })
  })

  it('Documentos pendentes sem documento é recusado com mensagem legível (200), em vez de sair "{{docs_faltantes}}"', () => {
    const r = recusarPedido({ etapa_key: 'DOCUMENTOS_PENDENTES' })
    expect(r).toMatchObject({ status: 200 })
    expect(r?.error).toContain('Cobrar documentos')
    expect(recusarPedido({ etapa_key: 'DOCUMENTOS_PENDENTES', docs_faltantes: '  \n ' })).toMatchObject({ status: 200 })
  })

  it('Documentos pendentes com documento (texto ou HTML antigo) passa; e-mail personalizado não precisa de lista', () => {
    expect(recusarPedido({ etapa_key: 'DOCUMENTOS_PENDENTES', docs_faltantes: 'Termo de Aceite' })).toBeNull()
    expect(recusarPedido({ etapa_key: 'DOCUMENTOS_PENDENTES', docs_faltantes: '<ul><li>Termo</li></ul>' })).toBeNull()
    expect(recusarPedido({ etapa_key: 'DOCUMENTOS_PENDENTES', corpo_html_override: '<p>Oi</p>' })).toBeNull()
  })
})
