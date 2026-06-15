// gmail-mark-read: marca/desmarca como lido + arquivar
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { ensureToken } from '../_shared/gmail.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const auth = req.headers.get('Authorization');
    if (!auth) throw new Error('not_authenticated');
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) throw new Error('not_authenticated');

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const body = await req.json();
    const { thread_id, action, task_id } = body;
    // action: 'read' | 'unread' | 'archive' | 'unarchive' | 'link_task' | 'star' | 'unstar' | 'trash' | 'spam'

    const { data: thread } = await admin
      .from('email_threads')
      .select('*, caixa:email_caixas_conectadas(*, integ:calendar_integrations(*))')
      .eq('id', thread_id)
      .maybeSingle();
    if (!thread) throw new Error('thread não encontrada');

    const { data: canSee } = await userClient.rpc('email_caixa_visible', { _caixa_id: thread.caixa_id, _user_id: user.id });
    if (!canSee) throw new Error('forbidden');

    if (action === 'link_task') {
      await admin.from('email_threads').update({ task_id: task_id || null }).eq('id', thread_id);
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const token = await ensureToken(admin, thread.caixa.integ);
    const remove: string[] = [];
    const add: string[] = [];
    if (action === 'read') remove.push('UNREAD');
    if (action === 'unread') add.push('UNREAD');
    if (action === 'archive') remove.push('INBOX');
    if (action === 'unarchive') add.push('INBOX');
    if (action === 'star') add.push('STARRED');
    if (action === 'unstar') remove.push('STARRED');

    if (action === 'trash') {
      const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${thread.gmail_thread_id}/trash`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`gmail_trash_failed: ${await res.text()}`);
      await admin.from('email_threads').update({ arquivado: true, pasta: 'trash', updated_at: new Date().toISOString() }).eq('id', thread_id);
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'spam') {
      const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${thread.gmail_thread_id}/modify`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] }),
      });
      if (!res.ok) throw new Error(`gmail_spam_failed: ${await res.text()}`);
      await admin.from('email_threads').update({ arquivado: true, pasta: 'spam', updated_at: new Date().toISOString() }).eq('id', thread_id);
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${thread.gmail_thread_id}/modify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }),
    });
    if (!res.ok) throw new Error(`gmail_modify_failed: ${await res.text()}`);

    const update: any = { updated_at: new Date().toISOString() };
    if (action === 'read') update.nao_lido = false;
    if (action === 'unread') update.nao_lido = true;
    if (action === 'archive') { update.arquivado = true; update.pasta = 'archived'; }
    if (action === 'unarchive') { update.arquivado = false; update.pasta = 'inbox'; }
    if (action === 'star') update.favoritado = true;
    if (action === 'unstar') update.favoritado = false;
    await admin.from('email_threads').update(update).eq('id', thread_id);

    return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: (e as Error).message }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
