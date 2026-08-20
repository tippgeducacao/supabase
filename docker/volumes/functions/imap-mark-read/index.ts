// imap-mark-read: espelho do gmail-mark-read para caixas IMAP.
//
// Aceita as MESMAS ações da versão Gmail, para o despachante do front poder mandar
// o mesmo payload. O que muda é o que chega ao servidor:
//   read/unread → UID STORE ±\Seen
//   archive     → MOVE para a pasta de Arquivo, quando o servidor tem uma
//   star/link_task → só local (IMAP não tem estrela nem vínculo com tarefa)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { abrirSessao, carregarConfig, classificarErro } from '../_shared/imap/caixa.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const responder = (corpo: unknown) =>
  new Response(JSON.stringify(corpo), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const auth = req.headers.get('Authorization');
    if (!auth) throw new Error('not_authenticated');
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) throw new Error('not_authenticated');

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { thread_id, action, task_id } = await req.json();
    if (!thread_id || !action) throw new Error('thread_id e action obrigatórios');

    const { data: thread } = await admin
      .from('email_threads')
      .select('id, caixa_id')
      .eq('id', thread_id)
      .maybeSingle();
    if (!thread) throw new Error('thread não encontrada');

    const { data: podeVer } = await userClient.rpc('email_caixa_visible', {
      _caixa_id: thread.caixa_id, _user_id: user.id,
    });
    if (!podeVer) throw new Error('forbidden');

    // ── Estado local primeiro ──────────────────────────────────────────────
    // A tela responde a ele. Se o servidor recusar depois, avisamos — mas não
    // deixamos a interface travada esperando a rede para marcar um e-mail como lido.
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (action === 'read') patch.nao_lido = false;
    if (action === 'unread') patch.nao_lido = true;
    if (action === 'archive') patch.arquivado = true;
    if (action === 'unarchive') patch.arquivado = false;
    if (action === 'star') patch.favoritado = true;
    if (action === 'unstar') patch.favoritado = false;
    if (action === 'trash' || action === 'spam') patch.arquivado = true;
    if (action === 'link_task') patch.task_id = task_id ?? null;

    await admin.from('email_threads').update(patch).eq('id', thread_id);

    // Ações que não existem no protocolo IMAP param por aqui, de propósito.
    if (action === 'link_task' || action === 'star' || action === 'unstar') {
      return responder({ success: true, servidor: 'nao_aplicavel' });
    }

    // ── Reflete no servidor ────────────────────────────────────────────────
    const { data: mensagens } = await admin
      .from('email_mensagens')
      .select('imap_uid')
      .eq('thread_id', thread_id)
      .not('imap_uid', 'is', null);
    const uids = (mensagens || []).map((m: any) => Number(m.imap_uid)).filter(Boolean);

    if (!uids.length) {
      return responder({ success: true, servidor: 'sem_uid' });
    }

    let aviso: string | null = null;
    try {
      const config = await carregarConfig(admin, thread.caixa_id);
      const sessao = await abrirSessao(config);
      try {
        await sessao.cliente.selecionar('INBOX');
        if (action === 'read' || action === 'unread') {
          for (const uid of uids) await sessao.cliente.marcarLida(uid, action === 'read');
        } else if (action === 'archive' || action === 'trash' || action === 'spam') {
          const destino = action === 'archive' ? config.pasta_arquivo : config.pasta_arquivo;
          if (destino) {
            for (const uid of uids) await sessao.cliente.mover(uid, destino);
          } else {
            aviso = 'Este servidor não tem pasta de Arquivo — a conversa foi arquivada só aqui no sistema.';
          }
        }
      } finally {
        await sessao.fechar();
      }
    } catch (e) {
      // O estado local já mudou; o servidor é que não acompanhou.
      const { recado } = classificarErro(e);
      aviso = `A alteração valeu aqui, mas não chegou ao servidor: ${recado}`;
      console.warn(aviso);
    }

    return responder({ success: true, aviso });
  } catch (e) {
    return responder({ success: false, error: (e as Error).message });
  }
});
