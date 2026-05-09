// Cria um evento no Google Calendar de uma integração + opcional Google Meet
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
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

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
  return { access_token: json.access_token as string, expires_in: json.expires_in as number };
}

async function ensureToken(admin: any, integ: any) {
  const expiresAt = integ.oauth_token_expires_at ? new Date(integ.oauth_token_expires_at).getTime() : 0;
  if (integ.oauth_access_token && expiresAt - Date.now() > 60_000) return integ.oauth_access_token;
  if (!integ.oauth_refresh_token) throw new Error('no_refresh_token');
  const fresh = await refreshAccessToken(integ.oauth_refresh_token);
  const newExpiresAt = new Date(Date.now() + fresh.expires_in * 1000).toISOString();
  await admin
    .from('calendar_integrations')
    .update({ oauth_access_token: fresh.access_token, oauth_token_expires_at: newExpiresAt })
    .eq('id', integ.id);
  return fresh.access_token;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  try {
    // Auth do usuário (precisa estar logado)
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Não autenticado');
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) throw new Error('Sessão inválida');

    const body = await req.json();
    const {
      integration_id,
      title,
      description,
      location,
      starts_at, // ISO
      ends_at,   // ISO
      attendees, // string[] de emails
      create_meet, // boolean
      reminders, // Array<{method:'popup'|'email', minutes:number}>
    } = body || {};

    if (!integration_id || !title || !starts_at || !ends_at) {
      throw new Error('Campos obrigatórios: integration_id, title, starts_at, ends_at');
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // Buscar integração
    const { data: integ, error: integErr } = await admin
      .from('calendar_integrations')
      .select('id, scope, owner_user_id, external_calendar_id, oauth_access_token, oauth_refresh_token, oauth_token_expires_at, is_active')
      .eq('id', integration_id)
      .maybeSingle();

    if (integErr || !integ) throw new Error('Integração não encontrada');
    if (!integ.is_active) throw new Error('Integração desativada');
    if (!integ.oauth_refresh_token) throw new Error('Integração sem token. Reconecte a agenda.');

    // Permissão: pessoal só dono; global qualquer um autenticado
    if (integ.scope === 'personal' && integ.owner_user_id !== user.id) {
      throw new Error('Sem permissão para criar nesta agenda pessoal');
    }

    const accessToken = await ensureToken(admin, integ);
    const calendarId = integ.external_calendar_id || 'primary';

    // Monta evento
    const eventBody: any = {
      summary: title,
      description: description || undefined,
      location: location || undefined,
      start: { dateTime: new Date(starts_at).toISOString(), timeZone: 'America/Sao_Paulo' },
      end: { dateTime: new Date(ends_at).toISOString(), timeZone: 'America/Sao_Paulo' },
    };
    if (Array.isArray(attendees) && attendees.length > 0) {
      eventBody.attendees = attendees
        .filter((e: any) => typeof e === 'string' && e.includes('@'))
        .map((email: string) => ({ email }));
    }
    if (Array.isArray(reminders)) {
      const overrides = reminders
        .filter((r: any) => r && (r.method === 'popup' || r.method === 'email') && Number.isFinite(Number(r.minutes)))
        .slice(0, 5)
        .map((r: any) => ({ method: r.method, minutes: Number(r.minutes) }));
      eventBody.reminders = { useDefault: false, overrides };
    }
    if (create_meet) {
      eventBody.conferenceData = {
        createRequest: {
          requestId: `meet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      };
    }

    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
    if (create_meet) url.searchParams.set('conferenceDataVersion', '1');
    url.searchParams.set('sendUpdates', 'all');

    const gRes = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(eventBody),
    });
    const gJson = await gRes.json();
    if (!gRes.ok) throw new Error(`google_create_failed: ${JSON.stringify(gJson)}`);

    // Cache local
    const allDay = !!gJson.start?.date;
    const startsIso = allDay
      ? new Date(`${gJson.start.date}T00:00:00`).toISOString()
      : new Date(gJson.start.dateTime).toISOString();
    const endsIso = allDay
      ? new Date(`${gJson.end.date}T00:00:00`).toISOString()
      : new Date(gJson.end.dateTime).toISOString();

    await admin.from('calendar_events_cache').upsert({
      integration_id: integ.id,
      external_event_id: gJson.id,
      title: gJson.summary || '(sem título)',
      description: gJson.description ?? null,
      location: gJson.location ?? null,
      starts_at: startsIso,
      ends_at: endsIso,
      all_day: allDay,
      attendees: gJson.attendees ?? null,
      meeting_link: gJson.hangoutLink || gJson.conferenceData?.entryPoints?.[0]?.uri || null,
      raw: gJson,
    }, { onConflict: 'integration_id,external_event_id' });

    return new Response(JSON.stringify({
      success: true,
      event: {
        id: gJson.id,
        htmlLink: gJson.htmlLink,
        meetLink: gJson.hangoutLink || gJson.conferenceData?.entryPoints?.[0]?.uri || null,
      },
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('create-event error', e);
    return new Response(JSON.stringify({ success: false, error: (e as Error).message }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
