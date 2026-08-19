// ============================================================================
// API SDR — gateway REST público (uma chave = um SDR).
//
// Deixa uma integração externa se comportar EXATAMENTE como um SDR do app:
// criar/selecionar lead, agendar reunião (com distribuição automática de
// vendedor e as mesmas validações), forçar agendamento, marcar resultado e ler
// pontuação. Toda ação é executada com o sdr_id DONO da chave — o caller nunca
// escolhe outro SDR.
//
// Autenticação: header `Authorization: Bearer <chave>`. A chave é hasheada
// (sha256) e comparada com `sdr_api_keys.key_hash`. As regras de negócio vivem
// nas RPCs `fn_sdr_api_*` (espelham AgendamentosService/ManualLeadService).
//
// Base URL: {SUPABASE_URL}/functions/v1/sdr-api
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.3'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// ---- helpers ---------------------------------------------------------------

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function sha256hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Espelha ErrorService.normalizePhoneToInternational
function normalizePhone(phone: string): string {
  const digits = (phone || '').replace(/\D/g, '')
  if (!digits) return ''
  if (digits.startsWith('55')) return `+${digits}`
  return `+55${digits}`
}

// Mapeia o `code` das RPCs para status HTTP
function statusForCode(code?: string): number {
  switch (code) {
    case 'conflito_agenda':
    case 'conflito_evento':
      return 409
    case 'sem_permissao':
      return 403
    case 'nao_encontrado':
    case 'lead_nao_encontrado':
      return 404
    default:
      return 422
  }
}

function rpcResult(res: any): Response {
  if (res && res.success === true) {
    return json(200, { data: res.agendamento ?? res, distribuicao: res.distribuicao ?? undefined })
  }
  return json(statusForCode(res?.code), { error: res?.error || 'Erro ao processar', code: res?.code })
}

// ISO week/year (igual ao padrão usado nos pontos SDR)
function isoWeekYear(d: Date): { ano: number; semana: number } {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNum = (date.getUTCDay() + 6) % 7 // segunda=0
  date.setUTCDate(date.getUTCDate() - dayNum + 3) // quinta da semana
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4))
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3)
  const semana = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000))
  return { ano: date.getUTCFullYear(), semana }
}

// ---- rate limit (em memória, por chave) ------------------------------------
const rate = new Map<string, { count: number; resetAt: number }>()
const RATE_MAX = 120
const RATE_WINDOW_MS = 60_000
function allow(keyId: string): boolean {
  const now = Date.now()
  const e = rate.get(keyId)
  if (!e || now > e.resetAt) {
    rate.set(keyId, { count: 1, resetAt: now + RATE_WINDOW_MS })
    return true
  }
  if (e.count >= RATE_MAX) return false
  e.count++
  return true
}

// ---- handlers --------------------------------------------------------------

async function handleMe(sdrId: string): Promise<Response> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, name, email, user_type, ativo')
    .eq('id', sdrId)
    .maybeSingle()
  if (error) return json(500, { error: error.message })
  return json(200, { data })
}

async function handleCreateLead(sdrId: string, body: any): Promise<Response> {
  if (!body?.nome || !String(body.nome).trim()) {
    return json(422, { error: 'Nome do lead é obrigatório', code: 'nome_obrigatorio' })
  }
  let whatsapp = String(body.whatsapp ?? '')
  if (whatsapp && !whatsapp.startsWith('+')) whatsapp = normalizePhone(whatsapp)

  const payload: Record<string, unknown> = {
    nome: String(body.nome).trim(),
    email: body.email ? String(body.email).trim() : null,
    whatsapp: whatsapp || null,
    observacoes: body.observacoes ?? null,
    fonte_referencia: body.fonte_referencia ?? null,
    status: body.status ?? 'novo',
    origem_criacao: 'api_sdr',
  }
  if (body.vendedor_atribuido) payload.vendedor_atribuido = body.vendedor_atribuido

  const { data, error } = await supabase.from('leads').insert(payload).select().maybeSingle()
  if (error) return json(422, { error: error.message })
  return json(201, { data })
}

