// Google Calendar sync: fetches events for active integrations and upserts into calendar_events_cache
// Body: { integration_id?: string }  -> if omitted, syncs all active integrations with tokens

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const CLIENT_ID = Deno.env.get('GOOGLE_CALENDAR_CLIENT_ID')!;
const CLIENT_SECRET = Deno.env.get('GOOGLE_CALENDAR_CLIENT_SECRET')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

interface Integration {
  id: string;
  external_calendar_id: string | null;
  oauth_access_token: string | null;
  oauth_refresh_token: string | null;
  oauth_token_expires_at: string | null;
  account_email?: string | null;
  owner_user_id?: string | null;
  scope?: string | null;
  is_primary?: boolean | null;
}

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

async function discoverSubCalendars(admin: any, integ: Integration, accessToken: string) {
  if (!integ.account_email) return;
  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader',
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const json = await res.json();
  if (!res.ok) {
    console.error('calendarList failed', json);
    return;
  }
  const items: Array<{ id: string; summary: string; backgroundColor?: string; primary?: boolean }> =
    Array.isArray(json?.items) ? json.items : [];
  if (items.length === 0) return;

  const primaryItem = items.find(i => i.primary) ?? items[0];
  const primaryId = primaryItem?.id ?? 'primary';

  // Atualiza esta integração como primary se ainda não foi marcada
  if (!integ.is_primary || integ.external_calendar_id !== primaryId) {
    await admin
      .from('calendar_integrations')
      .update({
        is_primary: true,
        external_calendar_id: primaryId,
        display_name: primaryItem?.summary ?? 'Principal',
        color: primaryItem?.backgroundColor ?? undefined,
      })
      .eq('id', integ.id);
    integ.external_calendar_id = primaryId;
    integ.is_primary = true;
  }

  // Insere/atualiza sub-agendas (selected=false por padrão)
  const subs = items.filter(i => i.id !== primaryId).map(i => ({
    owner_user_id: integ.owner_user_id,
    scope: integ.scope ?? 'personal',
    provider: 'google',
    account_email: integ.account_email,
    external_calendar_id: i.id,
    display_name: i.summary || i.id,
    color: i.backgroundColor || '#7C3AED',
    oauth_access_token: accessToken,
    oauth_refresh_token: integ.oauth_refresh_token,
    oauth_token_expires_at: integ.oauth_token_expires_at,
    is_primary: false,
    selected: false,
    is_active: true,
  }));

  if (subs.length > 0) {
    try {
      await upsertCalendarIntegrations(admin, subs);
    } catch (error) {
      console.error('upsert sub-calendars failed', error);
    }
  }
}

async function refreshAccessToken(refreshToken: string) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`refresh_failed: ${JSON.stringify(json)}`);
  return {
    access_token: json.access_token as string,
    expires_in: json.expires_in as number,
  };
}

async function ensureToken(admin: any, integ: Integration) {
  const expiresAt = integ.oauth_token_expires_at ? new Date(integ.oauth_token_expires_at).getTime() : 0;
  const now = Date.now();
  if (integ.oauth_access_token && expiresAt - now > 60_000) {
    return integ.oauth_access_token;
  }
  if (!integ.oauth_refresh_token) throw new Error('no_refresh_token');
  const fresh = await refreshAccessToken(integ.oauth_refresh_token);
  const newExpiresAt = new Date(Date.now() + fresh.expires_in * 1000).toISOString();
  await admin
    .from('calendar_integrations')
    .update({ oauth_access_token: fresh.access_token, oauth_token_expires_at: newExpiresAt })
    .eq('id', integ.id);
  return fresh.access_token;
}

