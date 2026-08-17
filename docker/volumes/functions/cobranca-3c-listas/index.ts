// Listas da COBRANCA no discador 3C+ — faxina e montagem diaria.
//
// SUBSTITUI o workflow n8n "Cobranca PPGVET -> 3C Plus" (schedule de 2 em 2 min).
//
// O DEFEITO do n8n: ele criava a lista do dia mas NUNCA apagava a do dia anterior.
// Quem quitava seguia vivo nas listas velhas e continuava recebendo ligacao de
// cobranca — desconforto real com cliente que ja esta em dia.
//
// O ciclo novo (dois crons):
//   19:00 BRT  ?acao=faxina  -> apaga TODA lista de cobranca (campanha fica zerada;
//                               das 19h as 10h30 nao existe fila, de proposito)
//   10:30 BRT  ?acao=montar  -> cria a lista do dia e sobe so quem AINDA e
//                               inadimplente (depois de o time revisar o funil)
//
// Chamada:
//   POST /functions/v1/cobranca-3c-listas?acao=montar
//   POST ?acao=montar&dry=1        -> simula (nao cria lista, nao envia, nao marca)
//   POST ?acao=faxina&dry=1        -> lista o que MORRERIA, sem apagar nada
//   POST ?acao=faxina&ids=1,2      -> apaga listas por id (usado no teste do DELETE)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const THREEC_BASE_ENV = Deno.env.get('THREEC_BASE_URL') ?? 'https://3c.fluxoti.com/api/v1'
const THREEC_TOKEN =
  Deno.env.get('3C_TOKEN_API') ??
  Deno.env.get('THREEC_API_TOKEN') ??
  Deno.env.get('THREEC_TOKEN') ??
  ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

// ORDEM IMPORTA: e a mesma com que a lista e criada (o 3C fixa o header na criacao).
// Mudou aqui -> tem que mudar tambem no corpo do POST /lists.
const HEADER = ['identifier', 'areacode', 'phone', 'nome', 'email', 'formacao', 'dias_atraso'] as const

// Teto do 3C por requisicao: "O campo Mailing deve ter no maximo 300 itens".
const MAX_POR_POST = 300

interface FilaRow {
  chave: string
  telefone: string
  nome: string
  email: string
  formacao: string
  dias_atraso: number | null
  visto_em: string
}

