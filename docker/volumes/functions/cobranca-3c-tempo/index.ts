// cobranca-3c-tempo — tempo do usuário 3C COMPARTILHADO da cobrança, minuto a minuto (22/10/2026)
//
// A cobrança disca por uma conta 3C própria com UM usuário ("Cobrança") que Derick, Débora
// e Kauane usam em rodízio. O 3C só entrega o tempo desse usuário; quem estava sentado o
// sistema sabe pelo botão "Assumi o 3C" (RPC cob_3c_assumir). Esta function só COLETA:
//
//   1. GET /agents/status/metrics/total  → o acumulado do dia (ocioso, em chamada, TPA,
//      pausa, chamadas) vira 1 linha em cob_3c_amostras;
//   2. GET /agents/status                → o usuário está logado agora?
//   3. GET /agents/login_history         → cada login, ao segundo, em cob_3c_sessoes.
//
// A divisão por pessoa é feita na leitura, pela função cob_3c_tempo_rodizio (migration
// 20261022130000), para um clique atrasado corrigir o passado sem reprocessar nada.
//
// Cron `cob-3c-tempo` a cada minuto (service role). Só fala com a conta da COBRANÇA:
// sem fallback para o 3C_TOKEN_API — ler a conta do comercial aqui gravaria o tempo de
// outra pessoa como se fosse da cobrança.
//
// ⚠️ O login_history devolve o objeto do agente com a SENHA DO RAMAL
// (extension_password). Daqui só saem as horas de login/logout.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const THREEC_BASE = Deno.env.get('THREEC_BASE_URL') ?? 'https://app.3c.plus/api/v1'
const TOKEN = Deno.env.get('3C_TOKEN_API_COBRANCA') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
})

type Rec = Record<string, unknown>

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

// O erro do fetch traz a URL inteira, com o token na query.
const semToken = (s: string): string => {
  let r = s.replace(/api_token=[^&\s"')]*/gi, 'api_token=***')
  if (TOKEN) r = r.split(TOKEN).join('***')
  return r
}

async function api(caminho: string): Promise<{ ok: boolean; status: number; json: Rec | null; texto: string }> {
  const url = `${THREEC_BASE}${caminho}${caminho.includes('?') ? '&' : '?'}api_token=${TOKEN}`
  const r = await fetch(url, { headers: { Accept: 'application/json' } })
  const texto = await r.text()
  let j: Rec | null = null
  try { j = JSON.parse(texto) as Rec } catch { /* não-JSON */ }
  return { ok: r.ok, status: r.status, json: j, texto: semToken(texto.slice(0, 300)) }
}

const lista = (j: Rec | null): Rec[] => {
  const d = j?.data
  return Array.isArray(d) ? (d as Rec[]) : []
}
const totalPaginas = (j: Rec | null): number => {
  const p = ((j?.meta as Rec | undefined)?.pagination ?? {}) as Rec
  return Math.max(1, Number(p.total_pages ?? 1) || 1)
}

// idle/acw/interval vêm em segundos (int); speaking já veio como "mm:ss" na conta antiga.
export const toSeconds = (v: unknown): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.round(v))
  if (typeof v === 'string') {
    const s = v.trim()
    if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s))
    const partes = s.split(':').map(Number)
    if (partes.length > 1 && partes.every(Number.isFinite)) return partes.reduce((acc, n) => acc * 60 + n, 0)
  }
  return 0
}
const inteiro = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0
}

// "21/10/2026 13:56:30" (login_history) ou "2026-10-21 13:56:30" (last_login), em hora de
// Brasília. O Brasil não tem horário de verão desde 2019: -03:00 fixo.
export function brtParaIso(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  let m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})[ T](\d{2}):(\d{2}):(\d{2})$/)
  if (m) return new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}-03:00`).toISOString()
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/)
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}-03:00`).toISOString()
  return null
}

const ymdBrt = (d: Date): string => d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })

