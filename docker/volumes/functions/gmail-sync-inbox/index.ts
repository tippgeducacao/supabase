// gmail-sync-inbox: sincroniza mensagens recentes (inbox + sent), incremental via history
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { ensureToken, parsePayload, parseHeaders, parseAddress, parseAddressList, isTokenRevokedError, markCaixaTokenRevoked, markCaixaTransient, isScopeInsufficientError, markCaixaEscopoInsuficiente } from '../_shared/gmail.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

async function gmail(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`gmail_${res.status}: ${text}`);
  }
  return res.json();
}

/**
 * Lista todas as mensagens de uma query Gmail, percorrendo pageToken até esgotar
 * ou bater `maxTotal`. Útil pro fallback de sync inicial quando o history_id
 * expirou (desconexão > 30 dias) — sem paginação, ficaríamos limitados a 1 página.
 */
async function gmailListAll(
  query: string,
  token: string,
  maxTotal = 2000,
  pageSize = 500,
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined = undefined;
  // Salvaguarda contra loops infinitos
  let iterations = 0;
  const MAX_ITERATIONS = Math.ceil(maxTotal / pageSize) + 2;
  while (ids.length < maxTotal && iterations < MAX_ITERATIONS) {
    iterations++;
    const params = new URLSearchParams({ q: query, maxResults: String(pageSize) });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await gmail(`/messages?${params.toString()}`, token);
    const msgs: { id: string }[] = res.messages || [];
    for (const m of msgs) {
      if (m.id) ids.push(m.id);
      if (ids.length >= maxTotal) break;
    }
    if (!res.nextPageToken || msgs.length === 0) break;
    pageToken = res.nextPageToken;
  }
  return ids;
}

