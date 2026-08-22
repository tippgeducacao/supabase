// imap-sync-inbox: espelho do gmail-sync-inbox para caixas IMAP.
//
// Incremental por UID, em DUAS pontas e nesta ordem de prioridade:
//   1. TOPO      — UID > `ultimo_uid`: o que acabou de chegar. Sempre primeiro.
//   2. BACKFILL  — UID < `uid_backfill`, descendo: o histórico, com o tempo que sobrar.
//
// ⚠️ Um ponteiro só NÃO serve, e o motivo não é performance. Subindo do UID 1 para
// frente, o e-mail que acabou de chegar é o que tem o MAIOR UID — ou seja, o ÚLTIMO
// a ser processado. Numa caixa de 1.373 mensagens com o ponteiro em 481, e-mail novo
// levava ~30 min para aparecer; em caixa grande, dias. Foi exatamente o relato:
// "o e-mail chegou no meu webmail mas não chegou aqui".
//
// Ponteiros são por PASTA, porque INBOX e Enviados têm numeração independente.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { chaveDaThread, parsearMensagem, resumo } from '../_shared/imap/mime.ts';
import { abrirSessao, carregarConfig, limparErro, marcarErro, classificarErro } from '../_shared/imap/caixa.ts';
import { pontoDePartida } from '../_shared/imap/ponteiros.ts';
import type { SessaoImap } from '../_shared/imap/conexao.ts';
import { diferencaDeSinalizador, emLotes, LOTE_FILTRO_IN } from '../_shared/emailReconciliacao.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// O worker do edge-runtime self-hosted é morto por volta de 60s (ver comentário
// equivalente no gmail-sync-inbox). Paramos ANTES disso e deixamos o resto do
// backlog para a próxima rodada do cron — o ponteiro por UID retoma exatamente
// de onde parou, sem perder nem repetir mensagem.
const ORCAMENTO_MS = 42_000;
const LOTE_FETCH = 15;
const MAX_POR_PASTA_POR_RODADA = 60;

interface Resultado {
  caixa_id: string;
  inseridas: number;
  parcial: boolean;
  erro?: string;
}

const agora = () => Date.now();

async function guardarAnexos(admin: any, mensagemId: string, caixaId: string, anexos: {
  filename: string; mimeType: string; size: number; conteudo: Uint8Array;
}[]) {
  for (const anexo of anexos) {
    // Diferente do Gmail (que busca sob demanda), aqui o corpo INTEIRO já veio no
    // FETCH — reabrir uma conexão IMAP depois só para buscar o anexo seria mais
    // caro do que guardá-lo agora. O front então usa a mesma gmail-download-attachment,
    // que devolve URL assinada direto quando storage_path está preenchido.
    const caminho = `${caixaId}/${mensagemId}/${anexo.filename}`;
    const { error: erroUpload } = await admin.storage
      .from('email-anexos')
      .upload(caminho, anexo.conteudo, { contentType: anexo.mimeType, upsert: true });

    await admin.from('email_anexos').insert({
      mensagem_id: mensagemId,
      filename: anexo.filename,
      mime_type: anexo.mimeType,
      size_bytes: anexo.size,
      storage_path: erroUpload ? null : caminho,
    });
  }
}

/**
 * Processa UM trecho de UMA pasta.
 *
 * `modo: 'topo'` pega o que chegou DEPOIS de `fronteira` (crescente); `'backfill'`
 * pega o que existe ANTES dela (decrescente). A pasta já vem selecionada por quem
 * chama — os dois modos rodam na mesma sessão, e reselecionar custa um round-trip.
 */
