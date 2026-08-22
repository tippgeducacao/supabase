// gmail-sync-inbox: sincroniza mensagens recentes (inbox + sent), incremental via history
//
// Sincroniza em DOIS sentidos. Mensagem nova desce pelo history; ESTADO (lida,
// favoritada, arquivada) desce por RECONCILIAÇÃO: o Gmail é perguntado quem está
// não lido/favoritado e o banco é alinhado com a resposta.
//
// ⚠️ Antes disso o sync era de mão ÚNICA: ler no sistema limpava o UNREAD lá, mas
// ler no Gmail nunca voltava pra cá e o contador travava pra sempre. Em agosto/2026
// havia caixa com 3.749 de 3.817 conversas marcadas como não lidas por isso.
//
// Reconciliar por CONSULTA, e não pelos eventos `labelAdded`/`labelRemoved` do
// history, é decisão consciente: o history entrega evento por MENSAGEM, então um
// "marcar tudo como lido" no Gmail viraria centenas de updates linha a linha dentro
// do orçamento de ~60s da edge. A consulta devolve o conjunto pronto, do tamanho do
// que está realmente não lido — e ainda cobre o que é mais velho que a janela de
// ~30 dias do history, que evento nenhum alcança.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { ensureToken, parsePayload, parseHeaders, parseAddress, parseAddressList, isTokenRevokedError, markCaixaTokenRevoked, markCaixaTransient, isScopeInsufficientError, markCaixaEscopoInsuficiente } from '../_shared/gmail.ts';
import { diferencaDeArquivadas, diferencaDeSinalizador, emLotes, LOTE_FILTRO_IN } from '../_shared/emailReconciliacao.ts';

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

/**
 * IDs de THREAD de uma query do Gmail, com o aviso de a lista ter vindo inteira.
 *
 * ⚠️ O `completo` não é enfeite: a reconciliação usa a lista como "tudo que está
 * neste estado". Se a paginação for cortada no meio, o que ficou de fora seria
 * desmarcado em MASSA — sumiria da frente da pessoa o e-mail que ela ainda não
 * leu. Lista truncada ⇒ não reconcilia nada.
 *
 * ⚠️ **Usa `/threads`, não `/messages`, e a diferença não é performance — é a
 * UNIDADE do teto.** `/messages` devolve uma linha por MENSAGEM, então o teto
 * contava mensagens enquanto a comparação é por CONVERSA. Na caixa do rafael
 * (3.751 conversas não lidas, mais de 5.000 mensagens dentro delas) o teto de
 * 5.000 estourava e a caixa era pulada por `lista_truncada` — justamente a que
 * mais precisava. Com `/threads` o teto está na mesma moeda do que se compara, e
 * ainda cabe mais conversa por página.
 */
async function gmailThreadIdsDaQuery(
  query: string,
  token: string,
  maxTotal = 20000,
  pageSize = 500,
): Promise<{ threadIds: Set<string>; completo: boolean }> {
  const threadIds = new Set<string>();
  let pageToken: string | undefined = undefined;
  do {
    const params = new URLSearchParams({ q: query, maxResults: String(pageSize) });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await gmail(`/threads?${params.toString()}`, token);
    const threads: { id: string }[] = res.threads || [];
    for (const t of threads) if (t.id) threadIds.add(t.id);
    pageToken = res.nextPageToken;
    if (threadIds.size >= maxTotal) return { threadIds, completo: !pageToken };
  } while (pageToken);
  return { threadIds, completo: true };
}


/**
 * Lê uma consulta inteira em páginas — PostgREST corta em 1.000 por padrão.
 *
 * Estoura no erro em vez de devolver o que deu: um `select` que falhou no meio
 * viraria "o banco não tem nada marcado", e quem chama trataria isso como estado
 * legítimo. Erro aqui derruba o sync DESTA caixa e cai no catch do laço, que já
 * registra e segue para a próxima.
 */
