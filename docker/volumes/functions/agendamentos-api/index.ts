import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.3'
import { corsHeaders } from '../_shared/cors.ts'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

interface CreateAgendamentoRequest {
  lead_id?: string
  lead_dados?: {
    nome: string
    email?: string
    whatsapp?: string
    observacoes?: string
    fonte_referencia?: string
  }
  vendedor_id: string
  sdr_id: string
  pos_graduacao_interesse: string
  data_agendamento: string
  data_fim_agendamento?: string
  link_reuniao: string
  observacoes?: string
}

interface AgendamentoResponse {
  id: string
  lead_id: string
  vendedor_id: string
  sdr_id: string
  pos_graduacao_interesse: string
  data_agendamento: string
  data_fim_agendamento: string | null
  link_reuniao: string
  status: string
  resultado_reuniao: string | null
  data_resultado: string | null
  observacoes: string | null
  created_at: string
  updated_at: string
  lead?: {
    nome: string
    email?: string
    whatsapp?: string
  }
  vendedor?: {
    nome: string
    email: string
  }
  sdr?: {
    nome: string
    email: string
  }
}

function validateApiKey(req: Request): boolean {
  const apiKey = req.headers.get('X-API-Key')
  const validApiKey = Deno.env.get('AGENDAMENTOS_API_KEY')
  
  if (!apiKey) {
    console.log('❌ API Key não fornecida')
    return false
  }
  
  if (!validApiKey) {
    console.log('❌ API Key não configurada no servidor')
    return false
  }
  
  if (apiKey !== validApiKey) {
    console.log('❌ API Key inválida')
    return false
  }
  
  console.log('✅ API Key válida')
  return true
}

function validateLinkReuniao(link: string): boolean {
  try {
    const url = new URL(link)
    return ['http:', 'https:'].includes(url.protocol)
  } catch {
    return false
  }
}

function parseISO8601(dateString: string): Date | null {
  try {
    const date = new Date(dateString)
    if (isNaN(date.getTime())) {
      return null
    }
    return date
  } catch {
    return null
  }
}

async function checkScheduleConflict(
  vendedorId: string, 
  dataInicio: Date, 
  dataFim: Date,
  excludeId?: string
): Promise<{ hasConflict: boolean; conflictDetails?: any }> {
  console.log(`🔍 Verificando conflitos para vendedor ${vendedorId} entre ${dataInicio.toISOString()} e ${dataFim.toISOString()}`)
  
  // Buscar agendamentos do vendedor na janela de tempo
  const { data: agendamentos, error } = await supabase
    .from('agendamentos')
    .select('id, data_agendamento, data_fim_agendamento, status')
    .eq('vendedor_id', vendedorId)
    .gte('data_agendamento', new Date(dataInicio.getTime() - 2 * 60 * 60 * 1000).toISOString()) // 2h antes
    .lte('data_agendamento', new Date(dataFim.getTime() + 2 * 60 * 60 * 1000).toISOString()) // 2h depois
    .in('status', ['agendado', 'atrasado', 'finalizado', 'finalizado_venda', 'remarcado'])
    .neq('id', excludeId || '')

  if (error) {
    console.error('❌ Erro ao buscar agendamentos:', error)
    return { hasConflict: false }
  }

  // Verificar sobreposições
  for (const agendamento of agendamentos || []) {
    const agendamentoInicio = new Date(agendamento.data_agendamento)
    const agendamentoFim = agendamento.data_fim_agendamento 
      ? new Date(agendamento.data_fim_agendamento)
      : new Date(agendamentoInicio.getTime() + 60 * 60 * 1000) // +1h se não especificado

    // Há conflito se há sobreposição de horários
    if (dataInicio < agendamentoFim && dataFim > agendamentoInicio) {
      console.log(`❌ Conflito detectado com agendamento ${agendamento.id}`)
      return {
        hasConflict: true,
        conflictDetails: {
          agendamento_id: agendamento.id,
          conflito_inicio: agendamentoInicio.toISOString(),
          conflito_fim: agendamentoFim.toISOString()
        }
      }
    }
  }

  console.log('✅ Nenhum conflito de agenda encontrado')
  return { hasConflict: false }
}