async function sincronizarPasta(
  admin: any,
  caixa: any,
  sessao: SessaoImap,
  opcoes: {
    apelido: 'inbox' | 'sent';
    modo: 'topo' | 'backfill';
    fronteira: number;
    limite: number;
  },
): Promise<{ fronteira: number; inseridas: number; parcial: boolean }> {
  const uids = opcoes.modo === 'topo'
    ? await sessao.cliente.uidsDesde(opcoes.fronteira)
    : await sessao.cliente.uidsAte(opcoes.fronteira);

  if (!uids.length) {
    // Backfill sem nada abaixo = histórico completo. O 0 é o sinal de "acabou",
    // e é o que impede a varredura de recomeçar do topo para sempre.
    return {
      fronteira: opcoes.modo === 'backfill' ? 0 : opcoes.fronteira,
      inseridas: 0,
      parcial: false,
    };
  }

  const aProcessar = uids.slice(0, opcoes.limite);
  const parcial = uids.length > aProcessar.length;
  let inseridas = 0;
  // No topo a fronteira SOBE (maior processado); no backfill ela DESCE (menor).
  let fronteira = opcoes.fronteira;
  const avancar = (uid: number) => {
    fronteira = opcoes.modo === 'topo' ? Math.max(fronteira, uid) : Math.min(fronteira, uid);
  };

  for (let i = 0; i < aProcessar.length; i += LOTE_FETCH) {
    if (agora() - INICIO > ORCAMENTO_MS) {
      return { fronteira, inseridas, parcial: true };
    }

    const lote = aProcessar.slice(i, i + LOTE_FETCH);

    // Descarta o que já está gravado ANTES de baixar. O FETCH traz o corpo inteiro
    // (é o que permite guardar o anexo na hora), então perguntar ao banco primeiro
    // troca 15 downloads por uma consulta — e é o que faz o backfill atravessar de
    // graça um trecho que já foi baixado numa rodada anterior.
    const chavesDoLote = lote.map((uid) => `imap:${caixa.id}:${opcoes.apelido}:${uid}`);
    const { data: gravadas } = await admin
      .from('email_mensagens')
      .select('gmail_message_id')
      .in('gmail_message_id', chavesDoLote);
    const jaTem = new Set((gravadas || []).map((m: any) => m.gmail_message_id));
    const faltando = lote.filter((uid) => !jaTem.has(`imap:${caixa.id}:${opcoes.apelido}:${uid}`));
    for (const uid of lote) avancar(uid);
    if (!faltando.length) continue;

    const mensagens = await sessao.cliente.buscarMensagens(faltando);

    for (const bruta of mensagens) {
      const chave = `imap:${caixa.id}:${opcoes.apelido}:${bruta.uid}`;

      const { data: jaExiste } = await admin
        .from('email_mensagens')
        .select('id')
        .eq('gmail_message_id', chave)
        .maybeSingle();
      if (jaExiste) { avancar(bruta.uid); continue; }

      let msg;
      try {
        msg = await parsearMensagem(bruta.bruto);
      } catch (e) {
        console.error(`falha ao parsear uid ${bruta.uid}`, e);
        avancar(bruta.uid);
        continue;
      }

      const chaveThread = chaveDaThread(msg) || chave;
      const assunto = msg.assunto || '(sem assunto)';
      const quando = msg.data ?? new Date().toISOString();
      const naoLido = !bruta.flags.some((f) => f.toLowerCase() === '\\seen');
      const ehSaida = opcoes.apelido === 'sent'
        || msg.de.email === String(caixa.email_caixa).toLowerCase();
      const trecho = resumo(msg.text, msg.html);

      // ── thread ──────────────────────────────────────────────────────────
      const { data: threadExistente } = await admin
        .from('email_threads')
        .select('id, ultima_mensagem_outgoing_em')
        .eq('caixa_id', caixa.id)
        .eq('gmail_thread_id', chaveThread)
        .maybeSingle();

      let threadId: string;
      if (threadExistente) {
        threadId = threadExistente.id;
        const patch: Record<string, unknown> = {
          assunto,
          snippet: trecho,
          ultima_mensagem_em: quando,
          updated_at: new Date().toISOString(),
        };
        if (!ehSaida && naoLido) patch.nao_lido = true;
        if (ehSaida) {
          const anterior = threadExistente.ultima_mensagem_outgoing_em
            ? new Date(threadExistente.ultima_mensagem_outgoing_em).getTime() : 0;
          if (new Date(quando).getTime() > anterior) patch.ultima_mensagem_outgoing_em = quando;
        }
        await admin.from('email_threads').update(patch).eq('id', threadId);
      } else {
        const participantes = [msg.de, ...msg.para, ...msg.cc].filter((p) => p.email);
        const { data: nova, error } = await admin
          .from('email_threads')
          .insert({
            caixa_id: caixa.id,
            gmail_thread_id: chaveThread,
            assunto,
            snippet: trecho,
            participantes,
            ultima_mensagem_em: quando,
            ultima_mensagem_outgoing_em: ehSaida ? quando : null,
            nao_lido: !ehSaida && naoLido,
            pasta: 'inbox',
          })
          .select('id')
          .single();
        if (error) { console.error('thread insert', error); continue; }
        threadId = nova.id;
      }

      // ── mensagem ────────────────────────────────────────────────────────
      // Guarda contra duplicar o que NÓS enviamos: o imap-send já gravou a
      // mensagem localmente e a colocou nos Enviados do servidor via APPEND.
      // Quando o sync lê essa mesma mensagem de volta, ela é reconhecida pelo
      // Message-ID dentro da própria thread e só ganha o UID real.
      if (msg.messageId) {
        const { data: nossa } = await admin
          .from('email_mensagens')
          .select('id')
          .eq('thread_id', threadId)
          .eq('message_id', msg.messageId)
          .maybeSingle();
        if (nossa) {
          await admin.from('email_mensagens')
            .update({ gmail_message_id: chave, imap_uid: bruta.uid })
            .eq('id', nossa.id);
          avancar(bruta.uid);
          continue;
        }
      }

      const { data: inserida, error: erroMsg } = await admin
        .from('email_mensagens')
        .insert({
          thread_id: threadId,
          gmail_message_id: chave,
          imap_uid: bruta.uid,
          message_id: msg.messageId || null,
          from_email: msg.de.email,
          from_nome: msg.de.name,
          to_emails: msg.para,
          cc_emails: msg.cc,
          assunto,
          snippet: trecho,
          body_html: msg.html,
          body_text: msg.text,
          enviado_em: quando,
          is_outgoing: ehSaida,
          in_reply_to: msg.inReplyTo ? msg.inReplyTo.replace(/[<>]/g, '') : null,
          references_header: msg.references || null,
          labels: bruta.flags,
        })
        .select('id')
        .single();
      if (erroMsg) { console.error('msg insert', erroMsg); continue; }

      if (msg.anexos.length) {
        await guardarAnexos(admin, inserida.id, caixa.id, msg.anexos);
      }

      inseridas++;
      avancar(bruta.uid);
    }
  }

  return { fronteira, inseridas, parcial };
}

