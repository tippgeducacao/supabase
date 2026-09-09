// O total de /lists pertence ao estoque ATUAL de cada lista. O phones.total de
// /lists/total_metrics muda com a janela de datas e não responde essa pergunta.
export interface SnapshotListas {
  total_contatos_3c: number
  quantidade_listas_3c: number
  listas_atualizado_em: string
}

type Objeto = Record<string, unknown>
const objeto = (valor: unknown): Objeto | null =>
  valor !== null && typeof valor === 'object' && !Array.isArray(valor) ? valor as Objeto : null

function inteiro(valor: unknown): number | null {
  if (typeof valor !== 'number' && !(typeof valor === 'string' && /^\d+$/.test(valor))) return null
  const numero = Number(valor)
  return Number.isSafeInteger(numero) && numero >= 0 ? numero : null
}

// A API atualmente entrega /lists sem meta, mas outros endpoints usam
// meta.pagination. Respeitamos páginas declaradas, deduplicando a identidade da
// lista entre páginas. Qualquer página incompleta invalida o snapshot inteiro.
export async function coletarSnapshotListas(
  buscarPagina: (pagina: number) => Promise<unknown>,
  agora: () => Date = () => new Date(),
): Promise<SnapshotListas> {
  const listas = new Map<string, number>()
  for (let pagina = 1; pagina <= 200; pagina++) {
    const corpo = objeto(await buscarPagina(pagina))
    if (!corpo || !Array.isArray(corpo.data)) throw new Error('resposta de listas inválida')
    const meta = objeto(corpo.meta)
    const paginacao = objeto(meta?.pagination)
    const paginas = paginacao ? inteiro(paginacao.total_pages) : null
    if (paginacao && (paginas === null || paginas < 1 || paginas > 200)) {
      throw new Error('paginação de listas inválida')
    }
    if (paginas !== null && pagina < paginas && corpo.data.length === 0) {
      throw new Error('página de listas incompleta')
    }

    for (const item of corpo.data) {
      const lista = objeto(item)
      const id = lista?.id
      const total = inteiro(lista?.total)
      if ((typeof id !== 'string' && typeof id !== 'number') || String(id) === '' || total === null) {
        throw new Error('lista sem identificador ou total válido')
      }
      listas.set(String(id), total)
    }

    // Sem metadados, /lists entrega a coleção inteira (verificado na API).
    if (paginas === null || pagina >= paginas) {
      const total = [...listas.values()].reduce((soma, n) => soma + n, 0)
      if (!Number.isSafeInteger(total)) throw new Error('total de listas inválido')
      return {
        total_contatos_3c: total,
        quantidade_listas_3c: listas.size,
        listas_atualizado_em: agora().toISOString(),
      }
    }
  }
  throw new Error('paginação de listas excedeu o limite')
}