async function syncCaixa(admin: any, caixaId: string, forceInitial: boolean) {
  const { data: caixa, error: cErr } = await admin
    .from('email_caixas_conectadas')
    .select('*, integ:calendar_integrations(*)')
    .eq('id', caixaId)
    .maybeSingle();
  if (cErr || !caixa) throw new Error('caixa não encontrada');
  if (!caixa.ativo) return { skipped: true };

  // Erros PERMANENTES (exigem reconectar) bloqueiam próximas tentativas:
  // `token_revoked` (Google derrubou o grant) e `scope_insuficiente` (token
  // válido, mas sem escopo Gmail). `transient` é só sinal de saúde, não bloqueia.
  if ((caixa.last_sync_error === 'token_revoked' || caixa.last_sync_error === 'scope_insuficiente') && !forceInitial) {
    return { skipped: true, reason: caixa.last_sync_error };
  }

  let token: string;
  try {
    token = await ensureToken(admin, caixa.integ);
  } catch (e) {
    // Diferencia revogação real (Google disse `invalid_grant` etc) de blip de
    // rede/5xx — antes, TODA falha virava token_revoked e matava a caixa.
    if (isTokenRevokedError(e)) {
      await markCaixaTokenRevoked(admin, caixa.id);
    } else {
      await markCaixaTransient(admin, caixa.id);
    }
    throw e;
  }

  let messageIds: string[] = [];
  let newHistoryId: string | null = null;

  if (caixa.history_id && !forceInitial) {
    // Incremental: pagina o history API para pegar TUDO que apareceu desde a última sync.
    // Crítico em caixas que ficaram desconectadas por dias acumulando volume.
    try {
      let pageToken: string | undefined = undefined;
      let pages = 0;
      const MAX_PAGES = 20; // teto de segurança (até ~10k mensagens)
      do {
        const params = new URLSearchParams({
          startHistoryId: String(caixa.history_id),
          historyTypes: 'messageAdded',
          maxResults: '500',
        });
        if (pageToken) params.set('pageToken', pageToken);
        const hist = await gmail(`/history?${params.toString()}`, token);
        newHistoryId = hist.historyId || newHistoryId || caixa.history_id;
        for (const h of hist.history || []) {
          for (const m of h.messagesAdded || []) {
            if (m.message?.id) messageIds.push(m.message.id);
          }
        }
        pageToken = hist.nextPageToken;
        pages++;
      } while (pageToken && pages < MAX_PAGES);
    } catch (e) {
      console.warn('history failed, doing fallback list', e);
      forceInitial = true;
    }
  }

  if (forceInitial || !caixa.history_id) {
    // Sync inicial / fallback: pagina o INBOX inteiro e os SENT dos últimos 90 dias.
    // Limite total alto pra cobrir caixas que ficaram dias desconectadas.
    const INBOX_MAX = 2000;   // ~2k emails é mais que suficiente pra grande maioria das caixas
    const SENT_MAX = 1000;
    const [inboxIds, sentIds] = await Promise.all([
      gmailListAll('in:inbox', token, INBOX_MAX),
      gmailListAll('in:sent newer_than:90d', token, SENT_MAX),
    ]);
    messageIds = [...inboxIds, ...sentIds];
  }

  messageIds = [...new Set(messageIds)];

  // Pré-carrega (em lotes) quais já existem, pra pular sem 1 query por mensagem.
  const existingSet = new Set<string>();
  for (let i = 0; i < messageIds.length; i += 300) {
    const chunk = messageIds.slice(i, i + 300);
    const { data: rows } = await admin
      .from('email_mensagens')
      .select('gmail_message_id')
      .in('gmail_message_id', chunk);
    for (const r of rows || []) existingSet.add(r.gmail_message_id);
  }

  // Processa no máximo MAX_NEW_POR_RUN mensagens NOVAS por invocação, pra não
  // estourar o wall-clock do edge. O backlog completo é puxado ao longo de
  // várias rodadas do cron (cada uma continua de onde parou, pulando as já
  // inseridas). Enquanto sobrar backlog, NÃO avançamos o history_id — assim o
  // sync não "fecha" no meio e nenhum email antigo é perdido.
  // Edge-runtime self-hosted mata o worker em ~60s. Com a lista limitada
  // (history_id resetado quando o delta é grande), cada msg sai ~0,25-0,4s,
  // então 100/rodada cabe com folga e enche o backlog rápido.
  const MAX_NEW_POR_RUN = 100;
  let processedNew = 0;
  let hitCap = false;

  let inserted = 0;
  for (const mid of messageIds) {
    if (existingSet.has(mid)) continue;

    let msg: any;
    try {
      msg = await gmail(`/messages/${mid}?format=full`, token);
    } catch (e) {
      console.error('fetch msg failed', mid, e);
      continue;
    }

    const headers = parseHeaders(msg.payload?.headers || []);
    const fromP = parseAddress(headers['from']);
    const toList = parseAddressList(headers['to']);
    const ccList = parseAddressList(headers['cc']);
    const subject = headers['subject'] || '(sem assunto)';
    const messageIdHeader = headers['message-id'] || null;
    const inReplyTo = headers['in-reply-to'] || null;
    const refs = headers['references'] || null;
    const dateHeader = headers['date'] ? new Date(headers['date']).toISOString() : new Date(parseInt(msg.internalDate || '0')).toISOString();
    const labelIds: string[] = msg.labelIds || [];
    // Outgoing = label SENT do Gmail (mais confiável do que comparar emails)
    const isOutgoing = labelIds.includes('SENT') || fromP.email === caixa.email_caixa.toLowerCase();
    const parsed = parsePayload(msg.payload);

    // Upsert thread
    const { data: existingThread } = await admin
      .from('email_threads')
      .select('id, task_id, ultima_mensagem_outgoing_em')
      .eq('caixa_id', caixa.id)
      .eq('gmail_thread_id', msg.threadId)
      .maybeSingle();

    let threadId: string;
    if (existingThread) {
      threadId = existingThread.id;
      const patch: any = {
        assunto: subject,
        snippet: msg.snippet,
        ultima_mensagem_em: dateHeader,
        nao_lido: labelIds.includes('UNREAD'),
        arquivado: !labelIds.includes('INBOX'),
        favoritado: labelIds.includes('STARRED'),
        updated_at: new Date().toISOString(),
      };
      if (isOutgoing) {
        const prev = existingThread.ultima_mensagem_outgoing_em ? new Date(existingThread.ultima_mensagem_outgoing_em).getTime() : 0;
        if (new Date(dateHeader).getTime() > prev) patch.ultima_mensagem_outgoing_em = dateHeader;
      }
      await admin.from('email_threads').update(patch).eq('id', threadId);
    } else {
      // Auto-vincular ao card via In-Reply-To matchando emails_enviados outgoing
      let autoTaskId: string | null = null;
      if (inReplyTo) {
        const cleanInReplyTo = inReplyTo.replace(/[<>]/g, '');
        const { data: prevEnv } = await admin
          .from('emails_enviados')
          .select('contexto_id, contexto_tipo')
          .eq('gmail_message_id', cleanInReplyTo)
          .maybeSingle();
        if (prevEnv?.contexto_tipo === 'task' && prevEnv?.contexto_id) {
          autoTaskId = prevEnv.contexto_id;
        }
      }

      const participantes = [fromP, ...toList, ...ccList].filter(p => p.email);
      const { data: newThread, error: tErr } = await admin
        .from('email_threads')
        .insert({
          caixa_id: caixa.id,
          gmail_thread_id: msg.threadId,
          assunto: subject,
          snippet: msg.snippet,
          participantes,
          ultima_mensagem_em: dateHeader,
          ultima_mensagem_outgoing_em: isOutgoing ? dateHeader : null,
          nao_lido: labelIds.includes('UNREAD'),
          arquivado: !labelIds.includes('INBOX'),
          favoritado: labelIds.includes('STARRED'),
          task_id: autoTaskId,
        })
        .select('id')
        .single();
      if (tErr) { console.error('thread insert', tErr); continue; }
      threadId = newThread.id;
    }

    // Insert mensagem
    const { data: insertedMsg, error: mErr } = await admin
      .from('email_mensagens')
      .insert({
        thread_id: threadId,
        gmail_message_id: mid,
        from_email: fromP.email,
        from_nome: fromP.name,
        to_emails: toList,
        cc_emails: ccList,
        assunto: subject,
        snippet: msg.snippet,
        body_html: parsed.html,
        body_text: parsed.text,
        enviado_em: dateHeader,
        is_outgoing: isOutgoing,
        in_reply_to: inReplyTo ? inReplyTo.replace(/[<>]/g, '') : null,
        references_header: refs,
        labels: labelIds,
      })
      .select('id')
      .single();
    if (mErr) { console.error('msg insert', mErr); continue; }

    // Anexos metadata
    if (parsed.attachments.length && insertedMsg) {
      await admin.from('email_anexos').insert(
        parsed.attachments.map(a => ({
          mensagem_id: insertedMsg.id,
          filename: a.filename,
          mime_type: a.mimeType,
          size_bytes: a.size,
          gmail_attachment_id: a.attachmentId,
        }))
      );
    }
    inserted++;
    processedNew++;
    if (processedNew >= MAX_NEW_POR_RUN) { hitCap = true; break; }
  }

  // Ainda há backlog (bateu o teto deste lote): NÃO avança o history_id, só
  // marca progresso e limpa o erro. A próxima rodada do cron continua de onde
  // parou (pulando as já inseridas). Retorna 200 — sem toast de erro.
  if (hitCap) {
    await admin.from('email_caixas_conectadas').update({
      last_sync_at: new Date().toISOString(),
      last_sync_error: null,
    }).eq('id', caixa.id);
    return { inserted, partial: true };
  }

  // Backlog terminado (ou sync incremental concluído): fixa o history_id e
  // passa a sync incremental nas próximas rodadas.
  if (!newHistoryId) {
    try {
      const profile = await gmail('/profile', token);
      newHistoryId = profile.historyId;
    } catch {}
  }
  await admin.from('email_caixas_conectadas').update({
    history_id: newHistoryId || caixa.history_id,
    last_sync_at: new Date().toISOString(),
    last_sync_error: null,
  }).eq('id', caixa.id);

  return { inserted, history_id: newHistoryId };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const { caixa_id, initial } = body;

    let caixaIds: string[];
    if (caixa_id) {
      caixaIds = [caixa_id];
    } else {
      // Ordena pela última sync DESC: caixas saudáveis (sync recente, incremental
      // rápido) primeiro; caixas com backlog/atrasadas (ex.: recém-reconectadas)
      // por último — assim uma caixa pesada não estoura o wall-clock antes das
      // saudáveis sincronizarem. O backlog é puxado nas próximas rodadas.
      const { data } = await admin
        .from('email_caixas_conectadas')
        .select('id')
        .eq('ativo', true)
        .order('last_sync_at', { ascending: false, nullsFirst: false });
      caixaIds = (data || []).map((c: any) => c.id);
    }

    // Teto global de mensagens por invocação. Sem caixa_id (cron de todas as
    // caixas), evita estourar o wall-clock quando várias têm backlog: as que
    // não couberem nesta rodada são puxadas na próxima. Com caixa_id (clique
    // manual numa caixa) processa essa caixa sem teto global.
    const GLOBAL_MAX = caixa_id ? Infinity : 100;
    let totalInserido = 0;
    const results: any[] = [];
    for (const id of caixaIds) {
      try {
        const r = await syncCaixa(admin, id, !!initial);
        results.push({ caixa_id: id, ...r });
        totalInserido += (r as any)?.inserted || 0;
      } catch (e) {
        console.error('sync caixa', id, e);
        // 403 do Gmail por falta de escopo: permanente. Marca a caixa (banner de
        // reconexão no front) em vez de repetir o mesmo 403 a cada rodada do cron.
        if (isScopeInsufficientError(e)) await markCaixaEscopoInsuficiente(admin, id);
        results.push({ caixa_id: id, error: (e as Error).message });
      }
      if (totalInserido >= GLOBAL_MAX) {
        results.push({ stopped: 'global_budget', totalInserido });
        break;
      }
    }
    return new Response(JSON.stringify({ success: true, results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: (e as Error).message }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
