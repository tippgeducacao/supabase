// Alimenta as campanhas do discador 3C POR INTERESSE (uma por pós/MBA), mais a de
// ORGÂNICOS e a de INDICAÇÃO, a partir da tabela `leads` do self-hosted.
//
// Irmã da `threec-mailing-sync`, que cuida só da campanha "🆕 Novo Lead SDR" (lead
// quente das últimas 24h/30d). Esta aqui existe porque o time montava as listas por
// pós À MÃO — exportando CSV e subindo no painel do 3C (pedido de 08/09/2026:
// "queria mesmo é listas automáticas conforme as regras").
//
// QUEM entra vive no banco, não aqui:
//   • `threec_mailing_elegiveis()`          — a régua-mãe (fora aluno, B2B, arquivado,
//                                             não perturbe, bloqueado, mesclado)
//   • `threec_mailing_selecionar_lista()`   — régua-mãe + o recorte da campanha
//   • `threec_mailing_a_expurgar_lista()`   — quem já está lá e hoje não passa mais
// Esta function só formata, envia, marca e sabe desfazer.
//
// ⚠️ UMA lista por invocação (a mais atrasada em `ultima_sync_em`). A régua-mãe custa
// ~12 s e são 22 campanhas: fazer todas numa chamada estoura o tempo da edge.
//
// Chamada:
//   POST /functions/v1/threec-mailing-listas               -> a campanha mais atrasada
//   POST ?lista=<uuid>                                     -> uma campanha específica
//   POST ?dry=1                                            -> só simula
//   POST ?acao=expurgar                                    -> tira quem não passa mais
//   POST ?limite=500                                       -> sobrescreve o limite da linha

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Host novo desde 22/08/2026 (a FluxoTI virou 3C Plus). Ver docs/Telefonia (3C).md.
const THREEC_BASE = Deno.env.get('THREEC_BASE_URL') ?? 'https://app.3c.plus/api/v1'
const THREEC_TOKEN =
  Deno.env.get('3C_TOKEN_API') ??
  Deno.env.get('THREEC_API_TOKEN') ??
  Deno.env.get('THREEC_TOKEN') ??
  ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// ORDEM IMPORTA: é o header com que a lista foi criada no 3C. Mesmo da campanha quente.
const HEADER = ['identifier', 'areacode', 'phone', 'nome', 'email', 'formacao', 'curso'] as const

const MAX_POR_POST = 300 // teto do 3C: "O campo Mailing deve ter no maximo 300 itens"
const MAX_POR_DELETE = 100

// Caracteres invisíveis que o lead usa no perfil + fontes estilizadas do Unicode.
// Escapes ASCII de propósito: literal invisível no fonte derruba o boot do Deno.
const INVISIVEIS = new RegExp('[\u00AD\u034F\u200B-\u200F\u2060-\u206F\uFEFF]', 'g')
const limpar = (s: string): string =>
  (s ?? '').normalize('NFKC').replace(INVISIVEIS, '').replace(/\s+/g, ' ').trim()

const humanizarFormacao = (s: string): string => {
  const base = limpar(s).replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : ''
}

// O `identifier` é o NÚMERO, em DDD + telefone (11 dígitos, sem DDI) — pedido do
// usuário em 08/09/2026: "sempre colocar o numero na hora de validar as listas como
// DDD+telefone, de resto nao precisa mais nada estar com identificador". É por ele que
// se confere uma linha do mailing contra o CRM; nome e curso continuam nas colunas.
const montarIdentifier = (telefone: string): string => telefone

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// Toda rodada vira uma linha em `threec_mailing_rodadas` — é o que a aba "Listas
// automáticas" do Dash Ligação lê. Sucesso E erro: rodada que falhou sem registro é
// exatamente o que deixou a operação cega até 08/09/2026.
async function registrar(
  lista: string,
  acao: 'sincronizar' | 'expurgar',
  n: { enviados?: number; aceitos?: number; descartados?: number; removidos?: number },
  erro?: string,
  detalhe?: unknown,
) {
  try {
    await supabase.rpc('threec_mailing_rodada_registrar', {
      p_lista: lista,
      p_acao: acao,
      p_enviados: n.enviados ?? 0,
      p_aceitos: n.aceitos ?? 0,
      p_descartados: n.descartados ?? 0,
      p_removidos: n.removidos ?? 0,
      p_erro: erro ?? null,
      p_detalhe: detalhe ? JSON.parse(JSON.stringify(detalhe)) : null,
    })
  } catch (err) {
    // registrar é observabilidade: nunca pode derrubar a rodada em si
    console.error('[threec-mailing-listas] falhou ao registrar a rodada', String(err))
  }
}

interface ListaCfg {
  id: string
  nome: string
  campanha_id: string
  lista_id: string | null
  recorte: string
  limite_por_rodada: number
}

