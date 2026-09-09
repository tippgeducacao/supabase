// Alimenta o mailing do discador 3C+ (campanha "Novo Lead SDR") a partir da
// tabela `leads` do self-hosted.
//
// SUBSTITUI o par de workflows n8n que morreu com o SprintHub:
//   • "Exportar leads"                    (webhook -> leads_buffer no Supabase CLOUD)
//   • "Leads SprintHub -> 3C Plus"        (schedule 2min -> lista DIARIA no 3C)
//
// O que muda:
//   • fonte = `leads` (self-hosted), sem buffer intermediario
//   • token do 3C em env (era hardcoded no node "Config 3C" do n8n)
//   • 2 listas FIXAS (Quente/Base) no lugar de 1 lista por dia — o 3C dilui o
//     peso entre as listas, e a campanha tinha chegado a 104 delas
//   • `curso` virou COLUNA do mailing (antes ia grudado no identifier)
//
// A regua de QUEM entra vive na RPC `threec_mailing_selecionar` (fonte unica),
// que aplica os cinco vetos próprios da SDR por telefone. Esta function formata,
// envia, confirma os lotes e remove quem passou a ser vetado (acao=expurgar).
//
// Novo escopo específico autorizado em 09/09/2026: todo retroativo e lead novo,
// excluindo B2B, aluno, arquivado, bloqueado e não-perturbe. As outras 21 campanhas
// mantêm sua régua própria. A ação manter remove antes de alimentar a SDR.
//
// Chamada:
//   POST /functions/v1/threec-mailing-sync            -> lista Quente, limite da config
//   POST ?lista=base&limite=500&desde=2026-06-27      -> backfill na Base
//   POST ?dry=1                                       -> so simula (nao envia, nao marca)
//   POST ?acao=expurgar&dry=1                         -> quem esta na campanha e hoje e vetado
//   POST ?acao=expurgar                               -> tira essa gente da campanha no 3C
//   POST ?acao=manter                                 -> expurga e depois alimenta sob o mesmo lease

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'
import { atualizarBloqueios3C } from './bloqueios.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ⚠️ HOST NOVO desde 22/08/2026: a FluxoTI virou **3C Plus** e aposentou o domínio.
// `fluxoti.com` não resolve mais (sem DNS) e `3c.fluxoti.com`, embora ainda responda
// pelo Cloudflare, devolve o MESMO 404 de nginx em todo path — raiz, /login, /api,
// /health. Não é token nem rede: não há nada servido ali.
// Medido com o token real, de dentro da VPS:
//     3c.fluxoti.com/api/v1/agents/status  -> 404
//     app.3c.plus/api/v1/agents/status     -> 200 OK
// O token continua o mesmo; só o endereço mudou. Parou tudo entre 21h46 e 21h48 BRT
// de 21/08/2026 — Dash Ligação, TV, mailing quente (0 lead no discador) e as listas
// de cobrança, todos de uma vez, porque as quatro functions caem neste default
// (THREEC_BASE_URL não está definida na VPS).
const THREEC_BASE = Deno.env.get('THREEC_BASE_URL') ?? 'https://app.3c.plus/api/v1'
const THREEC_TOKEN =
  Deno.env.get('3C_TOKEN_API') ??
  Deno.env.get('THREEC_API_TOKEN') ??
  Deno.env.get('THREEC_TOKEN') ??
  ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// Header mantido por compatibilidade com a importação. Os campos que aparecem
// ao atender precisam estar dentro de mailing.data; o header não substitui isso.
const HEADER = ['identifier', 'areacode', 'phone', 'nome', 'email', 'formacao', 'curso'] as const

// Teto do 3C por requisicao: "O campo Mailing deve ter no maximo 300 itens".
// Confirmado ao vivo (422 com 800). A rodada inteira é limitada a 300 para
// terminar dentro do lease e permitir alternar entrada, expurgo e carga da Base.
const MAX_POR_POST = 300

interface LeadRow {
  lead_id: string
  canon: string
  telefone: string
  nome: string
  email: string
  formacao: string
  curso: string
  criado_em: string
}

