// crm-agente-sdr — agente SDR "João" portado do n8n ("SDR v9.0 multi-agent Claude").
// Recebe o relay do crm-whatsapp-webhook (mesmo payload do CRM_N8N_INBOUND_URL),
// acumula mensagens em buffer Postgres, roteia validação×qualificador (ratchet),
// roda o loop agêntico (Sonnet + thinking + tools) e responde humanizado em chunks.
//
// Pipeline (espelho do fluxo principal do n8n):
//   guards (inbound, /excluirdados, iniciar_atendimento, pausa_ia)
//   → mídia (transcrição/análise Gemini) → buffer + lock por remotejid
//   → drain: persiste user msg → router (ratchet) → loop Claude/tools → chunks.
// Responde 200 imediatamente (o relay do gateway tem timeout de 10s) e processa
// em background via EdgeRuntime.waitUntil.

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.3';
import { AGENTE_QUALIFICADOR, AGENTE_VALIDACAO } from './prompts.ts';
import { encontrarFormacao, extrairPrimeiroNome, montarContextoTemporal, montarPerguntaFormacao, renderPrompt } from './contexto.ts';
import { atualizarAgenteComRatchet, atualizarLead, buscarLead, carregarHistorico, criarLead, excluirDadosLead, gravarMensagem, limparParaRouter, sanitizarHistorico } from './historico.ts';
import { carregarTools, chamarAgentePrincipal, chamarRouter } from './agente.ts';
import { type CtxConversa, executarTool, montarToolResults } from './tools.ts';
import { prepararMensagem } from './midia.ts';
import { enviarResposta } from './saida.ts';
import { rodarEsteiraFollowup } from './followup.ts';
import { criarTelemetria, resumir, type Telemetria } from './eventos.ts';

declare const EdgeRuntime: { waitUntil?: (p: Promise<unknown>) => void } | undefined;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// Opcional: se setado, o relay precisa apontar pra ...?token=<valor>.
const TOKEN = Deno.env.get('AGENTE_SDR_TOKEN') ?? '';
const LOCK_TTL_SEGUNDOS = 240; // mesmo TTL do lock Redis do n8n
const MAX_RODADAS_TOOLS = 8;   // trava de segurança (o n8n não limitava)

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// ── buffer/lock (Postgres no lugar do Redis) ────────────────────────────────

async function bufferInserir(remotejid: string, item: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from('crm_agente_sdr_buffer').insert({ remotejid, payload: item });
  if (error) throw new Error(`buffer insert: ${error.message}`);
}

// Silêncio desde a última mensagem do buffer, em segundos (relógio do BANCO,
// imune a skew entre VPS e edge runtime). null = buffer vazio.
async function bufferSilencioSegundos(remotejid: string): Promise<number | null> {
  const { data, error } = await supabase
    .from('crm_agente_sdr_buffer')
    .select('criado_em')
    .eq('remotejid', remotejid)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`buffer silencio: ${error.message}`);
  if (!data) return null;
  return (Date.now() - new Date(data.criado_em).getTime()) / 1000;
}

// Debounce configurável (crm_pipeline_settings.agente_sdr_delay_segundos):
// espera o lead ficar N segundos em silêncio antes de processar — mensagens
// que chegarem no meio entram no acúmulo e reiniciam a contagem.
async function carregarDelaySegundos(): Promise<number> {
  const { data } = await supabase
    .from('crm_pipeline_settings')
    .select('agente_sdr_delay_segundos')
    .eq('id', 1)
    .maybeSingle();
  const v = Number(data?.agente_sdr_delay_segundos);
  return Number.isFinite(v) && v >= 0 ? v : 45;
}

const ESPERA_MAXIMA_MS = 180_000; // lead "digitando" sem parar não segura a rodada pra sempre

async function aguardarSilencio(remotejid: string, delaySegundos: number, renovar: () => Promise<void>): Promise<number> {
  if (delaySegundos <= 0) return 0;
  const inicio = Date.now();
  while (true) {
    const silencio = await bufferSilencioSegundos(remotejid);
    if (silencio === null) return Date.now() - inicio;          // buffer esvaziou
    const faltaMs = (delaySegundos - silencio) * 1000;
    if (faltaMs <= 0) return Date.now() - inicio;               // silêncio atingido
    if (Date.now() - inicio > ESPERA_MAXIMA_MS) return Date.now() - inicio;
    await renovar();                                            // espera não pode perder o lock
    await new Promise((r) => setTimeout(r, Math.min(faltaMs, 5000)));
  }
}

