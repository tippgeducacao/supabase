// acesso: publico — página /agendar-reuniao/<código> do lead, sem login; a credencial é o código do link (80 bits, desativável), o marcar exige Turnstile + freio por IP e toda regra mora em RPCs só de service_role
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

/**
 * AGENDA PÚBLICA DO COMERCIAL — o lado do LEAD, sem login (14/11/2026, pedido do Welinton).
 *
 * O lead abre `/agendar-reuniao/<código>`, escolhe a pós, vê os horários livres e marca a
 * reunião comercial informando só nome e WhatsApp. Depois sai o template de confirmação com
 * os botões de graduação.
 *
 * Mesmo molde de `rh-agenda-publica` / `cob-agenda-publica`: a página NUNCA fala com o banco.
 * As RPCs `agenda_lead_publica_*` só executam como service_role e é nelas que mora toda a
 * regra (link ativo, horário livre de verdade, freios por telefone/IP, rodízio de vendedor).
 *
 * O que NÃO sai daqui, por desenho (revisão de segurança de 14/11):
 *  - nome, e-mail ou agenda de vendedor: a página recebe só `inicio`/`fim`/`dia`/`hora`;
 *  - qualquer dado de cadastro: a resposta do marcar devolve o que a própria pessoa digitou;
 *  - se o número "já existe" ou "já tem reunião": tudo isso responde `nao_concluido`, igual a
 *    qualquer outra recusa que não seja horário tomado.
 *
 * Freios do MARCAR, em camadas: Turnstile (widget próprio da página, separado do login) → 6 marcações
 * por IP a cada 10 min aqui, em memória → no banco, uma marcação pública por vez, 3 por
 * telefone e 15 por IP em 24 h e um disjuntor de 40 por hora. Cada marcação cria reunião,
 * evento no Google e template de WhatsApp para o número digitado; sem freio isso vira disparo
 * para desconhecidos.
 *
 * CORRIGIR (14/11, 'e se eu coloquei meu número errado?'): a marcação devolve à página um
 * código de correção de uso curto; com ele a própria pessoa troca o número da reunião que
 * acabou de marcar. Não é 'digite o telefone para mexer na reunião': quem não marcou não tem
 * o código.
 *
 * ABRIR e HORÁRIOS também têm freio por IP e cache curto: a conta de horários livres varre a
 * agenda de todos os vendedores da pós, e um laço de pedidos saturaria o banco.
 *
 * Revisão adversarial de 14/11 (antes de publicar), o que entrou por causa dela: o Turnstile
 * FECHA quando a Cloudflare não responde; o nome só aceita letras (ele vai para dentro do
 * modelo oficial de WhatsApp e da agenda do vendedor); IPv6 conta por /64; o segredo do
 * Turnstile só vem de `app_secrets` ou do env, nunca da tabela legada de leitura aberta.
 *
 * O Google é SECUNDÁRIO de propósito: a reunião já está gravada quando ele é chamado. Se
 * falhar, o lead vê a confirmação sem a sala e a confirmação do WhatsApp sai dizendo que o
 * link vem depois.
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// A mesma integração Google que a IA usa para pôr a reunião na agenda do vendedor.
const GCAL_INTEGRATION_ID = Deno.env.get('AGENTE_SDR_GCAL_INTEGRATION_ID') ?? '';
const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CALENDAR_CLIENT_ID') ?? '';
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CALENDAR_CLIENT_SECRET') ?? '';
const CHAVE_TURNSTILE = 'AGENDA_LEAD_TURNSTILE_SECRET';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// ── Freio por IP (em memória, por worker) ───────────────────────────────────────────────
// Dois baldes: MARCAR é caro e raro (6 a cada 10 min); LER (abrir + horários) é o uso normal
// da página, com folga para quem troca de pós e de dia (60 a cada 10 min).
const JANELA_MS = 10 * 60_000;
const baldes = {
  marcar: { max: 6, mapa: new Map<string, { n: number; ate: number }>() },
  ler: { max: 60, mapa: new Map<string, { n: number; ate: number }>() },
};

function dentroDoLimite(balde: keyof typeof baldes, ip: string): boolean {
  const { max, mapa } = baldes[balde];
  const agora = Date.now();
  // o mapa não cresce para sempre: passou de 5 mil chaves, sai o que já venceu
  if (mapa.size > 5000) for (const [k, v] of mapa) if (agora > v.ate) mapa.delete(k);
  const t = mapa.get(ip);
  if (!t || agora > t.ate) {
    mapa.set(ip, { n: 1, ate: agora + JANELA_MS });
    return true;
  }
  t.n += 1;
  return t.n <= max;
}

// IP do cliente SEM confiar no que o cliente manda: o PRIMEIRO valor do x-forwarded-for é
// forjável; varre da direita (o que os NOSSOS proxies apuseram) e pega o primeiro IP público.
// IPv6 conta por /64 (os 4 primeiros grupos): um assinante recebe o bloco inteiro e trocaria
// de endereço a cada pedido. Sem IP nenhum, todo mundo divide o balde "desconhecido".
const IP_PRIVADO_RE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:)/i;
function ipDe(req: Request): string {
  const cf = req.headers.get('cf-connecting-ip');
  let ip = cf ? cf.trim() : '';
  if (!ip) {
    const partes = (req.headers.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    for (let i = partes.length - 1; i >= 0 && !ip; i--) {
      if (!IP_PRIVADO_RE.test(partes[i])) ip = partes[i];
    }
    if (!ip) ip = partes[partes.length - 1] ?? '';
  }
  if (!ip) return 'desconhecido';
  if (ip.includes(':')) {
    const grupos = ip.toLowerCase().split('::')[0].split(':').filter(Boolean).slice(0, 4);
    return `${grupos.join(':')}::/64`;
  }
  return ip.slice(0, 45);
}

// ── Cache curto do que é igual para todo mundo ──────────────────────────────────────────
const cache = new Map<string, { ate: number; valor: unknown }>();
async function comCache<T>(chave: string, ttlMs: number, buscar: () => Promise<T>): Promise<T> {
  const agora = Date.now();
  const c = cache.get(chave);
  if (c && agora < c.ate) return c.valor as T;
  const valor = await buscar();
  if (cache.size > 500) for (const [k, v] of cache) if (agora > v.ate) cache.delete(k);
  cache.set(chave, { ate: agora + ttlMs, valor });
  return valor;
}

// ── Turnstile ───────────────────────────────────────────────────────────────────────────
// Fail-CLOSED em tudo: sem segredo, sem token, token recusado OU Cloudflare sem responder,
// não marca. (O webchat abre quando a Cloudflare cai para não zerar a captação; aqui cada
// marcação dispara WhatsApp para o número digitado, então esperar é o lado seguro.)
async function turnstileOk(segredo: string, token: string, ip: string): Promise<boolean> {
  if (!token) return false;
  try {
    const form = new URLSearchParams({ secret: segredo, response: token });
    if (ip && !ip.includes('/') && ip !== 'desconhecido') form.set('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(6000),
    });
    const j = await res.json();
    return j?.success === true;
  } catch (e) {
    console.error(`[agenda-lead-publica] siteverify do Turnstile não respondeu: ${(e as Error).message}`);
    return false;
  }
}

// O segredo do Turnstile: `app_secrets` (service-role-only) ou env. De propósito NÃO usa a
// cascata de `_shared/segredos.ts`, que ainda cai numa tabela legada legível por qualquer
// logado: quem plantasse ali a chave de teste da Cloudflare aprovaria todo captcha.
async function segredoTurnstile(admin: SupabaseClient): Promise<string> {
  try {
    const { data } = await admin.from('app_secrets').select('valor').eq('chave', CHAVE_TURNSTILE).maybeSingle();
    const v = String(data?.valor ?? '').trim();
    if (v) return v;
  } catch { /* cai no env */ }
  return (Deno.env.get(CHAVE_TURNSTILE) ?? '').trim();
}