async function handleListLeads(_sdrId: string, url: URL): Promise<Response> {
  const q = (url.searchParams.get('q') || '').trim()
  const status = (url.searchParams.get('status') || '').trim()
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 1), 100)

  let query = supabase
    .from('leads')
    .select('id, nome, email, whatsapp, status, fonte_referencia, vendedor_atribuido, created_at')
    .eq('arquivado', false)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (status) query = query.eq('status', status)
  if (q) {
    // remove caracteres que quebram a sintaxe do .or() do PostgREST
    const safe = q.replace(/[,()*]/g, ' ').trim()
    if (safe) query = query.or(`nome.ilike.%${safe}%,email.ilike.%${safe}%,whatsapp.ilike.%${safe}%`)
  }

  const { data, error } = await query
  if (error) return json(500, { error: error.message })
  return json(200, { data })
}

async function handleVendedores(_sdrId: string, url: URL): Promise<Response> {
  const pos = (url.searchParams.get('pos') || '').trim()
  if (!pos) return json(422, { error: 'Informe ?pos=<id ou nome do curso>', code: 'pos_obrigatoria' })

  const { data: resolved, error: e1 } = await supabase.rpc('fn_sdr_api_resolver_pos_graduacao', { p_valor: pos })
  if (e1) return json(500, { error: e1.message })
  const cursoId = (resolved as any)?.id ?? null
  if (!cursoId) return json(404, { error: 'Pós-graduação não encontrada', code: 'pos_nao_encontrada' })

  const { data: ids, error: e2 } = await supabase.rpc('fn_sdr_api_vendedores_elegiveis', { p_curso_id: cursoId })
  if (e2) return json(500, { error: e2.message })
  const idList = (ids as string[]) || []
  if (idList.length === 0) return json(200, { data: { curso: resolved, vendedores: [] } })

  const { data: vends, error: e3 } = await supabase
    .from('profiles')
    .select('id, name, email, user_type')
    .in('id', idList)
  if (e3) return json(500, { error: e3.message })
  return json(200, { data: { curso: resolved, vendedores: vends } })
}

// Resolve o lead do agendamento: usa lead_id se vier; senão faz FIND-OR-CREATE a partir
// de body.lead { nome, whatsapp, email }. Busca por telefone (8 dígitos do assinante) com
// PRIORIDADE, depois por email EXATO (case-insensitive); se não achar, cria. Evita duplicar
// os leads antigos do SprintHub (telefone em formatos variados).
async function resolverLead(body: any): Promise<{ lead_id?: string; criado?: boolean; error?: Response }> {
  if (body?.lead_id) return { lead_id: String(body.lead_id) }

  const lead = body?.lead
  const nome = String(lead?.nome ?? '').trim()
  const whatsappRaw = String(lead?.whatsapp ?? '').trim()
  const email = String(lead?.email ?? '').trim().toLowerCase()
  const sub = whatsappRaw.replace(/\D/g, '').slice(-8)

  if (!sub && !email) {
    return { error: json(422, { error: 'Informe lead_id OU lead com whatsapp e/ou email', code: 'lead_obrigatorio' }) }
  }

  // 1) match por telefone (prioridade — é a identidade do WhatsApp)
  if (sub) {
    const { data } = await supabase
      .from('leads').select('id').eq('arquivado', false)
      .ilike('whatsapp', `%${sub}%`).order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (data?.id) return { lead_id: data.id }
  }
  // 2) match por email EXATO (ilike sem % = igualdade case-insensitive)
  if (email) {
    const { data } = await supabase
      .from('leads').select('id').eq('arquivado', false)
      .ilike('email', email).order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (data?.id) return { lead_id: data.id }
  }

  // 3) não achou -> cria. Precisa de nome pra não gerar lead sem identificação.
  if (!nome) {
    return { error: json(422, { error: 'Lead não encontrado e nome não informado para criar', code: 'nome_obrigatorio' }) }
  }
  const whatsapp = whatsappRaw ? (whatsappRaw.startsWith('+') ? whatsappRaw : normalizePhone(whatsappRaw)) : null
  const { data: novo, error } = await supabase
    .from('leads')
    .insert({ nome, email: email || null, whatsapp, status: 'novo', origem_criacao: 'api_sdr' })
    .select('id').maybeSingle()
  if (error || !novo?.id) return { error: json(422, { error: error?.message || 'Falha ao criar lead' }) }
  return { lead_id: novo.id, criado: true }
}

