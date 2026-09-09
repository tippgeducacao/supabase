// Espelho dos bloqueios expressos do 3C para a SDR. Nunca interpreta agenda,
// sem interesse ou comportamento not-call-* como bloqueio por conta própria.
// A API filtra pela data da chamada, sem filtro documentado por updated_at:
// sobrepor 48 h cobre qualificações tardias recentes, não edições arbitrariamente
// antigas. Blacklist/DND nativos continuam sendo proteção independente no 3C.

type Registro = Record<string, unknown>
type ResultadoDB = { data: unknown; error: unknown }
interface Banco {
  rpc(nome: string, argumentos?: Registro): PromiseLike<ResultadoDB>
  from(tabela: string): {
    select(colunas: string): {
      eq(coluna: string, valor: boolean): { maybeSingle(): PromiseLike<ResultadoDB> }
    }
  }
}
interface Opcoes {
  supabase: Banco
  base: string
  token: string
  signal?: AbortSignal
}
interface Bloqueio {
  canon: string
  origem: '3c_qualificacao' | '3c_blacklist'
  fonte_id: string
  fonte_qualid: string | null
  categoria: 'aluno' | 'bloqueado'
  bloqueado_em: string
  valid_until: string | null
  permanente: boolean
  ativo: boolean
  verificado_em: string
}
const HORA = 3_600_000
const MAX_PAGINAS = 200
const MAX_POR_RPC = 500
// Apenas configuração, nunca estado de blacklist por telefone. Falha ao renovar
// não reutiliza configuração vencida. O overlap recupera eventos das regras novas.
let cacheRegras: { base: string; token: string; ate: number; regras: Map<string, Registro> } | null = null
const objeto = (v: unknown): v is Registro => !!v && typeof v === 'object' && !Array.isArray(v)
function falhar(codigo: string): never { throw new Error(`Falha ao atualizar bloqueios 3C (${codigo})`) }
const id = (v: unknown): string => typeof v === 'string' || typeof v === 'number' ? String(v) : ''

// Mesma identidade DDD+últimos8 de fn_canon_ddd8. O número original normalizado
// (com o nono dígito, quando existe) é preservado para consultar /blacklist/number.
function telefone(v: unknown): string | null {
  let d = id(v).replace(/\D/g, '').replace(/^0+/, '')
  // Mesmos reparos de telefone_br_normalizar: DDI duplicado e zeros de
  // operadora entre DDI/DDD. Nacional com DDD55 deve continuar nacional.
  while (d.length > 13 && d.startsWith('5555')) d = d.slice(2)
  if (d.startsWith('550') && d.length >= 13) d = '55' + d.slice(2).replace(/^0+/, '')
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2)
  return /^\d{10,11}$/.test(d) && d[0] >= '1' && d[1] >= '1' ? d : null
}
const canon = (numero: string): string => numero.slice(0, 2) + numero.slice(-8)
function dataUTC(v: unknown): string | null {
  // /blacklist/number devolve UNIX seconds numérico (confirmado em produção),
  // enquanto /calls usa RFC3339. Zero é um prazo expirado, nunca permanência.
  if (typeof v === 'number' || typeof v === 'string' && /^\d+(?:\.\d+)?$/.test(v)) {
    const n = Number(v)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null
    const ms = n < 100_000_000_000 ? n * 1000 : n
    if (ms > Date.UTC(3000, 0, 1)) return null
    return new Date(ms).toISOString()
  }
  if (typeof v !== 'string' || !v.trim()) return null
  const texto = v.trim()
  const comFuso = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(texto)
    ? texto : texto.replace(' ', 'T') + '-03:00'
  const ms = Date.parse(comFuso)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}
const dataBRT = (ms: number): string => new Date(ms - 3 * HORA).toISOString().slice(0, 19).replace('T', ' ')

