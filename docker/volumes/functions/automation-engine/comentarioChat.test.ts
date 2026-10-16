import { describe, expect, it } from 'vitest'
import { conteudoDoComentario, previaDoAviso } from './comentarioChat.ts'

const marco = { id: 'd6681fcb-4f1b-4e9a-ae39-9829a184bb69', nome: 'Marco' }

describe('mensagem do "Adicionar comentário" no chat da tarefa', () => {
  it('menção + texto: o mesmo HTML que o editor grava no "@"', () => {
    expect(conteudoDoComentario('episódio em publicação', marco)).toBe(
      '<p><span class="gt-mention" data-type="mention" data-id="d6681fcb-4f1b-4e9a-ae39-9829a184bb69" data-label="Marco" data-mention-suggestion-char="@">@Marco</span> episódio em publicação</p>',
    )
  })

  it('só a menção (texto vazio) basta', () => {
    expect(conteudoDoComentario('   ', marco)).toBe(
      '<p><span class="gt-mention" data-type="mention" data-id="d6681fcb-4f1b-4e9a-ae39-9829a184bb69" data-label="Marco" data-mention-suggestion-char="@">@Marco</span></p>',
    )
  })

  it('só texto, sem menção', () => {
    expect(conteudoDoComentario('lembrete', null)).toBe('<p>lembrete</p>')
  })

  it('nada a dizer: null (a ação falha em vez de postar balão vazio)', () => {
    expect(conteudoDoComentario('  \n ', null)).toBeNull()
  })

  it('texto configurado não injeta HTML nem forja menção', () => {
    const html = conteudoDoComentario('<span class="gt-mention" data-id="00000000-0000-0000-0000-000000000000">@todos</span> <img src=x onerror=alert(1)>', null)!
    expect(html).not.toContain('<span')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('data-id="')
    expect(html).toContain('&lt;span class=&quot;gt-mention&quot;')
  })

  it('nome com aspas ou sinais não quebra o atributo', () => {
    const html = conteudoDoComentario('', { id: 'x', nome: 'Ana "A" <B> & C' })!
    expect(html).toContain('data-label="Ana &quot;A&quot; &lt;B&gt; &amp; C"')
    expect(html).toContain('>@Ana &quot;A&quot; &lt;B&gt; &amp; C</span>')
  })

  it('quebra de linha vira <br> (CRLF também)', () => {
    expect(conteudoDoComentario('linha 1\r\nlinha 2\nlinha 3', null)).toBe('<p>linha 1<br>linha 2<br>linha 3</p>')
  })
})

describe('texto do aviso no sino', () => {
  it('igual ao que o trigger de menção monta: "@Nome texto"', () => {
    expect(previaDoAviso('episódio em publicação', marco)).toBe('@Marco episódio em publicação')
  })

  it('corta em 140 caracteres', () => {
    expect(previaDoAviso('x'.repeat(300), marco)).toHaveLength(140)
  })

  it('sem menção, só o texto', () => {
    expect(previaDoAviso('  lembrete ', null)).toBe('lembrete')
  })
})