interface LeadRow {
  lead_id: string
  canon: string
  telefone: string
  nome: string
  email: string
  formacao: string
  curso: string
}

interface ExpurgoRow {
  lead_id: string
  canon: string
  telefone: string
  nome: string
  motivo: string
}

// --------------------------------------------------------------- lista no 3C ----
// Nunca cria lista nova por rodada: o histórico dessa campanha mostra o estrago
// (a quente chegou a 104 listas). Usa a da config; se ela não tem, adota a mais
// recente que já existe na campanha; só cria quando a campanha está vazia.
async function resolverListaId(cfg: ListaCfg): Promise<{ listaId: string | null; criada: boolean; erro?: string }> {
  if (cfg.lista_id) return { listaId: cfg.lista_id, criada: false }

  const alvo = `${THREEC_BASE}/campaigns/${cfg.campanha_id}/lists?api_token=${THREEC_TOKEN}`
  let resp: Response
  try {
    resp = await fetch(alvo, { headers: { Accept: 'application/json' } })
  } catch (err) {
    return { listaId: null, criada: false, erro: `falha ao listar mailing lists: ${String(err)}` }
  }
  if (resp.ok) {
    const corpo = await resp.json().catch(() => null)
    const linhas = (corpo?.data ?? corpo ?? []) as Array<{ id: number | string; created_at?: string }>
    if (Array.isArray(linhas) && linhas.length > 0) {
      const maisNova = [...linhas].sort((a, b) =>
        String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')),
      )[0]
      return { listaId: String(maisNova.id), criada: false }
    }
  }

  // campanha sem nenhuma lista: cria uma
  const criar = `${THREEC_BASE}/campaigns/${cfg.campanha_id}/lists?api_token=${THREEC_TOKEN}`
  try {
    const r = await fetch(criar, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ name: `auto | ${cfg.nome}`.slice(0, 60) }),
    })
    const corpo = await r.json().catch(() => null)
    const novo = corpo?.data?.id ?? corpo?.id
    if (!r.ok || !novo) {
      return { listaId: null, criada: false, erro: `3C recusou criar a lista: HTTP ${r.status}` }
    }
    return { listaId: String(novo), criada: true }
  } catch (err) {
    return { listaId: null, criada: false, erro: `falha ao criar a lista: ${String(err)}` }
  }
}

// ------------------------------------------------------------------- expurgo ----
async function expurgar(cfg: ListaCfg, limite: number, dry: boolean): Promise<Response> {
  const { data, error } = await supabase.rpc('threec_mailing_a_expurgar_lista', {
    p_lista: cfg.id,
    p_limite: limite,
  })
  if (error) {
    await registrar(cfg.id, 'expurgar', {}, `falha ao listar quem expurgar: ${error.message}`)
    return json({ error: 'falha ao listar quem expurgar', detail: error.message }, 500)
  }

  const linhas = (data ?? []) as ExpurgoRow[]
  if (linhas.length === 0) return json({ ok: true, campanha: cfg.nome, expurgados: 0 })

  const porMotivo = linhas.reduce<Record<string, number>>((acc, l) => {
    acc[l.motivo] = (acc[l.motivo] ?? 0) + 1
    return acc
  }, {})
  if (dry) {
    return json({
      ok: true, dry: true, campanha: cfg.nome, total: linhas.length, por_motivo: porMotivo,
      amostra: linhas.slice(0, 10).map((l) => ({ nome: l.nome, telefone: l.telefone, motivo: l.motivo })),
    })
  }

  const removidos: string[] = []
  const falhas: string[] = []
  for (let ini = 0; ini < linhas.length; ini += MAX_POR_DELETE) {
    const fatia = linhas.slice(ini, ini + MAX_POR_DELETE)
    // corpo confirmado ao vivo: `phone` no SINGULAR, valor em ARRAY, resposta 204
    const alvo = `${THREEC_BASE}/campaigns/${cfg.campanha_id}/mailing/delete?api_token=${THREEC_TOKEN}`
    try {
      const resp = await fetch(alvo, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ phone: fatia.map((l) => l.telefone) }),
      })
      if (resp.status >= 200 && resp.status < 300) {
        for (const l of fatia) removidos.push(l.canon)
      } else {
        falhas.push(`lote ${ini / MAX_POR_DELETE}: HTTP ${resp.status}`)
      }
    } catch (err) {
      falhas.push(`lote ${ini / MAX_POR_DELETE}: ${String(err)}`)
    }
  }

  let marcados = 0
  if (removidos.length > 0) {
    const { data: n, error: eMarcar } = await supabase.rpc('threec_mailing_marcar_removidos', {
      p_canons: removidos,
      p_motivo: `expurgo: fora da regua (${cfg.nome})`,
    })
    if (eMarcar) {
      console.error('[threec-mailing-listas] REMOVEU MAS NAO MARCOU', eMarcar.message)
      return json({ ok: false, removidos_no_3c: removidos.length, marcados: 0, detail: eMarcar.message }, 500)
    }
    marcados = (n as number) ?? 0
  }

  await supabase.from('threec_mailing_listas')
    .update({ ultimo_expurgo_em: new Date().toISOString() }).eq('id', cfg.id)
  await registrar(cfg.id, 'expurgar', { removidos: marcados },
    falhas.length ? falhas.slice(0, 3).join(' | ') : undefined, { por_motivo: porMotivo })

  return json({
    ok: falhas.length === 0, campanha: cfg.nome,
    candidatos: linhas.length, removidos_no_3c: removidos.length, marcados,
    por_motivo: porMotivo, falhas: falhas.slice(0, 3),
  })
}