interface Lista3C {
  id: number | string
  name?: string
  nome?: string
  total?: number
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// Invisiveis que o cadastro traz colado no nome (o lead usa para furar filtro de
// bot). Montado por CODIGO, nunca literal: caractere invisivel no fonte quebra o
// parser do Deno ("Unterminated regexp literal") e derruba o boot da function —
// ja aconteceu no threec-mailing-sync.
// 00AD soft hyphen · 034F combining grapheme joiner · 200B-200F zero-width e
// marcas de direcao · 2060-2064 word joiner e invisiveis · FEFF BOM
const CODIGOS_INVISIVEIS = [
  0x00ad, 0x034f, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f,
  0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xfeff,
]
const INVISIVEIS = new RegExp(
  '[' + CODIGOS_INVISIVEIS.map((c) => String.fromCharCode(c)).join('') + ']',
  'g',
)
const limpar = (s: string): string =>
  (s ?? '').normalize('NFKC').replace(INVISIVEIS, '').replace(/\s+/g, ' ').trim()

// Nome da lista do dia, no fuso de Sao Paulo (o cron roda em UTC).
function nomeListaDoDia(prefixo: string): string {
  const data = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
  return `${prefixo} ${data}`
}

const nomeDaLista = (l: Lista3C): string => String(l.name ?? l.nome ?? '')

// O agente le o `identifier` primeiro na tela do 3C.
function montarIdentifier(nome: string, dias: number | null): string {
  const n = limpar(nome) || 'Aluno'
  const id = dias ? `${n} - ${dias} dias` : n
  return id.slice(0, 120)
}

// ------------------------------------------------------------- API 3C ----
function alvo(base: string, caminho: string): string {
  return `${base}${caminho}${caminho.includes('?') ? '&' : '?'}api_token=${THREEC_TOKEN}`
}

// A API do 3C PAGINA. Ler so a primeira pagina some com listas — o mesmo erro ja
// aconteceu com os agentes (ver docs/Telefonia (3C).md).
async function listarTodasAsListas(base: string, campanha: string): Promise<Lista3C[]> {
  const todas: Lista3C[] = []
  const vistos = new Set<string>()

  for (let page = 1; page <= 50; page++) {
    const resp = await fetch(alvo(base, `/campaigns/${campanha}/lists?page=${page}`), {
      headers: { Accept: 'application/json' },
    })
    if (!resp.ok) {
      if (page === 1) throw new Error(`GET lists falhou: HTTP ${resp.status} ${(await resp.text()).slice(0, 200)}`)
      break
    }
    const corpo = await resp.json()
    const pagina: Lista3C[] = Array.isArray(corpo?.data) ? corpo.data : Array.isArray(corpo) ? corpo : []
    if (pagina.length === 0) break

    let novas = 0
    for (const l of pagina) {
      const k = String(l.id)
      if (!vistos.has(k)) { vistos.add(k); todas.push(l); novas++ }
    }
    // API sem paginacao devolve tudo sempre igual: sem item novo, para.
    if (novas === 0) break

    const meta = corpo?.meta ?? corpo
    const atual = Number(meta?.current_page ?? page)
    const ultima = Number(meta?.last_page ?? 0)
    if (ultima && atual >= ultima) break
  }
  return todas
}

// ------------------------------------------------------------- faxina ----
async function faxina(base: string, campanha: string, prefixo: string, idsManuais: string[], dry: boolean) {
  const todas = await listarTodasAsListas(base, campanha)

  // Regra de seguranca: so morre lista NOSSA (o prefixo configurado) ou id passado
  // a mao. Lista de terceiro na mesma campanha nunca e tocada por acidente.
  const alvos = idsManuais.length > 0
    ? todas.filter((l) => idsManuais.includes(String(l.id)))
    : todas.filter((l) => nomeDaLista(l).startsWith(prefixo))

  const apagadas: Array<Record<string, unknown>> = []
  const falhas: string[] = []

  if (!dry) {
    for (const l of alvos) {
      const resp = await fetch(alvo(base, `/campaigns/${campanha}/lists/${l.id}`), { method: 'DELETE' })
      if (resp.ok || resp.status === 204) {
        apagadas.push({ id: l.id, nome: nomeDaLista(l), total: l.total ?? null })
      } else {
        falhas.push(`lista ${l.id}: HTTP ${resp.status} ${(await resp.text()).slice(0, 150)}`)
      }
    }
  }

  return {
    listas_na_campanha: todas.length,
    alvos: alvos.map((l) => ({ id: l.id, nome: nomeDaLista(l), total: l.total ?? null })),
    apagadas,
    falhas,
    preservadas: todas
      .filter((l) => !alvos.some((a) => String(a.id) === String(l.id)))
      .map((l) => ({ id: l.id, nome: nomeDaLista(l) })),
  }
}

// O 3C deduplica por telefone na CAMPANHA inteira e descarta em silencio quem ja
// existe nela — apagar as listas NAO limpa essa base (aprendizado do discador SDR).
// Sem limpar, a lista de amanha nasceria quase vazia, porque a maioria dos
// inadimplentes de hoje continua inadimplente amanha.
// O corpo aceito por este endpoint ainda nao foi confirmado ao vivo: tenta os
// formatos plausiveis e registra qual passou. Enquanto nenhum passar, a config
// `limpar_base_campanha` fica desligada e a montagem avisa na tela.
async function limparBaseDaCampanha(base: string, campanha: string) {
  const tentativas: Array<Record<string, unknown>> = [
    { all: true },
    { delete_all: true },
    { status: 'all' },
    {},
  ]
  for (const corpo of tentativas) {
    const resp = await fetch(alvo(base, `/campaigns/${campanha}/mailing/delete`), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(corpo),
    })
    const txt = await resp.text()
    if (resp.ok || resp.status === 204) return { ok: true, corpo_aceito: corpo, status: resp.status }
    console.warn('[cobranca-3c-listas] mailing/delete recusou', JSON.stringify(corpo), resp.status, txt.slice(0, 150))
  }
  return { ok: false, corpo_aceito: null, status: null }
}

