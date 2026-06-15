// gmail-send-reply: responde a uma thread pelo Gmail da caixa
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { ensureToken, base64UrlEncode, validateEmailList, friendlyGmailError, isTokenRevokedError, markCaixaTokenRevoked } from '../_shared/gmail.ts';

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
    const { thread_id, body_html, to_emails, cc_emails, assunto, attachments } = await req.json();
    if (!thread_id || !body_html) throw new Error('thread_id e body_html obrigatórios');

    // Carrega thread + caixa
    const { data: thread, error: tErr } = await admin
      .from('email_threads')
      .select('*, caixa:email_caixas_conectadas(*, integ:calendar_integrations(*))')
      .eq('id', thread_id)
      .maybeSingle();
    if (tErr || !thread) throw new Error('thread não encontrada');

    // Verifica permissão de acesso à caixa
    const { data: canSee } = await userClient.rpc('email_caixa_visible', { _caixa_id: thread.caixa_id, _user_id: user.id });
    if (!canSee) throw new Error('forbidden');

    // Última mensagem para pegar headers de threading
    const { data: lastMsg } = await admin
      .from('email_mensagens')
      .select('*')
      .eq('thread_id', thread_id)
      .order('enviado_em', { ascending: false })
      .limit(1)
      .maybeSingle();

    const fromEmail = thread.caixa.email_caixa;
    const fromNome = thread.caixa.nome_exibicao;
    const subj = assunto || `Re: ${(thread.assunto || '').replace(/^Re:\s*/i, '')}`;

    // Destinatários: reply-all baseado na última mensagem entrante
    let to: string[] = to_emails || [];
    let cc: string[] = cc_emails || [];
    if (!to.length && lastMsg) {
      if (!lastMsg.is_outgoing) {
        to = lastMsg.from_email ? [lastMsg.from_email] : [];
      } else {
        to = (lastMsg.to_emails || []).map((x: any) => x.email);
      }
    }
    const toCheck = validateEmailList(to);
    const ccCheck = validateEmailList(cc);
    if (toCheck.invalid.length) throw new Error(`Destinatário inválido: ${toCheck.invalid.join(', ')}`);
    if (ccCheck.invalid.length) throw new Error(`Cópia inválida: ${ccCheck.invalid.join(', ')}`);
    to = toCheck.ok;
    cc = ccCheck.ok;
    if (!to.length) throw new Error('Sem destinatário válido para responder. Informe o "Para" manualmente.');

    const inReplyTo = lastMsg?.in_reply_to_format || (lastMsg ? `<${lastMsg.gmail_message_id}@mail.gmail.com>` : null);
    const references = lastMsg?.references_header
      ? `${lastMsg.references_header} ${inReplyTo || ''}`.trim()
      : (inReplyTo || '');

    const atts = Array.isArray(attachments) ? attachments : [];
    const baseHeaders = [
      `From: "${fromNome}" <${fromEmail}>`,
      `To: ${to.join(', ')}`,
      cc.length ? `Cc: ${cc.join(', ')}` : null,
      `Subject: ${subj}`,
      'MIME-Version: 1.0',
      inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
      references ? `References: ${references}` : null,
    ].filter(Boolean);

    let raw: string;
    if (atts.length === 0) {
      raw = [...baseHeaders, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: 7bit', '', body_html].join('\r\n');
    } else {
      const boundary = `bnd_${crypto.randomUUID().replace(/-/g, '')}`;
      const parts: string[] = [];
      parts.push(`--${boundary}`);
      parts.push('Content-Type: text/html; charset="UTF-8"');
      parts.push('Content-Transfer-Encoding: 7bit');
      parts.push('');
      parts.push(body_html);
      for (const a of atts) {
        parts.push(`--${boundary}`);
        parts.push(`Content-Type: ${a.mimeType || 'application/octet-stream'}; name="${a.filename}"`);
        parts.push('Content-Transfer-Encoding: base64');
        parts.push(`Content-Disposition: attachment; filename="${a.filename}"`);
        parts.push('');
        parts.push((a.contentBase64 as string).replace(/(.{76})/g, '$1\r\n'));
      }
      parts.push(`--${boundary}--`);
      raw = [...baseHeaders, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts].join('\r\n');
    }
    const rawEncoded = base64UrlEncode(raw);

    let token: string;
    try {
      token = await ensureToken(admin, thread.caixa.integ);
    } catch (e) {
      if (isTokenRevokedError(e)) await markCaixaTokenRevoked(admin, thread.caixa.id);
      throw e;
    }

    const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: rawEncoded, threadId: thread.gmail_thread_id }),
    });
    const sendJson = await sendRes.json();
    if (!sendRes.ok) throw new Error(`gmail_send_failed: ${JSON.stringify(sendJson)}`);

    // Insere localmente
    await admin.from('email_mensagens').insert({
      thread_id,
      gmail_message_id: sendJson.id,
      from_email: fromEmail,
      from_nome: fromNome,
      to_emails: to.map(e => ({ email: e, name: '' })),
      cc_emails: cc.map(e => ({ email: e, name: '' })),
      assunto: subj,
      snippet: body_html.replace(/<[^>]*>/g, '').slice(0, 200),
      body_html,
      enviado_em: new Date().toISOString(),
      is_outgoing: true,
      enviado_por_user_id: user.id,
      labels: ['SENT'],
    });

    const nowIso = new Date().toISOString();
    await admin.from('email_threads').update({
      ultima_mensagem_em: nowIso,
      ultima_mensagem_outgoing_em: nowIso,
      nao_lido: false,
      updated_at: nowIso,
    }).eq('id', thread_id);

    return new Response(JSON.stringify({ success: true, gmail_id: sendJson.id }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: friendlyGmailError(e) }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