async function handleAgendar(sdrId: string, body: any): Promise<Response> {
  if (!body?.data_agendamento) return json(422, { error: 'data_agendamento é obrigatório (ISO-8601)', code: 'data_obrigatoria' })

  const r = await resolverLead(body)
  if (r.error) return r.error

  const { data, error } = await supabase.rpc('fn_sdr_api_agendar_reuniao', {
    p_sdr_id: sdrId,
    p_lead_id: r.lead_id,
    p_pos_graduacao: body.pos_graduacao_interesse ?? body.pos_graduacao ?? '',
    p_data_agendamento: body.data_agendamento,
    p_data_fim_agendamento: body.data_fim_agendamento ?? null,
    p_link_reuniao: body.link_reuniao ?? null,
    p_vendedor_id: body.vendedor_id ?? null,
    p_forcar: body.forcar === true,
    p_origem: body.origem ?? null,
    p_local_trabalho: body.local_trabalho ?? null,
    p_principal_dor_objetivo: body.principal_dor_objetivo ?? null,
    p_observacoes: body.observacoes ?? null,
  })
  if (error) return json(500, { error: error.message })
  // injeta lead_criado no resultado de sucesso (mantém o padrão do rpcResult)
  if (data && data.success === true) {
    return json(200, { data: data.agendamento ?? data, distribuicao: data.distribuicao ?? undefined, lead_criado: r.criado ?? false })
  }
  return json(statusForCode(data?.code), { error: data?.error || 'Erro ao processar', code: data?.code })
}

// Brasília é UTC-3 fixo (sem horário de verão desde 2019).
const BR_TZ = '-03:00'

// Janela (de/ate) a partir de data + periodo/horario_inicio. Retorna ISO-8601 -03:00.
function janelaDeDataPeriodo(data: string, periodo: string, horarioInicio: string): { de: string; ate: string } {
  let deH = '00:00:00', ateH = '23:59:59'
  const hIni = (horarioInicio || '').trim()
  const p = (periodo || 'qualquer').toLowerCase()
  if (hIni) {
    deH = hIni.length === 5 ? `${hIni}:00` : hIni // "20:00" -> "20:00:00"
  } else if (p === 'manhã' || p === 'manha') {
    deH = '00:00:00'; ateH = '12:00:00'
  } else if (p === 'tarde') {
    deH = '12:00:00'; ateH = '19:00:00'
  } else if (p === 'noite') {
    deH = '19:00:00'; ateH = '23:59:59'
  }
  return { de: `${data}T${deH}${BR_TZ}`, ate: `${data}T${ateH}${BR_TZ}` }
}

