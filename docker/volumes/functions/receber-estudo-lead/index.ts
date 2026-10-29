import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { createLogger } from '../_shared/logger.ts'
import { exigirAcesso, respostaAcessoNegado } from '../_shared/acesso.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const logger = createLogger('receber-estudo-lead')

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Método não permitido' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // PORTA (29/10/2026): sem login, sobrescrevia agendamentos.estudo_lead de qualquer agendamento
  // (e servia de oráculo de UUID). Quem chamava era o n8n, excluído em 14/10/2026; nenhum
  // estudo_lead foi gravado nos últimos 30 dias. Aceita só a chave de serviço exata ou o
  // cabeçalho x-webhook-secret = env RECEBER_ESTUDO_LEAD_SECRET (vazio = desligado).
  try {
    await exigirAcesso(req, { servico: true, segredo: { cabecalho: 'x-webhook-secret', valor: Deno.env.get('RECEBER_ESTUDO_LEAD_SECRET') } })
  } catch (e) {
    return respostaAcessoNegado(e, corsHeaders)
  }

  try {
    const body = await req.json()
    const { agendamento_id, estudo } = body

    if (!agendamento_id || typeof agendamento_id !== 'string') {
      logger.warn('Requisição sem agendamento_id válido')
      return new Response(
        JSON.stringify({ error: 'agendamento_id é obrigatório' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!estudo) {
      logger.warn('Requisição sem dados de estudo', { agendamento_id })
      return new Response(
        JSON.stringify({ error: 'estudo é obrigatório' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // Verificar se o agendamento existe
    const { data: existing, error: fetchError } = await supabase
      .from('agendamentos')
      .select('id')
      .eq('id', agendamento_id)
      .maybeSingle()

    if (fetchError) {
      logger.error('Erro ao buscar agendamento', fetchError, { agendamento_id })
      return new Response(
        JSON.stringify({ error: 'Erro ao buscar agendamento' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!existing) {
      logger.warn('Agendamento não encontrado', { agendamento_id })
      return new Response(
        JSON.stringify({ error: 'Agendamento não encontrado' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Salvar o estudo do lead
    const { error: updateError } = await supabase
      .from('agendamentos')
      .update({ estudo_lead: estudo })
      .eq('id', agendamento_id)

    if (updateError) {
      logger.error('Erro ao salvar estudo_lead', updateError, { agendamento_id })
      return new Response(
        JSON.stringify({ error: 'Erro ao salvar estudo_lead' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    logger.info('Estudo do lead salvo com sucesso', { agendamento_id })

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    logger.error('Erro interno', error)
    return new Response(
      JSON.stringify({ error: 'Erro interno do servidor' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