async function coletar() {
  const { data: cfg, error: eCfg } = await supabase
    .from('cob_semi_3c_config').select('agentes').eq('id', 1).maybeSingle()
  if (eCfg) throw new Error(`cob_semi_3c_config: ${eCfg.message}`)
  const agente = Number(((cfg?.agentes ?? []) as Array<{ id?: number }>)[0]?.id)
  if (!agente) throw new Error('cob_semi_3c_config.agentes sem o usuário compartilhado da cobrança')

  const agora = new Date()
  const agoraIso = agora.toISOString()
  const hoje = ymdBrt(agora)
  const seteDiasAtras = ymdBrt(new Date(agora.getTime() - 6 * 86_400_000))

  // 1) acumulado do dia. Paginado (15 por página): procura o agente em todas.
  let linha: Rec | undefined
  for (let page = 1; page <= 5 && !linha; page++) {
    const r = await api(`/agents/status/metrics/total?start_date=${hoje}&end_date=${hoje}${page > 1 ? `&page=${page}` : ''}`)
    if (!r.ok) throw new Error(`metrics/total HTTP ${r.status} ${r.texto}`)
    linha = lista(r.json).find((x) => Number(x.id ?? (x.metrics as Rec | undefined)?._id) === agente)
    if (page >= totalPaginas(r.json)) break
  }
  // Sem linha = sem atividade hoje: tudo zero (não é erro).
  const m = ((linha?.metrics ?? {}) as Rec)
  const valores = {
    available_s: toSeconds(m.idle),
    in_call_s: toSeconds(m.speaking),
    acw_s: toSeconds(m.acw),
    break_s: toSeconds(m.interval),
    // mesma régua do threec-sync: operação preditiva, "atendidas" = total do agente
    calls: inteiro(linha?.total_calls) || inteiro(m.calls),
  }

  // 2) logado agora?
  const st = await api('/agents/status')
  if (!st.ok) throw new Error(`agents/status HTTP ${st.status} ${st.texto}`)
  const meuStatus = lista(st.json).find((x) => Number(x.id) === agente)
  const online = !!meuStatus && Number(meuStatus.status) !== 0

  // 3) logins dos últimos 7 dias (15 por página; `per_page` derruba com HTTP 400 — visto
  //    em 22/10) — a entrada mais recente também traz agent.last_login,
  //    que é o login EM CURSO (o histórico pode só listar sessões já encerradas).
  const sessoes: Array<{ login: string; logout: string | null }> = []
  let ultimoLogin: string | null = null
  let historicoOk = true
  for (let page = 1; page <= 5; page++) {
    const r = await api(
      `/agents/login_history?start_date=${seteDiasAtras}%2000:00:00&end_date=${hoje}%2023:59:59` +
      `&agent_id=${agente}${page > 1 ? `&page=${page}` : ''}`,
    )
    if (!r.ok) { historicoOk = false; break }
    for (const h of lista(r.json)) {
      const login = brtParaIso(h.login)
      if (login) sessoes.push({ login, logout: brtParaIso(h.logout) })
      const ll = brtParaIso((h.agent as Rec | undefined)?.last_login)
      if (ll && (!ultimoLogin || ll > ultimoLogin)) ultimoLogin = ll
    }
    if (page >= totalPaginas(r.json)) break
  }
  for (const s of sessoes) if (!ultimoLogin || s.login > ultimoLogin) ultimoLogin = s.login

  if (sessoes.length) {
    const { error } = await supabase.from('cob_3c_sessoes').upsert(
      sessoes.map((s) => ({ ...s, origem: 'historico', atualizado_em: agoraIso })),
      { onConflict: 'login' },
    )
    if (error) throw new Error(`cob_3c_sessoes: ${error.message}`)
  }

  // Sessão em curso que o histórico ainda não listou.
  if (online) {
    if (ultimoLogin) {
      await supabase.from('cob_3c_sessoes').upsert(
        { login: ultimoLogin, logout: null, origem: 'status', atualizado_em: agoraIso },
        { onConflict: 'login', ignoreDuplicates: true },
      )
    } else {
      const { data: aberta } = await supabase.from('cob_3c_sessoes').select('login').is('logout', null).limit(1)
      if (!aberta?.length) {
        await supabase.from('cob_3c_sessoes').insert({ login: agoraIso, origem: 'status', atualizado_em: agoraIso })
      }
    }
  }

  // Fecha sessão aberta que já acabou: login por cima (acaba no novo login) ou usuário
  // deslogado (acaba agora; o histórico corrige para o segundo exato na próxima leitura).
  const { data: abertas } = await supabase.from('cob_3c_sessoes').select('login').is('logout', null)
  for (const a of (abertas ?? []) as Array<{ login: string }>) {
    const loginA = new Date(a.login).toISOString()
    let logout: string | null = null
    if (!online) logout = agoraIso
    else if (ultimoLogin && loginA < ultimoLogin) logout = ultimoLogin
    if (logout) {
      await supabase.from('cob_3c_sessoes')
        .update({ logout, atualizado_em: agoraIso }).eq('login', a.login).is('logout', null)
    }
  }

  // 4) a foto do minuto — SÓ com o usuário logado, mais a 1ª foto depois da saída (pega os
  //    últimos segundos) e a 1ª foto de todas (referência inicial).
  //    O metrics/total é monitor AO VIVO e IGNORA a data pedida: devolve o acumulado do dia
  //    corrente e zera de um dia para o outro. Deslogado, a doc do 3C registra que ele pode
  //    voltar vazio (threec-api-docs.ts, 09/07/2026) — por isso o valor deslogado não entra
  //    na conta (cob_3c_tempo_rodizio também o ignora). Em 22/10, deslogado às 16:44, ele
  //    ainda trazia o acumulado das 4 sessões da tarde: o vazio é o caso a temer, não a regra.
  const { data: ult } = await supabase.from('cob_3c_amostras')
    .select('online')
    .order('amostrado_em', { ascending: false }).limit(1).maybeSingle()
  let gravou = false
  if (online || !ult || ult.online) {
    const { error } = await supabase.from('cob_3c_amostras')
      .insert({ amostrado_em: agoraIso, report_date: hoje, online, ...valores })
    if (error) throw new Error(`cob_3c_amostras: ${error.message}`)
    gravou = true
  }

  // 5) batimento: a faixa "No 3C agora" sabe que a coleta está viva mesmo com o 3C
  //    desligado (quando não há foto nova).
  await supabase.from('cob_3c_coleta')
    .upsert({ id: 1, lido_em: agoraIso, online, erro: null, erro_em: null }, { onConflict: 'id' })

  return { agente, hoje, online, gravou, historicoOk, sessoes_lidas: sessoes.length, ultimo_login: ultimoLogin, ...valores }
}

async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  // Só o cron (service role). A key do vault e a env do container podem ser strings diferentes.
  const auth = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  let servico = !!auth && auth === SERVICE_ROLE
  if (!servico && auth) {
    try {
      const r = await supabase.rpc('_get_service_role_key')
      servico = !!r.data && auth === r.data
    } catch (err) {
      console.error('[cobranca-3c-tempo] falha ao ler a key do vault', String(err))
    }
  }
  if (!servico) return json({ error: 'forbidden' }, 403)
  if (!TOKEN) return json({ error: '3C_TOKEN_API_COBRANCA nao configurado no edge-runtime' }, 500)

  try {
    return json({ ok: true, ...(await coletar()) })
  } catch (err) {
    const msg = semToken(String(err))
    console.error('[cobranca-3c-tempo]', msg)
    // o erro fica no batimento; lido_em NÃO anda, e a faixa passa a dizer "atrasada"
    const { error: eBat } = await supabase.from('cob_3c_coleta')
      .update({ erro: msg.slice(0, 300), erro_em: new Date().toISOString() }).eq('id', 1)
    if (eBat) console.error('[cobranca-3c-tempo] batimento', eBat.message)
    return json({ ok: false, error: msg }, 502)
  }
}

Deno.serve(handler)
