// crm-agente-sdr/followup-template.ts — ESTEIRA DE FOLLOW-UP DE JANELA FECHADA.
//
// Par do followup.ts (janela ABERTA, texto livre dentro das 24h). Quando passam
// 24h da última mensagem do lead, a janela do Meta fecha e texto livre é rejeitado
// (erro 131047). A partir daí a reabertura é por TEMPLATE aprovado.
//
// Régua: 7 toques ao longo de 9 dias (dias contados desde o FECHAMENTO da janela =
// última msg + 24h). 1 template por dia, em horário variável pra não parecer robô;
// trava DURA "nunca < 24h entre templates" via crm_whatsapp_template_enviado_24h
// (vê toda saída de template, de qualquer origem).
//
// Como roda: cron chama o index com mode=followup-template em vários horários do dia
// (07/08/09/12/13/15/18 BRT). Cada lead "escolhe" deterministicamente UM desses
// horários por dia (hash do remotejid + dia), e o último tick do dia é rede de
// segurança pra quem foi barrado pela trava de 24h mais cedo. Tudo sob o lock por
// remotejid (não pisa numa rodada de inbound nem na esteira de janela aberta).
//
// SAI da esteira quando: followup_ativado=false (o agente desliga p/ lead sem
// graduação / incompatível, ou ao agendar reunião), agendado=true, pausa_ia,
// atendimento_finalizado, lead respondeu (a janela reabre e o inbound assume), ou
// os 7 toques acabaram. Os flags template_N_dia são ZERADOS ao reabrir (no index),
// então se o lead esfriar de novo a cadência recomeça do 1º toque.

// deno-lint-ignore-file no-explicit-any
import { extrairPrimeiroNome } from './contexto.ts';
import { buscarLead, atualizarLead } from './historico.ts';
import { criarTelemetria, type Telemetria } from './eventos.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SEND_URL = (Deno.env.get('AGENTE_SDR_SEND_URL') ?? `${SUPABASE_URL}/functions/v1/crm-whatsapp-send`).replace(/\/$/, '');

// ── RÉGUA DOS 7 TOQUES (PREENCHER os template_name quando cadastrar na Meta) ──
// toque    = nº do toque (1..7), marca a coluna template_<toque>_dia ao enviar.
// dia      = dias desde o FECHAMENTO da janela (última msg + 24h) p/ o toque ficar devido.
// nome_var = true se o template usa {{1}} = primeiro nome do lead (manda o parâmetro);
//            false se o template não tem variável (manda sem componentes).
// template_name VAZIO ('') = toque DESLIGADO (ainda não cadastrado) → é pulado.
type Toque = { toque: number; dia: number; template_name: string; lang: string; nome_var: boolean };
const TOQUES: Toque[] = [
  { toque: 1, dia: 1, template_name: '', lang: 'pt_BR', nome_var: true },
  { toque: 2, dia: 2, template_name: '', lang: 'pt_BR', nome_var: true },
  { toque: 3, dia: 3, template_name: '', lang: 'pt_BR', nome_var: true },
  { toque: 4, dia: 4, template_name: '', lang: 'pt_BR', nome_var: true },
  { toque: 5, dia: 5, template_name: '', lang: 'pt_BR', nome_var: true },
  { toque: 6, dia: 7, template_name: '', lang: 'pt_BR', nome_var: true },
  { toque: 7, dia: 9, template_name: 'mensagem_disparo_39', lang: 'pt_BR', nome_var: false },
];

const JANELA_FECHADA_MIN = 1440;            // 24h: antes disso é a esteira de janela aberta
const MAX_LEADS_POR_TICK = 300;             // teto por tick (worker timeout 5min)
const CONCORRENCIA = 5;                      // leads enviados em paralelo por tick
const HORAS_UTC = [10, 11, 12, 15, 16, 18, 21]; // 07,08,09,12,13,15,18 BRT (UTC-3)
const ULTIMA_HORA_UTC = 21;                  // rede de segurança: último tick do dia

const colunaToque = (n: number) => `template_${n}_dia`;

// Próximo toque pendente = o primeiro template_<toque>_dia que ainda não é true.
function proximoToque(lead: any): Toque | null {
  for (const t of TOQUES) {
    if (lead[colunaToque(t.toque)] !== true) return t;
  }
  return null; // os 7 já saíram
}

