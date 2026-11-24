// Apenas responsáveis habilitados: agenda pessoal continua privada, e o B2B consome ocupação sanitizada.
// Desde 24/11/2026 também espelha, na agenda GLOBAL do vendedor (profiles.id_calendar), a reunião
// B2B que pediu convite para o lead (agendamentos.convidado_email) — tipo `convite`.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { exigirAcesso, respostaAcessoNegado, type Chamador } from '../_shared/acesso.ts';
import type { ReuniaoB2B } from './regras.ts';
import { sincronizarReunioes, type Config, type Espelho, type RepositorioSincronizacao } from './sincronizacao.ts';

const URL_SUPABASE = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const admin = createClient(URL_SUPABASE, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });

function resposta(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

async function tokenGoogle(config: Config) {
  const { data: i, error } = await admin.from('calendar_integrations')
    .select('id,owner_user_id,scope,external_calendar_id,account_email,is_active,oauth_access_token,oauth_refresh_token,oauth_token_expires_at,scopes')
    .eq('id', config.integration_id).single();
  if (config.tipo === 'convite') {
    // Agenda global do vendedor: a mesma que o Meet do agendamento já usa (google-calendar-create-event).
    if (error || !i || !i.is_active || i.scope !== 'global' || !i.external_calendar_id) {
      throw new Error('A agenda do vendedor precisa estar conectada.');
    }
  } else if (error || !i || !i.is_active || i.owner_user_id !== config.user_id || i.scope !== 'personal' ||
      !i.external_calendar_id || i.external_calendar_id !== i.account_email) {
    throw new Error('A agenda pessoal do responsável precisa estar conectada.');
  }
  const scopes = String(i.scopes || '').split(/\s+/);
  if (!scopes.some(s => ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events'].includes(s))) {
    throw new Error('Reconecte o Google autorizando o acesso ao calendário.');
  }
  if (i.oauth_access_token && new Date(i.oauth_token_expires_at).getTime() > Date.now() + 60_000) {
    return { accessToken: i.oauth_access_token as string, calendarId: i.external_calendar_id as string };
  }
  if (!i.oauth_refresh_token) throw new Error('Reconecte a agenda do responsável.');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: Deno.env.get('GOOGLE_CALENDAR_CLIENT_ID')!,
      client_secret: Deno.env.get('GOOGLE_CALENDAR_CLIENT_SECRET')!,
      refresh_token: i.oauth_refresh_token, grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(20_000),
  });
  const fresh = await res.json();
  if (!res.ok || !fresh.access_token) throw new Error('Não foi possível renovar a conexão Google do responsável.');
  // A reconexão pode acontecer enquanto o worker roda: jamais substituir um grant novo.
  const { error: updateError } = await admin.from('calendar_integrations').update({
    oauth_access_token: fresh.access_token,
    oauth_token_expires_at: new Date(Date.now() + fresh.expires_in * 1000).toISOString(),
  }).eq('id', i.id).eq('oauth_refresh_token', i.oauth_refresh_token);
  if (updateError) throw new Error('Não foi possível atualizar a conexão Google.');
  return { accessToken: fresh.access_token as string, calendarId: i.external_calendar_id as string };
}

async function google(cred: { accessToken: string; calendarId: string }, path: string, method = 'GET', body?: unknown) {
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cred.calendarId)}/events${path}`, {
    method, headers: { Authorization: `Bearer ${cred.accessToken}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25_000),
  });
  const json = res.status === 204 ? {} : await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

