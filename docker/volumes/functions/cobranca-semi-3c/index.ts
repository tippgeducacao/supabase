// cobranca-semi-3c — CAMPANHA 3C SEMIAUTOMATICA DE COBRANCA (17/09/2026)
//
// Os cards dos tres funis-espelho "9.9 COBRANCA - FASE 01/02/03" viram a lista de
// discagem de uma campanha propria no 3C. Motor separado do discador antigo
// (cobranca-3c-listas, alimentado pelo SprintHub): a logica e outra.
//
//   POST ?acao=atualizar   o BOTAO do funil. Le os tres funis, tira bloqueado
//                          (permanente ou temporario), APAGA a lista anterior e
//                          sobe uma nova. Corpo: { exec_id } — a tela acompanha o
//                          progresso lendo cob_semi_3c_execucoes por esse id.
//   POST ?acao=atualizar&dry=1   so conta, nao toca no 3C
//   POST ?acao=faxina      cron das 18:00 BRT: apaga TODA lista da campanha
//   POST ?acao=preparar    cria a campanha no 3C (uma vez) e vincula os agentes.
//                          Idempotente: com a campanha criada, so confere os agentes.
//
// Vai para o 3C: nome, numero, e-mail, etapa e funil onde o card esta.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const THREEC_BASE = Deno.env.get('THREEC_BASE_URL') ?? 'https://app.3c.plus/api/v1'
const THREEC_TOKEN =
  Deno.env.get('3C_TOKEN_API') ??
  Deno.env.get('THREEC_API_TOKEN') ??
  Deno.env.get('THREEC_TOKEN') ??
  ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

// ORDEM IMPORTA: o 3C fixa o header na criacao da lista.
const HEADER = ['identifier', 'areacode', 'phone', 'nome', 'email', 'etapa', 'funil'] as const
// Lote pequeno de proposito: e o que faz a barra de progresso andar na tela.
const POR_LOTE = 100
const PREFIXO_LISTA = 'Cobrança Semi'
// A campanha nova nasce com a rota, o horario-base e a lista de qualificacao da
// campanha de cobranca que ja disca na casa. So LEITURA dela — nada la e alterado.
const CAMPANHA_MOLDE = '282311'
// Atualizacao presa (edge morta no meio) nao pode travar o botao para sempre.
const TRAVA_MINUTOS = 4

interface Pessoa {
  canon: string
  telefone: string
  nome: string | null
  email: string | null
  funil: string | null
  etapa: string | null
  lead_id: string | null
  oportunidade_id: string | null
}

interface Lista3C { id: number | string; name?: string; nome?: string; [k: string]: unknown }

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// Invisiveis colados no nome. Montado por CODIGO: caractere invisivel literal no
// fonte ja derrubou o boot de outra function ("Unterminated regexp literal").
const INVISIVEIS = new RegExp(
  '[' + [0x00ad, 0x034f, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xfeff]
    .map((c) => String.fromCharCode(c)).join('') + ']',
  'g',
)
const limpar = (s: string | null | undefined): string =>
  (s ?? '').normalize('NFKC').replace(INVISIVEIS, '').replace(/\s+/g, ' ').trim()

const hojeBRT = (): string => new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })

const alvo = (caminho: string): string =>
  `${THREEC_BASE}${caminho}${caminho.includes('?') ? '&' : '?'}api_token=${THREEC_TOKEN}`

async function api(metodo: string, caminho: string, corpo?: unknown) {
  const resp = await fetch(alvo(caminho), {
    method: metodo,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
  })
  const texto = await resp.text()
  let j: Record<string, unknown> | null = null
  try { j = JSON.parse(texto) } catch { /* nao-JSON */ }
  return { ok: resp.ok, status: resp.status, json: j, texto: texto.slice(0, 600) }
}

