import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.50.3";
import { createLogger } from "../_shared/logger.ts";

const logger = createLogger("facebook-leads-webhook");

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface FacebookLeadData {
  field_data: Array<{
    name: string;
    values: string[];
  }>;
  id: string;
  created_time: string;
}

interface FacebookWebhookEntry {
  id: string;
  time: number;
  changes: Array<{
    field: string;
    value: {
      ad_id?: string;
      form_id?: string;
      leadgen_id?: string;
      created_time?: number;
      page_id?: string;
      adgroup_id?: string;
    };
  }>;
}

interface FacebookWebhookPayload {
  object: string;
  entry: FacebookWebhookEntry[];
}

// Validar assinatura do Facebook para segurança
async function validateSignature(body: string, signature: string, appSecret: string): Promise<boolean> {
  try {
    const [algorithm, hash] = signature.split('=');
    if (algorithm !== 'sha256') {
      logger.warn('Invalid signature algorithm', { algorithm });
      return false;
    }

    const encoder = new TextEncoder();
    const keyData = encoder.encode(appSecret);
    const data = encoder.encode(body);

    // Criar HMAC SHA256
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const sig = await crypto.subtle.sign('HMAC', key, data);
    const hashArray = Array.from(new Uint8Array(sig));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex === hash;
  } catch (error) {
    logger.error('Error validating signature', error);
    return false;
  }
}

// Normalizar telefone para formato brasileiro internacional
function normalizePhoneToBrazil(phone: string): string {
  // Remove todos os caracteres não numéricos
  const digitsOnly = phone.replace(/\D/g, '');
  
  // Se já começa com 55, retorna com +
  if (digitsOnly.startsWith('55')) {
    return `+${digitsOnly}`;
  }
  
  // Se tem 10 ou 11 dígitos, assume Brasil
  if (digitsOnly.length === 10 || digitsOnly.length === 11) {
    return `+55${digitsOnly}`;
  }
  
  // Caso contrário, retorna como está com +
  return `+${digitsOnly}`;
}

// Buscar detalhes do lead via Graph API
async function fetchLeadDetails(leadId: string, accessToken: string): Promise<FacebookLeadData | null> {
  try {
    const url = `https://graph.facebook.com/v21.0/${leadId}?access_token=${accessToken}`;
    const response = await fetch(url);
    
    if (!response.ok) {
      logger.error('Failed to fetch lead details from Graph API', { 
        status: response.status,
        leadId 
      });
      return null;
    }
    
    const data = await response.json();
    return data;
  } catch (error) {
    logger.error('Error fetching lead details', error, { leadId });
    return null;
  }
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const VERIFY_TOKEN = Deno.env.get('FACEBOOK_VERIFY_TOKEN');
    const APP_SECRET = Deno.env.get('FACEBOOK_APP_SECRET');
    const APP_ID = Deno.env.get('FACEBOOK_APP_ID');

    if (!VERIFY_TOKEN || !APP_SECRET || !APP_ID) {
      logger.error('Missing required environment variables');
      return new Response(
        JSON.stringify({ error: 'Server configuration error' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const url = new URL(req.url);

    // GET: Webhook Verification
    if (req.method === 'GET') {
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');

      logger.info('Webhook verification request', { mode, tokenMatch: token === VERIFY_TOKEN });

      if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        logger.info('Webhook verified successfully');
        return new Response(challenge, { 
          status: 200,
          headers: { 'Content-Type': 'text/plain' }
        });
      }

      logger.warn('Webhook verification failed', { mode, token });
      return new Response('Forbidden', { status: 403 });
    }

    // POST: Receive Lead
    if (req.method === 'POST') {
      const bodyText = await req.text();
      const signature = req.headers.get('x-hub-signature-256') || '';

      // Validar assinatura
      const isValid = await validateSignature(bodyText, signature, APP_SECRET);
      if (!isValid) {
        logger.warn('Invalid webhook signature');
        return new Response('Forbidden', { status: 403 });
      }

      const payload: FacebookWebhookPayload = JSON.parse(bodyText);
      logger.info('Received webhook payload', { 
        object: payload.object,
        entries: payload.entry?.length 
      });

      // Verificar se é um evento de leadgen
      if (payload.object !== 'page') {
        logger.warn('Unexpected webhook object type', { object: payload.object });
        return new Response('OK', { status: 200 });
      }

      // Inicializar Supabase client
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      const supabase = createClient(supabaseUrl, supabaseKey);

      // Processar cada entrada
      for (const entry of payload.entry) {
        for (const change of entry.changes) {
          if (change.field !== 'leadgen') continue;

          const leadgenId = change.value.leadgen_id;
          if (!leadgenId) {
            logger.warn('No leadgen_id in change', { change });
            continue;
          }

          logger.info('Processing lead', { leadgenId });

          // Gerar access token (Page Access Token)
          // Nota: Em produção, você deve usar um Page Access Token de longa duração
          const accessToken = `${APP_ID}|${APP_SECRET}`;

          // Buscar detalhes do lead
          const leadData = await fetchLeadDetails(leadgenId, accessToken);
          if (!leadData || !leadData.field_data) {
            logger.error('Failed to fetch lead data', { leadgenId });
            continue;
          }

          // Extrair dados do lead
          let nome = '';
          let email = '';
          let whatsapp = '';

          for (const field of leadData.field_data) {
            const value = field.values[0] || '';
            
            switch (field.name.toLowerCase()) {
              case 'full_name':
              case 'name':
              case 'nome':
                nome = value;
                break;
              case 'email':
                email = value.toLowerCase().trim();
                break;
              case 'phone_number':
              case 'phone':
              case 'telefone':
              case 'whatsapp':
                whatsapp = normalizePhoneToBrazil(value);
                break;
            }
          }

          // Validar dados obrigatórios
          if (!nome) {
            logger.error('Missing required field: nome', { leadgenId });
            continue;
          }

          // Verificar duplicatas por email ou whatsapp
          if (email || whatsapp) {
            const { data: existingLead } = await supabase
              .from('leads')
              .select('id')
              .or(`email.eq.${email},whatsapp.eq.${whatsapp}`)
              .single();

            if (existingLead) {
              logger.info('Duplicate lead detected, skipping', { 
                leadgenId, 
                email, 
                whatsapp 
              });
              continue;
            }
          }

          // Inserir lead no banco
          const { data, error } = await supabase
            .from('leads')
            .insert({
              nome,
              email: email || null,
              whatsapp: whatsapp || null,
              utm_source: 'facebook',
              utm_medium: 'lead_ads',
              utm_campaign: change.value.ad_id ? `ad_${change.value.ad_id}` : null,
              pagina_nome: 'Facebook Lead Ad',
              fonte_referencia: 'Facebook Lead Ads',
              status: 'novo',
              observacoes: `Lead capturado via Facebook Lead Ads (ID: ${leadgenId})`
            })
            .select()
            .single();

          if (error) {
            logger.error('Error inserting lead', error, { leadgenId, nome, email });
            continue;
          }

          logger.info('Lead inserted successfully', { 
            leadId: data.id, 
            nome, 
            email,
            leadgenId 
          });
        }
      }

      return new Response(
        JSON.stringify({ success: true }),
        { 
          status: 200, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    }

    return new Response('Method not allowed', { status: 405 });

  } catch (error) {
    logger.error('Webhook processing error', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );
  }
});