// ---------------------------------------------------------------- limpeza ----
// O agente do discador LE esses campos na tela. O dado cru vem sujo de 3 formas:
//   - caracteres invisiveis que o lead usa p/ furar filtro de bot
//   - formacao com underscore, do formulario da Meta: "medico_veterinario_(a)"
//   - curso em CAIXA ALTA em parte das origens
//
// Construido com new RegExp e ESCAPES ASCII de proposito: caractere invisivel
// literal no fonte quebra o parser do Deno ("Unterminated regexp literal") e
// derruba o boot da function inteira. Ja aconteceu aqui — nao voltar ao literal.
// U+00AD soft hyphen | U+034F combining grapheme joiner | U+200B-200F zero-width
// e marcas de direcao | U+2060-206F word joiner/invisiveis | U+FEFF BOM
const INVISIVEIS = new RegExp('[\u00AD\u034F\u200B-\u200F\u2060-\u206F\uFEFF]', 'g')

// NFKC dobra as fontes estilizadas do Unicode que o lead usa no perfil
// ("𝑵𝒂𝒕𝒂𝒍𝒚" -> "Nataly"). Sem isso o agente ve o nome ilegivel na tela do 3C.
const limpar = (s: string): string =>
  (s ?? '').normalize('NFKC').replace(INVISIVEIS, '').replace(/\s+/g, ' ').trim()

// "medico_veterinario_(a)" -> "Medico Veterinario (a)"
const humanizarFormacao = (s: string): string => {
  const base = limpar(s).replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
  if (!base) return ''
  return base.charAt(0).toUpperCase() + base.slice(1)
}

// CAIXA ALTA -> Title Case; texto ja capitalizado fica como esta.
const MINUSCULAS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'na', 'no', 'para', 'com', 'a', 'o'])
const normalizarCurso = (s: string): string => {
  const base = limpar(s)
  if (!base) return ''
  const temMinuscula = /[a-záàâãéêíóôõúç]/.test(base)
  if (temMinuscula) return base // ja veio legivel
  return base
    .toLocaleLowerCase('pt-BR')
    .split(' ')
    .map((p, i) => {
      const semPont = p.replace(/[^\wáàâãéêíóôõúç]/gi, '')
      if (i > 0 && MINUSCULAS.has(semPont)) return p
      // sigla do dominio (POA, BEA, MBA, ITH...) fica em caixa alta
      if (semPont.length <= 3 && semPont.length > 0) return p.toLocaleUpperCase('pt-BR')
      return p.charAt(0).toLocaleUpperCase('pt-BR') + p.slice(1)
    })
    .join(' ')
}

// O `identifier` e o rotulo que o agente ve primeiro no 3C.
const montarIdentifier = (nome: string, curso: string): string => {
  const n = limpar(nome) || 'Lead'
  const c = normalizarCurso(curso)
  const id = c ? `${n} - ${c}` : n
  return id.slice(0, 120)
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// ----------------------------------------------------------------- expurgo ----
// Corrigir a regua impede a PROXIMA injecao — nao desfaz as anteriores. Quem ja
// esta na campanha continua na fila do discador ate ser ligado. Foi assim que o
// chamado "LEADS 3C" (31/08/2026) apareceu: 238 candidatos a VAGA ja dentro da
// campanha "Novo Lead SDR".
//
// Corpo confirmado ao vivo na investigacao da cobranca (docs/Financeiro e
// Cobranca.md): campo `phone` no SINGULAR, valor em ARRAY, resposta 204.
//     DELETE /campaigns/{id}/mailing/delete   {"phone": ["44999998888"]}
//
// A RPC de expurgo consulta os mesmos vetos por telefone da seleção SDR, inclusive
// quando o status mudou em outro cadastro com o mesmo telefone canônico.
const MAX_POR_DELETE = 100
const TIMEOUT_3C_MS = 20_000
const TIMEOUT_RODADA_MS = 120_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
interface ExpurgoRow { lead_id: string; canon: string; telefone: string; nome: string; motivo: string }
interface ConfigSDR {
  campanha_id: string; lista_quente_id: string; lista_base_id: string
  ativo: boolean; limite_por_rodada: number
}
const limitarRodada = (valor: number) => Math.max(1, Math.min(MAX_POR_POST, Math.trunc(valor)))

async function requisitar3C(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  if (signal?.aborted) throw new Error('prazo da rodada esgotado')
  const controller = new AbortController()
  const abortar = () => controller.abort()
  signal?.addEventListener('abort', abortar, { once: true })
  const timer = setTimeout(() => controller.abort(), TIMEOUT_3C_MS)
  try {
    const resposta = await fetch(url, { ...init, signal: controller.signal })
    // O prazo cobre também o corpo: receber cabeçalhos não encerra a requisição.
    const corpo = await resposta.text()
    return new Response([204, 205, 304].includes(resposta.status) ? null : corpo, {
      status: resposta.status, headers: resposta.headers,
    })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abortar)
  }
}

