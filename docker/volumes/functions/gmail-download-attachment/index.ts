// gmail-download-attachment: baixa do Gmail, salva no storage e retorna URL assinada
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { ensureToken, base64UrlDecode } from '../_shared/gmail.ts';

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
    const { anexo_id } = await req.json();

    const { data: anexo } = await admin
      .from('email_anexos')
      .select('*, mensagem:email_mensagens(gmail_message_id, thread:email_threads(caixa_id, caixa:email_caixas_conectadas(*, integ:calendar_integrations(*))))')
      .eq('id', anexo_id)
      .maybeSingle();
    if (!anexo) throw new Error('anexo não encontrado');

    const caixaId = anexo.mensagem.thread.caixa_id;
    const { data: canSee } = await userClient.rpc('email_caixa_visible', { _caixa_id: caixaId, _user_id: user.id });
    if (!canSee) throw new Error('forbidden');

    // Se já tem storage_path retorna URL assinada direto
    if (!anexo.storage_path) {
      const token = await ensureToken(admin, anexo.mensagem.thread.caixa.integ);
      const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${anexo.mensagem.gmail_message_id}/attachments/${anexo.gmail_attachment_id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error('gmail_attach_failed');
      const bytes = base64UrlDecode(json.data);
      const path = `${caixaId}/${anexo.id}/${anexo.filename}`;
      await admin.storage.from('email-anexos').upload(path, bytes, { contentType: anexo.mime_type || 'application/octet-stream', upsert: true });
      await admin.from('email_anexos').update({ storage_path: path }).eq('id', anexo.id);
      anexo.storage_path = path;
    }

    const { data: signed } = await admin.storage.from('email-anexos').createSignedUrl(anexo.storage_path, 3600);
    return new Response(JSON.stringify({ success: true, url: signed?.signedUrl }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: (e as Error).message }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
