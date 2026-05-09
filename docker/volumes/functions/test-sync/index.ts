import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  console.log('🎯 Função de teste executada!');
  
  return new Response(JSON.stringify({ 
    success: true,
    message: 'Função de teste funcionando!'
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});