export async function atualizarBloqueios3C({ supabase, base, token, signal }: Opcoes) {
  const agora = new Date()
  const fim = agora.toISOString()
  const controle = new AbortController()
  const interromper = () => controle.abort()
  const prazo = setTimeout(interromper, 80_000)
  signal?.addEventListener('abort', interromper, { once: true })
  if (signal?.aborted) interromper()
  let paginas = 0
  let consultasNativas = 0
  let chamadasSemIdentidade = 0
  try {
    let origem: URL
    try { origem = new URL(base.endsWith('/') ? base : base + '/') } catch { return falhar('URL_INVALIDA') }
    if (!token || !['http:', 'https:'].includes(origem.protocol) || origem.username || origem.password) falhar('CONFIGURACAO')

    async function get(caminho: string, params: Array<[string, string]> = [], aceita404 = false): Promise<Registro | null> {
      if (controle.signal.aborted) falhar('PRAZO_EXCEDIDO')
      const url = new URL(caminho, origem)
      url.searchParams.set('api_token', token)
      for (const [k, v] of params) url.searchParams.append(k, v)
      const local = new AbortController()
      const cancelar = () => local.abort()
      controle.signal.addEventListener('abort', cancelar, { once: true })
      const tempo = setTimeout(cancelar, 20_000)
      try {
        let resposta: Response
        try { resposta = await fetch(url.toString(), { method: 'GET', headers: { Accept: 'application/json' }, signal: local.signal }) }
        catch { return falhar('TRANSPORTE') }
        if (resposta.status === 404 && aceita404) {
          // Um 404 HTML de proxy/rota não comprova remoção da blacklist.
          let erro: unknown
          try { erro = await resposta.json() } catch { return falhar('BLACKLIST_404_AMBIGUO') }
          if (objeto(erro) && erro.status === 404) return null
          return falhar('BLACKLIST_404_AMBIGUO')
        }
        if (!resposta.ok) falhar(`HTTP_${resposta.status}`)
        let corpo: unknown
        try { corpo = await resposta.json() } catch { return falhar('JSON_INVALIDO') }
        if (!objeto(corpo)) falhar('FORMATO_INVALIDO')
        return corpo
      } finally {
        clearTimeout(tempo)
        controle.signal.removeEventListener('abort', cancelar)
      }
    }

    async function listar(caminho: string, params: Array<[string, string]> = [], exigirPaginacao = false): Promise<Registro[]> {
      const registros: Registro[] = []
      for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
        const corpo = await get(caminho, [...params, ['per_page', caminho === 'calls' ? '200' : '500'], ['page', String(pagina)]])
        if (!corpo || !Array.isArray(corpo.data) || !corpo.data.every(objeto)) falhar('LISTAGEM_INVALIDA')
        registros.push(...corpo.data as Registro[])
        paginas++
        const meta = objeto(corpo.meta) ? corpo.meta : {}
        const pag = objeto(meta.pagination) ? meta.pagination : null
        if (exigirPaginacao && (!pag || !objeto(pag.links))) falhar('PAGINACAO_AUSENTE')
        const links = pag && objeto(pag.links) ? pag.links : {}
        // Nunca segue a URL recebida: ela pode carregar token/outro host.
        // Apenas a existência de next determina a próxima página no mesmo endpoint.
        if (!links.next) {
          const total = Number(pag?.total_pages)
          if (!exigirPaginacao && Number.isFinite(total) && total > pagina) continue
          return registros
        }
      }
      return falhar('LIMITE_PAGINAS')
    }

    const cursor = await supabase.from('threec_sdr_bloqueios_sync')
      .select('ultima_sucesso_em').eq('id', true).maybeSingle()
    if (cursor.error) falhar('CURSOR_LEITURA')
    const ultima = objeto(cursor.data) ? dataUTC(cursor.data.ultima_sucesso_em) : null
    const inicioMs = Math.min(agora.getTime(), ultima ? Date.parse(ultima) : agora.getTime()) - 48 * HORA
    let regras: Map<string, Registro>
    if (cacheRegras?.base === base && cacheRegras.token === token && cacheRegras.ate > agora.getTime()) {
      regras = cacheRegras.regras
    } else {
      const listas = await listar('qualification_lists')
      regras = new Map<string, Registro>()
      for (const lista of listas) {
        const listaId = id(lista.id)
        if (!/^\d+$/.test(listaId)) falhar('QUALIFICACAO_LISTA_INVALIDA')
        for (const regra of await listar(`qualification_lists/${listaId}/qualifications`)) {
          if (regra.should_insert_blacklist === true || regra.black_list === true) {
            const regraId = id(regra.id)
            if (!/^\d+$/.test(regraId)) falhar('QUALIFICACAO_INVALIDA')
            regras.set(regraId, regra)
          }
        }
      }
      cacheRegras = { base, token, ate: agora.getTime() + 5 * 60_000, regras }
    }

    const chamadas = new Map<string, Registro>()
    if (regras.size) {
      for (let inicio = inicioMs; inicio <= agora.getTime();) {
        // Janelas de 6 h evitam o timeout observado na consulta única de 48 h.
        // Cada janela fica também abaixo do teto documentado de 31 dias.
        const ate = Math.min(agora.getTime(), inicio + 6 * HORA)
        const params: Array<[string, string]> = [
          ['start_date', dataBRT(inicio)], ['end_date', dataBRT(ate)],
          ['simple_paginate', '1'], ['with_mailing', '0'],
          ...Array.from(regras.keys(), q => ['qualifications[]', q] as [string, string]),
        ]
        for (const chamada of await listar('calls', params, true)) {
          if (!regras.has(id(chamada.qualification_id))) continue
          const chamadaId = id(chamada.id)
          if (!chamadaId) falhar('CHAMADA_SEM_ID')
          chamadas.set(chamadaId, chamada)
        }
        if (ate === agora.getTime()) break
        inicio = ate + 1000
      }
    }

    const registros = new Map<string, Bloqueio>()
    const nativos = new Map<string, Promise<Bloqueio>>()
    async function nativo(numero: string): Promise<Bloqueio> {
      const cn = canon(numero)
      let pendente = nativos.get(cn)
      if (!pendente) {
        pendente = (async () => {
          consultasNativas++
          const corpo = await get('blacklist/number', [['number', numero]], true)
          const dado = corpo?.data
          const ausente = corpo === null || dado === null || (Array.isArray(dado) && dado.length === 0)
          if (!ausente && (!objeto(dado) || !Object.prototype.hasOwnProperty.call(dado, 'expiration_date'))) falhar('BLACKLIST_AMBIGUA')
          const estado = objeto(dado) ? dado : null
          if (estado && (!telefone(estado.number) || canon(telefone(estado.number)!) !== cn)) falhar('BLACKLIST_NUMERO_DIVERGENTE')
          const expira = estado?.expiration_date == null ? null : dataUTC(estado.expiration_date)
          if (estado?.expiration_date != null && !expira) falhar('BLACKLIST_PRAZO_INVALIDO')
          const permanente = !ausente && estado?.expiration_date === null
          const observadoEm = new Date().toISOString()
          return {
            canon: cn, origem: '3c_blacklist', fonte_id: 'number', fonte_qualid: null,
            categoria: 'bloqueado', bloqueado_em: observadoEm, valid_until: expira, permanente,
            ativo: !ausente && (permanente || !!expira && Date.parse(expira) > Date.parse(observadoEm)), verificado_em: observadoEm,
          }
        })()
        nativos.set(cn, pendente)
      }
      return pendente
    }
    const linhas = Array.from(chamadas.values())
    // Toda qualificação bloqueadora é confirmada no estado nativo atual.
    // Uma chamada antiga pode ter sido requalificada depois de um desbloqueio:
    // a data da chamada e o rótulo/duração da qualificação não são autoridade.
    for (let i = 0; i < linhas.length; i += 4) {
      await Promise.all(linhas.slice(i, i + 4).map(async chamada => {
        const q = id(chamada.qualification_id)
        const numero = telefone(chamada.number)
        // Ramais/números fora da identidade BR não podem corresponder à seleção
        // SDR. Contabilizar sem bloquear toda a manutenção por um registro ruim.
        if (!numero) { chamadasSemIdentidade++; return }
        const aluno = q === '218230'
        let item: Bloqueio
        if (!aluno) {
          item = await nativo(numero)
        } else {
          // A qualificação Aluno é evidência atual independente da data antiga
          // da ligação. Sem data válida, registramos quando ela foi observada.
          const quando = dataUTC(chamada.qualification_date ?? chamada.qualified_at ?? chamada.call_date_rfc3339 ?? chamada.call_date) ?? fim
          item = {
            canon: canon(numero), origem: '3c_qualificacao', fonte_id: id(chamada.id), fonte_qualid: q,
            categoria: 'aluno', bloqueado_em: quando, valid_until: null,
            permanente: false, ativo: true, verificado_em: fim,
          }
        }
        registros.set(`${item.canon}|${item.origem}|${item.fonte_id}`, item)
      }))
    }
    // Desbloqueios manuais não geram necessariamente nova chamada. Revalidar
    // um lote dos canons mais antigos permite o override nativo (inclusive
    // ativo=false) prevalecer sobre eventos antigos relidos no overlap.
    const revisar = await supabase.rpc('threec_sdr_bloqueios_revalidar', { p_limite: 20 })
    if (revisar.error || !Array.isArray(revisar.data) || !revisar.data.every(objeto)) falhar('REVALIDACAO_LEITURA')
    const antigos = revisar.data as Registro[]
    if (antigos.length > 20) falhar('REVALIDACAO_LIMITE')
    for (let i = 0; i < antigos.length; i += 4) {
      await Promise.all(antigos.slice(i, i + 4).map(async alvo => {
        const numero = telefone(alvo.telefone)
        if (!numero || canon(numero) !== alvo.canon) falhar('REVALIDACAO_TELEFONE_INVALIDO')
        const item = await nativo(numero)
        registros.set(`${item.canon}|${item.origem}|${item.fonte_id}`, item)
      }))
    }
    const itens = Array.from(registros.values())
    for (let i = 0; i < itens.length; i += MAX_POR_RPC) {
      if (controle.signal.aborted) falhar('PRAZO_EXCEDIDO')
      const gravar = await supabase.rpc('threec_sdr_bloqueios_upsert', { p_itens: itens.slice(i, i + MAX_POR_RPC) })
      if (gravar.error) falhar('ESPELHO_GRAVACAO')
    }
    if (controle.signal.aborted) falhar('PRAZO_EXCEDIDO')
    const checkpoint = await supabase.rpc('threec_sdr_bloqueios_checkpoint', { p_ate: fim })
    if (checkpoint.error) falhar('CURSOR_GRAVACAO')
    return {
      ok: true as const, qualificacoes_bloqueadoras: regras.size, paginas,
      chamadas: chamadas.size, registros: itens.length, consultas_nativas: consultasNativas, revalidados: antigos.length,
      chamadas_sem_identidade: chamadasSemIdentidade,
      inicio_utc: new Date(inicioMs).toISOString(), fim_utc: fim,
    }
  } catch (erro) {
    // Não propagamos erro de fetch/PostgREST: pode conter token, URL ou telefone.
    if (erro instanceof Error && /^Falha ao atualizar bloqueios 3C \([A-Z_0-9]+\)$/.test(erro.message)) throw erro
    return falhar('OPERACAO_INCOMPLETA')
  } finally {
    controle.abort()
    clearTimeout(prazo)
    signal?.removeEventListener('abort', interromper)
  }
}
