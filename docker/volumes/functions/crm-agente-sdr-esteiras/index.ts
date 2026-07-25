// crm-agente-sdr-esteiras — as esteiras de FOLLOW-UP do agente SDR, isoladas da
// function que atende o lead ao vivo.
//
// POR QUE ESTA FUNCTION EXISTE (2026-07-25)
// ----------------------------------------
// As esteiras rodavam como um "modo" da própria crm-agente-sdr
// (?mode=followup / ?mode=followup-template), chamadas por cron a cada 2 e 3 minutos
// em modo SÍNCRONO (wait=1&limite=200, timeout de 100s). Isso significa uma requisição
// presa por até 100 segundos varrendo centenas de leads DENTRO DO MESMO ISOLATE que
// responde as conversas — e o supervisor do edge runtime mata o isolate quando ele
// estoura o orçamento de CPU ("CPU time hard limit reached" / "early termination").
// Quando isso acontece, TODO trabalho em background morre junto, inclusive a resposta
// que estava saindo em balões: o lead recebia meia mensagem e a conversa "travava".
//
// Medido antes do isolamento (crm_agente_sdr_eventos, 21 dias):
//   • até 08/07 .................... 0,2% a 0,7% das respostas truncadas
//   • 09/07 18:18 .................. 1ª execução do cron followup-template
//   • 10/07 em diante .............. 12,6% (pico de 14,3%), sem nunca voltar
//   • minutos múltiplos de 3 (o tick do cron) .... 21,9% truncadas
//   • demais minutos ............................. 4,9%
// A correlação com o minuto do cron (4,5x) é o que fecha o diagnóstico.
//
// Com as esteiras aqui, elas queimam o CPU DESTE isolate — o da crm-agente-sdr fica
// livre para atender e entregar as respostas. Nenhuma regra de negócio muda: os
// módulos followup.ts / followup-template.ts são os MESMOS, importados do diretório
// do agente (mesmo padrão de _shared/, que já é importado entre functions).
//
// ⚠️ Os modos ?mode=followup e ?mode=followup-template CONTINUAM existindo na
// crm-agente-sdr (compatibilidade e disparo manual), mas os CRONS apontam para cá.

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.3';
import { rodarEsteiraFollowup } from '../crm-agente-sdr/followup.ts';
import { rodarEsteiraFollowupTemplate } from '../crm-agente-sdr/followup-template.ts';

declare const EdgeRuntime: { waitUntil?: (p: Promise<unknown>) => void } | undefined;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// Mesma auth das esteiras na function original: segredo compartilhado no banco
// (crm_agente_sdr_config.followup_secret), enviado pelo cron no header x-followup-key.
// No self-hosted o service_role do pg_net NÃO bate com o SUPABASE_SERVICE_ROLE_KEY do
// container, então não dá pra autenticar por service_role; o segredo do banco resolve.
async function autorizado(req: Request): Promise<boolean> {
  const { data } = await supabase
    .from('crm_agente_sdr_config')
    .select('followup_secret')
    .eq('id', 1)
    .maybeSingle();
  const segredo = data?.followup_secret ?? '';
  return Boolean(segredo) && req.headers.get('x-followup-key') === segredo;
}

const numeroOuUndefined = (v: string | null): number | undefined => {
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok');
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const url = new URL(req.url);
  const mode = url.searchParams.get('mode');
  if (mode !== 'followup' && mode !== 'followup-template') {
    return json({ error: 'mode inválido (use followup | followup-template)' }, 400);
  }
  if (!(await autorizado(req))) return json({ error: 'unauthorized' }, 401);

  const limite = numeroOuUndefined(url.searchParams.get('limite'));

  // ?wait=1 roda síncrono (o cron usa isso — o waitUntil é cortado neste runtime e a
  // esteira nunca terminaria); sem wait, responde na hora e processa em background.
  const trabalho = mode === 'followup'
    ? rodarEsteiraFollowup(supabase, limite)
    : rodarEsteiraFollowupTemplate(supabase, {
      limite,
      // ⚠️ Number(null) === 0 — sem o guard de presença, tick SEM ?hora= rodaria com
      // hora forçada 0 (= 21h BRT, fora de toda janela) e nada seria enviado.
      horaUtc: url.searchParams.get('hora') === null ? undefined : Number(url.searchParams.get('hora')),
      cadeia: numeroOuUndefined(url.searchParams.get('cadeia')),
    });

  if (url.searchParams.get('wait') === '1') {
    return json({ ok: true, esteira: mode, isolada: true, ...(await trabalho) });
  }
  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(trabalho);
  else await trabalho;
  return json({ ok: true, esteira: mode, isolada: true, modo: 'background' });
});
