// O ID salvo não prova que a lista ainda existe no 3C. Antes de trocar o ponteiro,
// precisamos de uma coleção inteira: uma página truncada não autoriza recriação.
// O nome estável permite recuperar um POST aceito cujo retorno/persistência falhou.
export interface ConfiguracaoListaAutomatica {
  nome: string
  campanha_id: string
  lista_id: string | null
  peso?: number
  // O chamador só libera a reativação depois de retirar os contatos inelegíveis.
  reativar?: boolean
}

export interface DependenciasRecuperacaoLista {
  // Recebe somente caminhos relativos. Base e credencial ficam no chamador.
  api: (caminho: string, init?: RequestInit) => Promise<Response>
  renovarLease?: () => Promise<void>
}

export interface RecuperacaoListaAutomatica {
  listaId: string
  criada: boolean
  anteriorExcluida: boolean
  reativada: boolean
}

interface ListaRemota {
  id: string
  nome: string
  peso: number
  estoque: number
  criadaEm: string
}

const MAX_PAGINAS = 200
const API_TIMEOUT_MS = 60_000

function objeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
}

function inteiro(valor: unknown): number | null {
  if (typeof valor !== 'number' && !(typeof valor === 'string' && /^\d+$/.test(valor))) return null
  const numero = Number(valor)
  return Number.isSafeInteger(numero) && numero >= 0 ? numero : null
}

function identificador(valor: unknown): string | null {
  if (typeof valor === 'string' && valor.trim() !== '' && valor.trim() === valor) return valor
  if (typeof valor === 'number' && Number.isSafeInteger(valor) && valor > 0) return String(valor)
  return null
}

function validarLista(valor: unknown): ListaRemota {
  if (!objeto(valor)) throw new Error('3C: registro de lista inválido')
  const id = identificador(valor.id)
  const peso = inteiro(valor.weight)
  const total = inteiro(valor.total)
  if (id === null || typeof valor.name !== 'string' || peso === null || total === null) {
    throw new Error('3C: lista sem identificação, nome, peso ou estoque válido')
  }
  const dial = valor.dial === undefined ? null : inteiro(valor.dial)
  const redial = valor.redial === undefined ? null : inteiro(valor.redial)
  if ((valor.dial !== undefined && dial === null) || (valor.redial !== undefined && redial === null)) {
    throw new Error('3C: estoque discável inválido')
  }
  return {
    id, nome: valor.name, peso,
    // Total inclui contatos concluídos. Uma lista esgotada não está desativada.
    estoque: dial !== null && redial !== null ? dial + redial : total,
    criadaEm: typeof valor.created_at === 'string' ? valor.created_at : '',
  }
}

async function consultar(
  deps: DependenciasRecuperacaoLista,
  caminho: string,
  operacao: string,
  init: RequestInit = {},
): Promise<unknown> {
  // Fora do catch para conservar o tipo de erro de posse usado pelo chamador.
  await deps.renovarLease?.()
  let resposta: Response
  try {
    resposta = await deps.api(caminho, {
      ...init,
      headers: { Accept: 'application/json', ...init.headers },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    })
  } catch {
    // Erros de fetch podem conter a URL autenticada. Nunca transportar o original.
    throw new Error(`3C: falha ao ${operacao}; requisição sem resposta conclusiva`)
  }
  if (!resposta.ok) throw new Error(`3C: falha ao ${operacao}; HTTP ${resposta.status}`)
  let corpo: unknown
  try {
    corpo = await resposta.json()
  } catch {
    throw new Error(`3C: falha ao ${operacao}; resposta JSON inválida`)
  }
  if (objeto(corpo) && corpo.status !== undefined) {
    const status = inteiro(corpo.status)
    if (status === null || status < 200 || status >= 300) {
      throw new Error(`3C: falha ao ${operacao}; envelope sem confirmação de sucesso`)
    }
  }
  return corpo
}