async function lerTudo(montarQuery: (de: number, ate: number) => any) {
  const linhas: any[] = [];
  for (let de = 0; ; de += 1000) {
    const { data, error } = await montarQuery(de, de + 999);
    if (error) throw new Error(`leitura_paginada_falhou: ${error.message}`);
    if (!data?.length) break;
    linhas.push(...data);
    if (data.length < 1000) break;
  }
  return linhas;
}

/**
 * Alinha uma coluna booleana da thread com o conjunto que o Gmail devolveu.
 *
 * A comparação é feita pelo CONJUNTO VERDADEIRO dos dois lados (o que está não
 * lido / favoritado) — e ele é pequeno, então o custo acompanha o tamanho do que
 * está pendente, não o tamanho da caixa. Converge sozinho: a primeira rodada
 * paga o passivo, as seguintes comparam dois punhados.
 */
async function alinharSinalizador(
  admin: any,
  caixaId: string,
  coluna: 'nao_lido' | 'favoritado',
  verdadeirasNoGmail: Set<string>,
  soInbox: boolean,
) {
  const marcadas = await lerTudo((de, ate) => {
    let q = admin.from('email_threads')
      .select('id, gmail_thread_id')
      .eq('caixa_id', caixaId)
      .eq(coluna, true);
    if (soInbox) q = q.eq('pasta', 'inbox');
    return q.range(de, ate);
  });

  const { desmarcar, marcar } = diferencaDeSinalizador(
    marcadas.map((t) => ({ id: t.id, chave: t.gmail_thread_id })),
    verdadeirasNoGmail,
  );

  const quando = new Date().toISOString();
  for (const lote of emLotes(desmarcar, LOTE_FILTRO_IN)) {
    await admin.from('email_threads')
      .update({ [coluna]: false, updated_at: quando })
      .in('id', lote);
  }
  for (const lote of emLotes(marcar, LOTE_FILTRO_IN)) {
    // Escopado à caixa: `gmail_thread_id` não é único entre caixas — a mesma
    // conversa aparece nas duas quando duas caixas nossas estão na thread.
    let q = admin.from('email_threads')
      .update({ [coluna]: true, updated_at: quando })
      .eq('caixa_id', caixaId)
      .in('gmail_thread_id', lote);
    // Conversa que o sistema mandou pra lixeira/spam também foi pra lá no Gmail:
    // não deve voltar a acender por aqui.
    if (soInbox) q = q.eq('pasta', 'inbox');
    await q;
  }
  return { desmarcadas: desmarcar.length, marcadas: marcar.length };
}

/**
 * Alinha `arquivado` com a caixa de entrada do Gmail.
 *
 * Separada das outras porque é a CARA: o conjunto verdadeiro aqui é "não está na
 * inbox", que é o complemento — obriga a listar a inbox INTEIRA do Gmail e a ler
 * todas as threads da caixa. Por isso só roda no sync manual/inicial, não nas
 * rodadas de 2 em 2 minutos. `arquivado` não decide o que a lista mostra (isso é
 * a coluna `pasta`); ele alimenta o contador por caixa e o alerta de "precisa de
 * resposta", que aguentam ficar um pouco atrás.
 */
async function alinharArquivadas(admin: any, caixaId: string, token: string) {
  const { threadIds: naInboxDoGmail, completo } = await gmailThreadIdsDaQuery('in:inbox', token);
  if (!completo) return { alinhado: false, motivo: 'lista_truncada' };

  const todas = await lerTudo((de, ate) =>
    admin.from('email_threads')
      .select('id, gmail_thread_id, arquivado')
      .eq('caixa_id', caixaId)
      .range(de, ate));

  const { paraArquivar, paraDesarquivar } = diferencaDeArquivadas(
    todas.map((t) => ({ id: t.id, chave: t.gmail_thread_id, arquivado: t.arquivado })),
    naInboxDoGmail,
  );

  const quando = new Date().toISOString();
  for (const [alvo, ids] of [[true, paraArquivar], [false, paraDesarquivar]] as [boolean, string[]][]) {
    for (const lote of emLotes(ids, LOTE_FILTRO_IN)) {
      await admin.from('email_threads')
        .update({ arquivado: alvo, updated_at: quando })
        .in('id', lote);
    }
  }
  return { alinhado: true, arquivadas: paraArquivar.length, desarquivadas: paraDesarquivar.length };
}

