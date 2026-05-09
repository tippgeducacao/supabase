
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { createLogger } from '../_shared/logger.ts'

const logger = createLogger('webhook-leads');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
}

// Simple in-memory rate limiter
const rateLimiter = new Map<string, { count: number; resetAt: number }>();
const MAX_REQUESTS = 100;
const WINDOW_MS = 60000; // 1 minute

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const ipLimit = rateLimiter.get(ip);

  if (!ipLimit || now > ipLimit.resetAt) {
    rateLimiter.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }

  if (ipLimit.count >= MAX_REQUESTS) {
    logger.warn('Rate limit exceeded', { ip: ip.substring(0, 8) });
    return false;
  }

  ipLimit.count++;
  return true;
}

serve(async (req) => {
  logger.info('Webhook called');

  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    // Rate limiting by IP
    const clientIp = req.headers.get('x-forwarded-for') || 'unknown';
    if (!checkRateLimit(clientIp)) {
      return new Response(
        JSON.stringify({ error: 'Muitas requisições. Aguarde 1 minuto.' }),
        { 
          status: 429, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      );
    }

    if (req.method !== 'POST') {
      logger.warn('Invalid method', { method: req.method });
      return new Response(
        JSON.stringify({ 
          error: 'Método não permitido', 
          method: req.method,
          expected: 'POST',
          timestamp: new Date().toISOString()
        }),
        { 
          status: 405, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    // Ler o body da requisição
    console.log('📖 Lendo body da requisição...');
    let rawBody = '';
    let body: Record<string, any> = {};

    try {
      rawBody = await req.text();
      console.log('✅ Body lido com sucesso!');
      console.log('📏 Tamanho do body:', rawBody.length, 'caracteres');
    } catch (bodyError) {
      console.error('❌ ERRO ao ler body:', bodyError);
      return new Response(
        JSON.stringify({ 
          error: 'Erro ao ler requisição',
          timestamp: new Date().toISOString()
        }),
        { 
          status: 400, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      );
    }

    if (!rawBody || rawBody.trim() === '') {
      console.log('⚠️ Body está vazio!');
      return new Response(
        JSON.stringify({ 
          error: 'Body vazio - nenhum dado foi enviado',
          timestamp: new Date().toISOString()
        }),
        { 
          status: 400, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      );
    }

    // Parsear dados JSON
    const contentType = req.headers.get('content-type') || '';
    console.log('🔍 Content-Type detectado:', contentType);
    
    try {
      if (contentType.includes('application/json')) {
        console.log('📋 Parseando como JSON...');
        body = JSON.parse(rawBody);
        console.log('✅ JSON parseado com sucesso!');
      } else if (contentType.includes('application/x-www-form-urlencoded')) {
        console.log('📋 Parseando como form-urlencoded...');
        const formData = new URLSearchParams(rawBody);
        body = Object.fromEntries(formData.entries());
        console.log('✅ Form-urlencoded parseado com sucesso!');
      } else {
        console.log('⚠️ Content-Type desconhecido, tentando JSON...');
        try {
          body = JSON.parse(rawBody);
          console.log('✅ JSON parseado (fallback)');
        } catch {
          console.log('📋 JSON falhou, tentando form-urlencoded...');
          const formData = new URLSearchParams(rawBody);
          body = Object.fromEntries(formData.entries());
          console.log('✅ Form-urlencoded parseado (fallback)');
        }
      }
    } catch (parseError) {
      console.error('❌ Erro ao parsear dados:', parseError);
      body = { 
        raw_data: rawBody, 
        parse_error: (parseError as Error).message,
        content_type: contentType
      };
    }

    console.log('🔍 DADOS RECEBIDOS:');
    console.log('- Número de campos:', Object.keys(body).length);
    console.log('- Campos disponíveis:', Object.keys(body));
    console.log('- Dados completos:', JSON.stringify(body, null, 2));

    // Criar cliente Supabase
    console.log('🔗 Criando cliente Supabase...');
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    if (!Deno.env.get('SUPABASE_URL') || !Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
      console.error('❌ ERRO: Variáveis de ambiente do Supabase não encontradas!');
      return new Response(
        JSON.stringify({ 
          error: 'Configuração do servidor incompleta',
          timestamp: new Date().toISOString()
        }),
        { 
          status: 500, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      );
    }

    // 📜 Registrar log bruto do webhook (visível apenas para ti@ppg.com)
    let webhookLogId: string | null = null;
    try {
      // Tenta extrair URL da página de várias fontes (payload + headers)
      const _pageUrl: string | null =
        body.URL || body.url || body.page_url || body.landing_url || body.landing_page ||
        body.referer || body.referrer || body.Referer || body.Referrer ||
        req.headers.get('referer') || req.headers.get('referrer') || null;

      let _pageOrigem: string | null = null;
      if (_pageUrl && typeof _pageUrl === 'string') {
        try {
          const u = new URL(_pageUrl.startsWith('http') ? _pageUrl : `https://${_pageUrl}`);
          _pageOrigem = `${u.hostname}${u.pathname}`.replace(/\/+$/, '') || u.hostname;
        } catch { _pageOrigem = _pageUrl.substring(0, 200); }
      }

      // Fallback: identifica por tipo_lead / utm_campaign / form_name quando não há URL
      if (!_pageOrigem) {
        const tipo = (body.tipo_lead || body.Tipo_Lead || body.lead_type || '').toString().trim();
        const formName = (body.form_name || body.formName || body.event_name || body.page_name || '').toString().trim();
        const camp = (body.utm_campaign || '').toString().trim();
        if (tipo) _pageOrigem = `tipo_lead: ${tipo}`;
        else if (formName) _pageOrigem = `form: ${formName}`;
        else if (camp) _pageOrigem = `campanha: ${camp}`;
        else if (body.utm_source) _pageOrigem = `utm_source: ${body.utm_source}`;
        else _pageOrigem = 'Sem identificação';
      }

      const { data: logRow } = await supabase
        .from('lead_webhook_logs')
        .insert({
          pagina_url: _pageUrl,
          pagina_origem: _pageOrigem,
          fonte_referencia: body.Referral_Source || body.utm_source || null,
          utm_source: body.utm_source || null,
          utm_medium: body.utm_medium || null,
          utm_campaign: body.utm_campaign || null,
          ip_address: body.IP_do_usuario || req.headers.get('x-forwarded-for') || null,
          content_type: contentType,
          raw_body: rawBody?.substring(0, 50000) || null,
          parsed_payload: body,
          status: 'received',
        })
        .select('id')
        .single();
      webhookLogId = logRow?.id || null;
    } catch (logErr) {
      console.warn('⚠️ Falha ao gravar lead_webhook_logs:', (logErr as Error).message);
    }


    // HELPERS PARA LIMPEZA DE PLACEHOLDERS
    const isPlaceholder = (value: string | null | undefined): boolean => {
      if (!value || typeof value !== 'string') return false;
      // Detectar placeholders como {utm_source}, {fbclid}, etc.
      return /^\{[^}]+\}$/.test(value.trim());
    };

    const clean = (value: string | null | undefined, fallback: string | null = null): string | null => {
      if (!value || typeof value !== 'string') return fallback;
      const trimmed = value.trim();
      if (isPlaceholder(trimmed) || trimmed === '') return fallback;
      return trimmed;
    };

    // Função para normalizar número de WhatsApp/telefone removendo duplicação de +55
    const normalizeWhatsApp = (phone: string | null): string | null => {
      if (!phone || typeof phone !== 'string') return null;
      
      let normalized = phone.trim();
      
      // PRIMEIRO: Detectar duplicação literal ANTES de remover caracteres
      // Procurar padrões como: +55+55, +55 +55, +55-+55
      const duplicatePattern = /^\+55[\s\-]*\+55/i;
      
      if (duplicatePattern.test(normalized)) {
        // Remover o segundo +55
        normalized = normalized.replace(/^\+55[\s\-]*\+55/i, '+55');
        console.log(`🔧 Duplicação +55 removida: ${phone} → ${normalized}`);
      }
      
      // Agora sim, remover caracteres não-numéricos
      const digitsOnly = normalized.replace(/\D/g, '');
      
      // Garantir formato consistente
      if (digitsOnly.startsWith('55') && digitsOnly.length >= 12) {
        // Número brasileiro completo com código do país
        normalized = '+' + digitsOnly;
      } else if (digitsOnly.length >= 10 && digitsOnly.length <= 11) {
        // Número brasileiro sem código do país
        normalized = '+55' + digitsOnly;
        console.log(`🔧 Código +55 adicionado: ${phone} → ${normalized}`);
      } else if (digitsOnly.length > 0) {
        // Outros formatos
        normalized = '+' + digitsOnly;
      } else {
        return null;
      }
      
      return normalized;
    };

    // Função robusta para converter UTC para timezone brasileiro
    const convertUTCToBrazilTime = (input: string): string => {
      try {
        let dateUTC: Date;

        // Padrão sem timezone explícito: YYYY-MM-DD HH:mm:ss
        const m = input.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
        if (m) {
          const [, y, mo, d, h, mi, s] = m.map(Number);
          dateUTC = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
        } else {
          // ISO com Z ou offset é reconhecido nativamente
          const parsed = new Date(input);
          if (Number.isNaN(parsed.getTime())) return input; // fallback seguro
          // Garantir que tratamos como instante em UTC
          dateUTC = new Date(parsed.toISOString());
        }

        const fmt = new Intl.DateTimeFormat('pt-BR', {
          timeZone: 'America/Sao_Paulo',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        });
        const parts = Object.fromEntries(fmt.formatToParts(dateUTC).map(p => [p.type, p.value]));
        const result = `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`;

        console.log('🕒 Data_da_conversao (original):', input);
        console.log('🕒 Data_da_conversao (America/Sao_Paulo):', result);

        return result;
      } catch (e) {
        console.error('Erro conversão timezone:', e);
        return input;
      }
    };

    // MAPEAMENTO APRIMORADO DOS DADOS DO LEAD
    console.log('🗂️ Iniciando mapeamento aprimorado dos dados...');
    
    const leadData = {
      // Nome - múltiplas variações possíveis (incluindo página /sueli)
      nome: body.Nome || body.nome || body.Name || body.NOME || body.full_name || 
            body.fullName || body.firstName || body.first_name || body.cliente || 
            body.lead_name || body.Nome_do_Lead || body['Nome'] || body['nome'] || 'Nome não informado',
      
      // Email - múltiplas variações possíveis (incluindo página /sueli)
      email: body.E_mail || body.email || body.Email || body.EMAIL || body.e_mail || 
             body.mail || body.emailAddress || body.email_address || body.E_mail_do_Lead ||
             body['E-mail'] || body['email'] || body['E_mail'] || null,
      
      // WhatsApp/Telefone - múltiplas variações possíveis (incluindo página /sueli)
      whatsapp: normalizeWhatsApp(
        body.Seu_WhatsApp || body.whatsapp || body.phone || body.telefone || 
        body.WhatsApp || body.WHATSAPP || body.celular || body.mobile || 
        body.phoneNumber || body.phone_number || body.Whatsapp_do_Lead ||
        body['Telefone'] || body['WhatsApp'] || body['Seu_WhatsApp']
      ),
      
      // Fonte de referência - PRIORIDADE: Referral_Source -> utm_source limpo -> tipo_lead -> outros
      // Fallback final só usa "GreatPages" se nenhum outro sinal existir
      fonte_referencia: clean(body.Referral_Source) || 
                       clean(body.utm_source, 'GreatPages') || 
                       body.source || body.origem || body.referrer || 
                       body.fonte || body.campaign_source || 
                       null,

      // Dispositivo
      dispositivo: body.Dispositivo || body.device || body.dispositivo || body.user_agent || 
                  body.platform || body.browser || null,
      
      // Região
      regiao: body.Regiao_do_usuario || body.Cidade_do_usuario || body.Pais_do_usuario ||
              body.region || body.regiao || body.location || body.cidade || 
              body.city || body.state || body.estado || null,
      
      // Informações da página
      pagina_id: body.Id_da_pagina || body.page_id || body.pagina_id || body.form_id ||
                 body.formId || body.Id_do_formulario || body.campaign_id || body.ad_id || null,
      // pagina_nome: prioriza a URL real da landing (URL/referer), depois nome do funil/evento
      pagina_nome: clean(body.URL) || clean(body.url) || clean(body.page_url) ||
                   clean(body.landing_url) || clean(body.landing_page) ||
                   clean(body.referer) || clean(body.referrer) ||
                   clean(body.event_name) || clean(body.page_name) || clean(body.pagina_nome) ||
                   clean(body.page_title) || clean(body.form_name) || clean(body.formName) ||
                   clean(body.campaign_name) || clean(body.ad_name) || null,
      
      // UTM Parameters - com limpeza de placeholders
      utm_source: clean(body.utm_source, 'GreatPages'),
      utm_medium: clean(body.utm_medium, 'form'),
      utm_campaign: clean(body.utm_campaign),
      utm_content: clean(body.utm_content),
      utm_term: clean(body.utm_term),
      
      // Informações técnicas
      ip_address: body.IP_do_usuario || body.ip || body.ip_address || body.client_ip || 
                 req.headers.get('x-forwarded-for') || 
                 req.headers.get('x-real-ip') || null,
      user_agent: body.user_agent || req.headers.get('user-agent') || null,
      
      // Tempo de formação
      tempo_formacao: body.Tempo_formacao || body.tempo_formacao || null,
      
      // Profissão/Área (incluindo página /sueli)
      profissao: body.Eu_sou || body.profissao || body.Profissao || body.Formacao || null,
      
      // Área de interesse (incluindo página /sueli)
      area_interesse: body.Area_de_Interesse || body.area_interesse || body.area_de_interesse || null,

      // Curso de interesse (Formulário Direto e variações)
      curso_interesse: body.curso_de_Interesse || body.curso_de_interesse || body.curso_interesse || body.Curso_de_Interesse || null,

      // Status padrão
      status: 'novo',
      
      // Observações
      observacoes: null as string | null,
    }

    // Detectar landing pages do Lovable (subdomínio.ppgvet.com.br) sem UTM → fonte = Google
    const isLovableLanding = (url: string | null | undefined): boolean => {
      if (!url || typeof url !== 'string') return false;
      try {
        const u = new URL(url.startsWith('http') ? url : `https://${url}`);
        const host = u.hostname.toLowerCase();
        if (!host.endsWith('.ppgvet.com.br')) return false;
        const sub = host.replace(/\.ppgvet\.com\.br$/, '');
        const blocked = ['www', 'app', 'sistema', 'sistemappgvet', ''];
        return !blocked.includes(sub) && !sub.includes('.');
      } catch { return false; }
    };

    const hasRealUtm =
      !!clean(body.utm_source) || !!clean(body.utm_medium) ||
      !!clean(body.utm_campaign) || !!clean(body.utm_content) ||
      !!clean(body.utm_term) || !!clean(body.fbclid) || !!clean(body.gclid);

    const pageUrl = body.URL || body.url || body.page_url || body.referer || '';

    if (isLovableLanding(pageUrl) && !hasRealUtm) {
      leadData.fonte_referencia = 'Google';
      leadData.utm_source = 'Google';
      leadData.utm_medium = 'organic';
      console.log('🟢 Landing Lovable sem UTM detectada — fonte_referencia/utm_source = Google, medium = organic');
    }

    // Detectar página /sueli (captação orgânica) e forçar fonte_referencia = 'Indicação'
    if (typeof pageUrl === 'string' && pageUrl.includes('/sueli')) {
      leadData.fonte_referencia = 'Indicação';
      console.log('🌿 Página /sueli detectada — fonte_referencia definida como Indicação (Social Selling)');
    }

    // Inferir fonte a partir do campo tipo_lead enviado pelo formulário (ex.: GreatPages,
    // SprintHub) quando não veio utm_source/Referral_Source confiável.
    // Exemplos de tipo_lead: "formulario_campanha_direta_meta", "formulario_google_ads",
    // "formulario_organico", "formulario_link_bio".
    const tipoLeadRaw = (body.tipo_lead || body.Tipo_Lead || body.lead_type || '').toString().toLowerCase();
    if (tipoLeadRaw) {
      let inferida: string | null = null;
      // PRIORIDADE 1: formulários diretos (independente do canal mencionado no sufixo).
      // Ex.: "formulario_campanha_direta_meta" -> Formulário Direto (NÃO Meta Ads)
      if (tipoLeadRaw.includes('formulario') && (tipoLeadRaw.includes('direta') || tipoLeadRaw.includes('direto'))) {
        inferida = 'Formulário Direto';
      } else if (tipoLeadRaw.includes('link') && tipoLeadRaw.includes('bio')) {
        inferida = 'Link Bio';
      } else if (tipoLeadRaw.includes('organico') || tipoLeadRaw.includes('orgânico')) {
        inferida = 'Orgânico';
      } else if (tipoLeadRaw.includes('indica')) {
        inferida = 'Indicação';
      } else if (tipoLeadRaw.includes('meta') || tipoLeadRaw.includes('facebook') || tipoLeadRaw.includes('instagram') || tipoLeadRaw.includes('fb_')) {
        inferida = 'Meta Ads';
      } else if (tipoLeadRaw.includes('google') || tipoLeadRaw.includes('gads') || tipoLeadRaw.includes('adwords')) {
        inferida = 'Google Ads';
      } else if (tipoLeadRaw.includes('tiktok')) {
        inferida = 'TikTok Ads';
      }

      if (inferida) {
        // tipo_lead é mais específico que o fallback genérico (GreatPages/SprintHub),
        // então sobrescreve quando a fonte atual é vazia OU é uma plataforma genérica.
        const atual = (leadData.fonte_referencia || '').toLowerCase();
        const generica = !atual || atual === 'greatpages' || atual === 'sprinthub';
        if (generica) {
          leadData.fonte_referencia = inferida;
          // Se não tem utm_source real, espelhar para utm_source para manter coerência
          if (!leadData.utm_source || leadData.utm_source === 'GreatPages') {
            leadData.utm_source = inferida;
          }
          console.log(`🎯 Fonte inferida via tipo_lead="${tipoLeadRaw}" -> ${inferida}`);
        }
      }
    }

    // Fallback final: se ainda não temos fonte, usar GreatPages (origem padrão dos formulários)
    if (!leadData.fonte_referencia) {
      leadData.fonte_referencia = 'GreatPages';
    }

    // Observações: priorizar campo direto da /sueli, depois montar dos extras
    const obsFromBody = body.Obervacoes_Do_Lead || body.Observacoes_Do_Lead || 
                        body.observacoes || body.Observacoes || null;
    if (obsFromBody) {
      leadData.observacoes = obsFromBody;
    }

    // Log placeholders limpos
    const placeholdersLimpos = [];
    if (isPlaceholder(body.utm_source)) placeholdersLimpos.push(`utm_source: ${body.utm_source} -> ${leadData.utm_source}`);
    if (isPlaceholder(body.utm_medium)) placeholdersLimpos.push(`utm_medium: ${body.utm_medium} -> ${leadData.utm_medium}`);
    if (isPlaceholder(body.utm_campaign)) placeholdersLimpos.push(`utm_campaign: ${body.utm_campaign} -> ${leadData.utm_campaign}`);
    if (isPlaceholder(body.utm_content)) placeholdersLimpos.push(`utm_content: ${body.utm_content} -> ${leadData.utm_content}`);
    if (isPlaceholder(body.utm_term)) placeholdersLimpos.push(`utm_term: ${body.utm_term} -> ${leadData.utm_term}`);
    if (isPlaceholder(body.fbclid)) placeholdersLimpos.push(`fbclid: ${body.fbclid} -> limpo`);
    if (isPlaceholder(body.gclid)) placeholdersLimpos.push(`gclid: ${body.gclid} -> limpo`);
    
    if (placeholdersLimpos.length > 0) {
      console.log('🧹 Placeholders limpos:', placeholdersLimpos);
    }

    // Adicionar campos personalizados extras às observações
    const camposExtras = [];
    
    // Políticas de privacidade
    if (body.Politicas_de_privacidade !== undefined) {
      camposExtras.push(`Aceitou Políticas: ${body.Politicas_de_privacidade ? 'Sim' : 'Não'}`);
    }
    
    // Data da conversão (com conversão de timezone para horário brasileiro)
    const dataConversaoRaw = body.Data_da_conversao || body.data_da_conversao || body.data_conversao || body.Data_conversao;
    if (dataConversaoRaw) {
      camposExtras.push(`Data Conversão: ${convertUTCToBrazilTime(dataConversaoRaw)}`);
    }
    
    // IDs de tracking - com limpeza de placeholders
    if (body.fbclid && !isPlaceholder(body.fbclid)) {
      camposExtras.push(`Facebook Click ID: ${body.fbclid}`);
    }
    
    if (body.gclid && !isPlaceholder(body.gclid)) {
      camposExtras.push(`Google Click ID: ${body.gclid}`);
    }
    
    // Adicionar campos extras às observações (append se já houver obs da /sueli)
    if (camposExtras.length > 0) {
      const extrasText = camposExtras.join('\n');
      leadData.observacoes = leadData.observacoes 
        ? `${leadData.observacoes}\n${extrasText}` 
        : extrasText;
    }

    // Sanitize and enforce length limits on all string fields
    const sanitize = (val: any, maxLen: number): string | null => {
      if (val == null || typeof val !== 'string') return null;
      // Strip HTML tags to prevent XSS
      return val.replace(/<[^>]*>/g, '').trim().substring(0, maxLen) || null;
    };

    leadData.nome = sanitize(leadData.nome, 255) || 'Nome não informado';
    leadData.email = sanitize(leadData.email, 255);
    leadData.whatsapp = leadData.whatsapp ? leadData.whatsapp.substring(0, 20) : null;
    leadData.fonte_referencia = sanitize(leadData.fonte_referencia, 255);
    leadData.dispositivo = sanitize(leadData.dispositivo, 255);
    leadData.regiao = sanitize(leadData.regiao, 255);
    leadData.pagina_id = sanitize(leadData.pagina_id, 255);
    leadData.pagina_nome = sanitize(leadData.pagina_nome, 255);
    leadData.utm_source = sanitize(leadData.utm_source, 255);
    leadData.utm_medium = sanitize(leadData.utm_medium, 255);
    leadData.utm_campaign = sanitize(leadData.utm_campaign, 255);
    leadData.utm_content = sanitize(leadData.utm_content, 255);
    leadData.utm_term = sanitize(leadData.utm_term, 255);
    leadData.ip_address = sanitize(leadData.ip_address, 45);
    leadData.user_agent = sanitize(leadData.user_agent, 500);
    leadData.tempo_formacao = sanitize(leadData.tempo_formacao, 255);
    leadData.profissao = sanitize(leadData.profissao, 255);
    leadData.area_interesse = sanitize(leadData.area_interesse, 255);
    leadData.curso_interesse = sanitize(leadData.curso_interesse, 255);
    if (leadData.observacoes) {
      leadData.observacoes = sanitize(leadData.observacoes, 1000);
    }

    // Validate email format if provided
    if (leadData.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(leadData.email)) {
      leadData.email = null;
    }

    console.log('📋 DADOS DO LEAD VALIDADOS');

    // Validações críticas
    console.log('🔍 Validando dados essenciais...');
    
    if (!leadData.nome || leadData.nome === 'Nome não informado') {
      console.log('⚠️ TENTANDO ENCONTRAR NOME em qualquer campo...');
      
      // Buscar qualquer campo que possa ser um nome
      const possibleNames = Object.entries(body)
        .filter(([key, value]) => 
          typeof value === 'string' && 
          value.length > 1 && 
          value.length < 100 &&
          !key.toLowerCase().includes('email') &&
          !key.toLowerCase().includes('phone') &&
          !key.toLowerCase().includes('utm') &&
          !key.toLowerCase().includes('id') &&
          !key.toLowerCase().includes('ip')
        );
      
      console.log('🔍 Possíveis nomes encontrados:', possibleNames);
      
      if (possibleNames.length > 0) {
        leadData.nome = possibleNames[0][1];
        console.log('✅ Nome definido como:', leadData.nome);
      } else {
        console.log('⚠️ Nenhum nome válido encontrado, usando fallback');
        leadData.nome = `Lead ${new Date().toISOString()}`;
      }
    }

    console.log('💾 Iniciando lógica de deduplicação por WhatsApp...');

    let leadId: string;
    let isNewLead = false;
    let criouOportunidade = false;
    let motivo = 'lead_existente';

    // 1. Buscar lead existente pelo WhatsApp normalizado
    let existingLead = null;
    if (leadData.whatsapp) {
      const { data: found } = await supabase
        .from('leads')
        .select('*')
        .eq('whatsapp', leadData.whatsapp)
        .neq('status', 'mesclado')
        .order('created_at', { ascending: true })
        .limit(1)
        .single();
      existingLead = found;
    }

    if (existingLead) {
      leadId = existingLead.id;
      console.log(`🔄 Lead existente encontrado: ${leadId} (${existingLead.nome})`);

      // Atualizar dados do lead principal se houver dados novos/melhores
      const updates: Record<string, any> = {};
      if (leadData.email && !existingLead.email) updates.email = leadData.email;
      if (leadData.profissao && !existingLead.profissao) updates.profissao = leadData.profissao;
      if (leadData.area_interesse && !existingLead.area_interesse) updates.area_interesse = leadData.area_interesse;
      if (leadData.curso_interesse && !existingLead.curso_interesse) updates.curso_interesse = leadData.curso_interesse;
      if (leadData.regiao && !existingLead.regiao) updates.regiao = leadData.regiao;
      
      if (Object.keys(updates).length > 0) {
        updates.updated_at = new Date().toISOString();
        await supabase.from('leads').update(updates).eq('id', leadId);
        console.log('📝 Lead atualizado com novos dados:', Object.keys(updates));
      }

      // 2. Verificar se já existe oportunidade com mesma pagina_nome + area_interesse
      const { data: existingOpp } = await supabase
        .from('lead_oportunidades')
        .select('id')
        .eq('lead_id', leadId)
        .eq('pagina_nome', leadData.pagina_nome || '')
        .limit(1);

      const samePageOpp = existingOpp && existingOpp.length > 0;
      
      if (samePageOpp) {
        // Mesma página, mesma pessoa → duplicado
        motivo = 'duplicado_mesma_pagina';
        criouOportunidade = false;
        console.log('⏭️ Oportunidade duplicada (mesma página), não criando nova');
      } else {
        // Nova página/interesse → nova oportunidade
        motivo = 'nova_oportunidade';
        criouOportunidade = true;
        console.log('✨ Nova oportunidade identificada para lead existente');
      }
    } else {
      // 3. Lead novo → criar
      isNewLead = true;
      motivo = 'nova_oportunidade';
      criouOportunidade = true;

      const { data: newLead, error: insertError } = await supabase
        .from('leads')
        .insert([leadData])
        .select()
        .single();

      if (insertError) {
        console.error('❌ ERRO ao inserir lead:', insertError);
        return new Response(
          JSON.stringify({ error: 'Erro ao processar lead', timestamp: new Date().toISOString() }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      leadId = newLead.id;
      console.log(`🆕 Novo lead criado: ${leadId}`);
    }

    // 4. Sempre salvar o JSON completo em lead_entries
    const { data: entryData, error: entryError } = await supabase
      .from('lead_entries')
      .insert({
        lead_id: leadId,
        raw_payload: body as any,
        pagina_nome: leadData.pagina_nome,
        fonte: leadData.fonte_referencia,
        criou_oportunidade: criouOportunidade,
        motivo,
      })
      .select('id')
      .single();

    if (entryError) {
      console.error('⚠️ Erro ao salvar lead_entry:', entryError);
    } else {
      console.log(`📄 Lead entry salvo: ${entryData.id} (motivo: ${motivo})`);
    }

    // 5. Criar oportunidade se necessário
    if (criouOportunidade) {
      const { error: oppError } = await supabase
        .from('lead_oportunidades')
        .insert({
          lead_id: leadId,
          lead_entry_id: entryData?.id || null,
          pagina_nome: leadData.pagina_nome,
          area_interesse: leadData.area_interesse,
          profissao: leadData.profissao,
          utm_source: leadData.utm_source,
          utm_medium: leadData.utm_medium,
          utm_campaign: leadData.utm_campaign,
          fonte: leadData.fonte_referencia,
          status: 'ativo',
        });

      if (oppError) {
        console.error('⚠️ Erro ao criar oportunidade:', oppError);
      } else {
        console.log('🎯 Oportunidade criada com sucesso');
      }
    }

    console.log(`🎉 SUCESSO! Lead ${isNewLead ? 'criado' : 'atualizado'}: ${leadId} | Oportunidade: ${criouOportunidade ? 'SIM' : 'NÃO'} | Motivo: ${motivo}`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        lead_id: leadId,
        is_new: isNewLead,
        opportunity_created: criouOportunidade,
        motivo,
        timestamp: new Date().toISOString()
      }),
      { 
        status: 200, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )

  } catch (error) {
    console.error('💥 ERRO CRÍTICO:', error);
    
    return new Response(
      JSON.stringify({ 
        error: 'Erro interno do servidor',
        timestamp: new Date().toISOString()
      }),
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )
  }
})