async function syncIntegration(admin: any, integ: Integration) {
  const accessToken = await ensureToken(admin, integ);

  // Se esta integração for a primary (ou ainda não diferenciada), descobre sub-agendas
  if (integ.is_primary || !integ.external_calendar_id || integ.external_calendar_id === 'primary') {
    try {
      await discoverSubCalendars(admin, integ, accessToken);
    } catch (e) {
      console.error('discoverSubCalendars error', e);
    }
  }

  const calendarId = integ.external_calendar_id || 'primary';

  // Fetch events from 30 days ago to 180 days ahead
  const timeMin = new Date(Date.now() - 30 * 86400_000).toISOString();
  const timeMax = new Date(Date.now() + 180 * 86400_000).toISOString();

  const events: any[] = [];
  let pageToken: string | undefined = undefined;

  do {
    const u = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
    u.searchParams.set('timeMin', timeMin);
    u.searchParams.set('timeMax', timeMax);
    u.searchParams.set('singleEvents', 'true');
    u.searchParams.set('orderBy', 'startTime');
    u.searchParams.set('maxResults', '250');
    if (pageToken) u.searchParams.set('pageToken', pageToken);

    const res = await fetch(u.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    const json = await res.json();
    if (!res.ok) throw new Error(`events_fetch_failed: ${JSON.stringify(json)}`);
    events.push(...(json.items || []));
    pageToken = json.nextPageToken;
  } while (pageToken);

  // Upsert into cache
  let upserted = 0;
  for (const ev of events) {
    if (ev.status === 'cancelled') continue;
    const allDay = !!ev.start?.date;
    const startsAt = allDay
      ? new Date(`${ev.start.date}T00:00:00`).toISOString()
      : new Date(ev.start.dateTime).toISOString();
    const endsAt = allDay
      ? new Date(`${ev.end.date}T00:00:00`).toISOString()
      : new Date(ev.end.dateTime).toISOString();

    const row = {
      integration_id: integ.id,
      external_event_id: ev.id,
      title: ev.summary || '(sem título)',
      description: ev.description ?? null,
      location: ev.location ?? null,
      starts_at: startsAt,
      ends_at: endsAt,
      all_day: allDay,
      attendees: ev.attendees ?? null,
      meeting_link: ev.hangoutLink || ev.conferenceData?.entryPoints?.[0]?.uri || null,
      raw: ev,
    };

    const { error } = await admin
      .from('calendar_events_cache')
      .upsert(row, { onConflict: 'integration_id,external_event_id' });
    if (error) console.error('upsert failed', error, row.external_event_id);
    else upserted++;
  }

  // Mark synced
  await admin
    .from('calendar_integrations')
    .update({ last_synced_at: new Date().toISOString() })
    .eq('id', integ.id);

  return { events: events.length, upserted };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  let integrationId: string | undefined;
  try {
    const body = await req.json().catch(() => ({}));
    integrationId = body.integration_id;
  } catch { /* ignore */ }

  // Quando integration_id é informado, sincroniza ela + todas as sub-agendas
  // SELECTED da mesma conta (mesmo owner_user_id e account_email).
  let toSync: Integration[] = [];

  if (integrationId) {
    const { data: base, error: bErr } = await admin
      .from('calendar_integrations')
      .select('id, external_calendar_id, oauth_access_token, oauth_refresh_token, oauth_token_expires_at, owner_user_id, account_email, scope, is_primary')
      .eq('id', integrationId)
      .maybeSingle();
    if (bErr || !base) {
      return new Response(JSON.stringify({ error: bErr?.message || 'not_found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    toSync.push(base as Integration);

    // Demais sub-agendas SELECTED da mesma conta
    const { data: siblings } = await admin
      .from('calendar_integrations')
      .select('id, external_calendar_id, oauth_access_token, oauth_refresh_token, oauth_token_expires_at, account_email, owner_user_id, scope, is_primary')
      .eq('is_active', true)
      .eq('selected', true)
      .eq('account_email', (base as any).account_email)
      .eq('owner_user_id', (base as any).owner_user_id)
      .neq('id', integrationId)
      .not('oauth_refresh_token', 'is', null);
    toSync.push(...((siblings ?? []) as Integration[]));
  } else {
    const { data, error } = await admin
      .from('calendar_integrations')
      .select('id, external_calendar_id, oauth_access_token, oauth_refresh_token, oauth_token_expires_at, account_email, owner_user_id, scope, is_primary')
      .eq('is_active', true)
      .eq('selected', true)
      .not('oauth_refresh_token', 'is', null);
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    toSync = (data ?? []) as Integration[];
  }

  const integrations = toSync;

  const results: any[] = [];
  for (const integ of (integrations ?? []) as Integration[]) {
    try {
      const r = await syncIntegration(admin, integ);
      results.push({ integration_id: integ.id, ok: true, ...r });
    } catch (e) {
      console.error('sync error', integ.id, e);
      results.push({ integration_id: integ.id, ok: false, error: (e as Error).message });
    }
  }

  return new Response(JSON.stringify({ results }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
