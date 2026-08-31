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
// que le a lista `threec_mailing_exclusoes`. Esta function so formata, envia e
// marca — e sabe DESFAZER (acao=expurgar).
//
// ⚠️ `public.leads` NAO e uma tabela so do comercial: candidato a vaga (webhooks
// de contratacao), aluno importado pela carga do SIGA/EDUQ e inadimplente do
// funil de cobranca nascem todos ali. Sem a lista de exclusao, todos eles caem
// no discador de VENDAS — foi o chamado "LEADS 3C" de 31/08/2026.
//
// Chamada:
//   POST /functions/v1/threec-mailing-sync            -> lista Quente, limite da config
//   POST ?lista=base&limite=500&desde=2026-06-27      -> backfill na Base
//   POST ?dry=1                                       -> so simula (nao envia, nao marca)
//   POST ?acao=expurgar&dry=1                         -> quem esta na campanha e hoje e vetado
//   POST ?acao=expurgar                               -> tira essa gente da campanha no 3C

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

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

// Header do mailing. ORDEM IMPORTA: e a mesma com que as listas foram criadas
// no 3C. Mudou aqui -> tem que recriar as listas (o 3C fixa o header na criacao).
const HEADER = ['identifier', 'areacode', 'phone', 'nome', 'email', 'formacao', 'curso'] as const

// Teto do 3C por requisicao: "O campo Mailing deve ter no maximo 300 itens".
// Confirmado ao vivo (422 com 800). O `limite_por_rodada` da config pode ser
// maior — a function fatia sozinha.
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
// QUEM sai vem da RPC `threec_mailing_a_expurgar`, que le a MESMA lista de
// exclusao da regua de entrada — mexeu na lista, o expurgo acompanha. Linha de
// exclusao com `expurgar=false` (caso do [LEADS IMPORTADOS]) barra entrada nova
// mas nao tira ninguem retroativamente.
const MAX_POR_DELETE = 100

interface ExpurgoRow {
  lead_id: string
  canon: string
  telefone: string
  nome: string
  motivo: string
}