// A API do 3C PAGINA: ler so a 1a pagina some com listas.
async function listarListas(campanha: string): Promise<Lista3C[]> {
  const todas: Lista3C[] = []
  const vistos = new Set<string>()
  for (let page = 1; page <= 50; page++) {
    const r = await api('GET', `/campaigns/${campanha}/lists?page=${page}`)
    if (!r.ok) {
      if (page === 1) throw new Error(`GET lists falhou: HTTP ${r.status} ${r.texto.slice(0, 200)}`)
      break
    }
    const pagina = (Array.isArray(r.json?.data) ? r.json?.data : []) as Lista3C[]
    let novas = 0
    for (const l of pagina) {
      const k = String(l.id)
      if (!vistos.has(k)) { vistos.add(k); todas.push(l); novas++ }
    }
    if (novas === 0) break
    const meta = (r.json?.meta ?? r.json) as Record<string, unknown>
    const ultima = Number(meta?.last_page ?? 0)
    if (ultima && Number(meta?.current_page ?? page) >= ultima) break
  }
  return todas
}

async function criarLista(campanha: string, nome: string): Promise<string> {
  // multipart com header[i]: e o formato que o 3C aceita para registrar o header.
  const form = new FormData()
  form.append('name', nome)
  HEADER.forEach((h, i) => form.append(`header[${i}]`, h))
  const resp = await fetch(alvo(`/campaigns/${campanha}/lists`), { method: 'POST', body: form })
  const txt = await resp.text()
  if (!resp.ok) throw new Error(`POST lists falhou: HTTP ${resp.status} ${txt.slice(0, 200)}`)
  let id: unknown = null
  try { const j = JSON.parse(txt); id = j?.data?.id ?? j?.id ?? null } catch { /* nao-JSON */ }
  if (!id) throw new Error(`3C criou a lista mas nao devolveu id: ${txt.slice(0, 200)}`)
  return String(id)
}

