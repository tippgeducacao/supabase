// Alimenta as campanhas do discador 3C POR INTERESSE (uma por pós/MBA), mais a de
// ORGÂNICOS, INDICAÇÃO e RESULTADO DE REUNIÃO, a partir do CRM do self-hosted.
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
// UMA lista por invocação: sincronização ordena por `ultima_sync_em`; manutenção e
// expurgo, por `ultimo_expurgo_em`. A fila dedicada de reuniões usa o mesmo motor.
//
// Chamada:
//   POST /functions/v1/threec-mailing-listas               -> a campanha mais atrasada
//   POST ?lista=<uuid>                                     -> uma campanha específica
//   POST ?dry=1                                            -> só simula
//   POST ?acao=expurgar                                    -> tira quem não passa mais
//   POST ?acao=manter&recorte=resultado_reuniao             -> expurga antes de abastecer
//   POST ?limite=500                                       -> sobrescreve o limite da linha
//   POST ?acao=renovar                                     -> renovação NOTURNA das campanhas de pós:
//                                                             apaga TODAS as listas da campanha mais
//                                                             atrasada; o abastecimento recria e reenvia
//   POST ?acao=renovar&lista=<uuid>[&dry=1]                -> uma campanha específica / só simula

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'
import { listarListasDaCampanha, recuperarListaAutomatica } from './recuperacao-lista.ts'

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
const LEASE_SEGUNDOS = 180
// Uma chamada HTTP não pode ficar pendurada além da validade da posse da lista.
const API_TIMEOUT_MS = 60_000
type RenovarLease = () => Promise<void>
class LeasePerdido extends Error {}

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
  // Até uma rodada vazia ou com erro precisa ceder a vez à próxima campanha.
  // Antes, um expurgo sem candidatos prendia a fila no mesmo registro para sempre.
  try {
    const coluna = acao === 'expurgar' ? 'ultimo_expurgo_em' : 'ultima_sync_em'
    const { error } = await supabase.from('threec_mailing_listas')
      .update({ [coluna]: new Date().toISOString() }).eq('id', lista)
    if (error) console.error('[threec-mailing-listas] falhou ao avançar a fila', error.message)
  } catch (err) {
    console.error('[threec-mailing-listas] falhou ao avançar a fila', String(err))
  }
  try {
    const { error } = await supabase.rpc('threec_mailing_rodada_registrar', {
      p_lista: lista,
      p_acao: acao,
      p_enviados: n.enviados ?? 0,
      p_aceitos: n.aceitos ?? 0,
      p_descartados: n.descartados ?? 0,
      p_removidos: n.removidos ?? 0,
      p_erro: erro ?? null,
      p_detalhe: detalhe ? JSON.parse(JSON.stringify(detalhe)) : null,
    })
    if (error) console.error('[threec-mailing-listas] falhou ao registrar a rodada', error.message)
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

// Todas as URLs permanecem no host configurado; erros nunca expõem o api_token.
async function api3c(path: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(`${THREEC_BASE}${path}`)
  url.searchParams.set('api_token', THREEC_TOKEN)
  try {
    return await fetch(url.toString(), { ...init,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...init.headers },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    })
  } catch {
    throw new Error('3C indisponivel ou tempo de resposta excedido')
  }
}