async function handleDisponibilidade(_sdrId: string, url: URL): Promise<Response> {
  const pos = (url.searchParams.get('pos') || '').trim()
  if (!pos) return json(422, { error: 'Informe ?pos=<id ou nome do curso>', code: 'pos_obrigatoria' })
  const limite = Math.min(Math.max(parseInt(url.searchParams.get('limite') || '20', 10) || 20, 1), 100)
  const params: Record<string, unknown> = { p_pos: pos, p_limite: limite }

  // ?telefone= → a RPC resolve o DONO DO CONTATO e oferece a agenda dele (quem recebeu
  // o lead recebe a reunião). Opcional: sem ele a RPC mantém o rodízio de sempre.
  const telefone = (url.searchParams.get('telefone') || '').trim()
  if (telefone) params.p_telefone = telefone

  let de = (url.searchParams.get('de') || '').trim()
  let ate = (url.searchParams.get('ate') || '').trim()
  // Sem janela explícita? Monta de/ate a partir de data + periodo/horario_inicio (Brasília).
  const data = (url.searchParams.get('data') || '').trim()
  if (!de && !ate && data) {
    const j = janelaDeDataPeriodo(
      data,
      url.searchParams.get('periodo') || '',
      url.searchParams.get('horario_inicio') || '',
    )
    de = j.de
    ate = j.ate
  }
  if (de) params.p_de = de
  if (ate) params.p_ate = ate

  const { data: rpc, error } = await supabase.rpc('fn_sdr_api_disponibilidade', params)
  if (error) return json(500, { error: error.message })
  if (rpc && rpc.success === false) return json(statusForCode(rpc.code), { error: rpc.error, code: rpc.code })
  return json(200, { data: rpc })
}

async function handleListAgendamentos(sdrId: string, url: URL): Promise<Response> {
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 200)
  const status = (url.searchParams.get('status') || '').trim()
  const inicio = (url.searchParams.get('inicio') || '').trim()
  const fim = (url.searchParams.get('fim') || '').trim()
  const telefone = (url.searchParams.get('telefone') || '').trim()

  // Filtro por lead (telefone) — usado pra achar o(s) agendamento(s) do lead p/ cancelar/remarcar.
  let leadIds: string[] | null = null
  if (telefone) {
    const sub = telefone.replace(/\D/g, '').slice(-8)
    if (sub) {
      const { data: leads } = await supabase.from('leads').select('id').ilike('whatsapp', `%${sub}%`)
      leadIds = (leads ?? []).map((l: any) => l.id)
      if (leadIds.length === 0) return json(200, { data: [] })
    }
  }

  // vendedor embutido (FK explícita: sdr_id também aponta pra profiles) — id_calendar é a
  // agenda Google do vendedor, usada pelo fluxo externo pra criar/editar o evento do Meet.
  let query = supabase
    .from('agendamentos')
    .select('id, lead_id, vendedor_id, sdr_id, pos_graduacao_interesse, data_agendamento, data_fim_agendamento, link_reuniao, status, resultado_reuniao, data_resultado, is_forcado, origem, created_at, vendedor:profiles!agendamentos_vendedor_id_fkey(id, name, id_calendar)')
    .eq('sdr_id', sdrId)
    .order('data_agendamento', { ascending: false })
    .limit(limit)

  if (leadIds) query = query.in('lead_id', leadIds)
  if (status) query = query.eq('status', status)
  if (inicio) query = query.gte('data_agendamento', inicio)
  if (fim) query = query.lte('data_agendamento', fim)

  const { data, error } = await query
  if (error) return json(500, { error: error.message })
  return json(200, { data })
}

async function handleReagendar(sdrId: string, id: string, body: any): Promise<Response> {
  const { data, error } = await supabase.rpc('fn_sdr_api_reagendar', {
    p_sdr_id: sdrId,
    p_agendamento_id: id,
    p_vendedor_id: body.vendedor_id ?? null,
    p_data_agendamento: body.data_agendamento ?? null,
    p_data_fim_agendamento: body.data_fim_agendamento ?? null,
    p_pos_graduacao: body.pos_graduacao_interesse ?? body.pos_graduacao ?? null,
    p_link_reuniao: body.link_reuniao ?? null,
    p_observacoes: body.observacoes ?? null,
    p_principal_dor_objetivo: body.principal_dor_objetivo ?? null,
  })
  if (error) return json(500, { error: error.message })
  return rpcResult(data)
}

