// Livre/ocupado de uma agenda Google AO VIVO (FreeBusy), pela integração do sistema.
//
// Existe porque o cache `calendar_events_cache` da agenda GLOBAL da secretaria parou de
// sincronizar em 17/08/2026 — conferir conflito por ele diria "livre" para horário em que
// ela tem compromisso. O FreeBusy do Google já respeita o que importa: evento marcado como
// "livre" (transparent), cancelado ou recusado NÃO aparece como ocupado.
//
// Uso: reuniões com professor (`professor-agenda-publica` e `reuniao-professor-google`).
// Quem chama decide o que fazer quando o Google falha (`ok: false`): o link público NÃO
// oferece vaga sem conferir; a tela interna avisa e deixa a pessoa decidir.

// deno-lint-ignore-file no-explicit-any

const CLIENT_ID = Deno.env.get('GOOGLE_CALENDAR_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('GOOGLE_CALENDAR_CLIENT_SECRET') ?? '';

export interface Intervalo {
  inicio: string;
  fim: string;
}

export type ResultadoOcupados =
  | { ok: true; ocupados: Intervalo[] }
  | { ok: false; erro: string };

/** Token de acesso válido da integração (renova pelo refresh token quando está para vencer). */
export async function tokenDeAcesso(admin: any, integ: any): Promise<string> {
  const expira = integ.oauth_token_expires_at ? new Date(integ.oauth_token_expires_at).getTime() : 0;
  if (integ.oauth_access_token && expira - Date.now() > 60_000) return integ.oauth_access_token;
  if (!integ.oauth_refresh_token) throw new Error('integracao_sem_token');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: integ.oauth_refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`token_recusado: ${j.error ?? res.status}`);
  await admin
    .from('calendar_integrations')
    .update({
      oauth_access_token: j.access_token,
      oauth_token_expires_at: new Date(Date.now() + (Number(j.expires_in) || 3600) * 1000).toISOString(),
    })
    .eq('id', integ.id);
  return j.access_token as string;
}

/** Intervalos ocupados da agenda da integração entre `de` e `ate` (ISO). */
export async function ocupadosNoGoogle(
  admin: any, integrationId: string | null, de: string, ate: string,
): Promise<ResultadoOcupados> {
  try {
    if (!integrationId) return { ok: false, erro: 'sem_integracao' };
    const { data: integ, error } = await admin
      .from('calendar_integrations')
      .select('id, is_active, external_calendar_id, oauth_access_token, oauth_refresh_token, oauth_token_expires_at')
      .eq('id', integrationId)
      .maybeSingle();
    if (error || !integ) return { ok: false, erro: 'integracao_nao_encontrada' };
    if (!integ.is_active) return { ok: false, erro: 'integracao_desativada' };

    const token = await tokenDeAcesso(admin, integ);
    const calendario = integ.external_calendar_id || 'primary';
    const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeMin: de, timeMax: ate, timeZone: 'America/Sao_Paulo', items: [{ id: calendario }] }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, erro: `freebusy_${res.status}` };
    const cal = j?.calendars?.[calendario];
    if (!cal || (Array.isArray(cal.errors) && cal.errors.length > 0)) {
      return { ok: false, erro: `freebusy_calendario: ${cal?.errors?.[0]?.reason ?? 'sem_resposta'}` };
    }
    const ocupados: Intervalo[] = (cal.busy ?? []).map((b: any) => ({ inicio: b.start, fim: b.end }));
    return { ok: true, ocupados };
  } catch (e) {
    return { ok: false, erro: e instanceof Error ? e.message : String(e) };
  }
}

/** A vaga [inicio, fim) encosta em algum ocupado? Encostar na borda (fim = início) não conta. */
export function vagaOcupada(vaga: Intervalo, ocupados: Intervalo[]): boolean {
  const a = Date.parse(vaga.inicio);
  const b = Date.parse(vaga.fim);
  return ocupados.some((o) => Date.parse(o.inicio) < b && Date.parse(o.fim) > a);
}