// ------------------------------------------------------------------- expurgo ----
async function expurgar(cfg: ListaCfg, limite: number, dry: boolean, renovarLease?: RenovarLease): Promise<Response> {
  const { data, error } = await supabase.rpc('threec_mailing_a_expurgar_lista', {
    p_lista: cfg.id,
    p_limite: limite,
  })
  if (error) {
    if (!dry) await registrar(cfg.id, 'expurgar', {}, `falha ao listar quem expurgar: ${error.message}`)
    return json({ error: 'falha ao listar quem expurgar', detail: error.message }, 500)
  }

  const linhas = (data ?? []) as ExpurgoRow[]
  if (linhas.length === 0) {
    if (!dry) await registrar(cfg.id, 'expurgar', { removidos: 0 }, undefined, { motivo: 'nenhum contato para expurgar' })
    return json({ ok: true, ...(dry ? { dry: true } : {}), campanha: cfg.nome, expurgados: 0 })
  }

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
      await renovarLease?.()
      const resp = await fetch(alvo, {
        method: 'DELETE',
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
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
      if (err instanceof LeasePerdido) break
    }
  }

  let marcados = 0
  if (removidos.length > 0) {
    const { data: n, error: eMarcar } = await supabase.rpc('threec_mailing_marcar_removidos', {
      p_canons: removidos,
      p_motivo: `expurgo: fora da regua (${cfg.nome})`,
      p_campanha_id: cfg.campanha_id,
    })
    if (eMarcar) {
      console.error('[threec-mailing-listas] REMOVEU MAS NAO MARCOU', eMarcar.message)
      await registrar(cfg.id, 'expurgar', {}, `removeu no 3C mas falhou ao marcar: ${eMarcar.message}`,
        { removidos_no_3c: removidos.length, por_motivo: porMotivo })
      return json({ ok: false, removidos_no_3c: removidos.length, marcados: 0, detail: eMarcar.message }, 500)
    }
    marcados = (n as number) ?? 0
  }

  await registrar(cfg.id, 'expurgar', { removidos: marcados },
    falhas.length ? falhas.slice(0, 3).join(' | ') : undefined, { por_motivo: porMotivo })

  return json({
    ok: falhas.length === 0, campanha: cfg.nome,
    candidatos: linhas.length, removidos_no_3c: removidos.length, marcados,
    por_motivo: porMotivo, falhas: falhas.slice(0, 3),
  })
}

// ------------------------------------------------------------------ renovar ----
// RENOVAÇÃO NOTURNA das campanhas de pós (pedido do José, 18/09/2026): "muitas vezes os
// usuários reprocessam as listas e apagam a lista automática; ressubindo toda vez as listas
// de pós vai consertar isso". Às 23:00 cada campanha de pós fica SEM LISTA NENHUMA —
// automática, manual ou de reprocessamento — e amanhece com a automática completa.
//
// Esta ação só APAGA. Quem reconstrói é o motor que já existia: a próxima sincronização
// comprova que a lista salva sumiu, recria a `auto | <nome>`, libera o estoque daquela lista
// (`threec_mailing_lista_substituir`) e reenvia quem AINDA passa na régua, 1.000 por rodada.
// Por isso não há segunda régua aqui, nem mexida no histórico local.
//
// ⚠️ SÓ `grupo_segmento`. Novo Lead SDR (outra function), Orgânico/Indicação (`origem`) e
// as filas de reunião (`resultado_reuniao`) NÃO entram — o escopo já custou caro em 09/09.
const RECORTE_RENOVAVEL = 'grupo_segmento'

async function renovar(cfg: ListaCfg, dry: boolean, renovarLease?: RenovarLease): Promise<Response> {
  if (cfg.recorte !== RECORTE_RENOVAVEL) {
    return json({ ok: false, campanha: cfg.nome, error: 'renovação noturna vale só para campanhas de pós (grupo_segmento)' }, 400)
  }
  let listas: Array<{ id: string; nome: string; estoque: number }>
  try {
    listas = await listarListasDaCampanha(cfg.campanha_id, { api: api3c, renovarLease })
  } catch (err) {
    // Inventário incerto não autoriza apagar: a campanha fica para a próxima invocação.
    if (!dry) await registrar(cfg.id, 'expurgar', {}, `renovação: ${String(err)}`, { renovacao_noturna: true })
    return json({ ok: false, campanha: cfg.nome, etapa: 'inventario', detail: String(err) }, 502)
  }
  if (dry) return json({ ok: true, dry: true, campanha: cfg.nome, listas_que_seriam_apagadas: listas })

  const apagadas: typeof listas = []
  const falhas: string[] = []
  for (const l of listas) {
    try {
      await renovarLease?.()
      const resp = await api3c(`/campaigns/${encodeURIComponent(cfg.campanha_id)}/lists/${encodeURIComponent(l.id)}`, { method: 'DELETE' })
      if (resp.status >= 200 && resp.status < 300) apagadas.push(l)
      else falhas.push(`lista ${l.id}: HTTP ${resp.status}`)
    } catch (err) {
      falhas.push(`lista ${l.id}: ${String(err)}`)
      if (err instanceof LeasePerdido) break
    }
  }
  // Só marca a noite como feita se NÃO sobrou lista: com falha, a próxima invocação tenta de novo.
  if (falhas.length === 0) {
    const { error } = await supabase.from('threec_mailing_listas')
      .update({ ultima_renovacao_em: new Date().toISOString() }).eq('id', cfg.id)
    if (error) falhas.push(`marcar renovação: ${error.message}`)
  }
  await registrar(cfg.id, 'expurgar', { removidos: 0 },
    falhas.length ? `renovação: ${falhas.slice(0, 3).join(' | ')}` : undefined,
    { renovacao_noturna: true, listas_apagadas: apagadas, contatos_nas_listas: apagadas.reduce((t, l) => t + l.estoque, 0) })
  return json({ ok: falhas.length === 0, campanha: cfg.nome, listas_apagadas: apagadas, falhas: falhas.slice(0, 3) })
}