async function handleResultado(sdrId: string, id: string, body: any): Promise<Response> {
  if (!body?.resultado) return json(422, { error: 'resultado é obrigatório', code: 'resultado_obrigatorio' })
  const { data, error } = await supabase.rpc('fn_sdr_api_marcar_resultado', {
    p_sdr_id: sdrId,
    p_agendamento_id: id,
    p_resultado: body.resultado,
    p_observacoes: body.observacoes ?? null,
  })
  if (error) return json(500, { error: error.message })
  return rpcResult(data)
}

async function handleCancelar(sdrId: string, id: string, body: any): Promise<Response> {
  const { data, error } = await supabase.rpc('fn_sdr_api_cancelar', {
    p_sdr_id: sdrId,
    p_agendamento_id: id,
    p_observacoes: body?.observacoes ?? null,
  })
  if (error) return json(500, { error: error.message })
  return rpcResult(data)
}

// POST /envia-informacoes — tool envia_informacoes do agente.
// conteudo: 'cronograma' (PDF no WhatsApp do lead), 'valor' (texto pro SDR informar)
// ou 'cronograma_e_valor'. Lookup via fn_sdr_api_info_pos (MESMO resolver do
// /disponibilidade — se o agendamento acha o curso, aqui acha também). O PDF sai
// pelo pipeline do crm-whatsapp-send (tipo document) → registra na timeline do CRM.
async function handleEnviaInformacoes(_sdrId: string, body: any): Promise<Response> {
  const telefone = String(body?.whatsapp ?? body?.telefone ?? '').trim()
  const pos = String(body?.pos ?? '').trim()
  const conteudo = String(body?.conteudo ?? '').trim()

  if (!pos) return json(422, { error: 'pos é obrigatória', code: 'pos_obrigatoria' })
  if (!['cronograma', 'valor', 'cronograma_e_valor'].includes(conteudo)) {
    return json(422, { error: "conteudo deve ser 'cronograma', 'valor' ou 'cronograma_e_valor'", code: 'conteudo_invalido' })
  }
  const querCronograma = conteudo !== 'valor'
  if (querCronograma && !telefone) {
    return json(422, { error: 'whatsapp é obrigatório para enviar cronograma', code: 'whatsapp_obrigatorio' })
  }

  const { data: info, error } = await supabase.rpc('fn_sdr_api_info_pos', { p_pos: pos })
  if (error) return json(500, { error: error.message })
  if (!info?.success) return json(statusForCode(info?.code), { error: info?.error, code: info?.code })

  let cronogramaEnviado = false
  let cronogramaErro: string | null = null
  if (querCronograma) {
    if (!info.cronograma?.url) {
      cronogramaErro = 'cronograma não cadastrado para este curso'
      if (conteudo === 'cronograma') {
        return json(404, { error: cronogramaErro, code: 'cronograma_nao_cadastrado' })
      }
    } else {
      const base = {
        telefone,
        wa_account_id: body?.wa_account_id ?? null,
        lead_id: body?.lead_id ?? null,
        oportunidade_id: body?.oportunidade_id ?? null,
      }
      // Envio "solto" (document): exige JANELA DE 24h aberta. É o caminho do agente de
      // WhatsApp, onde o lead sempre respondeu antes.
      // wa_conexao_id (opcional): força uma LINHA Uazapi/Web, que não tem janela.
      const comoDocumento = {
        ...base,
        tipo: 'document',
        anexo_url: info.cronograma.url,
        filename: info.cronograma.nome_arquivo || undefined,
        wa_conexao_id: body?.wa_conexao_id ?? null,
      }
      // TEMPLATE (2026-08-19): quem NÃO tem janela — o visitante do webchat nunca mandou
      // mensagem pro número — recebe por template de UTILIDADE com o PDF no cabeçalho.
      // O `header_media_url` faz o crm-whatsapp-send montar o header sozinho e subir o
      // arquivo por media_id (1 upload por arquivo × número), que é o que evita o 131053.
      const templateName = String(body?.template_name ?? '').trim()
      // ⚠️ Parâmetro de corpo com QUEBRA DE LINHA faz a Meta recusar o template. Aqui a
      // gente achata antes de mandar, além da sanitização que o crm-whatsapp-send faz.
      const comoTemplate = templateName ? {
        ...base,
        tipo: 'template',
        template_name: templateName,
        template_lang: String(body?.template_lang ?? 'pt_BR'),
        template_components: [{
          type: 'body',
          parameters: (Array.isArray(body?.template_params) ? body.template_params : [])
            .map((t: unknown) => ({ type: 'text', text: String(t ?? '').replace(/\s+/g, ' ').trim() })),
        }],
        header_media_url: info.cronograma.url,
      } : null

      const enviar = async (payload: Record<string, unknown>) => {
        const r = await fetch(`${SUPABASE_URL}/functions/v1/crm-whatsapp-send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE}` },
          body: JSON.stringify(payload),
        })
        const resp = await r.json().catch(() => ({}))
        return {
          ok: r.ok && resp?.success === true,
          erro: resp?.error ?? `crm-whatsapp-send retornou ${r.status}`,
        }
      }

      let res = await enviar(comoTemplate ?? comoDocumento)
      // Plano B: template falhou (não aprovado no número, upload recusado, número
      // restrito) e o chamador ofereceu uma linha Web. Melhor entregar por ela do que
      // não entregar — o lead pediu o material.
      if (!res.ok && comoTemplate && body?.wa_conexao_id) {
        const viaWeb = await enviar(comoDocumento)
        if (viaWeb.ok) res = viaWeb
        else res = { ok: false, erro: `template: ${res.erro} | linha web: ${viaWeb.erro}` }
      }
      cronogramaEnviado = res.ok
      if (!cronogramaEnviado) cronogramaErro = res.erro
    }
  }

  // Modo com valor: devolve o valor integral da pós E o da matrícula (o agente fala os dois)
  const valorIntegral: string | null = conteudo !== 'cronograma' ? (info.valor_integral ?? null) : null
  const valorMatricula: string | null = conteudo !== 'cronograma' ? (info.valor_matricula ?? null) : null
  if (conteudo === 'valor' && !valorIntegral && !valorMatricula) {
    return json(404, { error: 'valor não cadastrado para este curso', code: 'valor_nao_cadastrado' })
  }

  return json(200, {
    data: {
      curso: info.curso?.nome ?? pos,
      cronograma_enviado: cronogramaEnviado,
      ...(cronogramaErro ? { cronograma_erro: cronogramaErro } : {}),
      valor_integral: valorIntegral,
      valor_matricula: valorMatricula,
    },
  })
}

