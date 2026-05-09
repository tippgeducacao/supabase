import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface CaptacaoOrganicaWebhookData {
  Nome_do_Lead?: string;
  E_mail_do_Lead?: string;
  Whatsapp_do_Lead?: string;
  Formacao?: string;
  Area_de_Interesse?: string;
  Observacoes?: string;
  URL?: string;
  IP_do_usuario?: string;
  Data_da_conversao?: string;
  Dispositivo?: string;
  Referral_Source?: string;
  Id_da_pagina?: string;
  Id_do_formulario?: string;
  Pais_do_usuario?: string;
  [key: string]: any;
}

/**
 * Extrai o nome do captador da URL
 * Exemplo: "https://ppgeducacao.com.br/suelen" → "suelen"
 */
function extractCaptadorFromUrl(url: string | undefined): string {
  if (!url) return '';
  
  try {
    console.log(`📍 Extraindo captador da URL: ${url}`);
    
    // Remove protocolo e pega apenas o path
    const cleanUrl = url.replace(/^https?:\/\//, '');
    const parts = cleanUrl.split('/').filter(p => p.trim() !== '');
    
    // O captador é o último segmento da URL (depois do domínio)
    if (parts.length > 1) {
      const captador = parts[parts.length - 1];
      console.log(`✅ Captador extraído: ${captador}`);
      return captador;
    }
    
    console.log(`⚠️ URL não contém captador válido (apenas domínio)`);
    return '';
  } catch (error) {
    console.error(`❌ Erro ao extrair captador da URL:`, error);
    return '';
  }
}

serve(async (req) => {
  console.log(`🌿🌿🌿 WEBHOOK CAPTAÇÕES ORGÂNICAS CHAMADO! 🌿🌿🌿`);
  console.log(`⏰ Timestamp: ${new Date().toISOString()}`);
  console.log(`🎯 Iniciando processamento do webhook de captações orgânicas...`);

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

    let requestData: CaptacaoOrganicaWebhookData;

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
          requestData = { Observacoes: body };
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
    console.log(`- Campos disponíveis:`, Object.keys(requestData));

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

    console.log(`🗂️ Iniciando mapeamento dos dados da captação orgânica...`);

    // Extrair o captador da URL
    const captador = extractCaptadorFromUrl(requestData.URL);

    // Map the incoming data to our captacoes_organicas table structure
    const captacaoData = {
      cadastrado_por: captador,
      nome_lead: requestData.Nome_do_Lead || '',
      whatsapp_lead: requestData.Whatsapp_do_Lead || '',
      email_lead: requestData.E_mail_do_Lead || '',
      formacao: requestData.Formacao || '',
      area_interesse: requestData.Area_de_Interesse || '',
      observacoes: requestData.Observacoes || '',
      status: 'novo'
    };

    console.log(`🔍 Validando dados essenciais...`);
    
    if (!captacaoData.cadastrado_por || !captacaoData.nome_lead) {
      console.error('❌ Dados essenciais faltando: cadastrado_por (extraído da URL) ou nome_lead');
      return new Response(
        JSON.stringify({ 
          error: 'Missing required fields',
          details: 'A URL deve conter o nome do captador (ex: ppgeducacao.com.br/suelen) e o Nome_do_Lead é obrigatório',
          received_url: requestData.URL,
          extracted_captador: captador
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    console.log(`📋 DADOS DA CAPTAÇÃO ORGÂNICA PREPARADOS:`, captacaoData);
    console.log(`💾 Tentando inserir captação orgânica na base de dados...`);

    // Insert the captacao into the database
    const { data, error } = await supabase
      .from('captacoes_organicas')
      .insert([captacaoData])
      .select();

    if (error) {
      console.error('❌ Erro ao inserir captação orgânica:', error);
      return new Response(
        JSON.stringify({ error: 'Failed to insert captacao organica', details: error.message }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    console.log(`🎉 SUCESSO! Captação orgânica inserida com sucesso!`);
    console.log(`🆔 ID da captação: ${data[0]?.id}`);
    console.log(`👤 Captador: ${captacaoData.cadastrado_por}`);
    console.log(`📋 Dados inseridos:`, data);

    // 2. Também inserir na tabela leads para aparecer na Gestão de Leads
    console.log(`📝 Inserindo lead na tabela leads...`);

    const observacoesLead = [
      `Captador: ${captador}`,
      captacaoData.area_interesse ? `Área de Interesse: ${captacaoData.area_interesse}` : null,
      captacaoData.observacoes ? captacaoData.observacoes : null
    ].filter(Boolean).join(' | ');

    const leadData = {
      nome: captacaoData.nome_lead,
      email: captacaoData.email_lead || null,
      whatsapp: captacaoData.whatsapp_lead || null,
      observacoes: observacoesLead,
      profissao: captacaoData.formacao || null,
      fonte_referencia: 'Orgânico',
      status: 'novo',
      vendedor_atribuido: null,
      dispositivo: requestData.Dispositivo || null,
      ip_address: requestData.IP_do_usuario || null,
      pagina_id: requestData.Id_da_pagina || null,
      regiao: requestData.Pais_do_usuario || null
    };

    console.log(`📋 Dados do lead:`, leadData);

    const { data: leadInserted, error: leadError } = await supabase
      .from('leads')
      .insert([leadData])
      .select();

    let leadId = null;
    if (leadError) {
      console.error('⚠️ Erro ao inserir na tabela leads (captação orgânica já salva):', leadError);
    } else {
      leadId = leadInserted[0]?.id;
      console.log(`✅ Lead também inserido na tabela leads! ID: ${leadId}`);
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: 'Captacao organica received and stored successfully',
        id: data[0]?.id,
        lead_id: leadId,
        captador: captacaoData.cadastrado_por,
        data: data[0] 
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