/**
 * Reconcilia o "não lido" da INBOX contra o servidor, que é a fonte da verdade.
 *
 * ⚠️ Espelha o `reconciliarNaoLidos` do motor do Gmail e existe pelo mesmo motivo:
 * o sync só sabia LIGAR o `nao_lido` (`if (!ehSaida && naoLido) patch.nao_lido = true`),
 * nunca desligar. Quem lia no webmail deixava a conversa marcada como não lida aqui
 * pra sempre — a caixa tecnologia.inovacao tinha 1.273 de 1.393 assim.
 *
 * Exige a INBOX já SELECIONADA por quem chama (UID é por pasta — ler UID com a
 * pasta errada selecionada opera na mensagem errada, em silêncio).
 */
async function reconciliarNaoLidosImap(admin: any, caixa: any, sessao: SessaoImap) {
  const uidsNaoLidos = await sessao.cliente.uidsNaoLidos();

  // UID -> a chave com que a mensagem foi gravada. A pasta faz parte da chave
  // justamente porque o UID sozinho não diz de onde veio.
  const chaves = uidsNaoLidos.map((uid) => `imap:${caixa.id}:inbox:${uid}`);

  // ⚠️ Este conjunto é a lista do que CONTINUA não lido. Se uma das consultas
  // falhasse e ele saísse incompleto, tudo que ficou de fora seria marcado como
  // LIDO — sumiria da frente da pessoa o e-mail que ela ainda não viu. Por isso
  // erro aqui ABORTA a reconciliação (o catch de quem chama só registra e segue),
  // em vez de virar um conjunto menor que passa por legítimo.
  const deveriaEstarNaoLida = new Set<string>();
  for (const lote of emLotes(chaves, LOTE_FILTRO_IN)) {
    const { data, error } = await admin
      .from('email_mensagens')
      .select('thread_id, is_outgoing')
      .in('gmail_message_id', lote);
    if (error) throw new Error(`traducao_uid_thread_falhou: ${error.message}`);
    // Mensagem de saída não conta como "não lida" — é a mesma regra do sync.
    for (const m of data || []) if (!m.is_outgoing) deveriaEstarNaoLida.add(m.thread_id);
  }

  const marcadas: { id: string }[] = [];
  for (let de = 0; ; de += 1000) {
    const { data, error } = await admin
      .from('email_threads')
      .select('id')
      .eq('caixa_id', caixa.id)
      .eq('pasta', 'inbox')
      .eq('nao_lido', true)
      .range(de, de + 999);
    if (error) throw new Error(`leitura_das_marcadas_falhou: ${error.message}`);
    if (!data?.length) break;
    marcadas.push(...data);
    if (data.length < 1000) break;
  }

  // Mesma régua do motor do Gmail. Aqui a "chave do servidor" é o próprio id da
  // thread: o IMAP não tem id de conversa, quem agrupa é o nosso `chaveDaThread`,
  // então a tradução UID -> thread já foi feita na consulta acima.
  const { desmarcar, marcar } = diferencaDeSinalizador(
    marcadas.map((t) => ({ id: t.id, chave: t.id })),
    deveriaEstarNaoLida,
  );

  const quando = new Date().toISOString();
  for (const lote of emLotes(desmarcar, LOTE_FILTRO_IN)) {
    await admin.from('email_threads')
      .update({ nao_lido: false, updated_at: quando })
      .in('id', lote);
  }
  for (const lote of emLotes(marcar, LOTE_FILTRO_IN)) {
    await admin.from('email_threads')
      .update({ nao_lido: true, updated_at: quando })
      .eq('pasta', 'inbox')
      .in('id', lote);
  }
  return { lidas: desmarcar.length, nao_lidas: marcar.length };
}