async function handlePontos(sdrId: string, url: URL): Promise<Response> {
  const hoje = new Date().toISOString().slice(0, 10)
  const inicio = (url.searchParams.get('inicio') || hoje).trim()
  const fim = (url.searchParams.get('fim') || hoje).trim()

  // Base: comparecimento + conversão (RPC canônica)
  const { data: diario, error } = await supabase.rpc('fn_ranking_publico_pontos_diarios', {
    start_date: inicio,
    end_date: fim,
  })
  if (error) return json(500, { error: error.message })

  const linhas = ((diario as any[]) || []).filter((r) => r.usuario_id === sdrId)
  let comparecimento = 0
  let conversao = 0
  for (const r of linhas) {
    comparecimento += Number(r.pontos_comparecimento || 0)
    conversao += Number(r.pontos_conversao || 0)
  }
  const base = comparecimento + conversao

  // Extras: somar pontos_extras_sdr das semanas ISO que tocam o período
  const semanas = new Set<string>()
  const dIni = new Date(`${inicio}T00:00:00Z`)
  const dFim = new Date(`${fim}T00:00:00Z`)
  for (let d = new Date(dIni); d <= dFim; d.setUTCDate(d.getUTCDate() + 1)) {
    const { ano, semana } = isoWeekYear(d)
    semanas.add(`${ano}-${semana}`)
  }
  let extras = 0
  if (semanas.size > 0) {
    const { data: ex } = await supabase
      .from('pontos_extras_sdr')
      .select('valor, ano, semana')
      .eq('sdr_id', sdrId)
    for (const row of (ex as any[]) || []) {
      if (semanas.has(`${row.ano}-${row.semana}`)) extras += Number(row.valor || 0)
    }
  }

  return json(200, {
    data: {
      sdr_id: sdrId,
      periodo: { inicio, fim },
      pontos_comparecimento: comparecimento,
      pontos_conversao: conversao,
      pontos_extras: extras,
      pontos_base: base,
      pontos_total: base + extras,
      detalhes_diarios: linhas,
    },
  })
}

