import { describe, expect, it } from 'vitest'
import { htmlDocsFaltantes, itensDocsFaltantes } from './docsFaltantes.ts'
import { renderizarTags } from '../_shared/emailBuilder/mergeTags.ts'

describe('lista de documentos pendentes do TCC', () => {
  it('texto um por linha vira os itens, sem linha vazia', () => {
    expect(itensDocsFaltantes('Termo de Aceite de Orientação\r\n\n  Ficha de Cadastro do Orientador  \n'))
      .toEqual(['Termo de Aceite de Orientação', 'Ficha de Cadastro do Orientador'])
  })

  it('aceita o HTML do bundle antigo e devolve o texto original de cada item', () => {
    const antigo = '<ul><li>Termo de Aceite</li><li>RG &amp; CPF</li><li>&lt;outro&gt;</li></ul>'
    expect(itensDocsFaltantes(antigo)).toEqual(['Termo de Aceite', 'RG & CPF', '<outro>'])
  })

  it('monta a lista escapando cada item — nada digitado vira markup', () => {
    expect(htmlDocsFaltantes(['Termo', '<img src=x onerror=alert(1)>']))
      .toBe('<ul><li>Termo</li><li>&lt;img src=x onerror=alert(1)&gt;</li></ul>')
    expect(htmlDocsFaltantes([])).toBe('')
    expect(itensDocsFaltantes(undefined)).toEqual([])
  })

  it('o e-mail do print de 24/09 sai com lista de verdade', () => {
    // Corpo do modelo "TCC - Documentos Pendentes (manual)" como está no banco.
    const corpo = '<p>Olá, {{nome_aluno}}.</p><p> {{docs_faltantes}}</p>'
    const docs = htmlDocsFaltantes(itensDocsFaltantes(
      'Termo de Aceite de Orientação\nFicha de Cadastro do Orientador\nDeclaração do Revisor de Língua Portuguesa\nProblemas de formatação do template.',
    ))
    const html = renderizarTags(corpo, { nome_aluno: 'Adriane Ferreira Frizzo', docs_faltantes: docs }, { variaveisHtml: ['docs_faltantes'] })
    expect(html).toContain('<ul><li>Termo de Aceite de Orientação</li><li>Ficha de Cadastro do Orientador</li>')
    expect(html).not.toContain('&lt;ul&gt;')
  })
})
