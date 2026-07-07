// crm-agendamento-lembretes — lembrete/confirmação de reunião (T-2h e T-30min).
//
// Reuniões próximas recebem 2 toques antes da reunião: T-2h e T-30min. Disparado por
// cron (a cada ~10 min). NÃO passa pela trava de 24h de marketing — lembrete de
// reunião é essencial e tem que sair sempre.
//
// NÚMERO QUE ENVIA — configurável POR RESPONSÁVEL (tabela crm_lembrete_numeros,
// aba "Lembretes de reunião" da tela WhatsApp Cloud API do CRM):
//   • Responsável da reunião: origem IA ('API SDR'/'Agendamento por IA') →
//     agendamento_responsavel_espelho() (o SDR que herdou o lead no SAC);
//     demais reuniões → sdr_id (quem marcou).
//   • Config canal='meta' → TEMPLATE pela conta Cloud API configurada (os templates
//     de lembrete precisam estar APROVADOS na WABA dessa conta).
//   • Config canal='web'  → TEXTO LIVRE pela linha WhatsApp Web/Uazapi (sem janela
//     24h/template) — os textos espelham o corpo dos templates (mudou o template na
//     Meta → atualize textoLivre aqui).
//   • SEM config ativa: comportamento ORIGINAL — reunião 'API SDR' sai pela conta
//     padrão (João); reunião marcada por humano NÃO recebe lembrete (opt-in).
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

// Reuniões da IA têm sdr_id = conta "IA SDR" → o responsável real vem do espelho.
const IA_ORIGENS = ['API SDR', 'Agendamento por IA'];

// Brasília = UTC-3 fixo.
const BR_OFFSET_MS = 3 * 60 * 60 * 1000;
const pad = (n: number) => String(n).padStart(2, '0');
function brData(isoUtc: string) {
  const b = new Date(new Date(isoUtc).getTime() - BR_OFFSET_MS);
  const dia = `${pad(b.getUTCDate())}/${pad(b.getUTCMonth() + 1)}`;
  const hora = `${b.getUTCHours()}h${b.getUTCMinutes() ? pad(b.getUTCMinutes()) : ''}`;
  return { dia, hora };
}
const primeiroNome = (nome: string | null | undefined) =>
  String(nome ?? '').trim().split(/\s+/)[0] ?? '';

// ── CONFIG DOS 2 LEMBRETES ──────────────────────────────────────────────────
// janelaMin = [piso, teto] de minutos restantes p/ o toque ficar devido.
// params(ctx) = valores de {{1}},{{2}}… NA ORDEM do template.
// textoLivre(ctx) = versão texto (linha Uazapi) — ESPELHA o body do template na Meta.
//   ctx = { nome, dia, hora, link }
type Ctx = { nome: string; dia: string; hora: string; link: string };
type Lembrete = {
  coluna: 'lembrete_2h_em' | 'lembrete_30min_em';
  template_name: string;
  lang: string;
  janelaMin: [number, number];
  params: (c: Ctx) => string[];
  textoLivre: (c: Ctx) => string;
};
const LEMBRETES: Lembrete[] = [
  {
    coluna: 'lembrete_2h_em',
    template_name: 'lembrete_2_horas_antes_utility', // {{1}}=nome {{2}}=hora {{3}}=link
    lang: 'pt_BR',
    janelaMin: [90, 120],
    params: (c) => [c.nome, c.hora, c.link],
    textoLivre: (c) =>
      `Oi ${c.nome}! Faltam só 2 horas para o nosso alinhamento das ${c.hora}. Já está tudo organizado por aqui.\n\nLink de acesso: ${c.link}\n\nÉ só entrar pelo link no horário. Te aguardamos lá!`,
  },
  {
    coluna: 'lembrete_30min_em',
    template_name: 'lembre_de_30_min_utility', // {{1}}=nome {{2}}=hora {{3}}=link
    lang: 'pt_BR',
    janelaMin: [10, 35],
    params: (c) => [c.nome, c.hora, c.link],
    textoLivre: (c) =>
      `Olá ${c.nome}, tudo certo aqui, já me organizei aqui para o seu alinhamento das ${c.hora}.\n\nLink: ${c.link}\n\nTe espero no nosso link que enviei acima.`,
  },
];

// ── Roteamento do número que envia ──────────────────────────────────────────
type Rota =
  | { via: 'meta'; wa_account_id: string | null } // null = conta padrão (comportamento original)
  | { via: 'web'; wa_conexao_id: string };