// ---- entrypoint ------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    // auth
    const authHeader = req.headers.get('Authorization') || ''
    const m = authHeader.match(/^Bearer\s+(.+)$/i)
    if (!m) return json(401, { error: 'Chave de API ausente. Use: Authorization: Bearer <sua_chave>' })
    const token = m[1].trim()
    const hash = await sha256hex(token)

    const { data: key } = await supabase
      .from('sdr_api_keys')
      .select('id, sdr_id, ativo, revoked_at')
      .eq('key_hash', hash)
      .maybeSingle()

    if (!key || key.ativo !== true || key.revoked_at) {
      return json(401, { error: 'Chave de API inválida ou revogada' })
    }
    if (!allow(key.id)) {
      return json(429, { error: 'Muitas requisições. Limite de 120/min por chave.' })
    }
    // marca uso (não bloqueante)
    supabase.from('sdr_api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', key.id).then(() => {})

    const sdrId = key.sdr_id as string
    const url = new URL(req.url)
    const segs = url.pathname.split('/').filter(Boolean)
    const i = segs.indexOf('sdr-api')
    const route = i >= 0 ? segs.slice(i + 1) : segs
    const method = req.method

    const needsBody = method === 'POST' || method === 'PATCH'
    let body: any = {}
    if (needsBody) {
      try {
        body = await req.json()
      } catch {
        body = {}
      }
    }

    // roteamento
    if (method === 'GET' && route.length === 0) {
      return json(200, { data: { service: 'sdr-api', sdr_id: sdrId, ok: true } })
    }
    if (method === 'GET' && route[0] === 'me') return await handleMe(sdrId)

    if (route[0] === 'leads') {
      if (method === 'POST' && route.length === 1) return await handleCreateLead(sdrId, body)
      if (method === 'GET' && route.length === 1) return await handleListLeads(sdrId, url)
    }

    if (route[0] === 'vendedores' && method === 'GET' && route.length === 1) {
      return await handleVendedores(sdrId, url)
    }

    if (route[0] === 'disponibilidade' && method === 'GET' && route.length === 1) {
      return await handleDisponibilidade(sdrId, url)
    }

    if (route[0] === 'agendamentos') {
      if (method === 'POST' && route.length === 1) return await handleAgendar(sdrId, body)
      if (method === 'GET' && route.length === 1) return await handleListAgendamentos(sdrId, url)
      if (method === 'PATCH' && route.length === 2) return await handleReagendar(sdrId, route[1], body)
      if (method === 'POST' && route.length === 3 && route[2] === 'resultado') {
        return await handleResultado(sdrId, route[1], body)
      }
      if (method === 'POST' && route.length === 3 && route[2] === 'cancelar') {
        return await handleCancelar(sdrId, route[1], body)
      }
    }

    if (route[0] === 'envia-informacoes' && method === 'POST' && route.length === 1) {
      return await handleEnviaInformacoes(sdrId, body)
    }

    if (route[0] === 'pontos' && method === 'GET' && route.length === 1) {
      return await handlePontos(sdrId, url)
    }

    return json(404, { error: `Rota não encontrada: ${method} /${route.join('/')}` })
  } catch (err) {
    console.error('[sdr-api] erro inesperado', err)
    return json(500, { error: 'Erro interno do servidor', detail: String(err) })
  }
})