/** O Gmail é a fonte da verdade do estado; aqui o banco é trazido pra ele. */
async function reconciliarEstado(
  admin: any,
  caixaId: string,
  token: string,
  incluirArquivadas: boolean,
) {
  const resultado: Record<string, unknown> = {};

  const naoLidas = await gmailThreadIdsDaQuery('in:inbox is:unread', token);
  resultado.nao_lidas = naoLidas.completo
    ? await alinharSinalizador(admin, caixaId, 'nao_lido', naoLidas.threadIds, true)
    : 'lista_truncada';

  const favoritas = await gmailThreadIdsDaQuery('is:starred', token);
  resultado.favoritas = favoritas.completo
    ? await alinharSinalizador(admin, caixaId, 'favoritado', favoritas.threadIds, false)
    : 'lista_truncada';

  if (incluirArquivadas) resultado.arquivadas = await alinharArquivadas(admin, caixaId, token);
  return resultado;
}

async function syncCaixa(admin: any, caixaId: string, forceInitial: boolean, sozinha: boolean) {
  const { data: caixa, error: cErr } = await admin
    .from('email_caixas_conectadas')
    .select('*, integ:calendar_integrations(*)')
    .eq('id', caixaId)
    .maybeSingle();
  if (cErr || !caixa) throw new Error('caixa não encontrada');
  if (!caixa.ativo) return { skipped: true };

  // Caixa IMAP tem motor próprio (imap-sync-inbox). Sem esta guarda o motor do
  // Gmail tenta refrescar um token que não existe e erra a cada 2 minutos — e uma
  // caixa CONVERTIDA de gmail para imap ainda carrega o calendar_integration_id
  // antigo, então nem a ausência de integração serve de filtro.
  if (caixa.provider === 'imap') return { skipped: true, motivo: 'caixa_imap' };

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

  // Reconcilia DEPOIS de gravar o progresso, e sem poder derrubar a rodada:
  // mensagem nova vale mais que contador. Se a reconciliação estourar (ou o
  // worker morrer no meio dela), o history_id já avançou e a próxima rodada
  // tenta de novo — em vez de reprocessar o sync inteiro por causa do contador.
  //
  // Também não roda durante o backlog (o `return` acima): a caixa ainda vai mudar
  // muito nesta e nas próximas rodadas, seria orçamento gasto à toa.
  //
  // A varredura cara (arquivadas) fica pro sync de UMA caixa só — o botão de
  // atualizar da tela e a carga inicial. Aí não há teto global e alguém está
  // esperando por ela; no cron de 2 em 2 minutos sairia caro em todas as caixas
  // de uma vez, e não é ela que decide o que a lista mostra.
  let estado: unknown;
  try {
    const varreduraCompleta = forceInitial || sozinha || !caixa.history_id;
    estado = await reconciliarEstado(admin, caixa.id, token, varreduraCompleta);
    // O cron DESCARTA a resposta da function, então sem este log a única forma de
    // saber que uma caixa foi pulada por `lista_truncada` era invocar na mão. Foi
    // o que custou uma rodada de investigação em 2026-08-22.
    console.log('reconciliação', caixa.email_caixa, JSON.stringify(estado));
  } catch (e) {
    console.warn('falha ao reconciliar estado', caixa.id, e);
    estado = { erro: (e as Error).message };
  }

  return { inserted, history_id: newHistoryId, estado };
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
        .eq('provider', 'gmail')
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
        const r = await syncCaixa(admin, id, !!initial, !!caixa_id);
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
