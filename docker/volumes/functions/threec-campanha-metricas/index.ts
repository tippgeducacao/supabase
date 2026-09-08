// Espelha do 3C o RESULTADO das ligações de cada campanha automática.
//
// Nasceu da pergunta do usuário (08/09/2026): "quantos estão dando erro nas campanhas?
// quantos atenderam?". A aba "Listas automáticas" mostrava só a alimentação (quem entrou
// e quem saiu) — o que acontece DEPOIS da injeção vive no 3C.
//
// Endpoint: GET /campaigns/{id}/lists/total_metrics?start_date&end_date
//   phones    → total no mailing · dialed (discados) · completed (esgotados)
//   calls     → total · failed · not_answered · not_answered_due_progress_amd ·
//               mailbox · abandoned
//   connected → total (falou com gente) · converted · dmc
//
// Duas janelas por campanha (`hoje` e `30d`), gravadas em `threec_campanha_metricas`.
// Cron threec-campanha-metricas, de 30 em 30 min.
//
// Varre TODAS as campanhas do 3C, não só as automáticas — o painel tem filtro e o time
// quer comparar as duas coisas. E agrega a CAUSA de desligamento do dia (GET /calls,
// `readable_hangup_cause_text`): foi assim que se descobriu que 47% das falhas de
// 08/09/2026 eram "Outgoing calls barred" (operadora barrando a saída) e só 3% eram
// número inexistente — sem isso, taxa de erro alta vira discussão sobre "base ruim".

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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// AAAA-MM-DD no fuso de Brasília — o 3C responde no fuso da conta, não em UTC
const dia = (offsetDias = 0): string => {
  const d = new Date(Date.now() - offsetDias * 86400000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d)
}

interface Metricas {
  campanha_id: string
  janela: 'hoje' | '30d'
  phones_total: number; phones_dialed: number; phones_completed: number
  calls_total: number; calls_failed: number; calls_nao_atendidas: number
  calls_amd: number; calls_mailbox: number; calls_abandonadas: number
  conectadas: number; convertidas: number
  bruto: unknown
  campanha_nome?: string
  automatica?: boolean
}

async function buscar(
  campanhaId: string, janela: 'hoje' | '30d', de: string, ate: string,
): Promise<Metricas | { erro: string }> {
  const alvo = `${THREEC_BASE}/campaigns/${campanhaId}/lists/total_metrics` +
    `?api_token=${THREEC_TOKEN}&start_date=${de}&end_date=${ate}`
  let resp: Response
  try {
    resp = await fetch(alvo, { headers: { Accept: 'application/json' } })
  } catch (err) {
    return { erro: `${campanhaId}/${janela}: ${String(err)}` }
  }
  if (!resp.ok) return { erro: `${campanhaId}/${janela}: HTTP ${resp.status}` }

  const corpo = await resp.json().catch(() => null)
  const d = corpo?.data ?? {}
  const p = d.phones ?? {}, c = d.calls ?? {}, k = d.connected ?? {}
  return {
    campanha_id: campanhaId, janela,
    phones_total: p.total ?? 0, phones_dialed: p.dialed ?? 0, phones_completed: p.completed ?? 0,
    calls_total: c.total ?? 0, calls_failed: c.failed ?? 0,
    calls_nao_atendidas: c.not_answered ?? 0,
    calls_amd: c.not_answered_due_progress_amd ?? 0,
    calls_mailbox: c.mailbox ?? 0, calls_abandonadas: c.abandoned ?? 0,
    conectadas: k.total ?? 0, convertidas: k.converted ?? 0,
    bruto: d,
  }
}