// -------------------------------------------------------- diagnostico ----
// Responde a UNICA pergunta que o desenho depende: apagar a lista limpa a base de
// mailing da CAMPANHA, ou o telefone fica preso nela e o reenvio de amanha e
// descartado em silencio?
//
// Sequencia: cria lista -> insere 1 telefone -> apaga a lista -> cria outra ->
// insere O MESMO telefone -> le `imported_lines`.
//   importados = 1  -> apagar limpa. O ciclo 19:00/10:30 funciona como esta.
//   importados = 0  -> dedup por campanha confirmado; ai testa mailing/delete.
//
// Roda contra listas descartaveis que ele mesmo cria e apaga no fim.
async function diagnostico(base: string, campanha: string, telefone: string) {
  const passos: Array<Record<string, unknown>> = []
  const criadas: string[] = []

  const inserir = async (listaId: string) => {
    const resp = await fetch(alvo(base, `/campaigns/${campanha}/lists/${listaId}/mailing`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        header: HEADER,
        mailing: [{
          identifier: 'DIAGNOSTICO - nao ligar',
          areacode: telefone.substring(0, 2),
          phone: telefone,
          nome: 'Diagnostico',
          email: '',
          formacao: '',
          dias_atraso: '',
        }],
      }),
    })
    const txt = await resp.text()
    let importados: number | null = null
    try { const j = JSON.parse(txt); importados = typeof j?.imported_lines === 'number' ? j.imported_lines : null } catch { /* nao-JSON */ }
    return { status: resp.status, importados, corpo: txt.slice(0, 200) }
  }

  const apagar = async (listaId: string) => {
    const resp = await fetch(alvo(base, `/campaigns/${campanha}/lists/${listaId}`), { method: 'DELETE' })
    return { status: resp.status, ok: resp.ok || resp.status === 204 }
  }

  try {
    // 0) valida token + base_url + paginacao de uma vez
    const antes = await listarTodasAsListas(base, campanha)
    passos.push({ passo: '0. GET lists', ok: true, listas_na_campanha: antes.length })

    // 1) primeira insercao
    const marca = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)
    const id1 = await criarLista(base, campanha, `ZZ DIAGNOSTICO A ${marca}`)
    criadas.push(id1)
    const ins1 = await inserir(id1)
    passos.push({ passo: '1. insere na lista A', lista_id: id1, ...ins1 })

    // 2) apaga a lista A
    const del1 = await apagar(id1)
    passos.push({ passo: '2. apaga a lista A', lista_id: id1, ...del1 })

    // 3) reinsere O MESMO telefone numa lista nova
    const id2 = await criarLista(base, campanha, `ZZ DIAGNOSTICO B ${marca}`)
    criadas.push(id2)
    const ins2 = await inserir(id2)
    passos.push({ passo: '3. reinsere o mesmo telefone na lista B', lista_id: id2, ...ins2 })

    const dedupPorCampanha = ins2.importados === 0
    let limpeza: unknown = null
    let aposLimpeza: unknown = null

    // 4) so se o dedup se confirmar: descobre qual corpo o mailing/delete aceita
    if (dedupPorCampanha) {
      await apagar(id2)
      limpeza = await limparBaseDaCampanha(base, campanha)
      const id3 = await criarLista(base, campanha, `ZZ DIAGNOSTICO C ${marca}`)
      criadas.push(id3)
      aposLimpeza = await inserir(id3)
      passos.push({ passo: '4. reinsere depois de limpar a base da campanha', lista_id: id3, ...(aposLimpeza as object) })
    }

    // 5) faxina das listas de diagnostico (o prefixo ZZ nunca colide com as reais)
    for (const id of criadas) await apagar(id)

    return {
      veredito: dedupPorCampanha
        ? ((aposLimpeza as { importados?: number } | null)?.importados === 1
          ? 'DEDUP POR CAMPANHA CONFIRMADO — e o mailing/delete resolve: ligue cob_3c_config.limpar_base_campanha'
          : 'DEDUP POR CAMPANHA CONFIRMADO e o mailing/delete NAO resolveu — o desenho precisa mudar (ver docs/Financeiro e Cobranca.md)')
        : 'SEM DEDUP POR CAMPANHA — apagar a lista libera o telefone; o ciclo 19:00/10:30 funciona como esta',
      dedup_por_campanha: dedupPorCampanha,
      corpo_aceito_pelo_mailing_delete: (limpeza as { corpo_aceito?: unknown } | null)?.corpo_aceito ?? null,
      passos,
      listas_de_teste_apagadas: criadas,
    }
  } catch (err) {
    // nao deixa lixo na campanha se algo estourar no meio
    for (const id of criadas) { try { await apagar(id) } catch { /* ja era */ } }
    return { veredito: 'FALHOU', erro: String(err), passos, listas_de_teste_apagadas: criadas }
  }
}