// ------------------------------------------------------------- execucao ----
async function marcar(execId: string, patch: Record<string, unknown>) {
  const { error } = await supabase.from('cob_semi_3c_execucoes').update(patch).eq('id', execId)
  if (error) console.error('[cobranca-semi-3c] falha ao gravar progresso', error.message)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// --------------------------------------------------------------- preparar ----
async function garantirAgentes(campanha: string, agentes: Array<{ id: number; nome: string }>) {
  const atuais = await api('GET', `/campaigns/${campanha}/agents`)
  const jaTem = new Set(((atuais.json?.data ?? []) as Array<{ id: number }>).map((a) => Number(a.id)))
  const faltam = agentes.filter((a) => !jaTem.has(Number(a.id)))
  if (faltam.length === 0) return { vinculados: agentes.map((a) => a.nome), adicionados: [], erro: null }
  const r = await api('POST', `/campaigns/${campanha}/agents`, { agents: faltam.map((a) => Number(a.id)) })
  return {
    vinculados: agentes.filter((a) => jaTem.has(Number(a.id))).map((a) => a.nome),
    adicionados: r.ok ? faltam.map((a) => a.nome) : [],
    erro: r.ok ? null : `HTTP ${r.status} ${JSON.stringify(r.json?.errors ?? r.texto).slice(0, 300)}`,
  }
}

async function preparar(cfg: Record<string, unknown>) {
  const agentes = (cfg.agentes ?? []) as Array<{ id: number; nome: string }>
  let campanha = String(cfg.campanha_id ?? '').trim()
  let criada = false

  if (!campanha) {
    const nome = String(cfg.campanha_nome)
    // Ja existe com esse nome (rodada anterior que nao gravou o id)? Reusa.
    for (let page = 1; page <= 20 && !campanha; page++) {
      const r = await api('GET', `/campaigns?page=${page}`)
      const pagina = (Array.isArray(r.json?.data) ? r.json?.data : []) as Array<Record<string, unknown>>
      if (!r.ok || pagina.length === 0) break
      const achou = pagina.find((c) => String(c.name ?? '') === nome)
      if (achou) campanha = String(achou.id)
      const meta = (r.json?.meta ?? r.json) as Record<string, unknown>
      const ultima = Number(meta?.last_page ?? 0)
      if (!ultima || Number(meta?.current_page ?? page) >= ultima) break
    }
  }

  if (!campanha) {
    const moldeResp = await api('GET', `/campaigns/${CAMPANHA_MOLDE}`)
    const molde = (moldeResp.json?.data ?? {}) as Record<string, unknown>
    if (!moldeResp.ok) throw new Error(`nao li a campanha molde: HTTP ${moldeResp.status}`)

    // O proprio 3C diz o que e obrigatorio: POST vazio volta 422 nomeando os campos.
    const vazio = await api('POST', '/campaigns', {})
    const exigidos = Object.keys((vazio.json?.errors ?? {}) as Record<string, unknown>)
    const corpo: Record<string, unknown> = {}
    for (const campo of exigidos) {
      if (campo in molde && molde[campo] !== null) corpo[campo] = molde[campo]
    }
    corpo.name = String(cfg.campanha_nome)
    corpo.start_time = '08:00'
    corpo.end_time = '18:00' // a lista morre as 18h; a campanha nao disca depois disso
    // `qualification_list` entra na RAIZ do POST, mas o GET devolve aninhado.
    if (corpo.qualification_list === undefined) {
      const ds = (molde.dialer_settings ?? {}) as Record<string, unknown>
      if (ds.qualification_list_id != null) corpo.qualification_list = ds.qualification_list_id
    }
    const criar = await api('POST', '/campaigns', corpo)
    const nova = (criar.json?.data ?? null) as Record<string, unknown> | null
    if (!nova?.id) {
      throw new Error(`3C recusou a criacao: HTTP ${criar.status} ${JSON.stringify(criar.json?.errors ?? criar.texto).slice(0, 400)}`)
    }
    campanha = String(nova.id)
    criada = true
    // Rota so pega por PATCH (o POST/PUT ignoram) — campanha sem rota NAO DISCA.
    await api('PATCH', `/campaigns/${campanha}`, {
      route_mobile_id: molde.route_mobile_id, route_landline_id: molde.route_landline_id,
    })
  }

  await supabase.from('cob_semi_3c_config')
    .update({ campanha_id: campanha, atualizado_em: new Date().toISOString() }).eq('id', 1)

  const agentesRes = await garantirAgentes(campanha, agentes)
  const lida = await api('GET', `/campaigns/${campanha}`)
  const d = (lida.json?.data ?? {}) as Record<string, unknown>
  const resumo = {
    campanha_id: campanha, criada, nome: d.name, horario: `${d.start_time}–${d.end_time}`, pausada: d.paused,
    rota_celular: d.route_mobile_id, rota_fixo: d.route_landline_id,
    qualificacao: (d.dialer_settings as Record<string, unknown> | undefined)?.qualification_list_id ?? null,
    agentes: agentesRes,
  }
  await supabase.from('cob_semi_3c_execucoes').insert({
    acao: 'preparar', status: agentesRes.erro ? 'erro' : 'ok', fase: 'Campanha preparada',
    erro: agentesRes.erro, detalhe: resumo, terminado_em: new Date().toISOString(),
  })
  return resumo
}

// ----------------------------------------------------------------- faxina ----
async function faxina(campanha: string) {
  const todas = await listarListas(campanha)
  const apagadas: Array<Record<string, unknown>> = []
  const falhas: string[] = []
  for (const l of todas) {
    const r = await api('DELETE', `/campaigns/${campanha}/lists/${l.id}`)
    if (r.ok || r.status === 204) apagadas.push({ id: l.id, nome: l.name ?? l.nome ?? '', total: l.total ?? null })
    else falhas.push(`lista ${l.id}: HTTP ${r.status} ${r.texto.slice(0, 150)}`)
  }
  // Lista que nao morreu continua discando: o espelho local so zera se TODAS foram.
  if (falhas.length === 0) {
    await supabase.from('cob_semi_3c_itens').delete().neq('canon', '')
    await supabase.from('cob_semi_3c_config').update({
      lista_atual_id: null, lista_atual_nome: null, lista_atual_criada_em: null,
      atualizado_em: new Date().toISOString(),
    }).eq('id', 1)
  }
  await supabase.from('cob_semi_3c_execucoes').insert({
    acao: 'faxina', status: falhas.length ? 'erro' : 'ok', fase: 'Lista do dia apagada',
    sairam: apagadas.reduce((s, l) => s + (Number(l.total) || 0), 0),
    erro: falhas.length ? falhas.join(' | ') : null,
    detalhe: { listas_na_campanha: todas.length, apagadas }, terminado_em: new Date().toISOString(),
  })
  return { listas_na_campanha: todas.length, apagadas, falhas }
}

// -------------------------------------------------------------- atualizar ----
async function atualizar(cfg: Record<string, unknown>, execId: string, dry: boolean) {
  const campanha = String(cfg.campanha_id)

  await marcar(execId, { fase: 'Lendo os funis de cobrança' })
  const { data: sel, error: eSel } = await supabase.rpc('cob_semi_3c_selecionar')
  if (eSel) throw new Error(`falha ao ler os funis: ${eSel.message}`)
  const regua = sel as {
    cards: number; pessoas: number; bloqueados: number; bloqueados_temporarios: number
    sem_telefone: number; elegiveis: Pessoa[]
  }
  const elegiveis = regua.elegiveis ?? []
  const contagem = {
    total: elegiveis.length, bloqueados: regua.bloqueados,
    bloqueados_temporarios: regua.bloqueados_temporarios, sem_telefone: regua.sem_telefone,
  }
  await marcar(execId, { ...contagem, fase: 'Conferindo a lista no 3C' })

  // CADA CLIQUE REFAZ A LISTA: apaga a anterior e sobe uma nova, do zero (pedido do
  // Gustavo, 17/09/2026). Nao existe atualizacao incremental — o que vale e sempre a
  // foto dos funis na hora do clique.
  const agora = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })
  const nomeLista = `${PREFIXO_LISTA} ${hojeBRT()} ${agora}`
  const listas = await listarListas(campanha)

  const { data: anteriores } = await supabase.from('cob_semi_3c_itens').select('canon')
  const naAnterior = new Set((anteriores ?? []).map((i: { canon: string }) => i.canon))
  const canonsDeAgora = new Set(elegiveis.map((p) => p.canon))
  const novos = elegiveis
  const jaEstavam = 0
  // quem estava na lista anterior e nao volta nesta (quitou, saiu do funil, bloqueou)
  const sairam = [...naAnterior].filter((c) => !canonsDeAgora.has(c)).length

  if (dry) {
    await marcar(execId, {
      status: 'ok', fase: 'Simulação', entraram: novos.length, sairam, ja_estavam: 0,
      na_lista: novos.length, terminado_em: new Date().toISOString(),
      detalhe: { dry: true, cards: regua.cards, listas_que_seriam_apagadas: listas.length, amostra: novos.slice(0, 5) },
    })
    return { dry: true, ...contagem, entrariam: novos.length, sairiam: sairam, listas_que_seriam_apagadas: listas.length }
  }

  const avisos: string[] = []

  // 1) apaga a lista anterior (todas as que houver na campanha)
  await marcar(execId, { fase: 'Apagando a lista anterior' })
  for (const l of listas) {
    const r = await api('DELETE', `/campaigns/${campanha}/lists/${l.id}`)
    // Lista velha viva dividiria a discagem com a nova e ligaria para quem ja saiu.
    if (!(r.ok || r.status === 204)) throw new Error(`nao consegui apagar a lista anterior (${l.id}): HTTP ${r.status} ${r.texto.slice(0, 150)}`)
  }
  await supabase.from('cob_semi_3c_itens').delete().neq('canon', '')

  const listaId = await criarLista(campanha, nomeLista)
  await supabase.from('cob_semi_3c_config').update({
    lista_atual_id: listaId, lista_atual_nome: nomeLista,
    lista_atual_criada_em: new Date().toISOString(), atualizado_em: new Date().toISOString(),
  }).eq('id', 1)
  await marcar(execId, { lista_id: listaId, lista_nome: nomeLista, sairam })

  // 2) poe quem entrou
  let entraram = 0
  let recusados = 0
  let processados = 0
  const lotes: Array<Record<string, unknown>> = []
  await marcar(execId, { fase: 'Enviando para o 3C' })
  for (let i = 0; i < novos.length; i += POR_LOTE) {
    const fatia = novos.slice(i, i + POR_LOTE)
    const mailing = fatia.map((p) => {
      const nome = limpar(p.nome) || 'Aluno'
      const etapa = limpar(p.etapa)
      const dados = { nome, email: limpar(p.email), etapa, funil: limpar(p.funil) }
      return {
        identifier: (etapa ? `${nome} - ${etapa}` : nome).slice(0, 120),
        areacode: p.telefone.substring(0, 2),
        phone: p.telefone, // 11 digitos COM DDD: sem o DDD o 3C disca 55+numero
        ...dados,
        data: dados, // o cartao "Ligacao Discador" so enumera mailing.data
      }
    })
    const r = await api('POST', `/campaigns/${campanha}/lists/${listaId}/mailing`, { header: HEADER, mailing })
    processados += fatia.length
    if (r.ok) {
      // 2xx NAO significa "importou tudo": imported_lines traz o numero real.
      const imp = typeof r.json?.imported_lines === 'number' ? (r.json.imported_lines as number) : fatia.length
      entraram += imp
      recusados += fatia.length - imp
      lotes.push({ enviados: fatia.length, importados: imp, sem_imported_lines: typeof r.json?.imported_lines !== 'number' })
      const { error } = await supabase.from('cob_semi_3c_itens').upsert(fatia.map((p) => ({
        canon: p.canon, telefone: p.telefone, nome: p.nome, email: p.email, funil: p.funil, etapa: p.etapa,
        lead_id: p.lead_id, oportunidade_id: p.oportunidade_id, lista_id: listaId,
      })), { onConflict: 'canon' })
      if (error) avisos.push(`espelho local: ${error.message}`)
    } else {
      avisos.push(`envio: HTTP ${r.status} ${r.texto.slice(0, 150)}`)
      lotes.push({ enviados: fatia.length, status: r.status })
    }
    await marcar(execId, { processados, entraram, recusados_3c: recusados })
  }

  const falhouTudo = novos.length > 0 && lotes.every((l) => l.status !== undefined)
  const resultado = {
    ...contagem, entraram, sairam, ja_estavam: jaEstavam, recusados_3c: recusados,
    na_lista: jaEstavam + entraram, lista_id: listaId, lista_nome: nomeLista,
  }
  await marcar(execId, {
    ...resultado, processados,
    status: falhouTudo ? 'erro' : 'ok',
    fase: falhouTudo ? 'O 3C recusou o envio' : 'Lista atualizada',
    erro: avisos.length ? avisos.join(' | ') : null,
    detalhe: { cards: regua.cards, pessoas: regua.pessoas, listas_apagadas: listas.length, lotes },
    terminado_em: new Date().toISOString(),
  })
  return resultado
}

