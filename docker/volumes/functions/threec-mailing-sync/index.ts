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
// A regua de QUEM entra vive na RPC `threec_mailing_selecionar` (fonte unica).
// Esta function so formata, envia e marca.
//
// Chamada:
//   POST /functions/v1/threec-mailing-sync            -> lista Quente, limite da config
//   POST ?lista=base&limite=500&desde=2026-06-27      -> backfill na Base
//   POST ?dry=1                                       -> so simula (nao envia, nao marca)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const THREEC_BASE = Deno.env.get('THREEC_BASE_URL') ?? 'https://3c.fluxoti.com/api/v1'
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
//   • caracteres invisiveis (U+034F etc.) que leads usam p/ furar filtro de bot
//   • formacao com underscore, do formulario da Meta: "medico_veterinario_(a)"
//   • curso em CAIXA ALTA em parte das origens
const INVISIVEIS = /[­͏​-‏ -‮⁠-⁯﻿]/g

const limpar = (s: string): string =>
  (s ?? '').replace(INVISIVEIS, '').replace(/\s+/g, ' ').trim()

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  // Gate: so service role (cron interno / operacao manual). Nunca anon.
  // Aceita as DUAS chaves: a do vault (_get_service_role_key) e a env do
  // container sao strings diferentes — comparar so com uma da 401 no cron.
  const auth = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!auth || auth !== SERVICE_ROLE) {
    const { data: vaultKey } = await supabase.rpc('_get_service_role_key').catch(() => ({ data: null }))
    if (!vaultKey || auth !== vaultKey) return json({ error: 'forbidden' }, 403)
  }

  if (!THREEC_TOKEN) return json({ error: '3C_TOKEN_API nao configurado no edge-runtime' }, 500)

  const url = new URL(req.url)
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
  if (!cfg.ativo) return json({ ok: true, skip: 'pipeline pausado (threec_mailing_config.ativo=false)' })

  const listaId = qLista === 'base' ? cfg.lista_base_id : cfg.lista_quente_id

  // 2) Leads elegiveis (a regua vive na RPC)
  const { data: leads, error: eSel } = await supabase.rpc('threec_mailing_selecionar', {
    p_limite: qLimite ?? cfg.limite_por_rodada,
    p_desde: qDesde ? new Date(qDesde).toISOString() : null,
    p_ignorar_enviados: false,
  })
  if (eSel) return json({ error: 'falha ao selecionar leads', detail: eSel.message }, 500)

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

  if (dry) {
    return json({ ok: true, dry: true, lista: qLista, lista_id: listaId, total: mailing.length, amostra: mailing.slice(0, 5) })
  }

  // 4) Envia ao 3C
  const alvo = `${THREEC_BASE}/campaigns/${cfg.campanha_id}/lists/${listaId}/mailing?api_token=${THREEC_TOKEN}`
  let resp: Response
  try {
    resp = await fetch(alvo, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ header: HEADER, mailing }),
    })
  } catch (err) {
    // 422 e nunca 502/504: o Cloudflare engole 5xx da origem sem headers CORS.
    return json({ error: 'falha ao alcancar o 3C', detail: String(err) }, 422)
  }

  const corpo = await resp.text()
  if (resp.status < 200 || resp.status >= 300) {
    console.error('[threec-mailing-sync] 3C recusou', { status: resp.status, corpo: corpo.slice(0, 500) })
    return json({ error: '3C recusou o mailing', status: resp.status, detail: corpo.slice(0, 500) }, 422)
  }

  // 5) Marca so o que o 3C aceitou (idempotente por canon)
  const itens = rows.map((r) => ({ lead_id: r.lead_id, canon: r.canon, telefone: r.telefone, curso: r.curso }))
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
  })
})
