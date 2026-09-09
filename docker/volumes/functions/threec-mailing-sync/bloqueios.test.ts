import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { atualizarBloqueios3C } from './bloqueios'

const base = 'https://threec.invalid/api/v1'
let token = 'credencial-apenas-teste'
let numeroTeste = 0
const agora = new Date('2026-09-09T19:00:00Z')
const numero = '5511999990001'
const resposta = (data: unknown, next?: string) => new Response(JSON.stringify({
  data, meta: { pagination: { links: next ? { next } : {}, total_pages: 2 } },
}), { status: 200, headers: { 'Content-Type': 'application/json' } })
const regra = (id: number, nome: string, dias: number | null, blacklist = true) => ({
  id, name: nome, should_insert_blacklist: blacklist, blacklist_blocking_days: dias,
})
const chamada = (id: string, qualification_id: number, number = numero) => ({
  id, qualification_id, number, call_date_rfc3339: '2026-09-09T14:00:00-03:00',
})
let regras: object[]
let chamadas: object[]
let ultimo: string | null
let fetchMock: ReturnType<typeof vi.fn>
let rpc: ReturnType<typeof vi.fn>
let supabase: Parameters<typeof atualizarBloqueios3C>[0]['supabase']

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(agora)
  token = `credencial-apenas-teste-${++numeroTeste}`
  regras = [regra(217544, 'Bloquear por 30 dias', 30)]
  chamadas = [chamada('chamada-1', 217544)]
  ultimo = null
  rpc = vi.fn(async (nome: string) => ({ data: nome === 'threec_sdr_bloqueios_revalidar' ? [] : 1, error: null }))
  supabase = {
    rpc,
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({
      data: { ultima_sucesso_em: ultimo }, error: null,
    }) }) }) }),
  }
  fetchMock = vi.fn(async (alvo: string) => {
    const u = new URL(alvo)
    if (u.pathname.endsWith('/qualification_lists')) return resposta([{ id: 29742 }])
    if (u.pathname.endsWith('/qualifications')) return resposta(regras)
    if (u.pathname.endsWith('/calls')) return resposta(chamadas)
    if (u.pathname.endsWith('/blacklist/number')) return resposta({ number: u.searchParams.get('number'), expiration_date: '2026-10-09T17:00:00Z' })
    throw new Error('URL inesperada em teste')
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
const executar = () => atualizarBloqueios3C({ supabase, base, token })
const itens = () => rpc.mock.calls.filter(([n]) => n === 'threec_sdr_bloqueios_upsert').flatMap(([, args]) => args.p_itens)

describe('espelho dos bloqueios expressos 3C', () => {
  it('recupera aliases BR, ignora ramal e dispensa data histórica para estado nativo', async () => {
    chamadas = [
      { ...chamada('ddi-duplicado', 217544, '555511999990001'), call_date_rfc3339: null },
      chamada('zero-operadora', 217544, '55011999990001'),
      chamada('ramal', 217544, '1234'),
    ]
    await expect(executar()).resolves.toMatchObject({ consultas_nativas: 1, registros: 1, chamadas_sem_identidade: 1 })
    expect(itens()[0]).toMatchObject({ canon: '1199990001', bloqueado_em: agora.toISOString() })
  })

  it('aluno com qualificação explícita e data ausente usa o momento da observação', async () => {
    regras = [regra(218230, 'Aluno Matriculado', null)]
    chamadas = [{ ...chamada('aluno-sem-data', 218230), call_date_rfc3339: null }]
    await executar()
    expect(itens()[0]).toMatchObject({ categoria: 'aluno', fonte_id: 'aluno-sem-data', bloqueado_em: agora.toISOString(), permanente: false })
  })

  it('espelha estado nativo exato, converte consulta BRT e avança cursor após gravação', async () => {
    await expect(executar()).resolves.toMatchObject({ ok: true, chamadas: 1, registros: 1, consultas_nativas: 1 })
    expect(itens()).toEqual([expect.objectContaining({
      canon: '1199990001', origem: '3c_blacklist', fonte_qualid: null,
      bloqueado_em: agora.toISOString(), valid_until: '2026-10-09T17:00:00.000Z',
      permanente: false, ativo: true,
    })])
    expect(rpc.mock.calls.at(-1)).toEqual(['threec_sdr_bloqueios_checkpoint', { p_ate: agora.toISOString() }])
    const u = new URL(fetchMock.mock.calls.find(([u]) => new URL(u).pathname.endsWith('/calls'))![0])
    expect(u.searchParams.get('start_date')).toBe('2026-09-07 16:00:00')
    expect(u.searchParams.get('end_date')).toBe('2026-09-07 22:00:00')
    expect(u.searchParams.get('fields')).toBeNull()
    expect(u.searchParams.getAll('qualifications[]')).toEqual(['217544'])
    expect(u.searchParams.has('campaigns[]')).toBe(false)
  })

  it('ignora agenda e sem interesse mesmo que API ignore o filtro de qualificações', async () => {
    regras.push(regra(216390, 'Agendamento', null, false), regra(216387, 'Sem interesse', null, false))
    chamadas.push(chamada('agenda', 216390), chamada('sem-interesse', 216387))
    await executar()
    expect(itens()).toHaveLength(1)
    expect(itens()[0].fonte_id).toBe('number')
  })

  it('estado nativo permanente e aluno são categorias distintas; aluno não ganha permanência inventada', async () => {
    regras = [regra(217536, 'Bloqueio Permanente', null), regra(218230, 'Aluno Matrículado', null)]
    chamadas = [chamada('permanente', 217536), chamada('aluno', 218230)]
    const anterior = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (u: string) => new URL(u).pathname.endsWith('/blacklist/number')
      ? resposta({ number: '11999990001', expiration_date: null }) : anterior(u))
    await executar()
    expect(itens()).toEqual(expect.arrayContaining([
      expect.objectContaining({ fonte_id: 'number', permanente: true, categoria: 'bloqueado', valid_until: null }),
      expect.objectContaining({ fonte_id: 'aluno', permanente: false, categoria: 'aluno', valid_until: null }),
    ]))
  })

  it('90 dias com duração nula exige estado nativo, sem deduzir prazo pelo nome', async () => {
    regras = [regra(217877, 'Bloquear por 90 dias', null)]
    chamadas = [chamada('a', 217877), chamada('b', 217877)]
    const anterior = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (u: string) => new URL(u).pathname.endsWith('/blacklist/number')
      ? resposta({ number: '11999990001', expiration_date: '2026-10-01 15:00:00' }) : anterior(u))
    await expect(executar()).resolves.toMatchObject({ consultas_nativas: 1, registros: 1 })
    expect(itens()[0]).toMatchObject({ origem: '3c_blacklist', fonte_id: 'number', permanente: false, valid_until: '2026-10-01T18:00:00.000Z' })
  })

  it('ausência nativa comprovada registra ativo=false para superar qualificações antigas', async () => {
    regras = [regra(217877, 'Bloquear por 90 dias', null)]
    chamadas = [chamada('a', 217877)]
    const anterior = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (u: string) => new URL(u).pathname.endsWith('/blacklist/number')
      ? new Response(JSON.stringify({ status: 404, title: 'Not Found' }), { status: 404 }) : anterior(u))
    await executar()
    expect(itens()[0]).toMatchObject({ origem: '3c_blacklist', ativo: false, permanente: false, valid_until: null })
  })

  it('404 HTML não é prova de desbloqueio; bloqueia o checkpoint', async () => {
    regras = [regra(217877, 'Bloquear por 90 dias', null)]
    chamadas = [chamada('a', 217877)]
    const anterior = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (u: string) => new URL(u).pathname.endsWith('/blacklist/number')
      ? new Response('<html>not found</html>', { status: 404 }) : anterior(u))
    await expect(executar()).rejects.toThrow('BLACKLIST_404_AMBIGUO')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('segue next sem confiar na URL recebida ou total_pages placeholder e deduplica chamadas', async () => {
    const anterior = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (u: string) => {
      const url = new URL(u)
      if (!url.pathname.endsWith('/calls')) return anterior(u)
      return url.searchParams.get('page') === '1'
        ? resposta([chamada('a', 217544)], 'https://outro-host.invalid/?api_token=segredo')
        : resposta([chamada('a', 217544), chamada('b', 217544, '5511999990002')])
    })
    await executar()
    expect(itens()).toHaveLength(2)
    expect(fetchMock.mock.calls.every(([u]) => new URL(u).origin === 'https://threec.invalid')).toBe(true)
    expect(fetchMock.mock.calls.filter(([u]) => new URL(u).pathname.endsWith('/calls'))).toHaveLength(16)
  })

  it('falha na segunda página não grava espelho nem checkpoint e sanitiza segredos', async () => {
    const anterior = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (u: string) => {
      const url = new URL(u)
      if (!url.pathname.endsWith('/calls')) return anterior(u)
      if (url.searchParams.get('page') === '1') return resposta(chamadas, 'next')
      throw new Error(`falha ${u} telefone=${numero}`)
    })
    await expect(executar()).rejects.toThrow('Falha ao atualizar bloqueios 3C (TRANSPORTE)')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('paginação ausente e erro de upsert impedem avanço do cursor', async () => {
    const anterior = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (u: string) => new URL(u).pathname.endsWith('/calls')
      ? new Response(JSON.stringify({ data: chamadas, meta: { pagination: {} } })) : anterior(u))
    await expect(executar()).rejects.toThrow('PAGINACAO_AUSENTE')
    expect(rpc).not.toHaveBeenCalled()
    fetchMock.mockImplementation(anterior)
    rpc.mockImplementation(async (nome: string) => nome === 'threec_sdr_bloqueios_revalidar'
      ? { data: [], error: null } : { data: null, error: { message: 'falha privada' } })
    await expect(executar()).rejects.toThrow('ESPELHO_GRAVACAO')
    expect(rpc.mock.calls.every(([n]) => n !== 'threec_sdr_bloqueios_checkpoint')).toBe(true)
  })

  it('cursor atrasado mantém overlap48h e consulta cada janela de no máximo6horas', async () => {
    ultimo = '2026-07-01T19:00:00Z'
    chamadas = []
    await executar()
    const urls = fetchMock.mock.calls.map(([u]) => new URL(u)).filter(u => u.pathname.endsWith('/calls'))
    expect(urls).toHaveLength(288)
    expect(urls[0].searchParams.get('start_date')).toBe('2026-06-29 16:00:00')
    expect(urls.at(-1)!.searchParams.get('end_date')).toBe('2026-09-09 16:00:00')
    expect(itens()).toHaveLength(0)
    expect(rpc.mock.calls.map(([n]) => n)).toEqual(['threec_sdr_bloqueios_revalidar', 'threec_sdr_bloqueios_checkpoint'])
  })

  it('revalida um permanente antigo e registra desbloqueio nativo sem depender de nova chamada', async () => {
    chamadas = []
    rpc.mockImplementation(async (nome: string) => ({
      data: nome === 'threec_sdr_bloqueios_revalidar' ? [{ canon: '1199990001', telefone: '11999990001' }] : 1,
      error: null,
    }))
    const anterior = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (u: string) => new URL(u).pathname.endsWith('/blacklist/number')
      ? resposta(null) : anterior(u))
    await expect(executar()).resolves.toMatchObject({ revalidados: 1, consultas_nativas: 1 })
    expect(itens()[0]).toMatchObject({ origem: '3c_blacklist', fonte_id: 'number', ativo: false, permanente: false })
  })

  it('falha na revalidação antiga não avança cursor nem ignora o possível desbloqueio', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'falha privada' } })
    await expect(executar()).rejects.toThrow('REVALIDACAO_LEITURA')
    expect(rpc.mock.calls.every(([n]) => n !== 'threec_sdr_bloqueios_checkpoint')).toBe(true)
  })

  it('qualificação permanente relida não restaura bloqueio removido manualmente no3C', async () => {
    regras = [regra(217536, 'Bloqueio Permanente', null)]
    chamadas = [chamada('requalificada', 217536)]
    const anterior = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (u: string) => new URL(u).pathname.endsWith('/blacklist/number')
      ? resposta(null) : anterior(u))
    await executar()
    expect(itens()).toEqual([expect.objectContaining({ origem: '3c_blacklist', ativo: false, permanente: false })])
  })

  it.each([
    [1800191227, '2027-01-17T13:07:07.000Z', true],
    [1800191227000, '2027-01-17T13:07:07.000Z', true],
    [0, '1970-01-01T00:00:00.000Z', false],
  ])('interpreta expiration_date UNIX %s sem tratar zero como permanente', async (prazo, esperado, ativo) => {
    const anterior = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (u: string) => new URL(u).pathname.endsWith('/blacklist/number')
      ? resposta({ number: '5511999990001', expiration_date: prazo }) : anterior(u))
    await executar()
    expect(itens()[0]).toMatchObject({ valid_until: esperado, ativo, permanente: false })
  })

  it('prazo numérico fora da faixa não vira um bloqueio inventado', async () => {
    const anterior = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (u: string) => new URL(u).pathname.endsWith('/blacklist/number')
      ? resposta({ number: '11999990001', expiration_date: 1e20 }) : anterior(u))
    await expect(executar()).rejects.toThrow('BLACKLIST_PRAZO_INVALIDO')
    expect(rpc).not.toHaveBeenCalled()
  })
})