async function bufferDrenar(remotejid: string): Promise<any[]> {
  const { data, error } = await supabase
    .from('crm_agente_sdr_buffer')
    .select('id, payload')
    .eq('remotejid', remotejid)
    .order('id', { ascending: true });
  if (error) throw new Error(`buffer select: ${error.message}`);
  if (!data?.length) return [];
  await supabase.from('crm_agente_sdr_buffer').delete().in('id', data.map((r: any) => r.id));
  return data.map((r: any) => r.payload);
}

async function lockClaim(remotejid: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('crm_agente_sdr_lock_claim', {
    p_remotejid: remotejid,
    p_ttl_segundos: LOCK_TTL_SEGUNDOS,
  });
  if (error) throw new Error(`lock claim: ${error.message}`);
  return data === true;
}

const lockRenovar = (remotejid: string) => async () => {
  await supabase.rpc('crm_agente_sdr_lock_renovar', { p_remotejid: remotejid, p_ttl_segundos: LOCK_TTL_SEGUNDOS });
};

async function lockSoltar(remotejid: string): Promise<void> {
  await supabase.from('crm_agente_sdr_lock').delete().eq('remotejid', remotejid);
}

// ── uma rodada do agente sobre um lote de mensagens drenadas ────────────────

async function rodadaAgente(remotejid: string, itens: any[], tel: Telemetria): Promise<void> {
  const inicioRodada = Date.now();
  tel.registrar('rodada_inicio', {
    mensagens: itens.map((i: any) => resumir(i.mensagem, 300)),
    arquivos: itens.filter((i: any) => i.arquivo).length,
  });
  const ultimo = itens[itens.length - 1];
  const ctx: CtxConversa = {
    remotejid,
    telefone: String(remotejid).split('@')[0],
    waAccountId: ultimo.wa_account_id ?? null,
    leadId: ultimo.lead_id ?? null,
    oportunidadeId: ultimo.oportunidade_id ?? null,
  };

  let lead = await buscarLead(supabase, remotejid);
  if (!lead) {
    await criarLead(supabase, remotejid);
    lead = await buscarLead(supabase, remotejid);
  }
  // Reabriu a conversa: atualiza o relógio âncora e ZERA o estágio de follow-up
  // (se o lead esfriar de novo, a cadência recomeça do 1º toque — igual ao n8n,
  // onde o reset do timestamp_mensagem + dedup por estágio reiniciava a régua).
  await atualizarLead(supabase, remotejid, { timestamp_mensagem: new Date().toISOString(), follow_up: null });

  // Arquivos analisados viram mensagem própria; o texto acumulado vira UMA mensagem.
  for (const item of itens) {
    if (item.arquivo) await gravarMensagem(supabase, remotejid, { role: 'user', content: item.arquivo });
  }
  const conteudo = itens.map((i: any) => i.mensagem).filter(Boolean).join('\n');
  if (conteudo) await gravarMensagem(supabase, remotejid, { role: 'user', content: conteudo });

  // Contexto do lead + temporal (mesma montagem do node "normalizador").
  const formacaoNormalizada = encontrarFormacao(lead?.formacao_academica ?? '');
  const vars = {
    nome: extrairPrimeiroNome(lead?.nome),
    curso_interesse_original: lead?.curso_interesse_original ?? '',
    pergunta_formacao: montarPerguntaFormacao(formacaoNormalizada),
  };
  const contextoTemporal = montarContextoTemporal();

  // Router (em erro, mantém o agente atual — não derruba a conversa).
  let proximo: 'agente_validacao' | 'agente_qualificador';
  const inicioRouter = Date.now();
  let routerFallback = false;
  try {
    proximo = await chamarRouter(limparParaRouter(await carregarHistorico(supabase, remotejid)));
  } catch (e) {
    console.error('[crm-agente-sdr] router falhou, mantendo agente atual:', e);
    routerFallback = true;
    proximo = lead?.agente_atual === 'agente_qualificador' ? 'agente_qualificador' : 'agente_validacao';
  }
  const agenteAtual = await atualizarAgenteComRatchet(supabase, remotejid, lead?.agente_atual ?? null, proximo);
  tel.registrar('router_decisao', {
    decidiu: proximo,
    efetivo: agenteAtual,
    anterior: lead?.agente_atual ?? null,
    fallback: routerFallback,
  }, Date.now() - inicioRouter);

  const promptAgente = renderPrompt(
    agenteAtual === 'agente_qualificador' ? AGENTE_QUALIFICADOR : AGENTE_VALIDACAO,
    vars,
  );
  const tools = await carregarTools(supabase, agenteAtual);
  const renovar = lockRenovar(remotejid);

  // Loop agêntico: igual ao n8n, o histórico é relido do banco a cada volta.
  for (let rodada = 0; rodada < MAX_RODADAS_TOOLS; rodada++) {
    const messages = sanitizarHistorico(await carregarHistorico(supabase, remotejid));
    const inicioLlm = Date.now();
    const resp = await chamarAgentePrincipal({ promptAgente, contextoTemporal, messages, tools });
    tel.registrar('llm_chamada', {
      volta: rodada + 1,
      agente: agenteAtual,
      stop_reason: resp.stop_reason ?? null,
      tokens_entrada: resp.usage?.input_tokens ?? null,
      tokens_saida: resp.usage?.output_tokens ?? null,
      cache_lido: resp.usage?.cache_read_input_tokens ?? null,
      blocos: (resp.content ?? []).map((b: any) => b.type),
    }, Date.now() - inicioLlm);
    await gravarMensagem(supabase, remotejid, { role: 'assistant', content: resp.content });

    const toolUses = (resp.content ?? []).filter((b: any) => b.type === 'tool_use');
    if (toolUses.length) {
      await renovar();
      const outputs: Record<string, unknown>[] = [];
      for (const tu of toolUses) {
        // uma function por vez, em ordem (idem "executa uma function por vez")
        const inicioTool = Date.now();
        const output = await executarTool(supabase, tu, ctx);
        tel.registrar('tool_exec', {
          tool: tu.name,
          input: resumir(tu.input, 800),
          output: resumir(output, 1200),
        }, Date.now() - inicioTool);
        outputs.push(output);
      }
      await gravarMensagem(supabase, remotejid, { role: 'user', content: montarToolResults(outputs) });
      continue;
    }

    const texto = (resp.content ?? [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n')
      .trim();
    if (texto) await enviarResposta(ctx, texto, renovar, tel);
    tel.registrar('rodada_fim', { voltas_llm: rodada + 1, respondeu: Boolean(texto) }, Date.now() - inicioRodada);
    return;
  }
  tel.registrar('erro', { onde: 'loop' }, Date.now() - inicioRodada, `limite de ${MAX_RODADAS_TOOLS} rodadas de tools atingido`);
  console.error(`[crm-agente-sdr] ${remotejid}: limite de ${MAX_RODADAS_TOOLS} rodadas de tools atingido.`);
}

// ── processamento completo de um inbound (roda em background) ───────────────

async function processarInbound(payload: any): Promise<void> {
  const remotejid: string = payload.remotejid;
  let telAtual: Telemetria | null = null;
  try {
    // Mídia é tratada ANTES do buffer (transcrição/análise), como no n8n.
    const tratada = await prepararMensagem(payload);
    await bufferInserir(remotejid, {
      ...tratada,
      msg_id: payload.id,
      timestamp: payload.timestamp,
      wa_account_id: payload.wa_account_id ?? null,
      lead_id: payload.lead_id ?? null,
      oportunidade_id: payload.oportunidade_id ?? null,
    });

    if (!(await lockClaim(remotejid))) return; // quem segura o lock drena o buffer

    try {
      const delaySegundos = await carregarDelaySegundos();
      const renovar = lockRenovar(remotejid);
      // Drena até esvaziar: cada lote espera o silêncio do debounce antes de
      // processar; mensagens que chegarem durante a rodada entram na próxima.
      while (true) {
        const esperouMs = await aguardarSilencio(remotejid, delaySegundos, renovar);
        const itens = await bufferDrenar(remotejid);
        if (!itens.length) break;
        telAtual = criarTelemetria(supabase, remotejid);
        if (delaySegundos > 0) {
          telAtual.registrar('debounce', { config_s: delaySegundos, mensagens_acumuladas: itens.length }, esperouMs);
        }
        await rodadaAgente(remotejid, itens, telAtual);
      }
    } finally {
      await lockSoltar(remotejid);
    }
  } catch (e) {
    console.error(`[crm-agente-sdr] erro processando ${remotejid}:`, e);
    (telAtual ?? criarTelemetria(supabase, remotejid)).registrar(
      'erro',
      { onde: 'processarInbound', stack: resumir((e as Error).stack ?? '', 1500) },
      undefined,
      (e as Error).message,
    );
    try { await lockSoltar(remotejid); } catch { /* melhor esforço */ }
  }
}

// ── entrada ─────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok');
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const url = new URL(req.url);

  // Esteira de follow-up de JANELA ABERTA: disparada pelo cron (mode=followup),
  // não é um inbound. Varre os leads devidos e reabre as conversas que esfriaram.
  // Auth por SEGREDO COMPARTILHADO no banco (crm_agente_sdr_config.followup_secret),
  // enviado pelo cron no header x-followup-key. No self-hosted o service_role do
  // pg_net NÃO bate com o SUPABASE_SERVICE_ROLE_KEY do container, então não dá pra
  // autenticar por service_role; o segredo do banco resolve (e o front não lê, RLS
  // bloqueia). Vem ANTES da checagem do token de inbound. ?wait=1 roda síncrono
  // (teste manual vê estatísticas); sem isso, background + 200 na hora.
  if (url.searchParams.get('mode') === 'followup') {
    const { data: cfg } = await supabase
      .from('crm_agente_sdr_config')
      .select('followup_secret')
      .eq('id', 1)
      .maybeSingle();
    const segredo = cfg?.followup_secret ?? '';
    if (!segredo || req.headers.get('x-followup-key') !== segredo) {
      return json({ error: 'unauthorized' }, 401);
    }
    const limiteParam = Number(url.searchParams.get('limite'));
    const trabalho = rodarEsteiraFollowup(supabase, Number.isFinite(limiteParam) && limiteParam > 0 ? limiteParam : undefined);
    if (url.searchParams.get('wait') === '1') {
      return json({ ok: true, esteira: 'followup', ...(await trabalho) });
    }
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(trabalho);
    else await trabalho;
    return json({ ok: true, esteira: 'followup', modo: 'background' });
  }

  if (TOKEN && url.searchParams.get('token') !== TOKEN) return json({ error: 'unauthorized' }, 401);

  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: 'payload inválido' }, 400); }

  // Guards de entrada (mesma ordem do n8n).
  if (payload?.direcao !== 'inbound' || payload?.from_me === true) return json({ ok: true, skip: 'nao_inbound' });
  if (!payload?.remotejid || !payload?.telefone) return json({ error: 'remotejid/telefone obrigatórios' }, 400);

  // Comando de reset usado nos testes (/excluirdados): apaga lead + mensagens.
  if (String(payload.conteudo ?? '').trim() === '/excluirdados') {
    await excluirDadosLead(supabase, payload.remotejid);
    await supabase.from('crm_agente_sdr_buffer').delete().eq('remotejid', payload.remotejid);
    return json({ ok: true, reset: true });
  }

  // Gate de atendimento: só leads marcados pra IA (iniciar_atendimento) e não pausados.
  const lead = await buscarLead(supabase, payload.remotejid);
  if (!lead || lead.iniciar_atendimento !== true) return json({ ok: true, skip: 'sem_iniciar_atendimento' });
  if (lead.pausa_ia === true) return json({ ok: true, skip: 'pausa_ia' });

  const trabalho = processarInbound(payload);
  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) {
    EdgeRuntime.waitUntil(trabalho);
  } else {
    await trabalho;
  }
  return json({ ok: true });
});