// O mesmo filtro do banco: só letras, espaço, apóstrofo e hífen (o nome vai para o modelo de
// WhatsApp, para o cadastro e para a agenda do vendedor).
const NOME_OK = /^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ '-]{1,59}$/;

// ── Google: evento com Meet na agenda do vendedor (a mesma integração da IA) ───────────
async function gcalToken(admin: SupabaseClient): Promise<string> {
  if (!GCAL_INTEGRATION_ID) throw new Error('AGENTE_SDR_GCAL_INTEGRATION_ID não configurado');
  const { data: integ, error } = await admin
    .from('calendar_integrations')
    .select('id, oauth_access_token, oauth_refresh_token, oauth_token_expires_at, is_active')
    .eq('id', GCAL_INTEGRATION_ID)
    .maybeSingle();
  if (error || !integ) throw new Error('Integração Google não encontrada');
  if (!integ.is_active) throw new Error('Integração Google desativada');

  const expiraEm = integ.oauth_token_expires_at ? new Date(integ.oauth_token_expires_at).getTime() : 0;
  if (integ.oauth_access_token && expiraEm - Date.now() > 60_000) return integ.oauth_access_token;
  if (!integ.oauth_refresh_token) throw new Error('Integração Google sem refresh token');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: integ.oauth_refresh_token,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`refresh do token Google falhou (${res.status})`);
  await admin
    .from('calendar_integrations')
    .update({
      oauth_access_token: j.access_token,
      oauth_token_expires_at: new Date(Date.now() + j.expires_in * 1000).toISOString(),
    })
    .eq('id', integ.id);
  return j.access_token;
}