async function expurgar(campanhaId: string, limite: number, dry: boolean, signal?: AbortSignal): Promise<Response> {
  const { data, error } = await supabase.rpc('threec_mailing_a_expurgar', { p_limite: limite })
  if (error) return json({ ok: false, error: 'falha ao listar quem expurgar' }, 500)
  const linhas = ((data ?? []) as ExpurgoRow[]).slice(0, limite)
  const porMotivo = linhas.reduce<Record<string, number>>((acc, l) => {
    acc[l.motivo] = (acc[l.motivo] ?? 0) + 1
    return acc
  }, {})
  if (dry) return json({ ok: true, dry: true, total: linhas.length, por_motivo: porMotivo,
    amostra: linhas.slice(0, 10).map((l) => ({ nome: l.nome, telefone: l.telefone, motivo: l.motivo })) })
  let removidos = 0
  let marcados = 0
  for (let ini = 0; ini < linhas.length; ini += MAX_POR_DELETE) {
    const fatia = linhas.slice(ini, ini + MAX_POR_DELETE)
    let resp: Response
    try {
      resp = await requisitar3C(`${THREEC_BASE}/campaigns/${campanhaId}/mailing/delete?api_token=${THREEC_TOKEN}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ phone: fatia.map((l) => l.telefone) }),
      }, signal)
    } catch {
      return json({ ok: false, error: 'falha de transporte no expurgo', removidos_no_3c: removidos, marcados }, 502)
    }
    if (!resp.ok) return json({ ok: false, error: '3C recusou o expurgo', status_3c: resp.status,
      removidos_no_3c: removidos, marcados }, 502)
    removidos += fatia.length
    // Confirma cada DELETE antes de continuar; a ação manter não alimenta se falhar.
    const { data: n, error: eMarcar } = await supabase.rpc('threec_mailing_marcar_removidos', {
      p_canons: fatia.map((l) => l.canon), p_motivo: 'expurgo: fora da regua do discador SDR', p_campanha_id: campanhaId,
    })
    if (eMarcar || !Number.isInteger(n) || (n as number) < 0) return json({ ok: false,
      alerta: 'removido no 3C mas falhou ao marcar no banco', removidos_no_3c: removidos, marcados }, 500)
    marcados += n as number
  }
  return json({ ok: true, total_candidatos: linhas.length, removidos_no_3c: removidos, marcados, por_motivo: porMotivo })
}

async function sincronizar(cfg: ConfigSDR, lista: string, limite: number, desde: string | null, dry: boolean, token: string, signal?: AbortSignal): Promise<Response> {
  if (!cfg.ativo) return json({ ok: true, skip: 'pipeline pausado (threec_mailing_config.ativo=false)' })
  const listaId = lista === 'base' ? cfg.lista_base_id : cfg.lista_quente_id
  const { data: leads, error: eSel } = await supabase.rpc('threec_mailing_selecionar', {
    p_limite: limite, p_desde: desde, p_ignorar_enviados: false,
  })
  if (eSel) return json({ ok: false, error: 'falha ao selecionar leads' }, 500)
  // Protege o teto da rodada mesmo se a RPC devolver mais que o limite solicitado.
  const rows = ((leads ?? []) as LeadRow[]).slice(0, limite)
  const mailing = rows.map((r) => ({
    identifier: montarIdentifier(r.nome, r.curso), areacode: r.telefone.substring(0, 2), phone: r.telefone,
    data: { nome: limpar(r.nome) || 'Lead', email: limpar(r.email),
      formacao: humanizarFormacao(r.formacao), curso: normalizarCurso(r.curso) },
  }))
  if (dry) return json({ ok: true, dry: true, lista, lista_id: listaId, total: mailing.length, amostra: mailing.slice(0, 5) })
  if (!rows.length) return json({ ok: true, lista, lista_id: listaId, enviados: 0, submetidos: 0, submetidos_confirmados: 0,
    marcados: 0, importados: 0, imported_lines: 0, importados_agregados: 0, descartados_agregados: 0,
    total_selecionado: 0, com_curso: 0, motivo: 'nenhum lead elegivel' })
  let submetidos = 0
  let marcados = 0
  let importados: number | null = 0
  const resumo = () => ({ enviados: submetidos, submetidos, submetidos_confirmados: submetidos, marcados,
    importados, imported_lines: importados, importados_agregados: importados,
    descartados_agregados: importados === null ? null : submetidos - importados, total_selecionado: rows.length })
  for (let ini = 0; ini < mailing.length; ini += MAX_POR_POST) {
    const fatia = mailing.slice(ini, ini + MAX_POR_POST)
    const itens = rows.slice(ini, ini + MAX_POR_POST).map((r) => ({
      lead_id: r.lead_id, canon: r.canon, telefone: r.telefone, curso: r.curso,
    }))
    // Persistir antes do HTTP impede repetição cega se o processo cair depois do POST.
    if (signal?.aborted) return json({ ok: false, error: 'prazo da rodada esgotado antes do envio', ...resumo() }, 504)
    const { data: loteId, error: eLote } = await supabase.rpc('threec_sdr_lote_iniciar', {
      p_token: token, p_lista_id: String(listaId), p_itens: itens,
    })
    if (eLote || typeof loteId !== 'string' || !UUID.test(loteId)) return json({ ok: false,
      error: 'não foi possível preparar lote durável', ...resumo(), retry_bloqueado: true }, 500)
    let resp: Response
    try {
      resp = await requisitar3C(`${THREEC_BASE}/campaigns/${cfg.campanha_id}/lists/${listaId}/mailing?api_token=${THREEC_TOKEN}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ header: HEADER, mailing: fatia }),
      }, signal)
    } catch {
      return json({ ok: false, alerta: 'resultado do envio desconhecido; reconciliar lote antes de repetir',
        ...resumo(), lote_id: loteId, retry_bloqueado: true }, 502)
    }
    if (!resp.ok) {
      // 408 e 5xx podem ocorrer após processamento: a pendência permanece durável.
      const recusado = resp.status >= 400 && resp.status < 500 && resp.status !== 408
      let liberado = false
      if (recusado) {
        const r = await supabase.rpc('threec_sdr_lote_recusar', {
          p_token: token, p_lote_id: loteId, p_detalhe: `HTTP ${resp.status}`,
        })
        liberado = !r.error && r.data === true
      }
      return json({ ok: false, error: '3C não confirmou o envio', status_3c: resp.status,
        ...resumo(), lote_id: loteId, retry_bloqueado: !liberado }, recusado ? 422 : 502)
    }
    submetidos += fatia.length
    let contagem: number | null = null
    try {
      const body = await resp.json()
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || (typeof body.status === 'number' && body.status >= 400)) throw new Error('resposta inválida')
      if (body.imported_lines !== undefined && body.imported_lines !== null) {
        if (!Number.isInteger(body.imported_lines) || body.imported_lines < 0 || body.imported_lines > fatia.length) {
          throw new Error('contagem inválida')
        }
        contagem = body.imported_lines
      }
    } catch {
      importados = null
      return json({ ok: false, alerta: 'resposta de importação inválida; reconciliar lote antes de repetir',
        ...resumo(), lote_id: loteId, retry_bloqueado: true }, 502)
    }
    importados = importados === null || contagem === null ? null : importados + contagem
    // Confirma submissões e conclui o lote atomicamente, sem alegar aceite individual.
    const { data: n, error: eMarcar } = await supabase.rpc('threec_sdr_lote_confirmar', {
      p_token: token, p_lote_id: loteId, p_importados: contagem,
    })
    if (eMarcar || !Number.isInteger(n) || (n as number) < 0) return json({ ok: false,
      alerta: 'enviado ao 3C mas falhou ao confirmar no banco; reconciliar lote antes de repetir',
      ...resumo(), lote_id: loteId, retry_bloqueado: true }, 500)
    marcados += n as number
  }
  return json({ ok: true, lista, lista_id: listaId, ...resumo(), com_curso: mailing.filter((m) => m.data.curso).length })
}

