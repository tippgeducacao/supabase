// Google Calendar do dono via service_role: refresh de token + events.list + events.insert
// (com Meet + convidados). Replica o padrão de google-calendar-create-event/sync, mas resolve
// a integração por ID (não por JWT), porque o assistente roda server-side.

const CLIENT_ID = Deno.env.get("GOOGLE_CALENDAR_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("GOOGLE_CALENDAR_CLIENT_SECRET")!;

async function refreshAccessToken(refreshToken: string) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      refresh_token: refreshToken, grant_type: "refresh_token",
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`refresh_falhou: ${JSON.stringify(json).slice(0, 200)}`);
  return { access_token: json.access_token as string, expires_in: json.expires_in as number };
}

async function carregarInteg(admin: any, id: string) {
  const { data } = await admin
    .from("calendar_integrations")
    .select("id, external_calendar_id, oauth_access_token, oauth_refresh_token, oauth_token_expires_at, is_active")
    .eq("id", id)
    .maybeSingle();
  if (!data) throw new Error("integração de agenda não encontrada");
  if (!data.is_active) throw new Error("integração de agenda desativada");
  if (!data.oauth_refresh_token) throw new Error("agenda sem token — reconecte o Google");
  return data;
}

async function ensureToken(admin: any, integ: any): Promise<string> {
  const expiresAt = integ.oauth_token_expires_at ? new Date(integ.oauth_token_expires_at).getTime() : 0;
  if (integ.oauth_access_token && expiresAt - Date.now() > 60_000) return integ.oauth_access_token;
  const fresh = await refreshAccessToken(integ.oauth_refresh_token);
  const novo = new Date(Date.now() + fresh.expires_in * 1000).toISOString();
  await admin.from("calendar_integrations")
    .update({ oauth_access_token: fresh.access_token, oauth_token_expires_at: novo })
    .eq("id", integ.id);
  return fresh.access_token;
}

export async function listarEventos(admin: any, integrationId: string, timeMinIso: string, timeMaxIso: string) {
  const integ = await carregarInteg(admin, integrationId);
  const token = await ensureToken(admin, integ);
  const calendarId = integ.external_calendar_id || "primary";
  const u = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  u.searchParams.set("timeMin", timeMinIso);
  u.searchParams.set("timeMax", timeMaxIso);
  u.searchParams.set("singleEvents", "true");
  u.searchParams.set("orderBy", "startTime");
  u.searchParams.set("maxResults", "50");

  const res = await fetch(u.toString(), { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json();
  if (!res.ok) throw new Error(`agenda_list_falhou: ${JSON.stringify(json).slice(0, 200)}`);
  return (json.items ?? [])
    .filter((e: any) => e.status !== "cancelled")
    .map((e: any) => ({
      titulo: e.summary || "(sem título)",
      inicio: e.start?.dateTime || e.start?.date,
      fim: e.end?.dateTime || e.end?.date,
      dia_inteiro: !!e.start?.date,
      local: e.location ?? null,
      meet: e.hangoutLink || e.conferenceData?.entryPoints?.[0]?.uri || null,
      convidados: (e.attendees ?? []).map((a: any) => a.email).filter(Boolean),
    }));
}

export async function criarReuniao(
  admin: any,
  integrationId: string,
  o: { titulo: string; inicioIso: string; fimIso: string; convidados?: string[]; descricao?: string; criar_meet?: boolean },
) {
  const integ = await carregarInteg(admin, integrationId);
  const token = await ensureToken(admin, integ);
  const calendarId = integ.external_calendar_id || "primary";
  const meet = o.criar_meet !== false;

  const body: any = {
    summary: o.titulo,
    description: o.descricao || undefined,
    start: { dateTime: new Date(o.inicioIso).toISOString(), timeZone: "America/Sao_Paulo" },
    end: { dateTime: new Date(o.fimIso).toISOString(), timeZone: "America/Sao_Paulo" },
  };
  const convidados = (o.convidados ?? []).filter((e) => typeof e === "string" && e.includes("@"));
  if (convidados.length) body.attendees = convidados.map((email) => ({ email }));
  if (meet) {
    body.conferenceData = {
      createRequest: {
        requestId: `meet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    };
  }

  const u = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  if (meet) u.searchParams.set("conferenceDataVersion", "1");
  u.searchParams.set("sendUpdates", "all"); // dispara o convite por e-mail

  const res = await fetch(u.toString(), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`agenda_criar_falhou: ${JSON.stringify(json).slice(0, 200)}`);
  return {
    id: json.id,
    htmlLink: json.htmlLink,
    meetLink: json.hangoutLink || json.conferenceData?.entryPoints?.[0]?.uri || null,
  };
}
