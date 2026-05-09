import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface LogActivityRequest {
  action_type: 'login' | 'logout' | 'upload' | 'download' | 'error' | 'permission_denied';
  action_category: string;
  entity_type?: string;
  entity_id?: string;
  entity_name?: string;
  description: string;
  details?: Record<string, unknown>;
  severity?: 'info' | 'warning' | 'critical';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  console.log('[log-activity] Request received');

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      console.log('[log-activity] Missing authorization header — skipping log');
      return new Response(
        JSON.stringify({ success: false, skipped: true, reason: 'no_auth' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const [scheme, token] = authHeader.split(' ');
    if (scheme !== 'Bearer' || !token) {
      console.log('[log-activity] Invalid authorization header format — skipping log');
      return new Response(
        JSON.stringify({ success: false, skipped: true, reason: 'bad_auth' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userError } = await userClient.auth.getUser(token);

    if (userError || !userData?.user) {
      // Token revogado/expirado (ex.: chamada disparada durante logout). Não
      // queremos quebrar a UI nem retornar 401 — apenas pular o log.
      console.warn('[log-activity] Token inválido/expirado — skipping log:', userError?.message);
      return new Response(
        JSON.stringify({ success: false, skipped: true, reason: 'invalid_token' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const user = { id: userData.user.id, email: userData.user.email ?? '' };

    const body: LogActivityRequest = await req.json();

    const ipAddress = req.headers.get('x-forwarded-for') ||
                      req.headers.get('x-real-ip') ||
                      req.headers.get('cf-connecting-ip') ||
                      'unknown';
    const userAgent = req.headers.get('user-agent') || 'unknown';

    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

    const { data: profile } = await serviceClient
      .from('profiles')
      .select('name, email, user_type')
      .eq('id', user.id)
      .single();

    const { error: insertError } = await serviceClient
      .from('user_activity_logs')
      .insert({
        user_id: user.id,
        user_name: profile?.name || user.email,
        user_email: profile?.email || user.email,
        user_type: profile?.user_type || 'unknown',
        action_type: body.action_type,
        action_category: body.action_category,
        entity_type: body.entity_type,
        entity_id: body.entity_id,
        entity_name: body.entity_name,
        description: body.description,
        new_values: body.details ? body.details : null,
        ip_address: ipAddress,
        user_agent: userAgent,
        severity: body.severity || 'info',
      });

    if (insertError) {
      console.error('[log-activity] Insert error:', insertError);
      return new Response(
        JSON.stringify({ error: 'Failed to process request' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[log-activity] Logged: ${body.action_type} - ${body.description} by ${profile?.name || user.email}`);

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[log-activity] Error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