async function criarEventoMeet(admin: SupabaseClient, o: {
  calendarId: string; inicio: string; fim: string; titulo: string; descricao: string;
}): Promise<{ link: string | null; eventId: string | null }> {
  const token = await gcalToken(admin);
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(o.calendarId)}/events`);
  url.searchParams.set('conferenceDataVersion', '1');
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: o.titulo,
      description: o.descricao,
      start: { dateTime: o.inicio, timeZone: 'America/Sao_Paulo' },
      end: { dateTime: o.fim, timeZone: 'America/Sao_Paulo' },
      conferenceData: {
        createRequest: {
          requestId: `agl-${crypto.randomUUID()}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
    }),
    // A confirmação do WhatsApp espera a sala por 75 s; o Google tem 20.
    signal: AbortSignal.timeout(20_000),
  });
  const g = await res.json();
  if (!res.ok) throw new Error(`Google Calendar recusou o evento (${res.status})`);
  return { link: g.hangoutLink ?? g.conferenceData?.entryPoints?.[0]?.uri ?? null, eventId: g.id ?? null };
}

const CODIGO_OK = /^[0-9a-f]{20}$/;
const UUID_OK = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const acao = String(body?.acao ?? 'abrir');
    const codigo = String(body?.codigo ?? '').trim().toLowerCase();
    if (!CODIGO_OK.test(codigo)) return json({ ok: false, motivo: 'link_invalido' });

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const ip = ipDe(req);

    // O link (e as pós que têm quem atenda): igual para todo mundo, 30 s de cache. Um link
    // desativado some da página em até 30 s; o MARCAR reconfere no banco, na hora.
    const abrir = () =>
      comCache(`abrir:${codigo}`, 30_000, async () => {
        const { data, error } = await admin.rpc('agenda_lead_publica_abrir', { p_codigo: codigo });
        if (error) throw error;
        return data;
      });

    if (acao === 'abrir' || acao === 'horarios') {
      if (!dentroDoLimite('ler', ip)) return json({ ok: false, motivo: 'muitas_tentativas' });
    }

    // ── Abrir ────────────────────────────────────────────────────────────────────────────
    if (acao === 'abrir') {
      const data = await abrir();
      if (!data?.ok) return json({ ok: false, motivo: data?.motivo ?? 'link_invalido' });
      return json({ ok: true, cursos: data.cursos ?? [], captcha: data.exigir_captcha === true });
    }

    const cursoId = String(body?.curso_id ?? '').toLowerCase();
    // a correção não escolhe pós: ela refaz a reunião que já existe
    if (acao !== 'corrigir' && !UUID_OK.test(cursoId)) return json({ ok: false, motivo: 'pedido_invalido' }, 400);

    // ── Horários livres da pós escolhida ─────────────────────────────────────────────────
    // 45 s de cache por pós: a conta varre a agenda de todos os vendedores dela. Horário que
    // alguém pegou nesse intervalo é barrado no marcar, que confere de novo.
    if (acao === 'horarios') {
      const data = await comCache(`horarios:${codigo}:${cursoId}`, 45_000, async () => {
        const { data, error } = await admin.rpc('agenda_lead_publica_horarios', {
          p_codigo: codigo,
          p_curso_id: cursoId,
        });
        if (error) throw error;
        return data;
      });
      if (!data?.ok) return json({ ok: false, motivo: data?.motivo ?? 'link_invalido' });
      return json({ ok: true, horarios: data.horarios ?? [] });
    }

    // ── Corrigir o número, logo depois de marcar ─────────────────────────────────────────
    // A credencial é o código de correção que SÓ a página que marcou recebeu (128 bits, 15 min,
    // no máximo 2 usos por marcação). Sem captcha de novo: ele já foi cobrado na marcação, e
    // os freios por telefone, por IP e por hora contam cada correção como uma marcação.
    if (acao === 'corrigir') {
      if (!dentroDoLimite('marcar', ip)) return json({ ok: false, motivo: 'muitas_tentativas' });
      const token = String(body?.correcao_token ?? '').trim().toLowerCase();
      const novo = String(body?.whatsapp ?? '').replace(/\D/g, '').slice(0, 15);
      if (!/^[0-9a-f]{32}$/.test(token)) return json({ ok: false, motivo: 'correcao_expirada' });
      if (novo.length < 10) return json({ ok: false, motivo: 'contato_incompleto' });

      const { data: c, error: erroC } = await admin.rpc('agenda_lead_publica_corrigir', {
        p_codigo: codigo,
        p_token: token,
        p_whatsapp: novo,
        p_ip: ip,
      });
      if (erroC) throw erroC;
      if (!c?.ok) return json({ ok: false, motivo: c?.motivo ?? 'falhou' });
      console.log(`[agenda-lead-publica] número corrigido pelo lead: reunião ${c.interno?.agendamento_id} refeita`);
      // a sala e o evento do Google são os mesmos da reunião que foi refeita
      return json({
        ok: true,
        reuniao: {
          inicio: c.reuniao.inicio,
          fim: c.reuniao.fim,
          dia: c.reuniao.dia,
          hora: c.reuniao.hora,
          curso: c.reuniao.curso,
          primeiro_nome: c.reuniao.primeiro_nome,
          confirmacao_whatsapp: c.reuniao.confirmacao_whatsapp === true,
          link: c.reuniao.link ?? null,
        },
        correcao: c.correcao ?? null,
      });
    }

    if (acao !== 'marcar') return json({ ok: false, motivo: 'pedido_invalido' }, 400);

    // ── Marcar ───────────────────────────────────────────────────────────────────────────
    if (!dentroDoLimite('marcar', ip)) return json({ ok: false, motivo: 'muitas_tentativas' });

    const inicio = String(body?.inicio ?? '');
    const nome = String(body?.nome ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
    const whatsapp = String(body?.whatsapp ?? '').replace(/\D/g, '').slice(0, 15);
    if (Number.isNaN(Date.parse(inicio))) return json({ ok: false, motivo: 'horario_indisponivel' });
    if (!NOME_OK.test(nome) || nome.split(' ')[0].length > 20 || whatsapp.length < 10) {
      return json({ ok: false, motivo: 'contato_incompleto' });
    }

    // O link vale e pede captcha?
    const link = await abrir();
    if (!link?.ok) return json({ ok: false, motivo: 'link_invalido' });

    if (link.exigir_captcha === true) {
      const segredo = await segredoTurnstile(admin);
      if (!segredo) {
        // Sem o segredo a página não tem como provar que é gente: não marca. Para liberar,
        // gravar AGENDA_LEAD_TURNSTILE_SECRET em app_secrets (ver docs/Agendamentos e Reuniões.md).
        console.error(`[agenda-lead-publica] ${CHAVE_TURNSTILE} não configurado: marcação recusada`);
        return json({ ok: false, motivo: 'indisponivel' });
      }
      if (!(await turnstileOk(segredo, String(body?.turnstile_token ?? '').slice(0, 5000), ip))) {
        return json({ ok: false, motivo: 'captcha_falhou' });
      }
    }

    const { data: r, error } = await admin.rpc('agenda_lead_publica_marcar', {
      p_codigo: codigo,
      p_curso_id: cursoId,
      p_inicio: new Date(inicio).toISOString(),
      p_nome: nome,
      p_whatsapp: whatsapp,
      // sempre um valor: sem IP, todo mundo divide o balde "desconhecido" (e o limite vale)
      p_ip: ip,
    });
    if (error) throw error;
    // marcou, ou o horário já tinha dono: a lista em cache desta pós não vale mais
    if (r?.ok || r?.motivo === 'horario_indisponivel') cache.delete(`horarios:${codigo}:${cursoId}`);
    if (!r?.ok) return json({ ok: false, motivo: r?.motivo ?? 'falhou' });

    // ── Evento com Meet na agenda do vendedor (melhor-esforço) ───────────────────────────
    let sala: string | null = null;
    const interno = r.interno ?? {};
    try {
      if (interno.calendar_id) {
        const evento = await criarEventoMeet(admin, {
          calendarId: String(interno.calendar_id),
          inicio: r.reuniao.inicio,
          fim: r.reuniao.fim,
          titulo: `Reunião PPG — ${interno.lead_nome ?? 'Lead'}`,
          descricao:
            `Agendamento: ${interno.agendamento_id}\n` +
            `Curso: ${r.reuniao.curso ?? '-'}\n` +
            `Lead: ${interno.lead_nome ?? '-'} (${interno.lead_whatsapp ?? '-'})\n` +
            `Vendedor: ${interno.vendedor_nome ?? '-'}\n\n` +
            `Marcada pelo próprio lead na agenda pública. Graduação a validar.`,
        });
        sala = evento.link;
        const { error: erroLinkSala } = await admin.rpc('agenda_lead_publica_anotar_link', {
          p_marcacao_id: r.marcacao_id,
          p_link: sala,
          p_google_event_id: evento.eventId,
        });
        if (erroLinkSala) console.error('[agenda-lead-publica] sala não anotada na reunião', erroLinkSala);
      } else {
        console.error(`[agenda-lead-publica] vendedor ${interno.vendedor_nome ?? '?'} sem id_calendar: reunião ${interno.agendamento_id} sem evento no Google`);
      }
    } catch (e) {
      console.error('[agenda-lead-publica] evento no Google falhou', (e as Error).message);
    }

    console.log(`[agenda-lead-publica] reunião ${interno.agendamento_id} marcada pelo link (${r.reuniao.dia} ${r.reuniao.hora})`);
    // `interno` fica aqui: a página recebe só o que a própria pessoa escolheu e digitou.
    return json({
      ok: true,
      reuniao: {
        inicio: r.reuniao.inicio,
        fim: r.reuniao.fim,
        dia: r.reuniao.dia,
        hora: r.reuniao.hora,
        curso: r.reuniao.curso,
        primeiro_nome: r.reuniao.primeiro_nome,
        confirmacao_whatsapp: r.reuniao.confirmacao_whatsapp === true,
        link: sala,
      },
      // código para a própria página corrigir o número nos próximos minutos
      correcao: r.correcao ?? null,
    });
  } catch (e) {
    console.error('[agenda-lead-publica]', e);
    return json({ ok: false, motivo: 'falhou' }, 500);
  }
});
