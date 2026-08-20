// imap-send: envia por SMTP e grava nos Enviados do servidor por IMAP APPEND.
//
// Cobre de uma vez o que no Gmail são duas edges: `thread_id` no corpo = responder
// (gmail-send-reply), `caixa_id` + `to_emails` = compor (gmail-compose-send). O
// despachante do front escolhe pelo provider da caixa e manda o MESMO payload.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { montarMensagem, destinatariosDoEnvelope, type MensagemParaEnvio } from '../_shared/imap/mensagem.ts';
import { abrirSessao, abrirSmtp, carregarConfig, classificarErro, senhaDaConfig } from '../_shared/imap/caixa.ts';
import { resumo } from '../_shared/imap/mime.ts';

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
    const body = await req.json();
    const { thread_id, caixa_id, body_html, assunto, attachments } = body;
    if (!body_html) throw new Error('body_html obrigatório');

    // ── De qual caixa, e em que thread ─────────────────────────────────────
    let caixaId: string = caixa_id;
    let thread: any = null;
    let ultima: any = null;

    if (thread_id) {
      const { data } = await admin
        .from('email_threads')
        .select('*, caixa:email_caixas_conectadas(*)')
        .eq('id', thread_id)
        .maybeSingle();
      if (!data) throw new Error('thread não encontrada');
      thread = data;
      caixaId = data.caixa_id;
      const { data: msgs } = await admin
        .from('email_mensagens')
        .select('*')
        .eq('thread_id', thread_id)
        .order('enviado_em', { ascending: false })
        .limit(1);
      ultima = msgs?.[0] ?? null;
    }
    if (!caixaId) throw new Error('informe thread_id ou caixa_id');

    const { data: podeVer } = await userClient.rpc('email_caixa_visible', {
      _caixa_id: caixaId, _user_id: user.id,
    });
    if (!podeVer) throw new Error('forbidden');

    const { data: caixa } = await admin
      .from('email_caixas_conectadas')
      .select('*')
      .eq('id', caixaId)
      .maybeSingle();
    if (!caixa) throw new Error('caixa não encontrada');
    if (caixa.provider !== 'imap') throw new Error('Esta caixa não é IMAP.');

    // ── Destinatários e cabeçalhos de encadeamento ─────────────────────────
    let para: string[] = (body.to_emails || []).filter(Boolean);
    const cc: string[] = (body.cc_emails || []).filter(Boolean);
    let assuntoFinal = assunto;
    let emRespostaA: string | undefined;
    let referencias: string | undefined;

    if (thread && !para.length) {
      // Responder sem destinatário explícito: volta para quem escreveu por último.
      // Se a última mensagem foi NOSSA, responde para quem ela endereçava.
      if (ultima?.is_outgoing) {
        para = (ultima.to_emails || []).map((t: any) => t.email).filter(Boolean);
      } else if (ultima?.from_email) {
        para = [ultima.from_email];
      }
    }
    if (thread) {
      assuntoFinal = assuntoFinal || (/^re:/i.test(thread.assunto || '') ? thread.assunto : `Re: ${thread.assunto || ''}`);
      if (ultima?.message_id) {
        emRespostaA = ultima.message_id;
        referencias = [ultima.references_header, ultima.message_id].filter(Boolean).join(' ');
      }
    }
    if (!para.length) throw new Error('Informe ao menos um destinatário.');
    if (!assuntoFinal) assuntoFinal = '(sem assunto)';

    // ── Monta UMA vez: o mesmo byte vai para o SMTP e para o APPEND ────────
    const config = await carregarConfig(admin, caixaId);
    const mensagem: MensagemParaEnvio = {
      de: { email: caixa.email_caixa, nome: caixa.nome_exibicao },
      para,
      cc,
      bcc: (body.bcc_emails || []).filter(Boolean),
      assunto: assuntoFinal,
      html: body_html,
      emRespostaA,
      referencias,
      anexos: (attachments || []).map((a: any) => ({
        filename: a.filename,
        mimeType: a.mimeType || 'application/octet-stream',
        conteudoBase64: a.contentBase64,
      })),
    };
    const { bruto, messageId } = montarMensagem(mensagem);

    const senha = await senhaDaConfig(config);
    const smtp = await abrirSmtp(config, senha);
    try {
      await smtp.cliente.enviar(caixa.email_caixa, destinatariosDoEnvelope(mensagem), bruto);
    } finally {
      await smtp.fechar();
    }

    // ── Enviados do servidor ───────────────────────────────────────────────
    // Falha aqui NÃO desfaz o envio: a mensagem já saiu. Só registramos, para o
    // usuário não achar que o envio falhou por causa de um detalhe de arquivamento.
    let avisoAppend: string | null = null;
    if (config.pasta_enviados) {
      try {
        const sessao = await abrirSessao(config);
        try {
          await sessao.cliente.append(config.pasta_enviados, bruto);
        } finally {
          await sessao.fechar();
        }
      } catch (e) {
        avisoAppend = `Enviado, mas não consegui gravar em "${config.pasta_enviados}": ${(e as Error).message}`;
        console.warn(avisoAppend);
      }
    }

    // ── Grava local ────────────────────────────────────────────────────────
    const quando = new Date().toISOString();
    const trecho = resumo('', body_html);
    let threadId = thread?.id as string | undefined;

    if (!threadId) {
      const { data: nova, error } = await admin
        .from('email_threads')
        .insert({
          caixa_id: caixaId,
          gmail_thread_id: messageId,
          assunto: assuntoFinal,
          snippet: trecho,
          participantes: para.map((email: string) => ({ email, name: '' })),
          ultima_mensagem_em: quando,
          ultima_mensagem_outgoing_em: quando,
          nao_lido: false,
          pasta: 'inbox',
        })
        .select('id')
        .single();
      if (error) throw new Error(error.message);
      threadId = nova.id;
    } else {
      await admin.from('email_threads').update({
        snippet: trecho,
        ultima_mensagem_em: quando,
        ultima_mensagem_outgoing_em: quando,
        nao_lido: false,
        updated_at: quando,
      }).eq('id', threadId);
    }

    // `gmail_message_id` recebe uma chave provisória: o UID real só existe depois
    // que o sync ler a mensagem de volta da pasta de Enviados, e é o `message_id`
    // que permite a ele reconhecer esta linha em vez de duplicá-la.
    await admin.from('email_mensagens').insert({
      thread_id: threadId,
      gmail_message_id: `imap:${caixaId}:enviada:${messageId}`,
      message_id: messageId,
      from_email: caixa.email_caixa,
      from_nome: caixa.nome_exibicao,
      to_emails: para.map((email: string) => ({ email, name: '' })),
      cc_emails: cc.map((email: string) => ({ email, name: '' })),
      assunto: assuntoFinal,
      snippet: trecho,
      body_html,
      body_text: null,
      enviado_em: quando,
      is_outgoing: true,
      in_reply_to: emRespostaA ? emRespostaA.replace(/[<>]/g, '') : null,
      references_header: referencias || null,
      labels: ['\\Seen'],
      enviado_por_user_id: user.id,
    });

    return responder({ success: true, thread_id: threadId, message_id: messageId, aviso: avisoAppend });
  } catch (e) {
    const { recado } = classificarErro(e);
    return responder({ success: false, error: recado || (e as Error).message });
  }
});
