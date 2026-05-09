import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
}

// Função para normalizar WhatsApp removendo duplicação literal de +55
const normalizeWhatsApp = (phone: string | null): string | null => {
  if (!phone || typeof phone !== 'string') return null;
  
  let normalized = phone.trim();
  
  // PRIMEIRO: Detectar duplicação literal ANTES de remover caracteres
  // Procurar padrões como: +55+55, +55 +55, +55-+55
  const duplicatePattern = /^\+55[\s\-]*\+55/i;
  
  if (duplicatePattern.test(normalized)) {
    // Remover o segundo +55
    normalized = normalized.replace(/^\+55[\s\-]*\+55/i, '+55');
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
  } else if (digitsOnly.length > 0) {
    // Outros formatos
    normalized = '+' + digitsOnly;
  } else {
    return null;
  }
  
  return normalized;
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    console.log('🔧 Iniciando correção de números com +55 duplicado...');

    // Buscar leads com WhatsApp contendo padrões problemáticos
    const { data: leads, error: fetchError } = await supabase
      .from('leads')
      .select('id, whatsapp')
      .or('whatsapp.like.%5555%,whatsapp.like.%+55+55%')
      .limit(1000);

    if (fetchError) {
      console.error('❌ Erro ao buscar leads:', fetchError);
      throw fetchError;
    }

    console.log(`📊 Total de leads encontrados: ${leads?.length || 0}`);

    let fixed = 0;
    let errors = 0;
    let skipped = 0;

    for (const lead of leads || []) {
      const normalized = normalizeWhatsApp(lead.whatsapp);
      
      if (normalized !== lead.whatsapp) {
        console.log(`🔧 Corrigindo lead ${lead.id}:`);
        console.log(`   Antes: ${lead.whatsapp}`);
        console.log(`   Depois: ${normalized}`);
        
        const { error: updateError } = await supabase
          .from('leads')
          .update({ whatsapp: normalized })
          .eq('id', lead.id);

        if (updateError) {
          console.error(`❌ Erro ao atualizar lead ${lead.id}:`, updateError);
          errors++;
        } else {
          fixed++;
        }
      } else {
        skipped++;
      }
    }

    console.log('✅ Correção finalizada!');
    console.log(`📊 Estatísticas:`);
    console.log(`   - Total analisados: ${leads?.length || 0}`);
    console.log(`   - Corrigidos: ${fixed}`);
    console.log(`   - Ignorados (já corretos): ${skipped}`);
    console.log(`   - Erros: ${errors}`);

    return new Response(
      JSON.stringify({
        success: true,
        total_leads: leads?.length || 0,
        fixed: fixed,
        skipped: skipped,
        errors: errors,
        message: `Correção finalizada. ${fixed} números corrigidos com sucesso.`
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )

  } catch (error) {
    console.error('💥 Erro crítico:', error);
    return new Response(
      JSON.stringify({ 
        error: (error as Error).message,
        success: false 
      }),
      { 
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )
  }
})