let INICIO = agora();

async function sincronizarCaixa(admin: any, caixaId: string): Promise<Resultado> {
  const { data: caixa } = await admin
    .from('email_caixas_conectadas')
    .select('*')
    .eq('id', caixaId)
    .maybeSingle();
  if (!caixa) throw new Error('caixa não encontrada');
  if (!caixa.ativo) return { caixa_id: caixaId, inseridas: 0, parcial: false };

  // Erro PERMANENTE bloqueia até alguém reconectar — martelar um servidor que
  // recusa a senha não melhora nada e ainda arrisca bloqueio por tentativa.
  if (String(caixa.last_sync_error || '').startsWith('auth_failed')) {
    return { caixa_id: caixaId, inseridas: 0, parcial: false, erro: 'auth_failed' };
  }

  const config = await carregarConfig(admin, caixaId);
  const sessao = await abrirSessao(config);
  try {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    let inseridas = 0;
    let parcial = false;

    // ── INBOX ────────────────────────────────────────────────────────────────
    const inbox = await varrerPasta(admin, caixa, sessao, {
      pasta: 'INBOX',
      apelido: 'inbox',
      teto: config.ultimo_uid,
      backfill: config.uid_backfill,
      uidValidityGuardado: config.uid_validity,
      orcamentoTopo: MAX_POR_PASTA_POR_RODADA,
      orcamentoBackfill: MAX_POR_PASTA_POR_RODADA,
    });
    patch.ultimo_uid = inbox.teto;
    patch.uid_backfill = inbox.backfill;
    patch.uid_validity = inbox.uidValidity;
    inseridas += inbox.inseridas;
    parcial = parcial || inbox.parcial;

    // Aqui e não depois: a INBOX ainda está selecionada (a pasta de Enviados só é
    // aberta abaixo), e UID vale por pasta. Fora do orçamento, fica pra próxima
    // rodada — reconciliar é convergente, atrasar dois minutos não custa nada.
    if (agora() - INICIO < ORCAMENTO_MS) {
      try {
        await reconciliarNaoLidosImap(admin, caixa, sessao);
      } catch (e) {
        // Não pode derrubar o sync: mensagem nova é mais importante que contador.
        console.warn('falha ao reconciliar não lidos', e);
      }
    }

    // ── Enviados ─────────────────────────────────────────────────────────────
    if (config.pasta_enviados && agora() - INICIO < ORCAMENTO_MS) {
      try {
        const enviados = await varrerPasta(admin, caixa, sessao, {
          pasta: config.pasta_enviados,
          apelido: 'sent',
          teto: config.ultimo_uid_enviados,
          backfill: config.uid_backfill_enviados,
          uidValidityGuardado: config.uid_validity_enviados,
          orcamentoTopo: Math.floor(MAX_POR_PASTA_POR_RODADA / 2),
          orcamentoBackfill: Math.floor(MAX_POR_PASTA_POR_RODADA / 4),
        });
        patch.ultimo_uid_enviados = enviados.teto;
        patch.uid_backfill_enviados = enviados.backfill;
        patch.uid_validity_enviados = enviados.uidValidity || null;
        inseridas += enviados.inseridas;
        parcial = parcial || enviados.parcial;
      } catch (e) {
        // Enviados é secundário: se a pasta sumiu ou mudou de nome, a INBOX não
        // pode deixar de sincronizar por causa disso.
        console.warn('falha na pasta de Enviados', e);
      }
    }

    await admin.from('email_caixa_imap_config').update(patch).eq('caixa_id', caixaId);
    await limparErro(admin, caixaId);
    return { caixa_id: caixaId, inseridas, parcial };
  } finally {
    await sessao.fechar();
  }
}

