import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface IndicacaoWebhookData {
  cadastrado_por?: string;
  nome_aluno?: string;
  whatsapp_aluno?: string;
  nome_indicado?: string;
  whatsapp_indicado?: string;
  formacao?: string;
  area_interesse?: string;
  observacoes?: string;
  [key: string]: any;
}

serve(async (req) => {
  console.log(`🚨🚨🚨 WEBHOOK INDICAÇÕES CHAMADO! 🚨🚨🚨`);
  console.log(`⏰ Timestamp: ${new Date().toISOString()}`);
  console.log(`🎯 Iniciando processamento do webhook de indicações...`);

  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Ensure this is a POST request
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    console.log(`📖 Lendo body da requisição...`);
    
    // Read the request body
    const body = await req.text();
    console.log(`✅ Body lido com sucesso!`);
    console.log(`📏 Tamanho do body: ${body.length} caracteres`);
    console.log(`🔍 BODY RAW:`, body);

    let requestData: IndicacaoWebhookData & { skip_db_insert?: boolean; email_indicado?: string };

    // Parse the request body
    const contentType = req.headers.get('content-type')?.toLowerCase() || '';
    console.log(`🔍 Content-Type detectado: ${contentType}`);

    try {
      if (contentType.includes('application/json')) {
        console.log(`📋 Parseando como JSON...`);
        requestData = JSON.parse(body);
        console.log(`✅ JSON parseado com sucesso!`);
      } else if (contentType.includes('application/x-www-form-urlencoded')) {
        console.log(`📋 Parseando como form-urlencoded...`);
        const params = new URLSearchParams(body);
        requestData = Object.fromEntries(params.entries());
        console.log(`✅ Form-urlencoded parseado com sucesso!`);
      } else {
        console.log(`📋 Tentando parsear como JSON (fallback)...`);
        try {
          requestData = JSON.parse(body);
          console.log(`✅ JSON parseado com sucesso no fallback!`);
        } catch {
          console.log(`⚠️ Fallback para texto simples`);
          requestData = { observacoes: body };
        }
      }
    } catch (parseError) {
      console.error(`❌ Erro no parsing:`, parseError);
      return new Response(
        JSON.stringify({ error: 'Error parsing request data', details: (parseError as Error).message }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    console.log(`🔍 DADOS RECEBIDOS:`);
    console.log(`- Dados completos:`, JSON.stringify(requestData, null, 2));
    console.log(`- Número de campos: ${Object.keys(requestData).length}`);
    console.log(`- Chaves dos campos:`, Object.keys(requestData));

    // 🔀 Se skip_db_insert=true, apenas enviar para SprintHub e retornar
    if (requestData.skip_db_insert) {
      console.log(`⏭️ skip_db_insert=true, enviando apenas para SprintHub...`);
      
      const sprintHubPayload = {
        cadastrado_por: requestData.cadastrado_por || '',
        nome_aluno: requestData.nome_aluno || '',
        whatsapp_aluno: requestData.whatsapp_aluno || '',
        nome_indicado: requestData.nome_indicado || '',
        whatsapp_indicado: requestData.whatsapp_indicado || '',
        email_indicado: requestData.email_indicado || null,
        formacao: requestData.formacao || null,
        area_interesse: requestData.area_interesse || null,
        observacoes: requestData.observacoes || null,
      };

      console.log(`📤 Payload para SprintHub:`, JSON.stringify(sprintHubPayload));

      try {
        const sprintHubResponse = await fetch(
          'https://sprinthub-api-grupoppgeducacao.sprinthub.app/api/hook/-indicacoes-lovable?i=grupoppgeducacao&access_token=p_OjA_o4Y5lJwz4nHE1ygFdBo1qP2oBbj2AwqtBrcA_6I6Vbw8',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sprintHubPayload),
          }
        );
        const sprintHubText = await sprintHubResponse.text();
        console.log(`✅ SprintHub respondeu: ${sprintHubResponse.status} - ${sprintHubText}`);
      } catch (sprintHubError) {
        console.error(`❌ Erro ao enviar para SprintHub:`, sprintHubError);
      }

      return new Response(
        JSON.stringify({ success: true, message: 'Dados enviados ao SprintHub' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Initialize Supabase client
    console.log(`🔗 Criando cliente Supabase...`);
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseServiceRoleKey) {
      console.error('❌ Variáveis de ambiente do Supabase não configuradas');
      return new Response(
        JSON.stringify({ error: 'Server configuration error' }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

    console.log(`🗂️ Iniciando mapeamento dos dados da indicação...`);

    // Map the incoming data to our indicacoes table structure
    const indicacaoData = {
      cadastrado_por: requestData.cadastrado_por || '',
      nome_aluno: requestData.Nome_do_Lead || requestData.nome_aluno || '',
      whatsapp_aluno: requestData.whatsapp_aluno || '',
      nome_indicado: requestData.nome_indicado || '',
      whatsapp_indicado: requestData.Whatsapp_do_Lead || requestData.whatsapp_indicado || '',
      email_indicado: requestData.email_indicado || null,
      formacao: requestData.Formacao || requestData.formacao || '',
      area_interesse: requestData.Area_de_Interesse || requestData.area_interesse || '',
      observacoes: requestData.observacoes || '',
      criado_por_usuario_id: requestData.criado_por_usuario_id || null,
      status: 'novo'
    };

    console.log(`🔍 Validando dados essenciais...`);
    
    if (!indicacaoData.nome_aluno || !indicacaoData.nome_indicado) {
      console.error('❌ Dados essenciais faltando: nome_aluno ou nome_indicado');
      return new Response(
        JSON.stringify({ 
          error: 'Missing required fields: nome_aluno and nome_indicado are required' 
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    console.log(`📋 DADOS DA INDICAÇÃO PREPARADOS:`);
    console.log(indicacaoData);

    // ⚠️ VERIFICAR DUPLICADOS - Checar se já existe indicação similar nos últimos 5 minutos
    console.log(`🔍 Verificando duplicados de indicação...`);
    const cincoMinutosAtras = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const { data: indicacaoExistente } = await supabase
      .from('indicacoes')
      .select('id, lead_id')
      .eq('nome_indicado', indicacaoData.nome_indicado)
      .eq('whatsapp_indicado', indicacaoData.whatsapp_indicado)
      .gte('created_at', cincoMinutosAtras)
      .maybeSingle();

    if (indicacaoExistente) {
      console.log(`⚠️ Indicação duplicada detectada! ID existente: ${indicacaoExistente.id}`);
      return new Response(
        JSON.stringify({ 
          success: true, 
          message: 'Indicação já processada anteriormente',
          id: indicacaoExistente.id,
          lead_id: indicacaoExistente.lead_id,
          duplicate: true
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`✅ Nenhuma indicação duplicada encontrada, prosseguindo com inserção...`);

    console.log(`💾 Tentando inserir indicação na base de dados...`);

    // Insert the indicacao into the database
    const { data, error } = await supabase
      .from('indicacoes')
      .insert([indicacaoData])
      .select()
      .single();

    if (error) {
      console.error('❌ Erro ao inserir indicação:', error);
      return new Response(
        JSON.stringify({ error: 'Failed to insert indicacao', details: error.message }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    console.log(`🎉 SUCESSO! Indicação inserida com sucesso!`);
    console.log(`🆔 ID da indicação: ${data?.id}`);
    console.log(`📋 Dados inseridos:`, data);

    // 🆕 CRIAR LEAD CORRESPONDENTE NO SISTEMA DE GESTÃO DE LEADS
    console.log(`📝 Criando lead correspondente no sistema...`);
    
    const leadData = {
      nome: indicacaoData.nome_indicado,
      whatsapp: indicacaoData.whatsapp_indicado,
      email: indicacaoData.email_indicado || null,
      profissao: indicacaoData.formacao || null,
      area_interesse: indicacaoData.area_interesse || null,
      fonte_referencia: 'Indicação',
      status: 'novo',
      observacoes: `Indicado por: ${indicacaoData.nome_aluno} (${indicacaoData.whatsapp_aluno})${indicacaoData.observacoes ? `\nObservações: ${indicacaoData.observacoes}` : ''}`,
      vendedor_atribuido: indicacaoData.criado_por_usuario_id || null,
    };

    // ⚠️ VERIFICAR DUPLICADOS DE LEAD - Checar se já existe lead similar nos últimos 5 minutos
    console.log(`🔍 Verificando duplicados de lead...`);
    const { data: leadExistente } = await supabase
      .from('leads')
      .select('id')
      .eq('nome', leadData.nome)
      .eq('whatsapp', leadData.whatsapp)
      .eq('fonte_referencia', 'Indicação')
      .gte('created_at', cincoMinutosAtras)
      .maybeSingle();

    if (leadExistente) {
      console.log(`⚠️ Lead duplicado detectado! Usando lead existente: ${leadExistente.id}`);
      
      // Vincular indicação ao lead existente ao invés de criar novo
      const { error: updateError } = await supabase
        .from('indicacoes')
        .update({ lead_id: leadExistente.id })
        .eq('id', data.id);

      if (updateError) {
        console.error('⚠️ Erro ao vincular lead existente à indicação:', updateError);
      } else {
        console.log(`🔗 Indicação vinculada ao lead existente ${leadExistente.id}`);
      }

      return new Response(
        JSON.stringify({ 
          success: true, 
          message: 'Indicação processada, lead já existia',
          id: data.id,
          lead_id: leadExistente.id,
          lead_reused: true
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`✅ Nenhum lead duplicado encontrado, criando novo lead...`);

    const { data: leadCreated, error: leadError } = await supabase
      .from('leads')
      .insert([leadData])
      .select()
      .single();

    if (!leadError && leadCreated) {
      console.log(`✅ Lead criado com sucesso! ID: ${leadCreated.id}`);
      
      // Atualizar indicação com o lead_id
      const { error: updateError } = await supabase
        .from('indicacoes')
        .update({ lead_id: leadCreated.id })
        .eq('id', data.id);

      if (updateError) {
        console.error('⚠️ Erro ao vincular lead à indicação:', updateError);
      } else {
        console.log(`🔗 Indicação vinculada ao lead ${leadCreated.id}`);
      }
    } else {
      console.error('⚠️ Erro ao criar lead:', leadError);
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: 'Indicacao received and stored successfully',
        id: data?.id,
        lead_id: leadCreated?.id || null,
        data: data 
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );

  } catch (error) {
    console.error('💥 Erro geral no processamento:', error);
    return new Response(
      JSON.stringify({ 
        error: 'Internal server error', 
        message: (error as Error).message 
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