// --------------------------------------------------------------- sincronizar ----
async function sincronizar(cfg: ListaCfg, limite: number | null, dry: boolean, renovarLease?: RenovarLease, tokenLease?: string): Promise<Response> {
  let recuperacao: Awaited<ReturnType<typeof recuperarListaAutomatica>> | undefined
  let liberados = 0
  if (!dry) {
    // A recuperação também roda sem novos candidatos. Antes, um ID apagado ficava
    // escondido pelo retorno antecipado "sem novos contatos" para sempre.
    const pendentes = await supabase.rpc('threec_mailing_a_expurgar_lista', { p_lista: cfg.id, p_limite: 1 })
    if (pendentes.error || !Array.isArray(pendentes.data)) {
      throw new Error('nao foi possivel conferir o expurgo antes de recuperar a lista')
    }
    if (pendentes.data.length > 0) {
      await registrar(cfg.id, 'sincronizar', {}, 'retirada de contatos ainda pendente; aguardando manutencao')
      return json({ ok: false, campanha: cfg.nome, error: 'retirada de contatos ainda pendente' }, 409)
    }
    try {
      recuperacao = await recuperarListaAutomatica(cfg, { api: api3c, renovarLease })
    } catch (err) {
      await registrar(cfg.id, 'sincronizar', {}, `falha ao recuperar lista: ${String(err)}`)
      return json({ ok: false, campanha: cfg.nome, error: 'falha ao recuperar lista', detail: String(err) }, 502)
    }
    // Confere também um ID mantido: a configuração foi lida antes de adquirir a
    // lease e outra rodada pode tê-la substituído nesse pequeno intervalo.
    {
      await renovarLease?.()
      const troca = await supabase.rpc('threec_mailing_lista_substituir', {
        p_lista: cfg.id, p_token: tokenLease, p_lista_anterior: cfg.lista_id,
        p_lista_nova: recuperacao.listaId, p_anterior_excluida: recuperacao.anteriorExcluida,
      })
      if (troca.error || typeof troca.data !== 'number') {
        throw new Error('lista recuperada no 3C mas confirmacao local pendente; envio interrompido')
      }
      liberados = troca.data
      cfg.lista_id = recuperacao.listaId
    }
  }
  const detalheRecuperacao = recuperacao && (recuperacao.criada || recuperacao.anteriorExcluida || recuperacao.reativada)
    ? { recuperacao: { ...recuperacao, liberados_para_reavaliacao: liberados } } : {}
  const { data, error } = await supabase.rpc('threec_mailing_selecionar_lista', {
    p_lista: cfg.id,
    p_limite: limite ?? cfg.limite_por_rodada,
  })
  if (error) {
    if (!dry) await registrar(cfg.id, 'sincronizar', {}, `falha ao selecionar: ${error.message}`)
    return json({ error: 'falha ao selecionar', detail: error.message }, 500)
  }

  const rows = (data ?? []) as LeadRow[]
  if (rows.length === 0) {
    if (!dry) {
      await supabase.from('threec_mailing_listas').update({
        ultimo_resultado: { enviados: 0, motivo: 'sem novos contatos liberados agora', ...detalheRecuperacao },
      }).eq('id', cfg.id)
    }
    if (!dry) await registrar(cfg.id, 'sincronizar', {}, undefined, { motivo: 'sem novos contatos liberados agora', ...detalheRecuperacao })
    return json({ ok: true, campanha: cfg.nome, enviados: 0, motivo: 'sem novos contatos liberados agora', ...detalheRecuperacao })
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

  const listaId = recuperacao!.listaId

  const alvo = `${THREEC_BASE}/campaigns/${cfg.campanha_id}/lists/${listaId}/mailing?api_token=${THREEC_TOKEN}`
  const aceitos: number[] = []
  let descartadosPeloTresC = 0
  const falhas: string[] = []

  for (let ini = 0; ini < mailing.length; ini += MAX_POR_POST) {
    const fatia = mailing.slice(ini, ini + MAX_POR_POST)
    let resp: Response
    try {
      await renovarLease?.()
      resp = await fetch(alvo, {
        method: 'POST',
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ header: HEADER, mailing: fatia }),
      })
    } catch (err) {
      falhas.push(`lote ${ini / MAX_POR_POST}: ${String(err)}`)
      if (err instanceof LeasePerdido) break
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
    ...detalheRecuperacao,
  }
  await supabase.from('threec_mailing_listas').update({
    ultimo_resultado: resultado,
    lista_id: listaId,
  }).eq('id', cfg.id)
  await registrar(cfg.id, 'sincronizar', {
    enviados: enviados.length,
    aceitos: enviados.length - descartadosPeloTresC,
    descartados: descartadosPeloTresC,
  }, falhas.length ? falhas.slice(0, 3).join(' | ') : undefined, { lista_id: listaId, ...detalheRecuperacao })

  return json({ ok: falhas.length === 0, campanha: cfg.nome, lista_id: listaId, ...resultado })
}