async function checkSpecialEventConflict(dataInicio: Date, dataFim: Date): Promise<boolean> {
  console.log(`🔍 Verificando conflitos com eventos especiais entre ${dataInicio.toISOString()} e ${dataFim.toISOString()}`)
  
  try {
    const { data, error } = await supabase.rpc('verificar_conflito_evento_especial', {
      data_inicio_agendamento: dataInicio.toISOString(),
      data_fim_agendamento: dataFim.toISOString()
    })

    if (error) {
      console.error('❌ Erro ao verificar conflito com eventos especiais:', error)
      return false
    }

    if (data === true) {
      console.log('❌ Conflito com evento especial detectado')
      return true
    }

    console.log('✅ Nenhum conflito com eventos especiais')
    return false
  } catch (error) {
    console.error('❌ Erro inesperado ao verificar eventos especiais:', error)
    return false
  }
}

async function createOrFindLead(leadData: any): Promise<string | null> {
  try {
    // Tentar encontrar lead existente por email ou whatsapp
    if (leadData.email || leadData.whatsapp) {
      const { data: existingLead } = await supabase
        .from('leads')
        .select('id')
        .or(`email.eq.${leadData.email || ''},whatsapp.eq.${leadData.whatsapp || ''}`)
        .limit(1)
        .single()

      if (existingLead) {
        console.log(`✅ Lead existente encontrado: ${existingLead.id}`)
        return existingLead.id
      }
    }

    // Criar novo lead
    const { data: newLead, error } = await supabase
      .from('leads')
      .insert({
        nome: leadData.nome,
        email: leadData.email || null,
        whatsapp: leadData.whatsapp || null,
        observacoes: leadData.observacoes || null,
        fonte_referencia: leadData.fonte_referencia || 'API Externa'
      })
      .select('id')
      .single()

    if (error) {
      console.error('❌ Erro ao criar lead:', error)
      return null
    }

    console.log(`✅ Novo lead criado: ${newLead.id}`)
    return newLead.id
  } catch (error) {
    console.error('❌ Erro inesperado ao criar/encontrar lead:', error)
    return null
  }
}

