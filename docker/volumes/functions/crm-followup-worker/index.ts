// Consumidor durável das esteiras do Agente SDR.
//
// Cada chamada reclama um micro-lote com FOR UPDATE SKIP LOCKED. O lease mora no
// Postgres: se o Edge Runtime encerrar o isolate, o próximo tick retoma o job. Toda
// regra de negócio continua nos módulos originais, que revalidam o lead sob lock.

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.3';
import { processarFollowupEnfileirado } from '../crm-agente-sdr/followup.ts';
import { processarFollowupTemplateEnfileirado } from '../crm-agente-sdr/followup-template.ts';
import {
  concorrenciaWorker,
  limiteWorker,
  type JobFilaFollowup,
  type TipoFilaFollowup,
} from '../crm-agente-sdr/fila.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

async function autorizado(req: Request): Promise<boolean> {
  const { data } = await supabase
    .from('crm_agente_sdr_config')
    .select('followup_secret')
    .eq('id', 1)
    .maybeSingle();
  const segredo = data?.followup_secret ?? '';
  return Boolean(segredo) && req.headers.get('x-followup-key') === segredo;
}

function numero(v: string | null): number | undefined {
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function stageAtual(valor: unknown): number {
  const achou = String(valor ?? '').match(/(\d+)/);
  return achou ? Number(achou[1]) : 0;
}

function mudouReferencia(atual: unknown, esperada: string): boolean {
  const a = Date.parse(String(atual ?? ''));
  const e = Date.parse(esperada);
  return Number.isFinite(a) && Number.isFinite(e) && Math.abs(a - e) > 1000;
}

async function jobFicouObsoleto(job: JobFilaFollowup): Promise<boolean> {
  if (job.tipo === 'janela_aberta') {
    const { data, error } = await supabase
      .from('cliente_ppg_leads_sdr')
      .select('follow_up,timestamp_mensagem,pausa_ia,atendimento_finalizado,followup_ativado,iniciar_atendimento,modo_recontato')
      .eq('remotejid', job.remotejid)
      .maybeSingle();
    if (error) throw error;
    if (!data) return true;
    return stageAtual(data.follow_up) >= job.toque
      || mudouReferencia(data.timestamp_mensagem, job.referencia_em)
      || data.pausa_ia === true
      || data.atendimento_finalizado === true
      || data.followup_ativado !== true
      || data.iniciar_atendimento !== true
      || data.modo_recontato === true;
  }

  const coluna = job.toque > 0 && job.toque <= 7 ? `template_${job.toque}_dia` : null;
  const campos = [
    'timestamp_mensagem',
    'template_inicial_em',
    'pausa_ia',
    'atendimento_finalizado',
    'followup_ativado',
    'iniciar_atendimento',
    'modo_recontato',
    'agendado',
    ...(coluna ? [coluna] : []),
  ].join(',');
  const { data, error } = await supabase
    .from('cliente_ppg_leads_sdr')
    .select(campos)
    .eq('remotejid', job.remotejid)
    .maybeSingle();
  if (error) throw error;
  if (!data) return true;
  const ancoraAtual = job.toque === 0
    ? job.referencia_em
    : data.timestamp_mensagem ?? data.template_inicial_em;
  return (coluna ? data[coluna] === true : false)
    || mudouReferencia(ancoraAtual, job.referencia_em)
    || data.pausa_ia === true
    || data.atendimento_finalizado === true
    || data.followup_ativado !== true
    || data.iniciar_atendimento !== true
    || data.modo_recontato === true
    || data.agendado === true;
}

async function concluir(job: JobFilaFollowup, workerId: string, resultado: Record<string, unknown>) {
  const { error } = await supabase.rpc('crm_followup_fila_concluir', {
    p_id: job.id,
    p_worker_id: workerId,
    p_resultado: resultado,
  });
  if (error) throw error;
}

async function falhar(job: JobFilaFollowup, workerId: string, erro: string) {
  const { error } = await supabase.rpc('crm_followup_fila_falhar', {
    p_id: job.id,
    p_worker_id: workerId,
    p_erro: erro.slice(0, 2000),
    p_retentavel: true,
  });
  if (error) throw error;
}

async function processar(job: JobFilaFollowup, workerId: string): Promise<'enviado' | 'pulado' | 'retry'> {
  try {
    const payload = job.payload ?? {};
    const ok = job.tipo === 'janela_aberta'
      ? await processarFollowupEnfileirado(supabase, job.remotejid, Number(payload.stage ?? job.toque))
      : await processarFollowupTemplateEnfileirado(supabase, {
        remotejid: job.remotejid,
        toque: Number(payload.toque ?? job.toque),
        resgate: payload.resgate === true,
        conta: typeof payload.conta === 'string' ? payload.conta : null,
      });

    if (ok) {
      await concluir(job, workerId, { resultado: 'enviado' });
      return 'enviado';
    }
    if (await jobFicouObsoleto(job)) {
      await concluir(job, workerId, { resultado: 'pulado_estado_fresco' });
      return 'pulado';
    }
    await falhar(job, workerId, 'Processamento não confirmou envio; será revalidado no próximo retry.');
    return 'retry';
  } catch (e) {
    const mensagem = e instanceof Error ? e.message : String(e);
    console.error(`[crm-followup-worker] job ${job.id}: ${mensagem}`);
    await falhar(job, workerId, mensagem).catch((falha) => {
      console.error(`[crm-followup-worker] não registrou falha do job ${job.id}: ${String(falha)}`);
    });
    return 'retry';
  }
}

async function comConcorrencia<T>(itens: T[], limite: number, fn: (item: T) => Promise<void>) {
  let proximo = 0;
  await Promise.all(Array.from({ length: Math.min(limite, itens.length) }, async () => {
    while (proximo < itens.length) {
      const indice = proximo++;
      await fn(itens[indice]);
    }
  }));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok');
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!(await autorizado(req))) return json({ error: 'unauthorized' }, 401);

  const url = new URL(req.url);
  const tipo = url.searchParams.get('tipo') as TipoFilaFollowup | null;
  if (tipo !== 'janela_aberta' && tipo !== 'template') {
    return json({ error: 'tipo inválido (use janela_aberta | template)' }, 400);
  }

  const limite = limiteWorker(tipo, numero(url.searchParams.get('limite')));
  const workerId = crypto.randomUUID();
  const { data, error } = await supabase.rpc('crm_followup_fila_claim', {
    p_tipo: tipo,
    p_limit: limite,
    p_worker_id: workerId,
  });
  if (error) return json({ error: error.message }, 500);

  const jobs = (data ?? []) as JobFilaFollowup[];
  const totais = { enviados: 0, pulados: 0, retry: 0 };
  await comConcorrencia(jobs, concorrenciaWorker(tipo, jobs.length), async (job) => {
    const resultado = await processar(job, workerId);
    totais[resultado]++;
  });

  return json({ ok: true, tipo, claimed: jobs.length, ...totais });
});
