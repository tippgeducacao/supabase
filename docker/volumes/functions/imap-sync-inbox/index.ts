// imap-sync-inbox: espelho do gmail-sync-inbox para caixas IMAP.
//
// Incremental por UID. Onde o Gmail navega history id, aqui o ponteiro é o maior UID
// já processado — guardado por PASTA, porque INBOX e Enviados têm numeração própria.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { chaveDaThread, parsearMensagem, resumo } from '../_shared/imap/mime.ts';
import { abrirSessao, carregarConfig, limparErro, marcarErro, classificarErro, type ConfigImap } from '../_shared/imap/caixa.ts';
import type { SessaoImap } from '../_shared/imap/conexao.ts';

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

/** Sincroniza UMA pasta. Devolve o novo ponteiro e se sobrou backlog. */
async function sincronizarPasta(
  admin: any,
  caixa: any,
  config: ConfigImap,
  sessao: SessaoImap,
  opcoes: {
    pasta: string;
    apelido: 'inbox' | 'sent';
    ultimoUid: number;
    uidValidityGuardado: number | null;
    limite: number;
  },
): Promise<{ ultimoUid: number; uidValidity: number; inseridas: number; parcial: boolean }> {
  const estado = await sessao.cliente.selecionar(opcoes.pasta);

  // A trava do IMAP. Se o servidor renumerou, todo UID guardado passou a apontar
  // para outra mensagem — insistir no ponteiro antigo gravaria conteúdo trocado
  // em silêncio, que é a pior falha possível aqui.
  let ultimoUid = opcoes.ultimoUid;
  if (opcoes.uidValidityGuardado && opcoes.uidValidityGuardado !== estado.uidValidity) {
    console.warn(`uidvalidity mudou em ${opcoes.pasta} (${opcoes.uidValidityGuardado} -> ${estado.uidValidity}); ressincronizando`);
    ultimoUid = 0;
  }

  const uids = await sessao.cliente.uidsDesde(ultimoUid);
  if (!uids.length) {
    return { ultimoUid, uidValidity: estado.uidValidity, inseridas: 0, parcial: false };
  }

  const aProcessar = uids.slice(0, opcoes.limite);
  const parcial = uids.length > aProcessar.length;
  let inseridas = 0;
  let maiorProcessado = ultimoUid;

  for (let i = 0; i < aProcessar.length; i += LOTE_FETCH) {
    if (agora() - INICIO > ORCAMENTO_MS) {
      return { ultimoUid: maiorProcessado, uidValidity: estado.uidValidity, inseridas, parcial: true };
    }

    const lote = aProcessar.slice(i, i + LOTE_FETCH);
    const mensagens = await sessao.cliente.buscarMensagens(lote);

    for (const bruta of mensagens) {
      const chave = `imap:${caixa.id}:${opcoes.apelido}:${bruta.uid}`;

      const { data: jaExiste } = await admin
        .from('email_mensagens')
        .select('id')
        .eq('gmail_message_id', chave)
        .maybeSingle();
      if (jaExiste) { maiorProcessado = Math.max(maiorProcessado, bruta.uid); continue; }

      let msg;
      try {
        msg = await parsearMensagem(bruta.bruto);
      } catch (e) {
        console.error(`falha ao parsear uid ${bruta.uid}`, e);
        maiorProcessado = Math.max(maiorProcessado, bruta.uid);
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
          maiorProcessado = Math.max(maiorProcessado, bruta.uid);
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
      maiorProcessado = Math.max(maiorProcessado, bruta.uid);
    }
  }

  return { ultimoUid: maiorProcessado, uidValidity: estado.uidValidity, inseridas, parcial };
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
    const inbox = await sincronizarPasta(admin, caixa, config, sessao, {
      pasta: 'INBOX',
      apelido: 'inbox',
      ultimoUid: config.ultimo_uid,
      uidValidityGuardado: config.uid_validity,
      limite: MAX_POR_PASTA_POR_RODADA,
    });

    let enviados = { ultimoUid: config.ultimo_uid_enviados, uidValidity: config.uid_validity_enviados ?? 0, inseridas: 0, parcial: false };
    if (config.pasta_enviados && agora() - INICIO < ORCAMENTO_MS) {
      try {
        enviados = await sincronizarPasta(admin, caixa, config, sessao, {
          pasta: config.pasta_enviados,
          apelido: 'sent',
          ultimoUid: config.ultimo_uid_enviados,
          uidValidityGuardado: config.uid_validity_enviados,
          limite: Math.floor(MAX_POR_PASTA_POR_RODADA / 2),
        });
      } catch (e) {
        // Enviados é secundário: se a pasta sumiu ou mudou de nome, a INBOX não
        // pode deixar de sincronizar por causa disso.
        console.warn('falha na pasta de Enviados', e);
      }
    }

    await admin.from('email_caixa_imap_config').update({
      ultimo_uid: inbox.ultimoUid,
      uid_validity: inbox.uidValidity,
      ultimo_uid_enviados: enviados.ultimoUid,
      uid_validity_enviados: enviados.uidValidity || null,
      updated_at: new Date().toISOString(),
    }).eq('caixa_id', caixaId);

    await limparErro(admin, caixaId);
    return {
      caixa_id: caixaId,
      inseridas: inbox.inseridas + enviados.inseridas,
      parcial: inbox.parcial || enviados.parcial,
    };
  } finally {
    await sessao.fechar();
  }
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