async function executarAcao(cfg: ListaCfg, acao: 'expurgar' | 'sincronizar', limite: number | null,
  dry: boolean, renovarLease?: RenovarLease, tokenLease?: string): Promise<Response> {
  try {
    return acao === 'expurgar'
      ? await expurgar(cfg, limite ?? 500, dry, renovarLease)
      : await sincronizar(cfg, limite, dry, renovarLease, tokenLease)
  } catch (err) {
    if (!dry) await registrar(cfg.id, acao, {}, `falha inesperada: ${String(err)}`)
    return json({ ok: false, error: `falha ao ${acao}`, detail: String(err) }, 500)
  }
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
  if (!['sincronizar', 'expurgar', 'manter', 'renovar'].includes(acao)) return json({ error: 'acao invalida' }, 400)
  const qLista = url.searchParams.get('lista')
  const qRecorte = url.searchParams.get('recorte')?.trim()
  const qLimite = Number(url.searchParams.get('limite') ?? '') || null
  const dry = url.searchParams.get('dry') === '1'

  // a campanha pedida, ou a mais atrasada da fila. Cada ação tem a SUA fila: ordenar
  // o expurgo por `ultima_sync_em` faria ele voltar sempre à mesma campanha.
  const colunaFila = acao === 'sincronizar' ? 'ultima_sync_em' : 'ultimo_expurgo_em'
  const campos = 'id, nome, campanha_id, lista_id, recorte, limite_por_rodada'
  let q = supabase.from('threec_mailing_listas').select(campos)
  q = qLista ? q.eq('id', qLista) : q.eq('ativo', true)
  if (qRecorte) q = q.eq('recorte', qRecorte)
  if (acao === 'renovar') {
    // Fila da NOITE: só pós, e só quem ainda não foi renovada nas últimas 12 h (o cron roda
    // 30 min seguidos; sem isto a campanha recém-recriada seria apagada de novo).
    q = q.eq('recorte', RECORTE_RENOVAVEL)
    if (!qLista) {
      const corte = new Date(Date.now() - 12 * 3_600_000).toISOString()
      q = q.or(`ultima_renovacao_em.is.null,ultima_renovacao_em.lt.${corte}`)
    }
  }
  const { data: linhas, error: eCfg } = await q
    .order(acao === 'renovar' ? 'ultima_renovacao_em' : colunaFila, { ascending: true, nullsFirst: true })
    .limit(1)
  if (eCfg) return json({ error: 'falha ao ler a config', detail: eCfg.message }, 500)
  const cfg = (linhas ?? [])[0] as ListaCfg | undefined
  if (!cfg) return json({ ok: true, skip: acao === 'renovar' ? 'todas as campanhas de pós já foram renovadas nesta noite' : 'nenhuma campanha ativa em threec_mailing_listas' })

  // A simulação não disputa lease nem altera fila/histórico. Cron dedicado e geral
  // podem alcançar a mesma lista: a posse é por token, não pela origem da chamada.
  const token = dry ? null : crypto.randomUUID()
  if (token) {
    const { data: adquirido, error } = await supabase.rpc('threec_mailing_lista_travar', {
      p_lista: cfg.id, p_token: token, p_segundos: LEASE_SEGUNDOS,
    })
    if (error) {
      await registrar(cfg.id, acao === 'sincronizar' ? 'sincronizar' : 'expurgar', {},
        `falha ao obter exclusividade: ${error.message}`)
      return json({ ok: false, error: 'falha ao obter exclusividade', detail: error.message }, 500)
    }
    if (adquirido !== true) return json({ ok: true, campanha: cfg.nome, skip: 'campanha em processamento' })
  }
  const renovarLease: RenovarLease | undefined = token ? async () => {
    try {
      const { data: renovado, error } = await supabase.rpc('threec_mailing_lista_travar', {
        p_lista: cfg.id, p_token: token, p_segundos: LEASE_SEGUNDOS,
      })
      if (!error && renovado === true) return
    } catch { /* Falha de transporte também impede continuar com uma posse incerta. */ }
    throw new LeasePerdido('exclusividade da campanha perdida; lote não enviado')
  } : undefined

  try {
    if (acao === 'renovar') return await renovar(cfg, dry, renovarLease)
    if (acao !== 'manter') return await executarAcao(cfg, acao as 'expurgar' | 'sincronizar', qLimite, dry, renovarLease, token ?? undefined)
    const respostaExpurgo = await executarAcao(cfg, 'expurgar', qLimite, dry, renovarLease, token ?? undefined)
    const resultadoExpurgo = await respostaExpurgo.json()
    // DELETE parcialmente recusado também responde com ok=false. Não basta HTTP 200:
    // abastecer agora poderia manter no discador quem acabou de remarcar a reunião.
    if (!respostaExpurgo.ok || resultadoExpurgo.ok !== true) {
      return json({ ok: false, campanha: cfg.nome, etapa: 'expurgar', expurgo: resultadoExpurgo },
        respostaExpurgo.ok ? 502 : respostaExpurgo.status)
    }
    const respostaSync = await executarAcao(cfg, 'sincronizar', qLimite, dry, renovarLease, token ?? undefined)
    const resultadoSync = await respostaSync.json()
    return json({ ok: respostaSync.ok && resultadoSync.ok === true, ...(dry ? { dry: true } : {}),
      campanha: cfg.nome, expurgo: resultadoExpurgo, sincronizacao: resultadoSync }, respostaSync.status)
  } finally {
    if (token) {
      try {
        const { error } = await supabase.rpc('threec_mailing_lista_destravar', { p_lista: cfg.id, p_token: token })
        if (error) console.error('[threec-mailing-listas] falhou ao liberar exclusividade', error.message)
      } catch (err) {
        console.error('[threec-mailing-listas] falhou ao liberar exclusividade', String(err))
      }
    }
  }
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
