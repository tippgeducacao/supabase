import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
}

interface SprintHubWebhookData {
  id?: string;
  nome?: string;
  name?: string;
  email?: string;
  telefone?: string;
  whatsapp?: string;
  phone?: string;
  produto?: string;
  product?: string;
  fonte?: string;
  source?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  created_at?: string;
  data_criacao?: string;
  [key: string]: any;
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log('🔔 Webhook SprintHub recebido:', req.method);

    // Validar método HTTP
    if (req.method !== 'POST') {
      console.log('❌ Método não permitido:', req.method);
      return new Response(
        JSON.stringify({ error: 'Método não permitido' }),
        { 
          status: 405, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    }

    // Ler e parsear o corpo da requisição
    let webhookData: SprintHubWebhookData;
    const contentType = req.headers.get('content-type');
    
    if (contentType?.includes('application/json')) {
      webhookData = await req.json();
    } else if (contentType?.includes('application/x-www-form-urlencoded')) {
      const formData = await req.formData();
      webhookData = {};
      for (const [key, value] of formData.entries()) {
        webhookData[key] = value.toString();
      }
    } else {
      const text = await req.text();
      try {
        webhookData = JSON.parse(text);
      } catch {
        console.log('❌ Formato de dados não suportado');
        return new Response(
          JSON.stringify({ error: 'Formato de dados não suportado' }),
          { 
            status: 400, 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
          }
        );
      }
    }

    console.log('📥 Dados recebidos do SprintHub:', JSON.stringify(webhookData, null, 2));

    // Criar cliente Supabase
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Mapear dados do SprintHub para o formato do banco
    const leadData = {
      nome: webhookData.nome || webhookData.name || '',
      email: webhookData.email || '',
      whatsapp: webhookData.whatsapp || webhookData.telefone || webhookData.phone || '',
      fonte_referencia: 'SprintHub',
      dispositivo: webhookData.dispositivo || '',
      regiao: webhookData.regiao || '',
      pagina_id: webhookData.pagina_id || '',
      pagina_nome: webhookData.pagina_nome || '',
      utm_source: webhookData.utm_source || '',
      utm_medium: webhookData.utm_medium || '',
      utm_campaign: webhookData.utm_campaign || '',
      utm_content: webhookData.utm_content || '',
      utm_term: webhookData.utm_term || '',
      ip_address: webhookData.ip_address || '',
      status: 'novo'
    };

    console.log('🔄 Dados formatados para inserção:', JSON.stringify(leadData, null, 2));

    // Verificar se já existe um lead com mesmo email
    let existingLead = null;
    
    if (leadData.email) {
      const { data: leadByEmail } = await supabase
        .from('leads')
        .select('id')
        .eq('email', leadData.email)
        .maybeSingle();
      existingLead = leadByEmail;
    }

    if (existingLead) {
      console.log('⚠️ Lead já existe, ignorando duplicata');
      return new Response(
        JSON.stringify({ 
          success: true, 
          message: 'Lead já existe - duplicata ignorada',
          lead_id: existingLead.id 
        }),
        { 
          status: 200, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    }

    // Inserir novo lead
    const { data: newLead, error: insertError } = await supabase
      .from('leads')
      .insert([leadData])
      .select()
      .single();

    if (insertError) {
      console.error('❌ Erro ao inserir lead:', insertError);
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'Erro ao salvar lead no banco de dados',
          details: insertError.message 
        }),
        { 
          status: 500, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    }

    console.log('✅ Lead inserido com sucesso:', newLead.id);

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: 'Lead recebido e processado com sucesso',
        lead_id: newLead.id 
      }),
      { 
        status: 200, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );

  } catch (error) {
    console.error('💥 Erro geral no webhook:', error);
    
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: 'Erro interno do servidor',
        details: (error as Error).message 
      }),
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );
  }
});