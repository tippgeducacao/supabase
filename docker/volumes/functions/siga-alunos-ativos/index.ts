// Proxy seguro para o webhook n8n que retorna alunos ativos do SIGA.
// Evita problemas de CORS no browser e centraliza a chamada externa.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SIGA_WEBHOOK_URL = 'https://auto.ppgeducacao.site/webhook/busca-alunos-siga';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const upstream = await fetch(SIGA_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    const text = await upstream.text();

    if (!upstream.ok) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Upstream HTTP ${upstream.status}`,
          body: text.slice(0, 500),
        }),
        {
          status: 502,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    let alunos: unknown[] = [];
    try {
      const parsed = JSON.parse(text);
      alunos = Array.isArray(parsed) ? parsed : [];
    } catch (_e) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Resposta upstream não é JSON válido',
          body: text.slice(0, 500),
        }),
        {
          status: 502,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        total: alunos.length,
        alunos,
        fetched_at: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erro desconhecido';
    console.error('siga-alunos-ativos error:', message);
    return new Response(
      JSON.stringify({ success: false, error: message }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }
});