async function getAgendamentos(url: URL): Promise<Response> {
  const status = url.searchParams.get('status')?.split(',') || []
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')
  const vendedorId = url.searchParams.get('vendedor_id')
  const sdrId = url.searchParams.get('sdr_id')
  const limit = parseInt(url.searchParams.get('limit') || '50')
  const offset = parseInt(url.searchParams.get('offset') || '0')

  console.log('📋 Listando agendamentos com filtros:', {
    status,
    from,
    to,
    vendedorId,
    sdrId,
    limit,
    offset
  })

  let query = supabase
    .from('agendamentos')
    .select(`
      *,
      leads:lead_id (nome, email, whatsapp),
      vendedor:profiles!vendedor_id (name, email),
      sdr:profiles!sdr_id (name, email)
    `)
    .order('data_agendamento', { ascending: false })

  if (status.length > 0) {
    query = query.in('status', status)
  }

  if (from) {
    const fromDate = parseISO8601(from)
    if (fromDate) {
      query = query.gte('data_agendamento', fromDate.toISOString())
    }
  }

  if (to) {
    const toDate = parseISO8601(to)
    if (toDate) {
      query = query.lte('data_agendamento', toDate.toISOString())
    }
  }

  if (vendedorId) {
    query = query.eq('vendedor_id', vendedorId)
  }

  if (sdrId) {
    query = query.eq('sdr_id', sdrId)
  }

  const { data, error, count } = await query
    .range(offset, offset + limit - 1)

  if (error) {
    console.error('❌ Erro ao buscar agendamentos:', error)
    return new Response(
      JSON.stringify({ error: 'Erro interno do servidor', details: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  const formattedData = (data || []).map((item: any) => ({
    id: item.id,
    lead_id: item.lead_id,
    vendedor_id: item.vendedor_id,
    sdr_id: item.sdr_id,
    pos_graduacao_interesse: item.pos_graduacao_interesse,
    data_agendamento: item.data_agendamento,
    data_fim_agendamento: item.data_fim_agendamento,
    link_reuniao: item.link_reuniao,
    status: item.status,
    resultado_reuniao: item.resultado_reuniao,
    data_resultado: item.data_resultado,
    observacoes: item.observacoes,
    created_at: item.created_at,
    updated_at: item.updated_at,
    lead: item.leads ? {
      nome: item.leads.nome,
      email: item.leads.email,
      whatsapp: item.leads.whatsapp
    } : null,
    vendedor: item.vendedor ? {
      nome: item.vendedor.name,
      email: item.vendedor.email
    } : null,
    sdr: item.sdr ? {
      nome: item.sdr.name,
      email: item.sdr.email
    } : null
  }))

  console.log(`✅ Retornando ${formattedData.length} agendamentos`)

  return new Response(
    JSON.stringify({
      data: formattedData,
      count: count || 0
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
}

async function getAgendamentoById(id: string): Promise<Response> {
  console.log(`🔍 Buscando agendamento por ID: ${id}`)

  const { data, error } = await supabase
    .from('agendamentos')
    .select(`
      *,
      leads:lead_id (nome, email, whatsapp),
      vendedor:profiles!vendedor_id (name, email),
      sdr:profiles!sdr_id (name, email)
    `)
    .eq('id', id)
    .single()

  if (error || !data) {
    console.log(`❌ Agendamento não encontrado: ${id}`)
    return new Response(
      JSON.stringify({ error: 'Agendamento não encontrado' }),
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  const formattedData = {
    id: data.id,
    lead_id: data.lead_id,
    vendedor_id: data.vendedor_id,
    sdr_id: data.sdr_id,
    pos_graduacao_interesse: data.pos_graduacao_interesse,
    data_agendamento: data.data_agendamento,
    data_fim_agendamento: data.data_fim_agendamento,
    link_reuniao: data.link_reuniao,
    status: data.status,
    resultado_reuniao: data.resultado_reuniao,
    data_resultado: data.data_resultado,
    observacoes: data.observacoes,
    created_at: data.created_at,
    updated_at: data.updated_at,
    lead: data.leads ? {
      nome: data.leads.nome,
      email: data.leads.email,
      whatsapp: data.leads.whatsapp
    } : null,
    vendedor: data.vendedor ? {
      nome: data.vendedor.name,
      email: data.vendedor.email
    } : null,
    sdr: data.sdr ? {
      nome: data.sdr.name,
      email: data.sdr.email
    } : null
  }

  console.log(`✅ Agendamento encontrado: ${id}`)

  return new Response(
    JSON.stringify(formattedData),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
}

async function createAgendamento(req: Request): Promise<Response> {
  let body: CreateAgendamentoRequest

  try {
    body = await req.json()
  } catch {
    return new Response(
      JSON.stringify({ error: 'Payload JSON inválido' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  console.log('📝 Criando novo agendamento:', body)

  // Validações obrigatórias
  const requiredFields = ['vendedor_id', 'sdr_id', 'pos_graduacao_interesse', 'data_agendamento', 'link_reuniao']
  const missingFields = requiredFields.filter(field => !body[field as keyof CreateAgendamentoRequest])

  if (missingFields.length > 0) {
    return new Response(
      JSON.stringify({
        error: 'Campos obrigatórios ausentes',
        missing_fields: missingFields
      }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Validar que existe lead_id OU lead_dados
  if (!body.lead_id && !body.lead_dados) {
    return new Response(
      JSON.stringify({
        error: 'É necessário fornecer lead_id OU lead_dados'
      }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Validar lead_dados se fornecido
  if (body.lead_dados && !body.lead_dados.nome) {
    return new Response(
      JSON.stringify({
        error: 'lead_dados.nome é obrigatório quando lead_dados é fornecido'
      }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Validar formato do link_reuniao
  if (!validateLinkReuniao(body.link_reuniao)) {
    return new Response(
      JSON.stringify({
        error: 'link_reuniao deve ser uma URL válida (http/https)'
      }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Validar e processar datas
  const dataInicio = parseISO8601(body.data_agendamento)
  if (!dataInicio) {
    return new Response(
      JSON.stringify({
        error: 'data_agendamento deve estar no formato ISO 8601 válido'
      }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  let dataFim: Date
  if (body.data_fim_agendamento) {
    const parsedDataFim = parseISO8601(body.data_fim_agendamento)
    if (!parsedDataFim) {
      return new Response(
        JSON.stringify({
          error: 'data_fim_agendamento deve estar no formato ISO 8601 válido'
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
    dataFim = parsedDataFim
  } else {
    // Padrão: +60 minutos
    dataFim = new Date(dataInicio.getTime() + 60 * 60 * 1000)
  }

  if (dataFim <= dataInicio) {
    return new Response(
      JSON.stringify({
        error: 'data_fim_agendamento deve ser posterior a data_agendamento'
      }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Verificar conflitos de agenda
  const conflictCheck = await checkScheduleConflict(body.vendedor_id, dataInicio, dataFim)
  if (conflictCheck.hasConflict) {
    return new Response(
      JSON.stringify({
        error: 'Conflito de agendamento detectado',
        conflict_details: conflictCheck.conflictDetails
      }),
      { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Verificar conflitos com eventos especiais
  const hasSpecialEventConflict = await checkSpecialEventConflict(dataInicio, dataFim)
  if (hasSpecialEventConflict) {
    return new Response(
      JSON.stringify({
        error: 'Conflito com evento especial detectado'
      }),
      { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Resolver lead_id
  let finalLeadId = body.lead_id
  if (!finalLeadId && body.lead_dados) {
    finalLeadId = await createOrFindLead(body.lead_dados) ?? undefined
    if (!finalLeadId) {
      return new Response(
        JSON.stringify({
          error: 'Erro ao criar/encontrar lead'
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
  }

  // Criar agendamento
  const { data, error } = await supabase
    .from('agendamentos')
    .insert({
      lead_id: finalLeadId,
      vendedor_id: body.vendedor_id,
      sdr_id: body.sdr_id,
      pos_graduacao_interesse: body.pos_graduacao_interesse,
      data_agendamento: dataInicio.toISOString(),
      data_fim_agendamento: dataFim.toISOString(),
      link_reuniao: body.link_reuniao,
      observacoes: body.observacoes || null,
      status: 'agendado'
    })
    .select('id')
    .single()

  if (error) {
    console.error('❌ Erro ao criar agendamento:', error)
    return new Response(
      JSON.stringify({
        error: 'Erro ao criar agendamento',
        details: error.message
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  console.log(`✅ Agendamento criado com sucesso: ${data.id}`)

  return new Response(
    JSON.stringify({
      id: data.id,
      status: 'agendado'
    }),
    { status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
}

Deno.serve(async (req) => {
  console.log(`🚀 API Agendamentos - ${req.method} ${req.url}`)

  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  // Validar API Key
  if (!validateApiKey(req)) {
    const apiKey = req.headers.get('X-API-Key')
    
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'X-API-Key header é obrigatório' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    } else {
      return new Response(
        JSON.stringify({ error: 'X-API-Key inválida' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
  }

  const url = new URL(req.url)
  const pathSegments = url.pathname.split('/').filter(Boolean)
  
  // Remover "agendamentos-api" do path se presente
  const actualPath = pathSegments[pathSegments.length - 1] === 'agendamentos-api' 
    ? [] 
    : pathSegments.slice(pathSegments.findIndex(seg => seg === 'agendamentos-api') + 1)

  try {
    // GET /agendamentos
    if (req.method === 'GET' && actualPath.length === 0) {
      return await getAgendamentos(url)
    }

    // GET /agendamentos/:id
    if (req.method === 'GET' && actualPath.length === 1) {
      return await getAgendamentoById(actualPath[0])
    }

    // POST /agendamentos
    if (req.method === 'POST' && actualPath.length === 0) {
      return await createAgendamento(req)
    }

    // Rota não encontrada
    return new Response(
      JSON.stringify({ error: 'Endpoint não encontrado' }),
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('❌ Erro inesperado:', error)
    return new Response(
      JSON.stringify({
        error: 'Erro interno do servidor',
        details: (error as Error).message
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})