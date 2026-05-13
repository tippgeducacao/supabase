import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const STATUS_PLANEJAMENTO = '67aa5966-4fe5-4e34-9ef6-e1eccbb74b84';
const STATUS_A_FAZER = '189823c0-de2b-4750-9b0d-7cd51a5dcc99';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const { post_id } = await req.json().catch(() => ({}));
    if (!post_id) return json({ ok: false, error: 'post_id obrigatório' });

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { data: post, error: pErr } = await supabase
      .from('marketing_posts')
      .select('id, gt_task_id, status')
      .eq('id', post_id)
      .maybeSingle();
    if (pErr) {
      console.error('[request_production] post lookup error', pErr);
      return json({ ok: false, error: 'Erro ao buscar post: ' + pErr.message });
    }
    if (!post) return json({ ok: false, error: 'Post não encontrado' });
    if (!post.gt_task_id)
      return json({ ok: false, error: 'Post sem tarefa vinculada — recrie a ideia.' });

    const { data: task, error: tErr } = await supabase
      .from('gt_tasks')
      .select('id, status_id')
      .eq('id', post.gt_task_id)
      .maybeSingle();
    if (tErr) {
      console.error('[request_production] task lookup error', tErr);
      return json({ ok: false, error: 'Erro ao buscar tarefa: ' + tErr.message });
    }
    if (!task) return json({ ok: false, error: 'Tarefa vinculada não encontrada' });

    if (task.status_id !== STATUS_PLANEJAMENTO) {
      return json({ ok: false, message: 'Tarefa já saiu de planejamento.', task_id: task.id });
    }

    const { error: uErr } = await supabase
      .from('gt_tasks')
      .update({ status_id: STATUS_A_FAZER })
      .eq('id', task.id);
    if (uErr) {
      console.error('[request_production] update task error', uErr);
      return json({ ok: false, error: 'Erro ao mover tarefa: ' + uErr.message });
    }

    const { error: mErr } = await supabase
      .from('marketing_posts')
      .update({ status: 'to_do' })
      .eq('id', post_id);
    if (mErr) console.warn('[request_production] update post status warn', mErr);

    return json({ ok: true, task_id: task.id });
  } catch (e) {
    const err = e as Error;
    console.error('[request_production] unhandled', err);
    return json({ ok: false, error: err.message ?? 'Erro inesperado' }, 500);
  }
});
