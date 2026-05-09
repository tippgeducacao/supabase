// Proxy seguro para o webhook n8n que retorna faturas vencidas (em aberto) do SIGA.
// Evita CORS no browser e centraliza a chamada externa.
// Body esperado: { dataInicio: "DD-MM-YYYY", dataFim: "DD-MM-YYYY" }

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SIGA_WEBHOOK_URL = 'https://auto.ppgeducacao.site/webhook/siga-vencidos';

const DATE_RE = /^\d{2}-\d{2}-\d{4}$/;

const isValidDate = (s: unknown): s is string =>
  typeof s === 'string' && DATE_RE.test(s);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ success: false, error: 'Método não permitido' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  try {
    const body = await req.json().catch(() => null);
    const dataInicio = body?.dataInicio;
    const dataFim = body?.dataFim;

    if (!isValidDate(dataInicio) || !isValidDate(dataFim)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Parâmetros inválidos: dataInicio e dataFim devem estar no formato DD-MM-YYYY.',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const upstream = await fetch(SIGA_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataInicio, dataFim }),
    });

    const text = await upstream.text();

    if (!upstream.ok) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Upstream HTTP ${upstream.status}`,
          body: text.slice(0, 500),
        }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Resposta upstream não é JSON válido',
          body: text.slice(0, 500),
        }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Aceita formatos:
    //  1) array puro de cobranças
    //  2) { faturas|data|result: [...] }
    //  3) array/obj de "contratos" contendo `cobrancas: [...]` (formato atual do SIGA)
    let raw: unknown[] = [];
    if (Array.isArray(parsed)) {
      raw = parsed;
    } else if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.faturas)) raw = obj.faturas as unknown[];
      else if (Array.isArray(obj.data)) raw = obj.data as unknown[];
      else if (Array.isArray(obj.result)) raw = obj.result as unknown[];
      else if (Array.isArray(obj.cobrancas)) raw = [obj];
    }

    // Achata `cobrancas` quando o item é um contrato (formato real do SIGA)
    const faturas: unknown[] = [];
    for (const item of raw) {
      if (item && typeof item === 'object') {
        const it = item as Record<string, unknown>;
        if (Array.isArray(it.cobrancas) && it.cobrancas.length > 0) {
          for (const c of it.cobrancas as unknown[]) faturas.push(c);
        } else {
          faturas.push(item);
        }
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        total: faturas.length,
        faturas,
        periodo: { dataInicio, dataFim },
        fetched_at: new Date().toISOString(),
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erro desconhecido';
    console.error('siga-vencidos error:', message);
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