async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  // Gate: so service role (cron interno / operacao manual). Nunca anon.
  // Aceita as DUAS chaves: a do vault (_get_service_role_key) e a env do
  // container sao strings diferentes — comparar so com uma da 401 no cron.
  const auth = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!auth || auth !== SERVICE_ROLE) {
    // NAO usar .catch() aqui: supabase.rpc() devolve um PostgrestBuilder
    // (thenable, nao Promise) — .catch nao existe e lança TypeError, que vira
    // um "Internal Server Error" sem corpo. try/catch de verdade.
    let vaultKey: string | null = null
    try {
      const r = await supabase.rpc('_get_service_role_key')
      vaultKey = (r.data as string | null) ?? null
    } catch (err) {
      console.error('[threec-mailing-sync] falha ao ler a key do vault', String(err))
    }
    if (!vaultKey || auth !== vaultKey) return json({ error: 'forbidden' }, 403)
  }
  if (!THREEC_TOKEN) return json({ error: '3C_TOKEN_API nao configurado no edge-runtime' }, 500)
  const url = new URL(req.url)
  const acao = (url.searchParams.get('acao') ?? 'sincronizar').toLowerCase()
  const lista = (url.searchParams.get('lista') ?? 'quente').toLowerCase()
  const qLimite = url.searchParams.get('limite')
  const desde = url.searchParams.get('desde')
  const dry = url.searchParams.get('dry') === '1'
  if (!['sincronizar', 'expurgar', 'manter'].includes(acao) || !['quente', 'base'].includes(lista)) {
    return json({ ok: false, error: 'ação ou lista inválida' }, 400)
  }
  if (qLimite !== null && (!qLimite.trim() || !Number.isFinite(Number(qLimite)))) return json({ ok: false, error: 'limite inválido' }, 400)
  if (desde !== null && !Number.isFinite(Date.parse(desde))) return json({ ok: false, error: 'data inválida' }, 400)
  const { data, error } = await supabase.from('threec_mailing_config')
    .select('campanha_id, lista_quente_id, lista_base_id, ativo, limite_por_rodada').maybeSingle()
  if (error || !data) return json({ ok: false, error: 'config indisponivel' }, 500)
  const cfg = data as ConfigSDR
  const limite = limitarRodada(qLimite === null ? Number(cfg.limite_por_rodada) || 300 : Number(qLimite))
  const token = dry ? '' : crypto.randomUUID()
  if (!dry) {
    const lease = await supabase.rpc('threec_sdr_travar', { p_token: token, p_segundos: 180 })
    if (lease.error) return json({ ok: false, error: 'falha ao adquirir trava SDR' }, 500)
    if (lease.data !== true) return json({ ok: false, ocupado: true, error: 'SDR ocupada ou com lote pendente de reconciliação' }, 409)
  }
  const rodada = new AbortController()
  const timerRodada = dry ? null : setTimeout(() => rodada.abort(), TIMEOUT_RODADA_MS)
  try {
    if (acao === 'expurgar') return await expurgar(String(cfg.campanha_id), limite, dry, rodada.signal)
    let bloqueios: Awaited<ReturnType<typeof atualizarBloqueios3C>> | null = null
    let resultadoExpurgo: Record<string, unknown> | null = null
    if (acao === 'manter') {
      if (!dry) {
        try {
          bloqueios = await atualizarBloqueios3C({ supabase, base: THREEC_BASE, token: THREEC_TOKEN, signal: rodada.signal })
        } catch {
          return json({ ok: false, error: 'falha ao atualizar bloqueios do 3C; entrada suspensa' }, 502)
        }
      }
      const resposta = await expurgar(String(cfg.campanha_id), limite, dry, rodada.signal)
      resultadoExpurgo = await resposta.clone().json()
      if (!resposta.ok || resultadoExpurgo?.ok !== true) return resposta
    }
    const resposta = await sincronizar(cfg, lista, limite, desde ? new Date(desde).toISOString() : null, dry, token, rodada.signal)
    if (!resultadoExpurgo) return resposta
    return json({ ...await resposta.json(), expurgo: resultadoExpurgo, bloqueios_3c: bloqueios }, resposta.status)
  } finally {
    if (timerRodada !== null) clearTimeout(timerRodada)
    if (!dry) {
      try {
        const r = await supabase.rpc('threec_sdr_destravar', { p_token: token })
        if (r.error || r.data !== true) console.error('[threec-mailing-sync] falha ao liberar lease; aguardar vencimento')
      } catch {
        console.error('[threec-mailing-sync] falha ao liberar lease; aguardar vencimento')
      }
    }
  }
}
Deno.serve(async (req) => {
  try { return await handler(req) } catch {
    // Erros de transporte podem conter URL autenticada; nunca ecoar a exceção.
    return json({ ok: false, error: 'erro interno no mailing SDR' }, 500)
  }
})