/**
 * Uma pasta inteira: primeiro o TOPO, depois o BACKFILL com o que sobrar.
 *
 * ⚠️ A ordem é a regra de negócio, não uma otimização. O topo é o e-mail que a
 * pessoa está esperando; o histórico pode levar horas sem incomodar ninguém.
 * Inverter isso é o bug que fez um e-mail recém-chegado não aparecer.
 */
async function varrerPasta(
  admin: any,
  caixa: any,
  sessao: SessaoImap,
  o: {
    pasta: string;
    apelido: 'inbox' | 'sent';
    teto: number;
    backfill: number | null;
    uidValidityGuardado: number | null;
    orcamentoTopo: number;
    orcamentoBackfill: number;
  },
): Promise<{ teto: number; backfill: number; uidValidity: number; inseridas: number; parcial: boolean }> {
  const estado = await sessao.cliente.selecionar(o.pasta);

  let teto = o.teto;
  let backfill = o.backfill;

  // A trava do IMAP. Se o servidor renumerou, todo UID guardado passou a apontar
  // para outra mensagem — insistir no ponteiro antigo gravaria conteúdo trocado
  // em silêncio, que é a pior falha possível aqui.
  if (o.uidValidityGuardado && o.uidValidityGuardado !== estado.uidValidity) {
    console.warn(`uidvalidity mudou em ${o.pasta} (${o.uidValidityGuardado} -> ${estado.uidValidity}); ressincronizando`);
    teto = 0;
    backfill = null;
  }

  // Caixa que nunca rodou com dois ponteiros: adota o UID mais alto do servidor
  // como teto e começa o histórico logo ACIMA dele, descendo. É isto que faz a
  // caixa nascer EM DIA — sem isso, a carga inicial teria de terminar antes de o
  // primeiro e-mail novo aparecer. A aritmética (e o ±1 que já custou uma
  // mensagem invisível) vive em `pontoDePartida`, com teste.
  const partida = pontoDePartida(estado.uidNext, teto, backfill);
  teto = partida.teto;
  backfill = partida.backfill;
  if (partida.adotou) {
    console.log(`caixa adotada em ${o.pasta}: teto=${teto}, histórico desce de ${backfill}`);
  }

  const topo = await sincronizarPasta(admin, caixa, sessao, {
    apelido: o.apelido, modo: 'topo', fronteira: teto, limite: o.orcamentoTopo,
  });

  let historico = { fronteira: backfill, inseridas: 0, parcial: false };
  const faltaHistorico = backfill > 1;
  if (faltaHistorico && agora() - INICIO < ORCAMENTO_MS) {
    historico = await sincronizarPasta(admin, caixa, sessao, {
      apelido: o.apelido, modo: 'backfill', fronteira: backfill, limite: o.orcamentoBackfill,
    });
  }

  return {
    teto: topo.fronteira,
    backfill: historico.fronteira,
    uidValidity: estado.uidValidity,
    inseridas: topo.inseridas + historico.inseridas,
    parcial: topo.parcial || historico.parcial || (historico.fronteira > 1),
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  INICIO = agora();

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  try {
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    let ids: string[];

    if (body.caixa_id) {
      ids = [body.caixa_id];
    } else {
      // Mais atrasadas por último, igual ao motor do Gmail: assim uma caixa com
      // backlog pesado não come o orçamento das saudáveis.
      const { data } = await admin
        .from('email_caixas_conectadas')
        .select('id')
        .eq('provider', 'imap')
        .eq('ativo', true)
        .order('last_sync_at', { ascending: false, nullsFirst: false });
      ids = (data || []).map((c: any) => c.id);
    }

    const resultados: Resultado[] = [];
    for (const id of ids) {
      if (agora() - INICIO > ORCAMENTO_MS) {
        resultados.push({ caixa_id: id, inseridas: 0, parcial: true, erro: 'sem_tempo_nesta_rodada' });
        continue;
      }
      try {
        resultados.push(await sincronizarCaixa(admin, id));
      } catch (e) {
        await marcarErro(admin, id, e);
        const { estado } = classificarErro(e);
        resultados.push({ caixa_id: id, inseridas: 0, parcial: false, erro: estado });
      }
    }

    return new Response(JSON.stringify({ success: true, resultados }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: (e as Error).message }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