// --------------------------------------------------------------- sincronizar ----
async function sincronizar(cfg: ListaCfg, limite: number | null, dry: boolean): Promise<Response> {
  const { data, error } = await supabase.rpc('threec_mailing_selecionar_lista', {
    p_lista: cfg.id,
    p_limite: limite ?? cfg.limite_por_rodada,
  })
  if (error) {
    await registrar(cfg.id, 'sincronizar', {}, `falha ao selecionar: ${error.message}`)
    return json({ error: 'falha ao selecionar', detail: error.message }, 500)
  }

  const rows = (data ?? []) as LeadRow[]
  if (rows.length === 0) {
    if (!dry) {
      await supabase.from('threec_mailing_listas').update({
        ultima_sync_em: new Date().toISOString(),
        ultimo_resultado: { enviados: 0, motivo: 'campanha ja completa' },
      }).eq('id', cfg.id)
    }
    if (!dry) await registrar(cfg.id, 'sincronizar', {}, undefined, { motivo: 'campanha ja completa' })
    return json({ ok: true, campanha: cfg.nome, enviados: 0, motivo: 'ninguem novo para injetar' })
  }

  const mailing = rows.map((r) => ({
    identifier: montarIdentifier(r.telefone),
    areacode: r.telefone.substring(0, 2),
    phone: r.telefone,
    // O atendimento do 3C só lê os extras de `mailing.data`. Na raiz a API
    // armazena o nome, mas ele não aparece na ligação (incidente de 09/09/2026).
    data: {
      nome: limpar(r.nome),
      email: limpar(r.email),
      formacao: humanizarFormacao(r.formacao),
      curso: limpar(r.curso),
    },
  }))

  if (dry) {
    return json({
      ok: true, dry: true, campanha: cfg.nome, campanha_id: cfg.campanha_id,
      total: mailing.length, amostra: mailing.slice(0, 5),
    })
  }

  const { listaId, criada, erro } = await resolverListaId(cfg)
  if (!listaId) {
    await registrar(cfg.id, 'sincronizar', {}, `sem mailing list no 3C: ${erro ?? ''}`)
    return json({ error: 'sem mailing list no 3C', detail: erro }, 502)
  }
  if (criada || cfg.lista_id !== listaId) {
    await supabase.from('threec_mailing_listas').update({ lista_id: listaId }).eq('id', cfg.id)
  }

  const alvo = `${THREEC_BASE}/campaigns/${cfg.campanha_id}/lists/${listaId}/mailing?api_token=${THREEC_TOKEN}`
  const aceitos: number[] = []
  let descartadosPeloTresC = 0
  const falhas: string[] = []

  for (let ini = 0; ini < mailing.length; ini += MAX_POR_POST) {
    const fatia = mailing.slice(ini, ini + MAX_POR_POST)
    let resp: Response
    try {
      resp = await fetch(alvo, {
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
      // 2xx não quer dizer "importou tudo": o 3C deduplica por telefone na CAMPANHA
      // inteira e descarta em silêncio; `imported_lines` traz o número real.
      try {
        const j = JSON.parse(corpo)
        const imp = typeof j?.imported_lines === 'number' ? j.imported_lines : fatia.length
        if (imp < fatia.length) descartadosPeloTresC += fatia.length - imp
      } catch { /* corpo não-JSON */ }
      for (let k = ini; k < ini + fatia.length; k++) aceitos.push(k)
    } else {
      console.error('[threec-mailing-listas] 3C recusou lote', {
        campanha: cfg.campanha_id, ini, status: resp.status, corpo: corpo.slice(0, 300),
      })
      falhas.push(`lote ${ini / MAX_POR_POST}: HTTP ${resp.status} ${corpo.slice(0, 200)}`)
    }
  }

  if (aceitos.length === 0) {
    await registrar(cfg.id, 'sincronizar', { enviados: mailing.length },
      `3C recusou todos os lotes: ${falhas.slice(0, 2).join(' | ')}`)
    return json({ error: '3C recusou todos os lotes', campanha: cfg.nome, detail: falhas.slice(0, 3) }, 422)
  }

  // marca SÓ o que o 3C aceitou — se falhar aqui, o próximo tick reenviaria os mesmos
  const enviados = aceitos.map((k) => rows[k])
  const { data: marcados, error: eMarcar } = await supabase.rpc('threec_mailing_marcar_enviados_lista', {
    p_lista: cfg.id,
    p_leads: enviados.map((r) => r.lead_id),
    p_canons: enviados.map((r) => r.canon),
    p_telefones: enviados.map((r) => r.telefone),
    p_curso: rows[0]?.curso ?? '',
  })
  if (eMarcar) {
    console.error('[threec-mailing-listas] ENVIOU MAS NAO MARCOU', eMarcar.message)
    await registrar(cfg.id, 'sincronizar', { enviados: enviados.length },
      `enviado ao 3C mas falhou ao marcar: ${eMarcar.message}`)
    return json({
      ok: false, campanha: cfg.nome, enviados: enviados.length, marcados: 0,
      alerta: 'enviado ao 3C mas falhou ao marcar — risco de duplicata no proximo tick',
      detail: eMarcar.message,
    }, 500)
  }

  const resultado = {
    enviados: enviados.length,
    marcados: (marcados as number) ?? 0,
    descartados_duplicata_campanha: descartadosPeloTresC,
    falhas: falhas.slice(0, 3),
  }
  await supabase.from('threec_mailing_listas').update({
    ultima_sync_em: new Date().toISOString(),
    ultimo_resultado: resultado,
    lista_id: listaId,
  }).eq('id', cfg.id)
  await registrar(cfg.id, 'sincronizar', {
    enviados: enviados.length,
    aceitos: enviados.length - descartadosPeloTresC,
    descartados: descartadosPeloTresC,
  }, falhas.length ? falhas.slice(0, 3).join(' | ') : undefined, { lista_id: listaId })

  return json({ ok: falhas.length === 0, campanha: cfg.nome, lista_id: listaId, ...resultado })
}

async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  // Gate: só service role (cron interno / operação manual). Nunca anon. Aceita as
  // DUAS chaves (vault e env do container) — comparar só com uma dá 401 no cron.
  const auth = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!auth || auth !== SERVICE_ROLE) {
    let vaultKey: string | null = null
    try {
      const r = await supabase.rpc('_get_service_role_key')
      vaultKey = (r.data as string | null) ?? null
    } catch (err) {
      console.error('[threec-mailing-listas] falha ao ler a key do vault', String(err))
    }
    if (!vaultKey || auth !== vaultKey) return json({ error: 'forbidden' }, 403)
  }
  if (!THREEC_TOKEN) return json({ error: '3C_TOKEN_API nao configurado no edge-runtime' }, 500)

  const url = new URL(req.url)
  const acao = (url.searchParams.get('acao') ?? 'sincronizar').toLowerCase()
  const qLista = url.searchParams.get('lista')
  const qLimite = Number(url.searchParams.get('limite') ?? '') || null
  const dry = url.searchParams.get('dry') === '1'

  // a campanha pedida, ou a mais atrasada da fila. Cada ação tem a SUA fila: ordenar
  // o expurgo por `ultima_sync_em` faria ele voltar sempre à mesma campanha.
  const colunaFila = acao === 'expurgar' ? 'ultimo_expurgo_em' : 'ultima_sync_em'
  const campos = 'id, nome, campanha_id, lista_id, recorte, limite_por_rodada'
  let q = supabase.from('threec_mailing_listas').select(campos)
  q = qLista ? q.eq('id', qLista) : q.eq('ativo', true)
  const { data: linhas, error: eCfg } = await q
    .order(colunaFila, { ascending: true, nullsFirst: true })
    .limit(1)
  if (eCfg) return json({ error: 'falha ao ler a config', detail: eCfg.message }, 500)
  const cfg = (linhas ?? [])[0] as ListaCfg | undefined
  if (!cfg) return json({ ok: true, skip: 'nenhuma campanha ativa em threec_mailing_listas' })

  if (acao === 'expurgar') return await expurgar(cfg, qLimite ?? 500, dry)
  return await sincronizar(cfg, qLimite, dry)
}

// Nunca devolver "Internal Server Error" pelado: sem corpo não dá para diagnosticar.
Deno.serve(async (req) => {
  try {
    return await handler(req)
  } catch (err) {
    console.error('[threec-mailing-listas] erro nao tratado', err)
    return json({ error: 'erro interno', detail: String(err) }, 500)
  }
})
