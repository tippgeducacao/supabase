import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const WEBHOOK_URL = 'https://auto.ppgeducacao.site/webhook/dadoslead'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const dados = await req.json()
    console.log('📤 Enviando webhook Estudo do Lead para:', WEBHOOK_URL)
    console.log('📋 Agendamento ID:', dados.agendamento_id)

    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dados),
    })

    if (!response.ok) {
      const text = await response.text()
      console.error('❌ Webhook retornou erro:', response.status, text)
      return new Response(
        JSON.stringify({ success: false, error: `Webhook returned ${response.status}` }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const retorno = await response.json()
    console.log('✅ Retorno da webhook Estudo do Lead recebido')

    // Salvar retorno no agendamento
    if (dados.agendamento_id) {
      const supabase = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
      )

      const { error } = await supabase
        .from('agendamentos')
        .update({ estudo_lead: retorno })
        .eq('id', dados.agendamento_id)

      if (error) {
        console.error('❌ Erro ao salvar estudo_lead:', error.message)
      } else {
        console.log('✅ Estudo do Lead salvo no agendamento:', dados.agendamento_id.substring(0, 8))
      }
    }

    return new Response(
      JSON.stringify({ success: true, data: retorno }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error('❌ Erro interno:', (error as Error).message)
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
