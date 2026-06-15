// gmail-connect-caixa: admin conecta uma caixa Gmail compartilhada a um setor
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const auth = req.headers.get('Authorization');
    if (!auth) throw new Error('not_authenticated');
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) throw new Error('not_authenticated');

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // Check admin/diretor
    const { data: roles } = await admin.from('user_roles').select('role').eq('user_id', user.id);
    const isAdmin = (roles || []).some((r: any) => r.role === 'admin' || r.role === 'diretor');
    if (!isAdmin) throw new Error('forbidden');

    const { account_email, departamento_id, nome_exibicao, extra_roles } = await req.json();
    if (!account_email || !nome_exibicao) throw new Error('campos obrigatórios: account_email, nome_exibicao');

    // Localiza integração calendar (pode haver múltiplas; escolhe a que tem escopos Gmail + refresh token)
    const { data: integrations } = await admin
      .from('calendar_integrations')
      .select('id, scopes, oauth_refresh_token, is_active, created_at')
      .eq('account_email', account_email.toLowerCase())
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (!integrations || integrations.length === 0) {
      throw new Error('Conta não autorizada. Use "Conectar nova conta Gmail" antes de cadastrar a caixa.');
    }
    const integ = integrations.find((i: any) => i.oauth_refresh_token && i.scopes && i.scopes.includes('gmail.'))
      || integrations.find((i: any) => i.oauth_refresh_token);
    if (!integ) throw new Error('Integração sem refresh token. Reautorize a conta antes de continuar.');
    if (!integ.scopes || !integ.scopes.includes('gmail.')) {
      throw new Error('Conta sem permissão de Gmail. Reautorize escolhendo "Conectar Gmail".');
    }

    const { data: caixa, error } = await admin
      .from('email_caixas_conectadas')
      .insert({
        calendar_integration_id: integ.id,
        email_caixa: account_email.toLowerCase(),
        nome_exibicao,
        departamento_id: departamento_id || null,
        created_by: user.id,
      })
      .select()
      .single();
    if (error) throw error;

    // Permissões extras
    if (Array.isArray(extra_roles) && extra_roles.length) {
      await admin.from('email_caixa_permissoes').insert(
        extra_roles.map((r: string) => ({ caixa_id: caixa.id, role: r }))
      );
    }

    // Dispara sync inicial em background
    fetch(`${SUPABASE_URL}/functions/v1/gmail-sync-inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_ROLE}` },
      body: JSON.stringify({ caixa_id: caixa.id, initial: true }),
    }).catch(e => console.error('sync trigger failed', e));

    return new Response(JSON.stringify({ success: true, caixa }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: (e as Error).message }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
