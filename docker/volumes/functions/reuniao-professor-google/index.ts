import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import { ocupadosNoGoogle, tokenDeAcesso } from '../_shared/googleOcupados.ts';

/**
 * REUNIÕES COM PROFESSOR — a agenda Google da secretaria, ao vivo.
 *
 * `acao: 'ocupados'` (padrão) — só INTERVALOS ocupados (FreeBusy) da agenda da config. Usado
 * por qualquer pessoa logada que marca reunião (coluna da Secretaria, painel "Agendar
 * reunião"): tira de oferta a vaga que bate com compromisso dela. Nunca título, convidado
 * ou descrição.
 *
 * `acao: 'eventos'` (09/10/2026) — os EVENTOS, com título, das agendas Google da conta da
 * secretaria (principal, monitorias, feriados), para a tela "Reuniões com Professores" da
 * Adriane. Só para quem GERE as reuniões (`reuniao_professor_pode_gerir()`: a secretaria,
 * admin ou diretoria) — conferido com o JWT de quem chama. O cache `calendar_events_cache`
 * da secretaria parou de sincronizar em 17/08/2026, por isso a leitura é ao vivo.
 *
 * JWT conferido aqui (o runtime self-hosted não confere sozinho). Janela máxima de 120 dias
 * (ocupados) / 62 dias (eventos). A agenda é sempre a da config, nunca uma que o chamador
 * escolha.
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

interface Calendario {
  id: string;
  nome: string;
  principal: boolean;
}

/** As agendas Google da MESMA conta da agenda da config (sem repetir o mesmo calendário). */
// deno-lint-ignore no-explicit-any
async function calendariosDaSecretaria(admin: any, integrationId: string): Promise<{ integ: any; calendarios: Calendario[] } | null> {
  const { data: integ } = await admin
    .from('calendar_integrations')
    .select('id, is_active, account_email, external_calendar_id, oauth_access_token, oauth_refresh_token, oauth_token_expires_at')
    .eq('id', integrationId)
    .maybeSingle();
  if (!integ?.is_active) return null;
  const principal = integ.external_calendar_id || 'primary';
  const { data: outras } = await admin
    .from('calendar_integrations')
    .select('external_calendar_id, display_name')
    .eq('scope', 'global')
    .eq('is_active', true)
    .eq('account_email', integ.account_email)
    .not('external_calendar_id', 'is', null);
  const vistos = new Set<string>([principal]);
  // Mesmo NOME = mesma agenda para quem olha: "Feriados no Brasil" está ligada duas vezes
  // (pt e pt-br do Google) e mostraria cada feriado em dobro.
  const nomesVistos = new Set<string>();
  const calendarios: Calendario[] = [{ id: principal, nome: 'Agenda da secretaria', principal: true }];
  for (const c of (outras ?? []) as Array<{ external_calendar_id: string; display_name: string | null }>) {
    const nome = (c.display_name ?? c.external_calendar_id).trim();
    if (vistos.has(c.external_calendar_id) || nomesVistos.has(nome.toLowerCase())) continue;
    vistos.add(c.external_calendar_id);
    nomesVistos.add(nome.toLowerCase());
    calendarios.push({ id: c.external_calendar_id, nome, principal: false });
  }
  return { integ, calendarios };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const auth = req.headers.get('Authorization') ?? '';
    const jwt = auth.replace(/^Bearer\s+/i, '');
    if (!jwt) return json({ ok: false, erro: 'nao_autenticado' }, 401);
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data: u, error: erroUser } = await admin.auth.getUser(jwt);
    if (erroUser || !u?.user) return json({ ok: false, erro: 'nao_autenticado' }, 401);

    const body = await req.json().catch(() => ({}));
    const acao = String(body?.acao ?? 'ocupados');
    const de = Date.parse(String(body?.de ?? ''));
    const ate = Date.parse(String(body?.ate ?? ''));
    const limiteDias = acao === 'eventos' ? 62 : 120;
    if (Number.isNaN(de) || Number.isNaN(ate) || ate <= de || ate - de > limiteDias * 86_400_000) {
      return json({ ok: false, erro: 'periodo_invalido' }, 400);
    }

    const { data: cfg } = await admin
      .from('reuniao_professor_config').select('calendar_integration_id').eq('id', true).maybeSingle();

    if (acao === 'ocupados') {
      const r = await ocupadosNoGoogle(admin, cfg?.calendar_integration_id ?? null,
        new Date(de).toISOString(), new Date(ate).toISOString());
      if (!r.ok) console.error('[reuniao-professor-google]', r.erro);
      return json(r);
    }

    if (acao !== 'eventos') return json({ ok: false, erro: 'acao_invalida' }, 400);

    // Título dos compromissos da secretaria: só para quem gere as reuniões (regra do banco,
    // avaliada com o JWT de quem chama).
    const comoUsuario = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
    const { data: podeGerir } = await comoUsuario.rpc('reuniao_professor_pode_gerir');
    if (podeGerir !== true) return json({ ok: false, erro: 'sem_permissao' }, 403);

    if (!cfg?.calendar_integration_id) return json({ ok: false, erro: 'sem_integracao' });
    const fonte = await calendariosDaSecretaria(admin, cfg.calendar_integration_id);
    if (!fonte) return json({ ok: false, erro: 'integracao_desativada' });

    const token = await tokenDeAcesso(admin, fonte.integ);
    const eventos: unknown[] = [];
    const falhas: string[] = [];
    await Promise.all(fonte.calendarios.map(async (cal) => {
      const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events`);
      url.searchParams.set('timeMin', new Date(de).toISOString());
      url.searchParams.set('timeMax', new Date(ate).toISOString());
      url.searchParams.set('singleEvents', 'true');
      url.searchParams.set('orderBy', 'startTime');
      url.searchParams.set('maxResults', '500');
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { falhas.push(cal.id); return; }
      // deno-lint-ignore no-explicit-any
      for (const e of (j.items ?? []) as any[]) {
        if (e.status === 'cancelled') continue;
        const diaInteiro = !!e.start?.date;
        eventos.push({
          id: `${cal.id}:${e.id}`,
          calendario: cal.id,
          titulo: String(e.summary ?? '(sem título)').slice(0, 200),
          inicio: diaInteiro ? e.start.date : e.start?.dateTime,
          fim: diaInteiro ? e.end?.date : e.end?.dateTime,
          dia_inteiro: diaInteiro,
          livre: e.transparency === 'transparent',
          meet: typeof e.hangoutLink === 'string' ? e.hangoutLink : null,
          link: typeof e.htmlLink === 'string' ? e.htmlLink : null,
        });
      }
    }));
    if (falhas.length) console.error('[reuniao-professor-google] eventos: calendários que falharam', falhas);
    if (falhas.length === fonte.calendarios.length) return json({ ok: false, erro: 'google_indisponivel' });
    return json({ ok: true, calendarios: fonte.calendarios, eventos, falhas });
  } catch (e) {
    console.error('[reuniao-professor-google]', e);
    return json({ ok: false, erro: 'falhou' }, 500);
  }
});