async function expurgar(campanhaId: string, limite: number, dry: boolean): Promise<Response> {
  const { data, error } = await supabase.rpc('threec_mailing_a_expurgar', { p_limite: limite })
  if (error) return json({ error: 'falha ao listar quem expurgar', detail: error.message }, 500)

  const linhas = (data ?? []) as ExpurgoRow[]
  const porMotivo = linhas.reduce<Record<string, number>>((acc, l) => {
    acc[l.motivo] = (acc[l.motivo] ?? 0) + 1
    return acc
  }, {})

  if (linhas.length === 0) return json({ ok: true, expurgados: 0, motivo: 'ninguem a expurgar' })
  if (dry) {
    return json({
      ok: true, dry: true, total: linhas.length, por_motivo: porMotivo,
      amostra: linhas.slice(0, 10).map((l) => ({ nome: l.nome, telefone: l.telefone, motivo: l.motivo })),
    })
  }

  const removidos: string[] = [] // canons que o 3C confirmou ter tirado
  const falhas: string[] = []
  for (let ini = 0; ini < linhas.length; ini += MAX_POR_DELETE) {
    const fatia = linhas.slice(ini, ini + MAX_POR_DELETE)
    const alvo = `${THREEC_BASE}/campaigns/${campanhaId}/mailing/delete?api_token=${THREEC_TOKEN}`
    let resp: Response
    try {
      resp = await fetch(alvo, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ phone: fatia.map((l) => l.telefone) }),
      })
    } catch (err) {
      falhas.push(`lote ${ini / MAX_POR_DELETE}: ${String(err)}`)
      continue
    }
    if (resp.status >= 200 && resp.status < 300) {
      for (const l of fatia) removidos.push(l.canon)
    } else {
      const corpo = await resp.text()
      console.error('[threec-mailing-sync] 3C recusou o DELETE', { ini, status: resp.status, corpo: corpo.slice(0, 300) })
      falhas.push(`lote ${ini / MAX_POR_DELETE}: HTTP ${resp.status} ${corpo.slice(0, 200)}`)
    }
  }

  // So marca o que o 3C confirmou: se o DELETE falhou, a linha continua
  // pendente e a proxima rodada tenta de novo.
  let marcados = 0
  if (removidos.length > 0) {
    const { data: n, error: eMarcar } = await supabase.rpc('threec_mailing_marcar_removidos', {
      p_canons: removidos,
      p_motivo: 'expurgo: fora da regua do discador SDR',
    })
    if (eMarcar) {
      console.error('[threec-mailing-sync] REMOVEU MAS NAO MARCOU', eMarcar.message)
      return json({ ok: false, removidos_no_3c: removidos.length, marcados: 0, alerta: 'removido no 3C mas falhou ao marcar no banco', detail: eMarcar.message }, 500)
    }
    marcados = (n as number) ?? 0
  }

  return json({
    ok: falhas.length === 0,
    total_candidatos: linhas.length,
    removidos_no_3c: removidos.length,
    marcados,
    por_motivo: porMotivo,
    falhas: falhas.slice(0, 3),
  })
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

  console.log('[threec-mailing-sync] gate ok; token?', THREEC_TOKEN ? 'sim' : 'NAO')
  if (!THREEC_TOKEN) return json({ error: '3C_TOKEN_API nao configurado no edge-runtime' }, 500)

  const url = new URL(req.url)
  const acao = (url.searchParams.get('acao') ?? 'sincronizar').toLowerCase()
  const qLista = (url.searchParams.get('lista') ?? 'quente').toLowerCase()
  const qLimite = Number(url.searchParams.get('limite') ?? '') || null
  const qDesde = url.searchParams.get('desde')
  const dry = url.searchParams.get('dry') === '1'

  // 1) Config
  const { data: cfg, error: eCfg } = await supabase
    .from('threec_mailing_config')
    .select('campanha_id, lista_quente_id, lista_base_id, ativo, limite_por_rodada')
    .maybeSingle()
  if (eCfg || !cfg) return json({ error: 'config indisponivel', detail: eCfg?.message }, 500)

  // 1b) EXPURGO — tira da campanha quem ja foi injetado mas hoje a regua veta.
  //     Roda mesmo com o pipeline pausado: pausar a entrada nao tira ninguem
  //     da fila do discador. Vem ANTES do gate de `ativo` de proposito.
  if (acao === 'expurgar') return await expurgar(String(cfg.campanha_id), qLimite ?? 1000, dry)

  if (!cfg.ativo) return json({ ok: true, skip: 'pipeline pausado (threec_mailing_config.ativo=false)' })

  console.log("[3c-mailing] config ok", cfg.campanha_id, "ativo=", cfg.ativo)
  const listaId = qLista === 'base' ? cfg.lista_base_id : cfg.lista_quente_id

  // 2) Leads elegiveis (a regua vive na RPC)
  const { data: leads, error: eSel } = await supabase.rpc('threec_mailing_selecionar', {
    p_limite: qLimite ?? cfg.limite_por_rodada,
    p_desde: qDesde ? new Date(qDesde).toISOString() : null,
    p_ignorar_enviados: false,
  })
  if (eSel) return json({ error: 'falha ao selecionar leads', detail: eSel.message }, 500)

  console.log("[3c-mailing] rpc ok; linhas=", (leads ?? []).length, "erro=", eSel ? eSel.message : "nenhum")
  const rows = (leads ?? []) as LeadRow[]
  if (rows.length === 0) return json({ ok: true, enviados: 0, motivo: 'nenhum lead elegivel' })

  // 3) Payload do 3C
  const mailing = rows.map((r) => ({
    identifier: montarIdentifier(r.nome, r.curso),
    areacode: r.telefone.substring(0, 2),
    phone: r.telefone,
    nome: limpar(r.nome),
    email: limpar(r.email),
    formacao: humanizarFormacao(r.formacao),
    curso: normalizarCurso(r.curso),
  }))

  console.log("[3c-mailing] payload montado:", mailing.length)
  if (dry) {
    return json({ ok: true, dry: true, lista: qLista, lista_id: listaId, total: mailing.length, amostra: mailing.slice(0, 5) })
  }

  // 4) Envia ao 3C EM LOTES: a API recusa mais de 300 itens por POST
  //    ("O campo Mailing deve ter no maximo 300 itens") — era por isso que o
  //    n8n legado lia o buffer de 300 em 300.
  const alvo = `${THREEC_BASE}/campaigns/${cfg.campanha_id}/lists/${listaId}/mailing?api_token=${THREEC_TOKEN}`
  const aceitos: number[] = [] // indices de `rows` que o 3C aceitou
  let descartadosPeloTresC = 0 // 2xx mas o 3C deduplicou contra a campanha
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
      // 422 e nunca 502/504: o Cloudflare engole 5xx da origem sem headers CORS.
      falhas.push(`lote ${ini / MAX_POR_POST}: ${String(err)}`)
      continue
    }
    const corpo = await resp.text()
    if (resp.status >= 200 && resp.status < 300) {
      // ⚠️ 2xx NAO significa "importou tudo": o 3C DEDUPLICA POR TELEFONE na
      // CAMPANHA inteira (nao por lista) e descarta em silencio quem ja existe
      // nela — apagar as listas NAO limpa essa base. A resposta traz
      // `imported_lines` com o numero REAL de linhas aceitas.
      try {
        const j = JSON.parse(corpo)
        const imp = typeof j?.imported_lines === 'number' ? j.imported_lines : fatia.length
        if (imp < fatia.length) {
          descartadosPeloTresC += fatia.length - imp
          console.warn('[threec-mailing-sync] 3C descartou linhas (duplicata na campanha)', {
            lote: ini / MAX_POR_POST, enviadas: fatia.length, importadas: imp,
          })
        }
      } catch { /* corpo nao-JSON: segue o baile */ }
      for (let k = ini; k < ini + fatia.length; k++) aceitos.push(k)
    } else {
      console.error('[threec-mailing-sync] 3C recusou lote', { ini, status: resp.status, corpo: corpo.slice(0, 300) })
      falhas.push(`lote ${ini / MAX_POR_POST}: HTTP ${resp.status} ${corpo.slice(0, 200)}`)
    }
  }

  // Nenhum lote passou -> nao marca nada (o proximo tick tenta de novo)
  if (aceitos.length === 0) {
    return json({ error: '3C recusou todos os lotes', detail: falhas.slice(0, 3) }, 422)
  }

  // 5) Marca SO o que o 3C aceitou (idempotente por canon)
  const itens = aceitos.map((k) => {
    const r = rows[k]
    return { lead_id: r.lead_id, canon: r.canon, telefone: r.telefone, curso: r.curso }
  })
  const { data: marcados, error: eMarcar } = await supabase.rpc('threec_mailing_marcar', {
    p_itens: itens,
    p_lista_id: String(listaId),
  })
  if (eMarcar) {
    // Enviou mas nao marcou: o proximo tick reenviaria os mesmos. Loga alto.
    console.error('[threec-mailing-sync] ENVIOU MAS NAO MARCOU', eMarcar.message)
    return json({ ok: false, enviados: mailing.length, marcados: 0, alerta: 'enviado ao 3C mas falhou ao marcar — risco de duplicata no proximo tick', detail: eMarcar.message }, 500)
  }

  return json({
    ok: true,
    lista: qLista,
    lista_id: listaId,
    enviados: mailing.length,
    marcados: marcados ?? 0,
    com_curso: mailing.filter((m) => m.curso).length,
    // quantos o 3C recusou por ja existirem na campanha (dedup dele, nao nosso)
    descartados_duplicata_campanha: descartadosPeloTresC,
  })
}

// Nunca devolver "Internal Server Error" pelado: sem corpo nao da para
// diagnosticar (custou um ciclo de deploy aqui). Todo erro sai como JSON.
Deno.serve(async (req) => {
  try {
    return await handler(req)
  } catch (err) {
    console.error('[threec-mailing-sync] erro nao tratado', err)
    return json({ error: 'erro interno', detail: String(err) }, 500)
  }
})