async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const auth = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!auth || auth !== SERVICE_ROLE) {
    let vaultKey: string | null = null
    try {
      const r = await supabase.rpc('_get_service_role_key')
      vaultKey = (r.data as string | null) ?? null
    } catch (err) {
      console.error('[threec-campanha-metricas] falha ao ler a key do vault', String(err))
    }
    if (!vaultKey || auth !== vaultKey) return json({ error: 'forbidden' }, 403)
  }
  if (!THREEC_TOKEN) return json({ error: '3C_TOKEN_API nao configurado' }, 500)

  const { data: listas, error } = await supabase
    .from('threec_mailing_listas')
    .select('campanha_id')
  if (error) return json({ error: 'falha ao ler as campanhas', detail: error.message }, 500)
  const automaticas = new Set((listas ?? []).map((l: { campanha_id: string }) => String(l.campanha_id)))

  // todas as campanhas do 3C — o painel filtra depois
  const campanhas: Array<{ id: string; nome: string }> = []
  try {
    const r = await fetch(`${THREEC_BASE}/campaigns?api_token=${THREEC_TOKEN}&per_page=100`,
      { headers: { Accept: 'application/json' } })
    const corpo = await r.json().catch(() => null)
    for (const c of (corpo?.data ?? []) as Array<{ id: number | string; name?: string }>) {
      campanhas.push({ id: String(c.id), nome: c.name ?? '' })
    }
  } catch (err) {
    console.error('[threec-campanha-metricas] falha ao listar campanhas', String(err))
  }
  // fallback: se a listagem falhar, ao menos as automáticas
  if (campanhas.length === 0) {
    for (const id of automaticas) campanhas.push({ id, nome: '' })
  }

  const hoje = dia()
  const linhas: Metricas[] = []
  const falhas: string[] = []

  for (const l of campanhas.map((c) => ({ campanha_id: c.id, nome: c.nome }))) {
    for (const [janela, de, ate] of [
      ['hoje', hoje, hoje],
      ['30d', dia(30), hoje],
    ] as Array<['hoje' | '30d', string, string]>) {
      const r = await buscar(l.campanha_id, janela, de, ate)
      if ('erro' in r) falhas.push(r.erro)
      else linhas.push({ ...r, campanha_nome: l.nome, automatica: automaticas.has(l.campanha_id) })
    }
  }

  if (linhas.length > 0) {
    const { error: eGravar } = await supabase.rpc('threec_campanha_metricas_gravar', {
      p_linhas: linhas,
    })
    if (eGravar) return json({ error: 'falha ao gravar', detail: eGravar.message }, 500)
  }

  // ── causa de desligamento do dia, por campanha ────────────────────────────────
  // GET /calls exige data COM HORA. Percorre no máximo 40 páginas de 500 (20 mil
  // chamadas/dia) — acima disso o dado do dia já é representativo o suficiente.
  const causas = new Map<string, number>()   // "campanha|causa" -> n
  let pagina = 1, lidas = 0
  while (pagina <= 40) {
    const q = new URLSearchParams({
      api_token: THREEC_TOKEN,
      start_date: `${hoje} 00:00:00`, end_date: `${hoje} 23:59:59`,
      per_page: '500', page: String(pagina),
    })
    let corpo: { data?: unknown[]; meta?: { pagination?: { total_pages?: number } } } | null = null
    try {
      const r = await fetch(`${THREEC_BASE}/calls?${q}`, { headers: { Accept: 'application/json' } })
      if (!r.ok) { falhas.push(`calls p${pagina}: HTTP ${r.status}`); break }
      corpo = await r.json()
    } catch (err) {
      falhas.push(`calls p${pagina}: ${String(err)}`); break
    }
    const rows = (corpo?.data ?? []) as Array<Record<string, unknown>>
    if (rows.length === 0) break
    for (const c of rows) {
      const camp = String(c.campaign_id ?? '')
      const causa = String(c.readable_hangup_cause_text ?? c.hangup_cause_text ?? 'desconhecida')
      if (!camp) continue
      const chave = `${camp}|${causa}`
      causas.set(chave, (causas.get(chave) ?? 0) + 1)
      lidas++
    }
    const totalPaginas = corpo?.meta?.pagination?.total_pages ?? 1
    if (pagina >= totalPaginas) break
    pagina++
  }

  if (causas.size > 0) {
    const linhasCausa = [...causas.entries()].map(([chave, n]) => {
      const [campanha_id, causa] = chave.split('|')
      return { campanha_id, causa, chamadas: n }
    })
    const { error: eCausas } = await supabase.rpc('threec_campanha_causas_gravar', {
      p_dia: hoje, p_linhas: linhasCausa,
    })
    if (eCausas) falhas.push(`causas: ${eCausas.message}`)
  }

  return json({
    ok: falhas.length === 0,
    campanhas: campanhas.length,
    gravadas: linhas.length,
    chamadas_lidas: lidas,
    causas: causas.size,
    falhas: falhas.slice(0, 5),
  })
}

Deno.serve(async (req) => {
  try {
    return await handler(req)
  } catch (err) {
    console.error('[threec-campanha-metricas] erro nao tratado', err)
    return json({ error: 'erro interno', detail: String(err) }, 500)
  }
})
