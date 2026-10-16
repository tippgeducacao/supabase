// Conteúdo da mensagem que a ação "Adicionar comentário" grava no chat da tarefa
// (16/10/2026). Puro, para testar sem banco.
//
// O HTML é o mesmo que o editor do chat (TipTap/Mention) grava ao escolher alguém no "@":
// o chip laranja aparece igual ao da menção manual, e a sanitização da tela
// (sanitizarHtmlRico/DOMPurify) mantém class e data-*. Texto e nome são escapados — as
// aspas viram &quot;, então o texto configurado na automação não forja um span de menção.

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export interface Mencao {
  id: string
  nome: string
}

/** HTML da mensagem, ou null quando não há o que dizer (sem texto e sem menção). */
export function conteudoDoComentario(texto: string, mencao: Mencao | null): string | null {
  const span = mencao
    ? `<span class="gt-mention" data-type="mention" data-id="${escapeHtml(mencao.id)}" data-label="${escapeHtml(mencao.nome)}" data-mention-suggestion-char="@">@${escapeHtml(mencao.nome)}</span>`
    : ''
  const corpo = escapeHtml(texto.trim()).replace(/\r?\n/g, '<br>')
  if (!span && !corpo) return null
  return `<p>${[span, corpo].filter(Boolean).join(' ')}</p>`
}

/** Texto do aviso no sino (sem HTML, até 140 caracteres), como o trigger de menção monta. */
export function previaDoAviso(texto: string, mencao: Mencao | null): string {
  return [mencao ? `@${mencao.nome}` : '', texto.trim()].filter(Boolean).join(' ').slice(0, 140)
}