async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  // Gate. Duas portas, nunca anon:
  //   1) service role -> o cron das 18h e a operacao manual via SQL
  //   2) JWT de quem e do FINANCEIRO/GESTAO -> o botao do funil
  const auth = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!auth) return json({ error: 'forbidden' }, 403)

  let servico = auth === SERVICE_ROLE
  if (!servico) {
    // a key do vault e a env do container sao strings diferentes
    try {
      const r = await supabase.rpc('_get_service_role_key')
      servico = !!r.data && auth === r.data
    } catch (err) {
      console.error('[cobranca-semi-3c] falha ao ler a key do vault', String(err))
    }
  }
  let usuario: { id: string; nome: string | null } | null = null
  if (!servico) {
    try {
      const comoUsuario = createClient(SUPABASE_URL, ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${auth}` } },
      })
      const { data: u } = await comoUsuario.auth.getUser()
      if (u?.user) {
        const fin = await comoUsuario.rpc('is_financial_user')
        if (fin.data === true) {
          const { data: p } = await supabase.from('profiles').select('name').eq('id', u.user.id).maybeSingle()
          usuario = { id: u.user.id, nome: (p?.name as string | null) ?? null }
        }
      }
    } catch (err) {
      console.error('[cobranca-semi-3c] falha ao validar usuario', String(err))
    }
  }
  if (!servico && !usuario) return json({ error: 'forbidden' }, 403)
  if (!THREEC_TOKEN) return json({ error: '3C_TOKEN_API nao configurado no edge-runtime' }, 500)

  const url = new URL(req.url)
  const acao = (url.searchParams.get('acao') ?? 'atualizar').toLowerCase()
  const dry = url.searchParams.get('dry') === '1'

  const { data: cfg, error: eCfg } = await supabase.from('cob_semi_3c_config').select('*').eq('id', 1).maybeSingle()
  if (eCfg || !cfg) return json({ error: 'cob_semi_3c_config indisponivel', detail: eCfg?.message }, 500)

  if (acao === 'preparar') {
    if (!servico) return json({ error: 'preparar e so por service role' }, 403)
    try {
      return json({ ok: true, acao, ...(await preparar(cfg)) })
    } catch (err) {
      return json({ ok: false, acao, error: String(err) }, 502)
    }
  }

  if (!cfg.campanha_id) return json({ ok: false, error: 'A campanha ainda não foi criada no 3C (rode ?acao=preparar).' }, 409)

  if (acao === 'faxina') {
    if (!servico) return json({ error: 'faxina e so por service role' }, 403)
    try {
      return json({ ok: true, acao, ...(await faxina(String(cfg.campanha_id))) })
    } catch (err) {
      await supabase.from('cob_semi_3c_execucoes').insert({
        acao: 'faxina', status: 'erro', erro: String(err), terminado_em: new Date().toISOString(),
      })
      return json({ ok: false, acao, error: String(err) }, 502)
    }
  }

  if (acao !== 'atualizar') return json({ error: `acao desconhecida: ${acao}` }, 400)
  if (!cfg.ativo && !dry) return json({ ok: false, error: 'A campanha está pausada no sistema (cob_semi_3c_config.ativo).' }, 409)

  let corpo: Record<string, unknown> = {}
  try { corpo = await req.json() } catch { /* sem corpo */ }
  const execId = UUID.test(String(corpo.exec_id ?? '')) ? String(corpo.exec_id) : crypto.randomUUID()

  // Dois cliques ao mesmo tempo criariam duas listas e mandariam todo mundo em dobro.
  const desde = new Date(Date.now() - TRAVA_MINUTOS * 60_000).toISOString()
  const { data: emCurso } = await supabase.from('cob_semi_3c_execucoes')
    .select('id, iniciado_nome').eq('acao', 'atualizar').eq('status', 'rodando').gte('iniciado_em', desde).limit(1)
  if (emCurso && emCurso.length > 0) {
    return json({ ok: false, error: `Já existe uma atualização em andamento${emCurso[0].iniciado_nome ? ` (${emCurso[0].iniciado_nome})` : ''}. Aguarde ela terminar.` }, 409)
  }

  const { error: eIns } = await supabase.from('cob_semi_3c_execucoes').insert({
    id: execId, acao: 'atualizar', status: 'rodando', fase: 'Começando',
    iniciado_por: usuario?.id ?? null, iniciado_nome: usuario?.nome ?? (servico ? 'Sistema' : null),
  })
  if (eIns) return json({ ok: false, error: 'nao consegui registrar a execucao', detail: eIns.message }, 500)

  try {
    return json({ ok: true, acao, exec_id: execId, ...(await atualizar(cfg, execId, dry)) })
  } catch (err) {
    await marcar(execId, { status: 'erro', fase: 'Falhou', erro: String(err), terminado_em: new Date().toISOString() })
    return json({ ok: false, acao, exec_id: execId, error: String(err) }, 502)
  }
}

Deno.serve(handler)
