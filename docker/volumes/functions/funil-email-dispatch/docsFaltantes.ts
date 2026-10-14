// Lista de documentos pendentes do TCC (`{{docs_faltantes}}`) — o HTML é montado AQUI.
//
// Desde 17/09/2026 (e8930daef) o email-send escapa o valor de toda merge tag no HTML.
// Certo para nome de lead, errado para esta lista: a aba Comunicação mandava `<ul><li>…`
// pronto e o aluno recebia as tags como texto (todos os 7 envios de 23/09 a 10/10).
// Agora quem chama manda TEXTO, um documento por linha; a lista sai daqui com cada item
// escapado e vai ao email-send marcada em `variaveis_html` — a única porta de HTML em
// variável.
//
// Aceita também o formato antigo (`<ul><li>…</li></ul>`): aba aberta com o bundle velho
// continua mandando HTML por dias depois do deploy.
import { escaparHtml } from '../_shared/emailBuilder/mergeTags.ts'

const ENTIDADES: Record<string, string> = {
  '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&',
}

/** Itens de texto puro, na ordem, sem vazios. */
export function itensDocsFaltantes(valor: string | null | undefined): string[] {
  if (!valor) return []
  if (/<li[\s>]/i.test(valor)) {
    // Formato antigo: o front escapava cada item antes de montar o <li>.
    return [...valor.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
      .map((m) => m[1].replace(/<[^>]*>/g, '').replace(/&(?:lt|gt|quot|#39|amp);/g, (e) => ENTIDADES[e]).trim())
      .filter(Boolean)
  }
  return valor.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

/** `<ul>` com cada item escapado; vazio quando não há item (a tag segue o padrão do modelo). */
export function htmlDocsFaltantes(itens: string[]): string {
  if (!itens.length) return ''
  return `<ul>${itens.map((i) => `<li>${escaparHtml(i)}</li>`).join('')}</ul>`
}
