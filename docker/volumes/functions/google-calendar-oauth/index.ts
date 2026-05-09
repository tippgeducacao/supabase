// Google Calendar OAuth: start + callback
// - GET ?action=start&integration_id=...  -> redirect to Google
// - GET /callback?code=...&state=...      -> exchange code, store tokens, close popup

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const CLIENT_ID = Deno.env.get('GOOGLE_CALENDAR_CLIENT_ID')!;
const CLIENT_SECRET = Deno.env.get('GOOGLE_CALENDAR_CLIENT_SECRET')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/google-calendar-oauth/callback`;
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
].join(' ');

async function upsertCalendarIntegrations(
  admin: ReturnType<typeof createClient>,
  rows: Array<Record<string, unknown>>,
) {
  for (const row of rows) {
    const ownerUserId = (row.owner_user_id as string | null | undefined) ?? null;
    const accountEmail = row.account_email as string | undefined;
    const externalCalendarId = row.external_calendar_id as string | undefined;

    if (!accountEmail || !externalCalendarId) continue;

    let lookup = admin
      .from('calendar_integrations')
      .select('id')
      .eq('account_email', accountEmail)
      .eq('external_calendar_id', externalCalendarId)
      .limit(1);

    lookup = ownerUserId
      ? lookup.eq('owner_user_id', ownerUserId)
      : lookup.is('owner_user_id', null);

    const { data: existing, error: lookupError } = await lookup;
    if (lookupError) throw lookupError;

    if (existing?.[0]?.id) {
      const { error: updateError } = await admin
        .from('calendar_integrations')
        .update(row)
        .eq('id', existing[0].id);
      if (updateError) throw updateError;
    } else {
      const { error: insertError } = await admin
        .from('calendar_integrations')
        .insert(row);
      if (insertError) throw insertError;
    }
  }
}

function htmlResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const url = new URL(req.url);
  const path = url.pathname.split('/').pop();

  try {
    // ---- START ----
    if (path !== 'callback') {
      const action = url.searchParams.get('action');
      if (action !== 'start') {
        return jsonResponse({ error: 'invalid_action' }, 400);
      }

      // Auth user
      const authHeader = req.headers.get('Authorization');
      if (!authHeader?.startsWith('Bearer ')) return jsonResponse({ error: 'unauthorized' }, 401);
      const userClient = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: userData, error: cErr } = await userClient.auth.getUser();
      if (cErr || !userData?.user?.id) return jsonResponse({ error: 'unauthorized' }, 401);
      const userId = userData.user.id;

      const integrationId = url.searchParams.get('integration_id');
      if (!integrationId) return jsonResponse({ error: 'missing integration_id' }, 400);

      // state = base64({ integration_id, user_id, nonce })
      const state = btoa(JSON.stringify({
        i: integrationId,
        u: userId,
        n: crypto.randomUUID(),
      }));

      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', CLIENT_ID);
      authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', SCOPES);
      authUrl.searchParams.set('access_type', 'offline');
      authUrl.searchParams.set('prompt', 'consent');
      authUrl.searchParams.set('include_granted_scopes', 'true');
      authUrl.searchParams.set('state', state);

      return jsonResponse({ url: authUrl.toString() });
    }

    // ---- CALLBACK ----
    const code = url.searchParams.get('code');
    const stateRaw = url.searchParams.get('state');
    const errorParam = url.searchParams.get('error');

    if (errorParam) {
      return htmlResponse(closePopupHtml(false, errorParam));
    }
    if (!code || !stateRaw) return htmlResponse(closePopupHtml(false, 'missing_code_or_state'), 400);

    let state: { i: string; u: string };
    try {
      state = JSON.parse(atob(stateRaw));
    } catch {
      return htmlResponse(closePopupHtml(false, 'invalid_state'), 400);
    }

    // Exchange code -> tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error('token exchange failed', tokenJson);
      return htmlResponse(closePopupHtml(false, tokenJson.error || 'token_exchange_failed'), 400);
    }

    const { access_token, refresh_token, expires_in } = tokenJson;

    // Get user email
    const uiRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const uiJson = await uiRes.json();
    const accountEmail = uiJson.email as string | undefined;

    const expiresAt = new Date(Date.now() + (expires_in ?? 3600) * 1000).toISOString();

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // Buscar TODAS as sub-agendas da conta Google (calendarList)
    const listRes = await fetch(
      'https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader',
      { headers: { Authorization: `Bearer ${access_token}` } },
    );
    const listJson = await listRes.json();
    const items: Array<{
      id: string;
      summary: string;
      backgroundColor?: string;
      primary?: boolean;
      accessRole?: string;
    }> = Array.isArray(listJson?.items) ? listJson.items : [];

    // Carrega a integration original (para owner_user_id, scope, etc)
    const { data: baseInteg } = await admin
      .from('calendar_integrations')
      .select('*')
      .eq('id', state.i)
      .maybeSingle();

    if (!baseInteg) {
      return htmlResponse(closePopupHtml(false, 'integration_not_found'), 404);
    }

    // Identifica primary
    const primaryItem = items.find(i => i.primary) ?? items[0];
    const primaryId = primaryItem?.id ?? 'primary';

    // 1) Atualiza a integration original como agenda PRIMARY da conta
    const baseUpdates: Record<string, unknown> = {
      oauth_access_token: access_token,
      oauth_token_expires_at: expiresAt,
      external_calendar_id: primaryId,
      is_primary: true,
      selected: true,
    };
    if (refresh_token) baseUpdates.oauth_refresh_token = refresh_token;
    if (accountEmail) baseUpdates.account_email = accountEmail;
    if (primaryItem?.summary) baseUpdates.display_name = primaryItem.summary;
    if (primaryItem?.backgroundColor) baseUpdates.color = primaryItem.backgroundColor;

    const { error: updErr } = await admin
      .from('calendar_integrations')
      .update(baseUpdates)
      .eq('id', state.i);

    if (updErr) {
      console.error('update integration failed', updErr);
      return htmlResponse(closePopupHtml(false, updErr.message), 500);
    }

    // 2) Insere/atualiza demais sub-agendas (selected=false por padrão)
    const subItems = items.filter(i => i.id !== primaryId);
    if (subItems.length > 0 && accountEmail) {
      const rows = subItems.map(i => ({
        owner_user_id: baseInteg.owner_user_id,
        scope: baseInteg.scope,
        account_email: accountEmail,
        external_calendar_id: i.id,
        display_name: i.summary || i.id,
        color: i.backgroundColor || '#7C3AED',
        oauth_access_token: access_token,
        oauth_refresh_token: refresh_token ?? baseInteg.oauth_refresh_token,
        oauth_token_expires_at: expiresAt,
        is_primary: false,
        selected: false,
      }));

      const { error: deactivateErr } = await admin
        .from('calendar_integrations')
        .update({ is_active: false, selected: false })
        .eq('account_email', accountEmail)
        .eq('owner_user_id', baseInteg.owner_user_id)
        .neq('id', state.i)
        .not('external_calendar_id', 'is', null)
        .not('external_calendar_id', 'in', `(${subItems.map(i => JSON.stringify(i.id)).join(',')})`);

      if (deactivateErr) {
        console.error('deactivate stale sub-calendars failed', deactivateErr);
      }

      try {
        await upsertCalendarIntegrations(admin, rows);
      } catch (subErr) {
        console.error('insert sub-calendars failed', subErr);
      }
    }

    // Trigger first sync (non-blocking) – sync da primary
    fetch(`${SUPABASE_URL}/functions/v1/google-calendar-sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SERVICE_ROLE}`,
      },
      body: JSON.stringify({ integration_id: state.i }),
    }).catch((e) => console.error('initial sync failed', e));

    return htmlResponse(closePopupHtml(true));
  } catch (e) {
    console.error('oauth error', e);
    return htmlResponse(closePopupHtml(false, (e as Error).message), 500);
  }
});

function closePopupHtml(success: boolean, error?: string) {
  const payload = JSON.stringify({ source: 'google-calendar-oauth', success, error });
  // Send postMessage immediately, then close popup quickly to avoid racing with parent re-render
  return `<!doctype html><html><head><meta charset="utf-8"><title>${success ? 'Conectado' : 'Erro'}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0b0b0c;color:#fff;text-align:center;padding:20px}</style>
</head><body>
<div>
<h2>${success ? '✅ Agenda conectada!' : '❌ Falha na conexão'}</h2>
<p>${success ? 'Pode fechar esta janela...' : (error || 'Tente novamente.')}</p>
</div>
<script>
(function(){
  var payload = ${payload};
  function send(target){ try { target && target.postMessage(payload, '*'); } catch(e){} }
  // Send to opener and any potential parent (covers cases where popup loses opener)
  send(window.opener);
  send(window.parent);
  // Close quickly so parent's re-render after success is not racing with this window
  setTimeout(function(){ try { window.close(); } catch(e){} }, 80);
})();
</script>
</body></html>`;
}
