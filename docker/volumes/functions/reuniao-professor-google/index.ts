import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import { ocupadosNoGoogle } from '../_shared/googleOcupados.ts';

/**
 * REUNIÕES COM PROFESSOR — o que está OCUPADO na agenda Google da secretaria, ao vivo.
 *
 * A coluna da Secretaria na Agenda Geral e a janela "Reunião com professor" chamam esta
 * função para tirar de oferta a vaga que bate com um compromisso que ela pôs DIRETO no
 * Google (o cache do sistema parou de sincronizar em 17/08/2026 e não serve para isso).
 * Devolve só INTERVALOS (início/fim) — nunca título, convidados ou descrição.
 *
 * Só pessoa logada (JWT conferido aqui: o runtime self-hosted não confere sozinho). A
 * agenda é a da config (`reuniao_professor_config.calendar_integration_id`), nunca uma que
 * o chamador escolha. Janela máxima de 120 dias.
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
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
    const de = Date.parse(String(body?.de ?? ''));
    const ate = Date.parse(String(body?.ate ?? ''));
    if (Number.isNaN(de) || Number.isNaN(ate) || ate <= de || ate - de > 120 * 86_400_000) {
      return json({ ok: false, erro: 'periodo_invalido' }, 400);
    }

    const { data: cfg } = await admin
      .from('reuniao_professor_config').select('calendar_integration_id').eq('id', true).maybeSingle();
    const r = await ocupadosNoGoogle(admin, cfg?.calendar_integration_id ?? null,
      new Date(de).toISOString(), new Date(ate).toISOString());
    if (!r.ok) console.error('[reuniao-professor-google]', r.erro);
    return json(r);
  } catch (e) {
    console.error('[reuniao-professor-google]', e);
    return json({ ok: false, erro: 'falhou' }, 500);
  }
});