// ------------------------------------------------------------- montar ----
async function criarLista(base: string, campanha: string, nome: string): Promise<string> {
  // multipart-form-data com header[i]: e o formato que o n8n usava e que o 3C aceita.
  const form = new FormData()
  form.append('name', nome)
  HEADER.forEach((h, i) => form.append(`header[${i}]`, h))

  const resp = await fetch(alvo(base, `/campaigns/${campanha}/lists`), { method: 'POST', body: form })
  const txt = await resp.text()
  if (!resp.ok) throw new Error(`POST lists falhou: HTTP ${resp.status} ${txt.slice(0, 200)}`)

  let id: unknown = null
  try {
    const j = JSON.parse(txt)
    id = j?.data?.id ?? j?.id ?? null
  } catch { /* corpo nao-JSON */ }
  if (!id) throw new Error(`3C criou a lista mas nao devolveu id: ${txt.slice(0, 200)}`)
  return String(id)
}

async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  // Gate. Duas portas, nunca anon:
  //   1) service role  -> o cron interno (e operacao manual via SQL)
  //   2) JWT de usuario do FINANCEIRO/GESTAO -> os botoes da tela do portal
  // Aceita as DUAS chaves de service role: a do vault e a env do container sao
  // strings diferentes — comparar so com uma da 403 no cron.
  const auth = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!auth) return json({ error: 'forbidden' }, 403)

  let autorizado = auth === SERVICE_ROLE
  if (!autorizado) {
    let vaultKey: string | null = null
    try {
      const r = await supabase.rpc('_get_service_role_key')
      vaultKey = (r.data as string | null) ?? null
    } catch (err) {
      console.error('[cobranca-3c-listas] falha ao ler a key do vault', String(err))
    }
    autorizado = !!vaultKey && auth === vaultKey
  }
  if (!autorizado) {
    // Porta 2: a MESMA regua da RLS das cob_* decide, avaliada no contexto do
    // usuario (auth.uid()) — não reimplementamos permissão aqui.
    try {
      const comoUsuario = createClient(SUPABASE_URL, ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${auth}` } },
      })
      const { data: u } = await comoUsuario.auth.getUser()
      if (u?.user) {
        const fin = await comoUsuario.rpc('is_financial_user')
        const ges = await comoUsuario.rpc('is_management_user')
        autorizado = fin.data === true || ges.data === true
      }
    } catch (err) {
      console.error('[cobranca-3c-listas] falha ao validar usuario', String(err))
    }
  }
  if (!autorizado) return json({ error: 'forbidden' }, 403)

  if (!THREEC_TOKEN) return json({ error: '3C_TOKEN_API nao configurado no edge-runtime' }, 500)

  const url = new URL(req.url)
  const acao = (url.searchParams.get('acao') ?? 'montar').toLowerCase()
  const dry = url.searchParams.get('dry') === '1'
  const idsManuais = (url.searchParams.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const qLimite = Number(url.searchParams.get('limite') ?? '') || null

  const { data: cfg, error: eCfg } = await supabase
    .from('cob_3c_config')
    .select('*')
    .eq('id', 1)
    .maybeSingle()
  if (eCfg || !cfg) return json({ error: 'cob_3c_config indisponivel', detail: eCfg?.message }, 500)

  // `ativo=false` pausa o pipeline, mas dry-run continua liberado: e como o time
  // confere o que aconteceria ANTES de ligar.
  if (!cfg.ativo && !dry) {
    return json({ ok: true, skip: 'pipeline pausado (cob_3c_config.ativo=false)' })
  }

  const base = (cfg.base_url ?? '').trim() || THREEC_BASE_ENV
  const campanha = String(cfg.campanha_id)
  const prefixo = String(cfg.prefixo_lista)

  // ------------------------------------------------------- DIAGNOSTICO ----
  if (acao === 'diagnostico') {
    const tel = (url.searchParams.get('telefone') ?? '').replace(/\D/g, '')
    // Sem numero default DE PROPOSITO: o telefone entra numa lista de uma campanha
    // que pode estar discando. Use um numero SEU, ou pause a campanha antes.
    if (tel.length !== 11) {
      return json({ error: 'passe ?telefone=DDD+9+numero (11 digitos). Use um numero SEU: ele entra numa lista real por alguns segundos.' }, 400)
    }
    return json({ ok: true, acao: 'diagnostico', ...(await diagnostico(base, campanha, tel)) })
  }

  // ------------------------------------------------------------ FAXINA ----
  if (acao === 'faxina') {
    let res
    try {
      res = await faxina(base, campanha, prefixo, idsManuais, dry)
    } catch (err) {
      await supabase.from('cob_3c_execucoes').insert({ acao: 'faxina', dry, ok: false, erro: String(err) })
      return json({ error: 'faxina falhou', detail: String(err) }, 502)
    }

    let limpezaBase: unknown = null
    if (!dry && cfg.limpar_base_campanha) {
      limpezaBase = await limparBaseDaCampanha(base, campanha)
    }

    if (!dry) {
      await supabase.from('cob_3c_config').update({
        lista_atual_id: null, lista_atual_nome: null, lista_atual_criada_em: null, atualizado_em: new Date().toISOString(),
      }).eq('id', 1)
    }

    await supabase.from('cob_3c_execucoes').insert({
      acao: 'faxina',
      dry,
      ok: res.falhas.length === 0,
      listas_apagadas: res.apagadas,
      erro: res.falhas.length ? res.falhas.slice(0, 3).join(' | ') : null,
      detalhe: { ...res, limpeza_base_campanha: limpezaBase },
    })

    return json({ ok: res.falhas.length === 0, acao: 'faxina', dry, ...res, limpeza_base_campanha: limpezaBase })
  }

  // ------------------------------------------------------------ MONTAR ----
  if (acao !== 'montar') return json({ error: `acao desconhecida: ${acao}` }, 400)

  const { data: fila, error: eSel } = await supabase.rpc('cob_3c_selecionar', {
    p_limite: qLimite ?? cfg.limite_por_rodada,
  })
  if (eSel) return json({ error: 'falha ao selecionar a fila', detail: eSel.message }, 500)

  const rows = (fila ?? []) as FilaRow[]
  if (rows.length === 0) {
    await supabase.from('cob_3c_execucoes').insert({
      acao: 'montar', dry, ok: true, erro: 'nenhum inadimplente na janela',
    })
    return json({ ok: true, acao: 'montar', enviados: 0, motivo: 'nenhum inadimplente na janela de recencia' })
  }

  const mailing = rows.map((r) => ({
    identifier: montarIdentifier(r.nome, r.dias_atraso),
    areacode: r.telefone.substring(0, 2),
    phone: r.telefone,
    nome: limpar(r.nome),
    email: limpar(r.email),
    formacao: limpar(r.formacao),
    dias_atraso: r.dias_atraso ?? '',
  }))

  const nomeLista = nomeListaDoDia(prefixo)

  if (dry) {
    return json({
      ok: true, acao: 'montar', dry: true, lista_nome: nomeLista,
      total: mailing.length, amostra: mailing.slice(0, 5),
    })
  }

  // Idempotente: rodar montar duas vezes no mesmo dia reusa a lista, nao duplica.
  let listaId: string
  let criada = false
  try {
    const todas = await listarTodasAsListas(base, campanha)
    const existente = todas.find((l) => nomeDaLista(l) === nomeLista)
    if (existente) {
      listaId = String(existente.id)
    } else {
      listaId = await criarLista(base, campanha, nomeLista)
      criada = true
    }
  } catch (err) {
    await supabase.from('cob_3c_execucoes').insert({
      acao: 'montar', dry: false, ok: false, lista_nome: nomeLista, erro: String(err),
    })
    return json({ error: 'falha ao criar/achar a lista do dia', detail: String(err) }, 502)
  }

  // Envia em lotes: a API recusa mais de 300 itens por POST.
  const aceitos: number[] = []
  let descartados = 0
  const falhas: string[] = []

  for (let ini = 0; ini < mailing.length; ini += MAX_POR_POST) {
    const fatia = mailing.slice(ini, ini + MAX_POR_POST)
    let resp: Response
    try {
      resp = await fetch(alvo(base, `/campaigns/${campanha}/lists/${listaId}/mailing`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ header: HEADER, mailing: fatia }),
      })
    } catch (err) {
      falhas.push(`lote ${ini / MAX_POR_POST}: ${String(err)}`)
      continue
    }
    const corpo = await resp.text()
    if (resp.status >= 200 && resp.status < 300) {
      // 2xx NAO significa "importou tudo": `imported_lines` traz o numero real.
      try {
        const j = JSON.parse(corpo)
        const imp = typeof j?.imported_lines === 'number' ? j.imported_lines : fatia.length
        if (imp < fatia.length) descartados += fatia.length - imp
      } catch { /* corpo nao-JSON */ }
      for (let k = ini; k < ini + fatia.length; k++) aceitos.push(k)
    } else {
      falhas.push(`lote ${ini / MAX_POR_POST}: HTTP ${resp.status} ${corpo.slice(0, 200)}`)
    }
  }

  if (aceitos.length === 0) {
    await supabase.from('cob_3c_execucoes').insert({
      acao: 'montar', dry: false, ok: false, lista_id: listaId, lista_nome: nomeLista,
      enviados: mailing.length, erro: falhas.slice(0, 3).join(' | '),
    })
    return json({ error: '3C recusou todos os lotes', detail: falhas.slice(0, 3) }, 422)
  }

  const chaves = aceitos.map((k) => rows[k].chave)
  const { data: marcados, error: eMarcar } = await supabase.rpc('cob_3c_marcar_enviados', {
    p_chaves: chaves,
    p_lista_id: listaId,
  })
  if (eMarcar) console.error('[cobranca-3c-listas] enviou mas nao marcou', eMarcar.message)

  await supabase.from('cob_3c_config').update({
    lista_atual_id: listaId,
    lista_atual_nome: nomeLista,
    lista_atual_criada_em: new Date().toISOString(),
    atualizado_em: new Date().toISOString(),
  }).eq('id', 1)

  const importados = aceitos.length - descartados

  await supabase.from('cob_3c_execucoes').insert({
    acao: 'montar',
    dry: false,
    ok: falhas.length === 0,
    lista_id: listaId,
    lista_nome: nomeLista,
    enviados: mailing.length,
    importados,
    descartados,
    erro: falhas.length ? falhas.slice(0, 3).join(' | ') : null,
    detalhe: { lista_criada_agora: criada, marcados: marcados ?? 0 },
  })

  return json({
    ok: falhas.length === 0,
    acao: 'montar',
    lista_id: listaId,
    lista_nome: nomeLista,
    lista_criada_agora: criada,
    enviados: mailing.length,
    importados,
    // Se isto vier alto, o 3C esta deduplicando contra a base da CAMPANHA e a
    // faxina precisa tambem limpar o mailing dela (cob_3c_config.limpar_base_campanha).
    descartados_duplicata_campanha: descartados,
    marcados: marcados ?? 0,
    falhas: falhas.slice(0, 3),
  })
}

Deno.serve(async (req) => {
  try {
    return await handler(req)
  } catch (err) {
    console.error('[cobranca-3c-listas] erro nao tratado', err)
    return json({ error: 'erro interno', detail: String(err) }, 500)
  }
})