async function resolverRota(ag: { id: string; origem: string | null; sdr_id: string | null }): Promise<Rota | null> {
  const origem = String(ag.origem ?? '');
  let responsavelId: string | null = null;
  if (IA_ORIGENS.includes(origem)) {
    // Reunião da IA: o responsável é o SDR-espelho (quem herdou o lead no SAC).
    // Sem espelho (nenhum atendimento casou), cai no sdr_id = conta "IA SDR" —
    // ou seja, dá pra configurar o próprio perfil IA SDR pra redirecionar o padrão.
    const { data, error } = await supabase.rpc('agendamento_responsavel_espelho', { p_ag_id: ag.id });
    if (error) console.error(`[lembretes] espelho ${ag.id}: ${error.message}`);
    responsavelId = (data as string | null) ?? ag.sdr_id ?? null;
  } else {
    responsavelId = ag.sdr_id ?? null;
  }

  if (responsavelId) {
    const { data: cfg, error } = await supabase
      .from('crm_lembrete_numeros')
      .select('canal, wa_account_id, wa_conexao_id')
      .eq('responsavel_id', responsavelId)
      .eq('ativo', true)
      .maybeSingle();
    if (error) console.error(`[lembretes] config ${responsavelId}: ${error.message}`);
    if (cfg?.canal === 'web' && cfg.wa_conexao_id) return { via: 'web', wa_conexao_id: cfg.wa_conexao_id };
    if (cfg?.canal === 'meta' && cfg.wa_account_id) return { via: 'meta', wa_account_id: cfg.wa_account_id };
  }

  // Sem config: só a reunião do agente ('API SDR') mantém o lembrete, pela conta padrão.
  return origem === 'API SDR' ? { via: 'meta', wa_account_id: null } : null;
}

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

async function enviarTemplate(telefone: string, lem: Lembrete, ctx: Ctx, waAccountId: string | null): Promise<boolean> {
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
      wa_account_id: waAccountId,
      // Lembrete é UTILITY (reunião iminente) → fura a trava de 24h de marketing. Sem isso o
      // crm-whatsapp-send bloqueava silenciosamente (HTTP 200) quando a lead pegou template do
      // disparo no mesmo dia → o claim ficava setado e o lembrete nunca chegava.
      forcar_template: true,
    }),
  });
  if (!res.ok) {
    console.error(`[lembretes] send HTTP ${res.status}: ${await res.text()}`);
    return false;
  }
  return true;
}

// Linha WhatsApp Web (Uazapi): texto livre — sem janela 24h/template. Linha
// desconectada → o send devolve 409, o claim é solto e retenta no próximo tick.
async function enviarTexto(telefone: string, texto: string, waConexaoId: string): Promise<boolean> {
  const res = await fetch(SEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SERVICE_ROLE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      telefone,
      tipo: 'text',
      conteudo: texto,
      wa_conexao_id: waConexaoId,
    }),
  });
  if (!res.ok) {
    console.error(`[lembretes] send (web) HTTP ${res.status}: ${await res.text()}`);
    return false;
  }
  return true;
}

async function rodar(): Promise<{ candidatos: number; enviados: number }> {
  // TODAS as reuniões nas próximas ~2h05 (não só as da IA — a config por responsável
  // pode habilitar lembrete p/ reunião marcada por humano), não canceladas/realizadas/
  // já convertidas, com WhatsApp do lead. Quem NÃO tem rota (sem config e fora da IA)
  // é pulado em resolverRota().
  const { data, error } = await supabase
    .from('agendamentos')
    .select('id, data_agendamento, status, origem, sdr_id, link_reuniao, lembrete_2h_em, lembrete_30min_em, lead:leads!agendamentos_lead_id_fkey(nome, whatsapp)')
    .gt('data_agendamento', new Date().toISOString())
    .lt('data_agendamento', new Date(Date.now() + 125 * 60_000).toISOString())
    .not('status', 'in', '(cancelado,realizado,finalizado_venda)');
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

    // Só resolve a rota (RPC do espelho + config) quando há toque DEVIDO nesta reunião.
    const devidos = LEMBRETES.filter(
      (lem) => lem.template_name && !(ag as any)[lem.coluna] && restaMin >= lem.janelaMin[0] && restaMin <= lem.janelaMin[1],
    );
    if (!devidos.length) continue;

    const rota = await resolverRota(ag as any);
    if (!rota) continue; // sem número configurado e fora do padrão da IA → não lembra

    for (const lem of devidos) {
      if (!(await claim(ag.id, lem.coluna))) continue; // outro tick pegou
      const ok = rota.via === 'web'
        ? await enviarTexto(telefone, lem.textoLivre(ctx), rota.wa_conexao_id)
        : await enviarTemplate(telefone, lem, ctx, rota.wa_account_id);
      if (ok) {
        enviados++;
        console.log(`[lembretes] ${lem.coluna} enviado p/ ${telefone} via ${rota.via} (reunião ${dia} ${hora})`);
      } else {
        await soltarClaim(ag.id, lem.coluna); // falhou: retenta no próximo tick
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