async function listarTodas(deps: DependenciasRecuperacaoLista, caminho: string): Promise<ListaRemota[]> {
  const listas = new Map<string, ListaRemota>()
  let paginasEsperadas: number | null = null
  let totalEsperado: number | null = null
  let tamanhoEsperado: number | null = null
  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const corpo = await consultar(deps, `${caminho}?page=${pagina}`, 'consultar listas')
    const linhas = Array.isArray(corpo) ? corpo : objeto(corpo) ? corpo.data : null
    if (!Array.isArray(linhas)) throw new Error('3C: coleção de listas inválida')
    const meta = objeto(corpo) ? corpo.meta : undefined
    if (meta !== undefined && !objeto(meta)) throw new Error('3C: metadados de listas inválidos')
    const paginacao = objeto(meta) ? meta.pagination : undefined
    let paginas: number | null = null
    let total: number | null = null
    let tamanho: number | null = null
    if (paginacao !== undefined) {
      if (!objeto(paginacao)) throw new Error('3C: paginação de listas inválida')
      paginas = inteiro(paginacao.total_pages)
      total = paginacao.total === undefined ? null : inteiro(paginacao.total)
      tamanho = paginacao.per_page === undefined ? null : inteiro(paginacao.per_page)
      if (paginas === null || paginas < pagina || paginas > MAX_PAGINAS
        || inteiro(paginacao.current_page) !== pagina
        || (paginacao.total !== undefined && total === null)
        || (paginacao.per_page !== undefined && (tamanho === null || tamanho < 1))
        || (paginacao.count !== undefined && inteiro(paginacao.count) !== linhas.length)) {
        throw new Error('3C: paginação de listas inválida')
      }
      if ((pagina < paginas && linhas.length === 0)
        || (tamanho !== null && linhas.length > tamanho)
        || (tamanho !== null && pagina < paginas && linhas.length !== tamanho)
        || (total !== null && tamanho !== null && Math.max(1, Math.ceil(total / tamanho)) !== paginas)) {
        throw new Error('3C: página de listas incompleta')
      }
      if (objeto(paginacao.links) && paginacao.links.next != null && paginacao.links.next !== '') {
        if (typeof paginacao.links.next !== 'string' || pagina >= paginas) {
          throw new Error('3C: continuação de listas incompatível com a paginação')
        }
      }
    }
    if (pagina > 1 && (paginas !== paginasEsperadas || total !== totalEsperado || tamanho !== tamanhoEsperado)) {
      throw new Error('3C: paginação de listas mudou durante a consulta')
    }
    paginasEsperadas = paginas
    totalEsperado = total
    tamanhoEsperado = tamanho
    for (const linha of linhas) {
      const lista = validarLista(linha)
      if (listas.has(lista.id)) throw new Error('3C: coleção de listas repetida ou alterada durante a consulta')
      listas.set(lista.id, lista)
    }
    if (paginas === null || pagina === paginas) {
      if (total !== null && listas.size !== total) throw new Error('3C: coleção de listas incompleta')
      return [...listas.values()]
    }
  }
  throw new Error('3C: limite de páginas de listas excedido')
}

/**
 * Inventário COMPLETO das listas de uma campanha, com as mesmas garantias da recuperação
 * (paginação conferida, coleção que não mudou durante a leitura). A renovação noturna só
 * apaga a partir de um inventário inteiro: página truncada não autoriza apagar nada.
 */
export async function listarListasDaCampanha(
  campanhaId: string, deps: DependenciasRecuperacaoLista,
): Promise<Array<{ id: string; nome: string; estoque: number }>> {
  if (!identificador(campanhaId)) throw new Error('3C: campanha inválida')
  const listas = await listarTodas(deps, `/campaigns/${encodeURIComponent(campanhaId)}/lists`)
  return listas.map((l) => ({ id: l.id, nome: l.nome, estoque: l.estoque }))
}

function maisRecente(listas: ListaRemota[]): ListaRemota | undefined {
  return [...listas].sort((a, b) => b.criadaEm.localeCompare(a.criadaEm)
    || b.id.localeCompare(a.id, undefined, { numeric: true }))[0]
}

export async function recuperarListaAutomatica(
  cfg: ConfiguracaoListaAutomatica,
  deps: DependenciasRecuperacaoLista,
): Promise<RecuperacaoListaAutomatica> {
  if (!cfg.nome.trim() || !identificador(cfg.campanha_id)
    || (cfg.lista_id !== null && !identificador(cfg.lista_id))
    || (cfg.peso !== undefined && (inteiro(cfg.peso) === null || cfg.peso < 1))) {
    throw new Error('3C: configuração de lista automática inválida')
  }
  const caminho = `/campaigns/${encodeURIComponent(cfg.campanha_id)}/lists`
  const nomeAutomatico = `auto | ${cfg.nome}`.slice(0, 60)
  const listas = await listarTodas(deps, caminho)
  const salva = listas.find((lista) => lista.id === cfg.lista_id)
  const anteriorExcluida = cfg.lista_id !== null && salva === undefined
  // Após exclusão, uma lista manual tem histórico próprio e não pode receber o
  // estoque recuperado. Adoção livre permanece apenas na primeira configuração.
  const encontrada = salva
    ?? maisRecente(listas.filter((lista) => lista.nome === nomeAutomatico))
    ?? (cfg.lista_id === null ? maisRecente(listas) : undefined)

  if (!encontrada) {
    const corpo = await consultar(deps, caminho, 'criar lista automática', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nomeAutomatico }),
    })
    const recurso = objeto(corpo) && corpo.data !== undefined ? corpo.data : corpo
    const id = objeto(recurso) ? identificador(recurso.id) : null
    if (!id || listas.some((lista) => lista.id === id)) throw new Error('3C: criação de lista sem identificador novo válido')
    // A nova lista ainda está vazia; inserir o primeiro mailing libera seu peso.
    return { listaId: id, criada: true, anteriorExcluida, reativada: false }
  }

  let reativada = false
  if (cfg.reativar !== false && encontrada.peso === 0 && encontrada.estoque > 0) {
    await consultar(deps, `${caminho}/${encodeURIComponent(encontrada.id)}/updateWeight`, 'reativar lista automática', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weight: cfg.peso ?? 1 }),
    })
    // HTTP 200 sozinho não prova alteração no 3C (há endpoints que ignoram campos).
    const confirmada = (await listarTodas(deps, caminho)).find((lista) => lista.id === encontrada.id)
    if (!confirmada || confirmada.peso === 0) throw new Error('3C: reativação de lista não confirmada na releitura')
    reativada = true
  }
  return { listaId: encontrada.id, criada: false, anteriorExcluida, reativada }
}
