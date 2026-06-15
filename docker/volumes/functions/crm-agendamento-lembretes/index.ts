// crm-agendamento-lembretes — lembrete/confirmação de reunião por TEMPLATE utility.
//
// Reuniões agendadas pelo AGENTE SDR (agendamentos.origem='API SDR') recebem 2 toques
// antes da reunião: T-2h e T-30min. Disparado por cron (a cada ~10 min). Envia via
// crm-whatsapp-send (tipo=template). NÃO passa pela trava de 24h de marketing — lembrete
// de reunião é essencial e tem que sair sempre.
//
// Janelas (minutos restantes até a reunião) — largas o bastante p/ o cron de 10 min
// sempre acertar; o claim atômico da coluna garante 1 envio só:
//   • T-2h:    resta entre 90 e 120 min  → se a reunião foi marcada com MENOS de ~1h30
//              de antecedência, esta janela já passou e só o de 30min sai.
//   • T-30min: resta entre 10 e 35 min.
//
// Dedup: claim atômico (UPDATE ... WHERE coluna IS NULL RETURNING) antes de enviar;
// se o envio falhar, a coluna volta a NULL e tenta no próximo tick.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.3';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SEND_URL = (Deno.env.get('AGENTE_SDR_SEND_URL') ?? `${SUPABASE_URL}/functions/v1/crm-whatsapp-send`).replace(/\/$/, '');

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// Brasília = UTC-3 fixo.
const BR_OFFSET_MS = 3 * 60 * 60 * 1000;
const pad = (n: number) => String(n).padStart(2, '0');
function brData(isoUtc: string) {
  const b = new Date(new Date(isoUtc).getTime() - BR_OFFSET_MS);
  const dia = `${pad(b.getUTCDate())}/${pad(b.getUTCMonth() + 1)}`;
  const hora = `${pad(b.getUTCHours())}h${b.getUTCMinutes() ? pad(b.getUTCMinutes()) : ''}`;
  return { dia, hora };
}
const primeiroNome = (nome: string | null | undefined) =>
  String(nome ?? '').trim().split(/\s+/)[0] ?? '';

// ── CONFIG DOS 2 LEMBRETES (PREENCHER template_name quando cadastrar na Meta) ──
// janelaMin = [piso, teto] de minutos restantes p/ o toque ficar devido.
// params(ctx) = valores de {{1}},{{2}}… NA ORDEM do template (ajustar quando criar).
//   ctx = { nome, dia, hora, link }
type Ctx = { nome: string; dia: string; hora: string; link: string };
type Lembrete = {
  coluna: 'lembrete_2h_em' | 'lembrete_30min_em';
  template_name: string;
  lang: string;
  janelaMin: [number, number];
  params: (c: Ctx) => string[];
};
const LEMBRETES: Lembrete[] = [
  {
    coluna: 'lembrete_2h_em',
    template_name: '', // PREENCHER (template utility de 2h antes)
    lang: 'pt_BR',
    janelaMin: [90, 120],
    params: (c) => [c.nome, c.hora, c.link], // ajustar à ordem real das variáveis
  },
  {
    coluna: 'lembrete_30min_em',
    template_name: '', // PREENCHER (template utility de 30min antes)
    lang: 'pt_BR',
    janelaMin: [10, 35],
    params: (c) => [c.nome, c.hora, c.link], // ajustar à ordem real das variáveis
  },
];

// Claim atômico: marca a coluna se ainda está NULL. true = consegui o claim (envio meu).
async function claim(agId: string, coluna: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('agendamentos')
    .update({ [coluna]: new Date().toISOString() })
    .eq('id', agId)
    .is(coluna, null)
    .select('id');
  if (error) { console.error(`[lembretes] claim ${coluna} ${agId}: ${error.message}`); return false; }
  return (data?.length ?? 0) > 0;
}
async function soltarClaim(agId: string, coluna: string): Promise<void> {
  await supabase.from('agendamentos').update({ [coluna]: null }).eq('id', agId);
}

async function enviarTemplate(telefone: string, lem: Lembrete, ctx: Ctx): Promise<boolean> {
  const valores = lem.params(ctx).filter((v) => v != null);
  const components = valores.length
    ? [{ type: 'body', parameters: valores.map((v) => ({ type: 'text', text: String(v) })) }]
    : [];
  const res = await fetch(SEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SERVICE_ROLE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      telefone,
      tipo: 'template',
      template_name: lem.template_name,
      template_lang: lem.lang,
      template_components: components,
      wa_account_id: null,
    }),
  });
  if (!res.ok) {
    console.error(`[lembretes] send HTTP ${res.status}: ${await res.text()}`);
    return false;
  }
  return true;
}

async function rodar(): Promise<{ candidatos: number; enviados: number }> {
  // Reuniões do agente nas próximas ~2h05, não canceladas/realizadas, com WhatsApp.
  const { data, error } = await supabase
    .from('agendamentos')
    .select('id, data_agendamento, status, link_reuniao, lembrete_2h_em, lembrete_30min_em, lead:leads!agendamentos_lead_id_fkey(nome, whatsapp)')
    .eq('origem', 'API SDR')
    .gt('data_agendamento', new Date().toISOString())
    .lt('data_agendamento', new Date(Date.now() + 125 * 60_000).toISOString())
    .not('status', 'in', '(cancelado,realizado)');
  if (error) throw new Error(`select agendamentos: ${error.message}`);

  const candidatos = data ?? [];
  let enviados = 0;
  const agora = Date.now();

  for (const ag of candidatos) {
    const restaMin = (new Date(ag.data_agendamento).getTime() - agora) / 60_000;
    const lead = (ag as any).lead ?? {};
    const telefone = String(lead.whatsapp ?? '').trim();
    if (!telefone) continue;
    const { dia, hora } = brData(ag.data_agendamento);
    const ctx: Ctx = { nome: primeiroNome(lead.nome), dia, hora, link: ag.link_reuniao ?? '' };

    for (const lem of LEMBRETES) {
      if (!lem.template_name) continue;                                  // toque não cadastrado
      if ((ag as any)[lem.coluna]) continue;                             // já enviado
      if (restaMin < lem.janelaMin[0] || restaMin > lem.janelaMin[1]) continue; // fora da janela
      if (!(await claim(ag.id, lem.coluna))) continue;                   // outro tick pegou
      const ok = await enviarTemplate(telefone, lem, ctx);
      if (ok) {
        enviados++;
        console.log(`[lembretes] ${lem.coluna} enviado p/ ${telefone} (reunião ${dia} ${hora})`);
      } else {
        await soltarClaim(ag.id, lem.coluna);                            // falhou: retenta no próximo tick
      }
    }
  }
  return { candidatos: candidatos.length, enviados };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok');
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // Auth: mesmo segredo compartilhado dos crons do agente (x-followup-key).
  const { data: cfg } = await supabase
    .from('crm_agente_sdr_config')
    .select('followup_secret')
    .eq('id', 1)
    .maybeSingle();
  const segredo = cfg?.followup_secret ?? '';
  if (!segredo || req.headers.get('x-followup-key') !== segredo) {
    return json({ error: 'unauthorized' }, 401);
  }

  try {
    const r = await rodar();
    return json({ ok: true, ...r });
  } catch (e) {
    console.error('[lembretes] fatal:', e);
    return json({ error: (e as Error).message }, 500);
  }
});
