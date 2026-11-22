// acesso: publico — convite pessoal de 256 bits com validade, vinculado ao lead e à empresa pelo SAC.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import { criarFreio, lerTextoComTeto } from '../_shared/cobAgendaPublica.ts';

const podeAbrir = criarFreio(90, 60_000);
const podeMarcar = criarFreio(8, 600_000);
const banco = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const headers = { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const resposta = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { headers, status });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers });
  if (req.method !== 'POST') return resposta({ ok: false }, 405);
  try {
    const texto = await lerTextoComTeto(req.body);
    if (texto === null) return resposta({ ok: false }, 413);
    const corpo = JSON.parse(texto || '{}');
    if (!corpo || typeof corpo.token !== 'string' || !/^[0-9a-f]{64}$/.test(corpo.token)) {
      return resposta({ ok: false, motivo: 'link_invalido' });
    }
    const { acao, token, inicio } = corpo;
    if (acao !== 'carregar' && acao !== 'marcar') return resposta({ ok: false, motivo: 'link_invalido' });
    if (acao === 'marcar' && (typeof inicio !== 'string' || !Number.isFinite(Date.parse(inicio)))) {
      return resposta({ ok: false, motivo: 'horario_indisponivel' });
    }
    const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || 'origem-local';
    if (!podeAbrir(ip) || (acao === 'marcar' && !podeMarcar(token))) {
      return resposta({ ok: false, motivo: 'muitas_tentativas' });
    }
    if (acao === 'marcar') {
      const { data: convite, error } = await banco.rpc('b2b_agenda_por_token', {
        p_token: token, p_acao: 'validar', p_inicio: new Date(inicio).toISOString(),
      });
      if (error) return resposta({ ok: false, motivo: 'falhou' });
      if (!convite?.ok) return resposta({ ok: false, motivo: convite?.motivo || 'link_invalido' });
      if (convite.atualizar) {
        const { data: sync, error: erroSync } = await banco.functions.invoke('b2b-calendar-sync', {
          body: { vendedor_id: convite.vendedor_id, modo: 'validar' },
        });
        if (erroSync || !sync?.results?.some((r: { user_id: string; success: boolean }) =>
          r.user_id === convite.vendedor_id && r.success)) {
          return resposta({ ok: false, motivo: 'agenda_indisponivel' });
        }
      }
    }
    const { data, error } = await banco.rpc('b2b_agenda_por_token', {
      p_token: token, p_acao: acao, p_inicio: acao === 'marcar' ? new Date(inicio).toISOString() : null,
    });
    if (error) {
      const disputa = ['40001', '40P01'].includes(error.code);
      return resposta({ ok: false, motivo: disputa ? 'horario_indisponivel' : 'falhou' });
    }
    return resposta(data);
  } catch {
    return resposta({ ok: false, motivo: 'falhou' });
  }
});