// Toque devido pelo calendário? (dias desde o fechamento da janela >= t.dia)
function devido(lead: any, now: number, t: Toque): boolean {
  const ts = Date.parse(lead.timestamp_mensagem ?? '');
  if (!Number.isFinite(ts)) return false;
  const fechamento = ts + JANELA_FECHADA_MIN * 60_000;
  const elapsedDias = (now - fechamento) / 86_400_000;
  return elapsedDias >= t.dia;
}

// Horário "sorteado" do lead pra hoje (estável no dia, varia dia a dia) — espalha
// os envios entre os ticks em vez de empilhar todos no primeiro horário.
function horaPreferida(remotejid: string, now: number): number {
  const epochDay = Math.floor(now / 86_400_000);
  const s = `${remotejid}:${epochDay}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return HORAS_UTC[h % HORAS_UTC.length];
}

// ── trava dura: nenhum template (de qualquer origem) nas últimas 24h ─────────
async function templateNas24h(supabase: any, telefone: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('crm_whatsapp_template_enviado_24h', { p_telefone: telefone });
  if (error) {
    console.error(`[crm-agente-sdr][followup-template] trava 24h ${telefone}: ${error.message}`);
    return true; // em erro, NÃO envia (conservador)
  }
  return data === true;
}

// ── lock por remotejid (mesmas RPCs do inbound/janela aberta) ───────────────
async function lockClaim(supabase: any, remotejid: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('crm_agente_sdr_lock_claim', {
    p_remotejid: remotejid,
    p_ttl_segundos: 240,
  });
  if (error) {
    console.error(`[crm-agente-sdr][followup-template] lock claim ${remotejid}: ${error.message}`);
    return false;
  }
  return data === true;
}
async function lockSoltar(supabase: any, remotejid: string): Promise<void> {
  await supabase.from('crm_agente_sdr_lock').delete().eq('remotejid', remotejid);
}

// ── envio do template via crm-whatsapp-send ─────────────────────────────────
async function enviarTemplate(telefone: string, t: Toque, nome: string): Promise<boolean> {
  const components = t.nome_var
    ? [{ type: 'body', parameters: [{ type: 'text', text: nome || '' }] }]
    : [];
  const res = await fetch(SEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SERVICE_ROLE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      telefone,
      tipo: 'template',
      template_name: t.template_name,
      template_lang: t.lang,
      template_components: components,
      wa_account_id: null, // crm-whatsapp-send resolve a conta CRM ativa
    }),
  });
  if (!res.ok) {
    console.error(`[crm-agente-sdr][followup-template] send HTTP ${res.status}: ${await res.text()}`);
    return false;
  }
  return true;
}

// ── seleção grossa no banco (booleans + janela fechada) ─────────────────────
async function selecionarCandidatos(supabase: any): Promise<any[]> {
  const limiteJanela = new Date(Date.now() - JANELA_FECHADA_MIN * 60_000).toISOString(); // <= agora-24h
  const { data, error } = await supabase
    .from('cliente_ppg_leads_sdr')
    .select('remotejid, nome, timestamp_mensagem, followup_ativado, iniciar_atendimento, agendado, pausa_ia, atendimento_finalizado, template_1_dia, template_2_dia, template_3_dia, template_4_dia, template_5_dia, template_6_dia, template_7_dia, template_followup_em, modo_recontato')
    .eq('followup_ativado', true)
    .eq('iniciar_atendimento', true)
    .not('modo_recontato', 'is', true) // lead em recontato (no-show) NÃO recebe a cadência de lead novo
    .or('agendado.is.null,agendado.eq.false')
    .or('pausa_ia.is.null,pausa_ia.eq.false')
    .or('atendimento_finalizado.is.null,atendimento_finalizado.eq.false')
    .lt('timestamp_mensagem', limiteJanela)
    .order('timestamp_mensagem', { ascending: true })
    .limit(3000);
  if (error) throw new Error(`selecionarCandidatos: ${error.message}`);
  return data ?? [];
}

// ── processa um lead (sob lock, revalidando o estado fresco) ────────────────
async function processarLead(supabase: any, leadSel: any, toqueSel: Toque, tel: Telemetria): Promise<boolean> {
  const remotejid = leadSel.remotejid;
  if (!(await lockClaim(supabase, remotejid))) return false; // inbound/outra esteira em andamento
  try {
    const lead = await buscarLead(supabase, remotejid);
    if (!lead) return false;
    if (lead.followup_ativado !== true) return false;
    if (lead.iniciar_atendimento !== true) return false;
    if (lead.modo_recontato === true) return false; // virou recontato no meio-tempo
    if (lead.agendado === true) return false;
    if (lead.pausa_ia === true) return false;
    if (lead.atendimento_finalizado === true) return false;

    // Recalcula o toque com o estado FRESCO (pode ter mudado entre a seleção e agora).
    const t = proximoToque(lead);
    if (!t || t.toque !== toqueSel.toque) return false;
    if (!t.template_name) return false;                 // toque não cadastrado
    if (!devido(lead, Date.now(), t)) return false;

    const telefone = String(remotejid).split('@')[0];
    if (await templateNas24h(supabase, telefone)) {
      tel.registrar('followup_template_pulado', { motivo: 'trava_24h', toque: t.toque });
      return false;
    }

    const nome = extrairPrimeiroNome(lead.nome);
    const ok = await enviarTemplate(telefone, t, nome);
    if (!ok) {
      tel.registrar('followup_template_falhou', { toque: t.toque, template: t.template_name });
      return false; // não marca o toque: tenta de novo no próximo tick elegível
    }

    // Marca o toque + âncora. (A msg já está logada em crm_whatsapp_messages pelo send.)
    await atualizarLead(supabase, remotejid, {
      [colunaToque(t.toque)]: true,
      template_followup_em: new Date().toISOString(),
    });
    tel.registrar('followup_template_enviado', { toque: t.toque, dia: t.dia, template: t.template_name });
    return true;
  } catch (e) {
    tel.registrar('erro', { onde: 'processarLeadTemplate', remotejid }, undefined, (e as Error).message);
    console.error(`[crm-agente-sdr][followup-template] ${remotejid}:`, e);
    return false;
  } finally {
    await lockSoltar(supabase, remotejid);
  }
}

// Pool de concorrência simples (sem libs).
async function comConcorrencia<T>(itens: T[], limite: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limite, itens.length) }, async () => {
    while (i < itens.length) {
      const idx = i++;
      await fn(itens[idx]);
    }
  });
  await Promise.all(workers);
}

// ── entrada (chamada pelo index quando mode=followup-template) ──────────────
// opts.horaUtc: força a hora do tick (default = hora UTC atual); útil pra teste.
// opts.limite: teto de leads neste tick (default MAX_LEADS_POR_TICK).
export async function rodarEsteiraFollowupTemplate(
  supabase: any,
  opts?: { limite?: number; horaUtc?: number },
): Promise<{ candidatos: number; devidos: number; enviados: number; hora_utc: number }> {
  const inicio = Date.now();
  const tel = criarTelemetria(supabase, 'followup-template-sweep');
  const horaAtual = Number.isFinite(opts?.horaUtc) ? (opts!.horaUtc as number) : new Date(inicio).getUTCHours();
  const cap = Number.isFinite(opts?.limite) && (opts!.limite as number) > 0 ? Math.floor(opts!.limite as number) : MAX_LEADS_POR_TICK;

  const candidatos = await selecionarCandidatos(supabase);
  const devidos: { lead: any; toque: Toque }[] = [];
  for (const lead of candidatos) {
    const t = proximoToque(lead);
    if (!t || !t.template_name) continue;          // sem toque pendente ou toque desligado
    if (!devido(lead, inicio, t)) continue;        // ainda não chegou o dia do toque
    const hp = horaPreferida(lead.remotejid, inicio);
    if (horaAtual !== hp && horaAtual !== ULTIMA_HORA_UTC) continue; // espalha por horário
    devidos.push({ lead, toque: t });
    if (devidos.length >= cap) break;
  }

  let enviados = 0;
  await comConcorrencia(devidos, CONCORRENCIA, async (d) => {
    if (await processarLead(supabase, d.lead, d.toque, tel)) enviados++;
  });

  tel.registrar('followup_template_tick', {
    hora_utc: horaAtual,
    candidatos: candidatos.length,
    devidos: devidos.length,
    enviados,
  }, Date.now() - inicio);
  return { candidatos: candidatos.length, devidos: devidos.length, enviados, hora_utc: horaAtual };
}