async function atualizarOcupacao(config: Config) {
  const iniciou = new Date();
  const res = await fetch(`${URL_SUPABASE}/functions/v1/google-calendar-sync`, {
    method: 'POST', headers: { Authorization: `Bearer ${SERVICE_ROLE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ integration_id: config.integration_id }), signal: AbortSignal.timeout(90_000),
  });
  const json = await res.json();
  const proprio = json.results?.find((r: { integration_id: string }) => r.integration_id === config.integration_id);
  if (!res.ok || !proprio?.ok || proprio.events !== proprio.upserted) {
    throw new Error('Não foi possível atualizar a disponibilidade no Google. Tente novamente.');
  }
  const { error } = await admin.from('calendar_b2b_config').update({
    busy_synced_at: new Date().toISOString(), busy_sync_error: null,
    // Margem de um minuto cobre o instante usado internamente pelo sincronizador.
    busy_inicio: new Date(iniciou.getTime() - 30 * 86400_000 + 60_000).toISOString(),
    busy_fim: new Date(iniciou.getTime() + 180 * 86400_000 - 60_000).toISOString(),
  }).eq('user_id', config.user_id).eq('integration_id', config.integration_id);
  if (error) throw new Error('Não foi possível registrar a atualização da disponibilidade.');
}

async function todos<T>(tabela: string, coluna: string, valor: string): Promise<T[]> {
  const linhas: T[] = [];
  for (let de = 0; ; de += 500) {
    const { data, error } = await admin.from(tabela).select('*').eq(coluna, valor)
      .order(tabela === 'calendar_b2b_eventos' ? 'agendamento_id' : 'id').range(de, de + 499);
    if (error) throw new Error('Não foi possível consultar as reuniões para sincronizar.');
    linhas.push(...(data || []) as T[]);
    if (!data || data.length < 500) return linhas;
  }
}

async function salvarEspelho(patch: Partial<Espelho> & { agendamento_id: string; user_id: string }) {
  const { error } = await admin.from('calendar_b2b_eventos').upsert(patch, { onConflict: 'agendamento_id,user_id' });
  if (error) throw new Error('Não foi possível registrar o vínculo da reunião com o Google.');
}


// Agenda pessoal: toda reunião B2B da pessoa. Agenda global: só as que pediram convite.
const repositorioPara = (view: 'calendar_b2b_reunioes' | 'calendar_b2b_reunioes_convite'): RepositorioSincronizacao => ({
  listarReunioes: userId => todos<ReuniaoB2B>(view, 'vendedor_id', userId),
  listarEspelhos: userId => todos<Espelho>('calendar_b2b_eventos', 'user_id', userId),
  async buscarReuniao(id, userId) {
    const { data, error } = await admin.from(view).select('*')
      .eq('id', id).eq('vendedor_id', userId).maybeSingle();
    if (error) throw new Error('Não foi possível revalidar a reunião antes de sincronizar.');
    return data as ReuniaoB2B | null;
  },
  salvarEspelho,
  async removerCache(integrationId, eventId) {
    const { error } = await admin.from('calendar_events_cache').delete()
      .eq('integration_id', integrationId).eq('external_event_id', eventId);
    if (error) throw new Error('Não foi possível retirar do calendário a reunião cancelada.');
  },
  async vincularReuniao(reuniao, patch) {
    const { data, error } = await admin.from('agendamentos').update(patch)
      .eq('id', reuniao.id).eq('vendedor_id', reuniao.vendedor_id).eq('updated_at', reuniao.updated_at).select('id');
    if (error) throw new Error('O evento foi criado, mas seu vínculo no sistema ainda precisa ser sincronizado.');
    return Boolean(data?.length);
  },
});

/** Integração `global` ativa da agenda do vendedor (profiles.id_calendar), como no front. */
async function integracaoGlobalDo(userId: string): Promise<string | null> {
  const { data: prof } = await admin.from('profiles').select('id_calendar').eq('id', userId).maybeSingle();
  const idCalendar = String(prof?.id_calendar ?? '').trim();
  if (!idCalendar) return null;
  const { data } = await admin.from('calendar_integrations').select('id')
    .eq('scope', 'global').eq('is_active', true).eq('external_calendar_id', idCalendar)
    .not('oauth_refresh_token', 'is', null).limit(1).maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

/**
 * Vendedores de agenda GLOBAL com reunião que pediu convite — ou com espelho ainda vivo (a
 * reunião foi reatribuída/apagada e o evento precisa sair). Quem tem agenda pessoal fica de fora:
 * o tipo `pessoal` já cobre tudo dele.
 */
async function configsDeConvite(vendedorId: string | undefined, pessoais: Set<string>): Promise<Config[]> {
  const usuarios = new Map<string, string | null>();
  for (let de = 0; ; de += 1000) {
    let q = admin.from('calendar_b2b_reunioes_convite').select('vendedor_id').order('id').range(de, de + 999);
    if (vendedorId) q = q.eq('vendedor_id', vendedorId);
    const { data, error } = await q;
    if (error) throw new Error('Não foi possível consultar as reuniões com convite.');
    for (const r of data || []) usuarios.set(r.vendedor_id as string, null);
    if (!data || data.length < 1000) break;
  }
  let qe = admin.from('calendar_b2b_eventos').select('user_id,integration_id').neq('estado', 'cancelado');
  if (vendedorId) qe = qe.eq('user_id', vendedorId);
  const { data: vivos, error: erroVivos } = await qe;
  if (erroVivos) throw new Error('Não foi possível consultar os convites já enviados.');
  for (const e of vivos || []) if (!usuarios.get(e.user_id)) usuarios.set(e.user_id, e.integration_id);
  const configs: Config[] = [];
  for (const [userId, doEspelho] of usuarios) {
    if (pessoais.has(userId)) continue;
    const integrationId = (await integracaoGlobalDo(userId)) ?? doEspelho;
    // Vendedor sem agenda conectada: a reunião fica só no sistema (o e-mail segue gravado).
    if (integrationId) configs.push({ user_id: userId, integration_id: integrationId, ativo: true, tipo: 'convite' });
  }
  return configs;
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return resposta({});
  if (req.method !== 'POST') return resposta({ success: false, error: 'Método inválido.' }, 405);
  try {
    // Quem chama: o cron (segredo do Vault conferido pelo banco), a chave de serviço ou um
    // colaborador logado. A chave anon é um JWT válido, mas não é login (regra 12).
    const cronSecret = req.headers.get('x-calendar-cron');
    const cron = cronSecret ? (await admin.rpc('calendar_b2b_validar_cron', { p_secret: cronSecret })).data === true : false;
    let chamador: Chamador | null = null;
    if (!cron) {
      try {
        chamador = await exigirAcesso(req, { servico: true, usuario: true });
      } catch (e) {
        return respostaAcessoNegado(e, cors);
      }
    }
    const body = await req.json().catch(() => ({}));
    let soConvite = false;
    if (chamador?.tipo === 'usuario') {
      if (!body.vendedor_id) return resposta({ success: false, error: 'Não autenticado.' }, 401);
      const client = createClient(URL_SUPABASE, SERVICE_ROLE, {
        global: { headers: { Authorization: `Bearer ${chamador.token}` } }, auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data, error } = await client.rpc('calendar_b2b_configuracoes', { p_user_ids: [body.vendedor_id] });
      if (error || !data?.some((c: Config) => c.user_id === body.vendedor_id && c.ativo)) {
        // Sem agenda pessoal visível: só sobra o convite pela agenda global, e só se esse
        // vendedor tem reunião que pediu convite. O worker apenas leva ao Google o que já
        // está gravado no banco (quem chama não escolhe conteúdo).
        const { count } = await admin.from('calendar_b2b_reunioes_convite')
          .select('id', { count: 'exact', head: true }).eq('vendedor_id', body.vendedor_id);
        if (!count) return resposta({ success: false, error: 'Sem acesso à disponibilidade deste responsável.' }, 403);
        soConvite = true;
      }
    }
    if (body.modo && !['validar', 'sincronizar'].includes(body.modo)) return resposta({ success: false, error: 'Operação inválida.' }, 400);
    let query = admin.from('calendar_b2b_config').select('user_id,integration_id,ativo').eq('ativo', true);
    if (body.vendedor_id) query = query.eq('user_id', body.vendedor_id);
    const { data: ativos, error } = await query;
    if (error) throw new Error('Não foi possível consultar as agendas habilitadas.');
    const pessoais = ((soConvite ? [] : ativos) || []).map(c => ({ ...c, tipo: 'pessoal' as const })) as Config[];
    // "validar" é sobre a ocupação da agenda pessoal; o convite só existe em "sincronizar".
    const convites = body.modo === 'validar' ? [] : await configsDeConvite(
      body.vendedor_id, new Set(((ativos || []) as Config[]).map(c => c.user_id)),
    );
    const configs = [...pessoais, ...convites];
    const results = [];
    for (const config of configs) {
      const lease = crypto.randomUUID();
      const { data: locked, error: lockError } = await admin.rpc('calendar_b2b_adquirir_lock', { p_user: config.user_id, p_token: lease });
      if (lockError || !locked) {
        results.push({ user_id: config.user_id, success: false, error: 'A agenda está sendo atualizada. Tente novamente em instantes.' });
        continue;
      }
      try {
        const cred = await tokenGoogle(config);
        let alterados = 0;
        const repositorio = repositorioPara(config.tipo === 'convite' ? 'calendar_b2b_reunioes_convite' : 'calendar_b2b_reunioes');
        if (body.modo !== 'validar') alterados = await sincronizarReunioes(config, cred, { repositorio, google });
        if (config.tipo !== 'convite') await atualizarOcupacao(config);
        results.push({ user_id: config.user_id, success: true, alterados });
      } catch (e) {
        const mensagem = e instanceof Error ? e.message : 'Falha ao sincronizar a agenda.';
        if (config.tipo !== 'convite') {
          await admin.from('calendar_b2b_config').update({ busy_sync_error: mensagem }).eq('user_id', config.user_id);
        }
        results.push({ user_id: config.user_id, success: false, error: mensagem });
      } finally {
        await admin.from('calendar_b2b_locks').delete().eq('user_id', config.user_id).eq('token', lease);
      }
    }
    const falha = results.find(r => !r.success);
    return resposta({ success: configs.length > 0 && !falha, results,
      ...(falha ? { error: falha.error } : {}) });
  } catch {
    return resposta({ success: false, error: 'Não foi possível sincronizar a agenda B2B.' }, 500);
  }
});
