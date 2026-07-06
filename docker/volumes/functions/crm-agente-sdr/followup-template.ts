// crm-agente-sdr/followup-template.ts — ESTEIRA DE FOLLOW-UP DE JANELA FECHADA.
//
// Par do followup.ts (janela ABERTA, texto livre dentro das 24h). Quando passam
// 24h da última mensagem do lead, a janela do Meta fecha e texto livre é rejeitado
// (erro 131047). A partir daí a reabertura é por TEMPLATE aprovado.
//
// Régua: até 7 toques (dias contados desde o FECHAMENTO da janela = última msg + 24h).
// 1 template por dia, em horário variável pra não parecer robô; trava DURA "nunca
// < 24h entre templates" via crm_whatsapp_template_enviado_24h.
//
// ÂNCORA DUPLA (2026-07-04): lead que NUNCA respondeu (timestamp_mensagem NULL — só
// recebeu o 1º template do webhook/automação/reconciliação) TAMBÉM entra na cadência,
// ancorado em template_inicial_em (quando o 1º template SAIU; carimbado por trigger em
// crm_whatsapp_messages + no seed do crm-lead-webhook — migration
// 20260704120000_followup_template_inicial_em). Toque N fica devido N dias (dia da
// régua) após o 1º template. Quando o lead responde, timestamp_mensagem passa a mandar
// (o index zera os flags e a cadência recomeça ancorada na conversa, como sempre foi).
//
// CONFIG: os toques (template, dia, variáveis, ligado/desligado, NÚMERO de envio e
// template de FALLBACK) vêm da tabela public.crm_agente_sdr_followup_toques, editada
// pela tela (Config WhatsApp → Follow-up Janela Fechada). NÃO é hardcoded — cada tick
// recarrega a config; só entram na cadência toques ATIVOS com template_name preenchido
// (um toque desligado é PULADO e não trava os seguintes).
// ⚠️ Esta versão (config na tabela) já foi PERDIDA uma vez: viveu só na VPS sem commit
// e um git push com a versão antiga hardcoded a reverteu. NUNCA editar esta esteira
// fora do repo — o deploy-edges.yml publica o que está aqui.
//
// FALLBACK (2026-07-02, pedido do usuário): template MARKETING sofre throttle/limite
// da Meta (ex.: 131049) e o toque simplesmente não chega. Cada toque pode ter um
// template de FALLBACK (em geral UTILITY): se o envio do principal FALHAR, o fallback
// sai no lugar e o toque conta como feito. Cobre falha SÍNCRONA (Meta recusa o POST)
// e ASSÍNCRONA (status 'failed' chega depois pelo webhook — o resgate roda no próximo
// tick, dentro de 48h, sem violar a trava de 24h entre templates ENTREGUES).
//
// NÚMERO (2026-07-02, 2+ números qualificadores em produção): o toque sai pelo
// número DO LEAD — a conta da última mensagem dele em crm_whatsapp_messages cuja
// persona é qualificadora (conta de persona 'recontato' nunca; ver conta.ts).
// Fallbacks, nessa ordem: wa_account_id configurado no toque → conta CRM ativa.
// Assim a cadência continua na MESMA conversa em que o lead é atendido, e a
// resposta dele cai num número onde a IA atende.
//
// Como roda: cron chama o index com mode=followup-template em vários horários do dia
// (07/08/09/12/13/15/18 BRT). Cada lead "escolhe" deterministicamente UM desses
// horários por dia (hash do remotejid + dia), e o último tick do dia é rede de
// segurança pra quem foi barrado pela trava de 24h mais cedo. Tudo sob o lock por
// remotejid (não pisa numa rodada de inbound nem na esteira de janela aberta).
//
// SAI da esteira quando: followup_ativado=false, agendado=true, pausa_ia,
// nao_perturbe, atendimento_finalizado, modo_recontato (persona de no-show assume),
// lead respondeu (a janela reabre e o inbound assume), ou os toques acabaram. Os
// flags template_N_dia são ZERADOS ao reabrir (no index), então se o lead esfriar
// de novo a cadência recomeça do 1º toque ativo.

// deno-lint-ignore-file no-explicit-any
import { extrairPrimeiroNome } from './contexto.ts';
import { buscarLead, atualizarLead } from './historico.ts';
import { criarTelemetria, type Telemetria } from './eventos.ts';
import { contaDoLead, phoneVariants } from './conta.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SEND_URL = (Deno.env.get('AGENTE_SDR_SEND_URL') ?? `${SUPABASE_URL}/functions/v1/crm-whatsapp-send`).replace(/\/$/, '');

// ── Mapa de uma variável {{N}} do template ──────────────────────────────────
// 'curso' = cliente_ppg_leads_sdr.curso_interesse_original (curso/título do card,
// preenchido pelo seed do webhook/automação). Lead sem curso → o toque é PULADO
// (Meta rejeita parâmetro vazio; ver guarda em processarLead).
type VarTipo = 'primeiro_nome' | 'nome' | 'telefone' | 'email' | 'curso' | 'fixo';
// padrao: valor usado quando o dado do lead resolve VAZIO (ex.: "doutor(a)" pro nome,
// "sua área de interesse" pro curso). Sem padrao, lead com variável vazia é PULADO.
type VarMap = { tipo: VarTipo; valor?: string; padrao?: string };

// Um "envio" concreto: template + idioma + variáveis + conta de saída.
type TemplateEnvio = { template_name: string; lang: string; variaveis: VarMap[]; wa_account_id: string | null };

// toque: nº do toque (1..7), marca a coluna template_<toque>_dia ao enviar.
// dia: dias desde o FECHAMENTO da janela (última msg + 24h) p/ o toque ficar devido.
// fallback_template_name vazio = sem fallback.
type Toque = {
  toque: number;
  dia: number;
  template_name: string;
  lang: string;
  variaveis: VarMap[];
  fallback_template_name: string;
  fallback_lang: string;
  fallback_variaveis: VarMap[];
  wa_account_id: string | null;
  /** Janela de HORÁRIO do toque (hora BRT 0-23, inclusivas; null = qualquer horário).
   *  Ex.: template "Boa tarde…" com 12–18 só sai nos ticks da tarde. */
  hora_inicio: number | null;
  hora_fim: number | null;
  /** Régua POR CONTA: id da conta Meta dona desta régua; null = régua PADRÃO.
   *  A esteira escolhe a régua pela conta onde o LEAD conversa (contaDoLead). */
  regua_wa_account_id: string | null;
};

/** Régua do lead: a da conta onde ele conversa (se tiver toques ativos), senão a padrão. */
function reguaPara(toques: Toque[], conta: string | null): Toque[] {
  if (conta) {
    const daConta = toques.filter((t) => t.regua_wa_account_id === conta);
    if (daConta.length) return daConta;
  }
  return toques.filter((t) => t.regua_wa_account_id === null);
}

const JANELA_FECHADA_MIN = 1440;            // 24h: antes disso é a esteira de janela aberta
const MAX_LEADS_POR_TICK = 300;             // teto por tick (worker timeout 5min)
const CONCORRENCIA = 5;                      // leads enviados em paralelo por tick
const HORAS_UTC = [10, 11, 12, 15, 16, 18, 21]; // 07,08,09,12,13,15,18 BRT (UTC-3)
const ULTIMA_HORA_UTC = 21;                  // rede de segurança: último tick do dia
const RESGATE_JANELA_MS = 48 * 3600_000;     // falha assíncrona: resgata até 48h após o envio

const colunaToque = (n: number) => `template_${n}_dia`;

function parseVars(raw: unknown): VarMap[] {
  return Array.isArray(raw)
    ? (raw as any[]).map((v) => ({
        tipo: String(v?.tipo ?? 'fixo') as VarTipo,
        valor: v?.valor != null ? String(v.valor) : undefined,
        padrao: v?.padrao != null ? String(v.padrao) : undefined,
      }))
    : [];
}

// ── carrega a config dos toques (tabela editável pela tela) ─────────────────
// Só retorna toques ATIVOS e com template cadastrado, ordenados pelo nº do toque.
// select('*') de propósito: as colunas de fallback/número podem ainda não existir
// (migration pendente) — nesse caso os campos voltam undefined e viram default.
// Em erro/vazio retorna [] (a esteira não envia nada nesse tick — conservador).
async function carregarToques(supabase: any): Promise<Toque[]> {
  const { data, error } = await supabase
    .from('crm_agente_sdr_followup_toques')
    .select('*')
    .eq('ativo', true)
    .order('toque', { ascending: true });
  if (error) {
    console.error(`[crm-agente-sdr][followup-template] carregarToques: ${error.message}`);
    return [];
  }
  return (data ?? [])
    .filter((r: any) => typeof r.template_name === 'string' && r.template_name.trim() !== '')
    .map((r: any) => ({
      toque: Number(r.toque),
      dia: Number(r.dia),
      template_name: String(r.template_name).trim(),
      lang: String(r.template_lang || 'pt_BR'),
      variaveis: parseVars(r.variaveis),
      fallback_template_name: String(r.fallback_template_name ?? '').trim(),
      fallback_lang: String(r.fallback_template_lang || 'pt_BR'),
      fallback_variaveis: parseVars(r.fallback_variaveis),
      wa_account_id: r.wa_account_id ? String(r.wa_account_id) : null,
      hora_inicio: Number.isFinite(Number(r.hora_inicio)) && r.hora_inicio !== null ? Number(r.hora_inicio) : null,
      hora_fim: Number.isFinite(Number(r.hora_fim)) && r.hora_fim !== null ? Number(r.hora_fim) : null,
      regua_wa_account_id: r.regua_wa_account_id ? String(r.regua_wa_account_id) : null,
    }));
}

// ── janela de HORÁRIO do toque (hora BRT, inclusiva nas duas pontas) ─────────
const horaBrtDe = (horaUtc: number) => (horaUtc + 21) % 24; // UTC-3
function dentroDaJanelaHorario(t: Toque, horaUtc: number): boolean {
  if (t.hora_inicio == null || t.hora_fim == null) return true;
  const h = horaBrtDe(horaUtc);
  return h >= t.hora_inicio && h <= t.hora_fim;
}
/** Ticks (horas UTC) em que este toque PODE sair — o espalhamento por lead roda
 *  dentro deles. Janela sem nenhum tick elegível ⇒ o toque nunca envia (a tela
 *  avisa que a janela precisa conter um dos horários de envio). */
function horasElegiveis(t: Toque): number[] {
  return HORAS_UTC.filter((hu) => dentroDaJanelaHorario(t, hu));
}

const envioPrincipal = (t: Toque): TemplateEnvio =>
  ({ template_name: t.template_name, lang: t.lang, variaveis: t.variaveis, wa_account_id: t.wa_account_id });
const envioFallback = (t: Toque): TemplateEnvio =>
  ({ template_name: t.fallback_template_name, lang: t.fallback_lang, variaveis: t.fallback_variaveis, wa_account_id: t.wa_account_id });
// Fallback utilizável = configurado E diferente do principal (igual causaria loop de reenvio).
const temFallback = (t: Toque): boolean =>
  !!t.fallback_template_name && t.fallback_template_name !== t.template_name;

// Próximo toque pendente = o primeiro toque ATIVO cujo template_<toque>_dia ainda não é true.
function proximoToque(lead: any, toques: Toque[]): Toque | null {
  for (const t of toques) {
    if (lead[colunaToque(t.toque)] !== true) return t;
  }
  return null; // todos os toques ativos já saíram
}

// Toque devido pelo calendário? (dias desde o fechamento da janela >= t.dia)
// ÂNCORA DUPLA (2026-07-04): lead que JÁ conversou ancora na última msg dele
// (timestamp_mensagem; fechamento = msg + 24h). Lead que NUNCA respondeu (timestamp
// NULL) ancora no ENVIO do 1º template (template_inicial_em — carimbado por trigger
// em crm_whatsapp_messages + seed do webhook): template não abre janela nenhuma,
// então o próprio envio é o "fechamento" — toque N fica devido N dias (t.dia) após
// o 1º template (com a régua padrão dia=1, o toque 1 sai 24h depois do 1º template).
function devido(lead: any, now: number, t: Toque): boolean {
  const tsMsg = Date.parse(lead.timestamp_mensagem ?? '');
  let fechamento: number;
  if (Number.isFinite(tsMsg)) {
    fechamento = tsMsg + JANELA_FECHADA_MIN * 60_000;
  } else {
    const tsTpl = Date.parse(lead.template_inicial_em ?? '');
    if (!Number.isFinite(tsTpl)) return false; // sem âncora nenhuma: fora da esteira
    fechamento = tsTpl;
  }
  const elapsedDias = (now - fechamento) / 86_400_000;
  return elapsedDias >= t.dia;
}

// Candidato a RESGATE de falha assíncrona: já teve toque enviado há pouco (<48h).
// A confirmação (a última msg de template FALHOU?) é cara e roda só sob lock.
function resgateCandidato(lead: any, now: number): boolean {
  const ts = Date.parse(lead.template_followup_em ?? '');
  return Number.isFinite(ts) && now - ts <= RESGATE_JANELA_MS;
}

// Horário "sorteado" do lead pra hoje (estável no dia, varia dia a dia) — espalha
// os envios entre os ticks ELEGÍVEIS em vez de empilhar todos no primeiro horário.
// `horas` = ticks permitidos (todos, ou os da janela do toque); vazio → null.
function horaPreferida(remotejid: string, now: number, horas: number[] = HORAS_UTC): number | null {
  if (!horas.length) return null;
  const epochDay = Math.floor(now / 86_400_000);
  const s = `${remotejid}:${epochDay}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return horas[h % horas.length];
}

// Resolve o valor de uma variável do template a partir do lead. Dado VAZIO com
// `padrao` configurado na régua → usa o padrão (ex.: sem nome → "doutor(a)") em vez
// de pular o lead; sem padrão, o vazio propaga e o guard variavelVazia pula o toque.
function resolverVariavel(v: VarMap, lead: any): string {
  const bruto = (() => {
    switch (v.tipo) {
      case 'primeiro_nome': return extrairPrimeiroNome(lead?.nome) || '';
      case 'nome':          return String(lead?.nome ?? '').trim();
      case 'telefone':      return String(lead?.remotejid ?? '').split('@')[0];
      case 'email':         return String(lead?.email ?? '').trim();
      case 'curso':         return String(lead?.curso_interesse_original ?? '').trim();
      case 'fixo':          return String(v?.valor ?? '');
      default:              return String(v?.valor ?? '');
    }
  })();
  return bruto.trim() ? bruto : String(v?.padrao ?? '').trim() || bruto;
}

// Toque cujo template tem QUALQUER variável que resolve VAZIA pro lead (sem nome,
// sem curso, sem email…) → pular (a Meta rejeita parâmetro de body vazio — 131008;
// visto 06/07: 192 falhas do bom_dia_receber_cronograma, TODAS leads sem nome, e o
// toque não marcado re-tentava a cada tick). Não marca o toque: se o dado for
// preenchido depois, ele sai no próximo tick elegível. Devolve o tipo da variável
// vazia (telemetria) ou null quando está tudo preenchido.
function variavelVazia(variaveis: VarMap[], lead: any): string | null {
  for (const v of variaveis) {
    if (!resolverVariavel(v, lead).trim()) return v.tipo;
  }
  return null;
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
// Devolve o resultado detalhado (status HTTP + código da Meta) pro fallback decidir.
async function enviarTemplate(
  telefone: string,
  envio: TemplateEnvio,
  lead: any,
): Promise<{ ok: boolean; status: number; metaCode: number | null }> {
  const parametros = envio.variaveis.map((v) => ({ type: 'text', text: resolverVariavel(v, lead) }));
  const components = parametros.length ? [{ type: 'body', parameters: parametros }] : [];
  const res = await fetch(SEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SERVICE_ROLE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      telefone,
      tipo: 'template',
      template_name: envio.template_name,
      template_lang: envio.lang,
      template_components: components,
      wa_account_id: envio.wa_account_id, // null = crm-whatsapp-send resolve a conta CRM ativa
    }),
  });
  if (res.ok) return { ok: true, status: res.status, metaCode: null };
  const corpo = await res.text();
  let metaCode: number | null = null;
  try { metaCode = JSON.parse(corpo)?.meta_code ?? null; } catch { /* corpo não-JSON */ }
  console.error(`[crm-agente-sdr][followup-template] send HTTP ${res.status} (${envio.template_name}): ${corpo}`);
  return { ok: false, status: res.status, metaCode };
}

// ── seleção grossa no banco (booleans + janela fechada) ─────────────────────
const COLS_CANDIDATO =
  'remotejid, nome, email, curso_interesse_original, timestamp_mensagem, followup_ativado, iniciar_atendimento, agendado, pausa_ia, nao_perturbe, atendimento_finalizado, template_1_dia, template_2_dia, template_3_dia, template_4_dia, template_5_dia, template_6_dia, template_7_dia, template_followup_em, modo_recontato';

function queryCandidatos(supabase: any, cols: string) {
  return supabase
    .from('cliente_ppg_leads_sdr')
    .select(cols)
    .eq('followup_ativado', true)
    .eq('iniciar_atendimento', true)
    .not('modo_recontato', 'is', true) // lead em recontato (no-show) NÃO recebe a cadência de lead novo
    .or('agendado.is.null,agendado.eq.false')
    .or('pausa_ia.is.null,pausa_ia.eq.false')
    .or('nao_perturbe.is.null,nao_perturbe.eq.false')
    .or('atendimento_finalizado.is.null,atendimento_finalizado.eq.false')
    .order('timestamp_mensagem', { ascending: true })
    .limit(3000);
}

async function selecionarCandidatos(supabase: any): Promise<any[]> {
  const limiteJanela = new Date(Date.now() - JANELA_FECHADA_MIN * 60_000).toISOString(); // <= agora-24h
  // Janela fechada por UMA das âncoras: última msg do lead há 24h+ (conversou e
  // esfriou) OU — lead que NUNCA respondeu (timestamp NULL) — 1º template há 24h+
  // (template_inicial_em, migration 20260704120000).
  //
  // ⚠️ DUAS consultas DE PROPÓSITO (uma por coorte): o PostgREST corta qualquer SELECT
  // em 1000 linhas (max-rows), e com um SELECT só + NULLS LAST os nunca-respondentes
  // ficavam SEMPRE depois do corte quando havia 1000+ conversados-esfriaram — foi o
  // tick de 06/07 (candidatos=1000, zero âncora template_inicial). Separando, cada
  // coorte tem seu próprio teto de 1000 e as duas entram no tick; os conversados
  // continuam na frente da fila (prioridade preservada).
  const conversados = await queryCandidatos(supabase, COLS_CANDIDATO)
    .lt('timestamp_mensagem', limiteJanela);
  if (conversados.error) throw new Error(`selecionarCandidatos (conversados): ${conversados.error.message}`);

  const mudos = await queryCandidatos(supabase, `${COLS_CANDIDATO}, template_inicial_em`)
    .is('timestamp_mensagem', null)
    .lt('template_inicial_em', limiteJanela);
  if (mudos.error) {
    // DEGRADAÇÃO pré-migration: coluna template_inicial_em ausente → segue só com quem
    // conversou (comportamento antigo) em vez de derrubar a esteira inteira.
    if (String(mudos.error.message).includes('template_inicial_em')) {
      console.error('[crm-agente-sdr][followup-template] template_inicial_em ausente (migration 20260704120000 pendente) — seleção legada');
      return conversados.data ?? [];
    }
    throw new Error(`selecionarCandidatos (mudos): ${mudos.error.message}`);
  }
  return [...(conversados.data ?? []), ...(mudos.data ?? [])];
}

// Gates comuns (revalidados com o lead FRESCO, sob lock).
function leadElegivel(lead: any): boolean {
  if (!lead) return false;
  if (lead.followup_ativado !== true) return false;
  if (lead.iniciar_atendimento !== true) return false;
  if (lead.modo_recontato === true) return false; // virou recontato no meio-tempo
  if (lead.agendado === true) return false;
  if (lead.pausa_ia === true) return false;
  if (lead.nao_perturbe === true) return false;
  if (lead.atendimento_finalizado === true) return false;
  return true;
}

// ── RESGATE de falha ASSÍNCRONA ──────────────────────────────────────────────
// O envio do toque voltou 200 mas a Meta marcou 'failed' depois (webhook) — típico
// de throttle de MARKETING (131049). Se o último template do número FALHOU e ele é
// o principal de um toque com fallback, manda o fallback agora. Guardas:
// - só se NENHUM template com sucesso saiu nas últimas 24h (mantém a trava dura);
// - o nome falho tem que ser o PRINCIPAL de um toque (fallback falho não re-tenta — sem loop).
async function resgatarFalhaAsync(supabase: any, lead: any, toques: Toque[], tel: Telemetria): Promise<boolean> {
  const telefone = String(lead.remotejid).split('@')[0];
  const variants = phoneVariants(telefone);

  const { data: rows, error } = await supabase
    .from('crm_whatsapp_messages')
    .select('template_name, status_entrega, created_at')
    .in('telefone', variants)
    .eq('direcao', 'outbound')
    .eq('tipo', 'template')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) {
    console.error(`[crm-agente-sdr][followup-template] resgate ${telefone}: ${error.message}`);
    return false;
  }
  const ult = rows?.[0];
  if (!ult || ult.status_entrega !== 'failed') return false;

  const t = toques.find((x) => x.template_name === ult.template_name);
  if (!t || !temFallback(t)) return false;
  if (lead[colunaToque(t.toque)] !== true) return false; // não foi a esteira que mandou

  // Trava de 24h olhando só templates ENTREGÁVEIS (o failed não abriu conversa nenhuma).
  const desde = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data: okRows } = await supabase
    .from('crm_whatsapp_messages')
    .select('id')
    .in('telefone', variants)
    .eq('direcao', 'outbound')
    .eq('tipo', 'template')
    .neq('status_entrega', 'failed')
    .gte('created_at', desde)
    .limit(1);
  if ((okRows ?? []).length > 0) return false;

  // Mesma resolução de número do envio normal: conta do lead → config do toque → ativa.
  const conta = (await contaDoLead(supabase, telefone)) ?? t.wa_account_id ?? null;
  const r = await enviarTemplate(telefone, { ...envioFallback(t), wa_account_id: conta }, lead);
  if (!r.ok) {
    tel.registrar('followup_template_fallback_falhou', { toque: t.toque, template_fallback: t.fallback_template_name, modo: 'assincrono', conta, status: r.status, meta_code: r.metaCode });
    return false;
  }
  await atualizarLead(supabase, lead.remotejid, { template_followup_em: new Date().toISOString() });
  tel.registrar('followup_template_fallback_enviado', {
    toque: t.toque, modo: 'assincrono', conta,
    template_principal: t.template_name, template_fallback: t.fallback_template_name,
  });
  return true;
}

// ── processa um lead (sob lock, revalidando o estado fresco) ────────────────
// `contaSel` = conta onde o lead conversa (resolvida na seleção) — define a RÉGUA do
// lead (reguaPara) e o número de saída.
async function processarLead(
  supabase: any,
  leadSel: any,
  toqueSel: Toque | null,
  toques: Toque[],
  resgate: boolean,
  tel: Telemetria,
  contaSel: string | null,
): Promise<boolean> {
  const remotejid = leadSel.remotejid;
  if (!(await lockClaim(supabase, remotejid))) return false; // inbound/outra esteira em andamento
  try {
    const lead = await buscarLead(supabase, remotejid);
    if (!leadElegivel(lead)) return false;

    // Régua do lead: a da conta onde ele conversa (se existir), senão a padrão.
    const toquesLead = reguaPara(toques, contaSel);
    if (!toquesLead.length) return false;

    if (resgate) return await resgatarFalhaAsync(supabase, lead, toquesLead, tel);

    // Recalcula o toque com o estado FRESCO (pode ter mudado entre a seleção e agora).
    const t = proximoToque(lead, toquesLead);
    if (!t || !toqueSel || t.toque !== toqueSel.toque) return false;
    if (!devido(lead, Date.now(), t)) return false;

    // Janela de horário do toque (revalidada aqui com a hora ATUAL — o tick pode ter
    // atrasado): fora da janela ⇒ não envia nem marca; o próximo tick elegível pega.
    if (!dentroDaJanelaHorario(t, new Date().getUTCHours())) {
      tel.registrar('followup_template_pulado', { motivo: 'fora_do_horario', toque: t.toque });
      return false;
    }

    const telefone = String(remotejid).split('@')[0];
    if (await templateNas24h(supabase, telefone)) {
      tel.registrar('followup_template_pulado', { motivo: 'trava_24h', toque: t.toque });
      return false;
    }

    // Guardas DURAS (cinto e suspensório — followup_ativado já deveria estar off nesses
    // casos): lead ARQUIVADO ou com TEMPORIZADOR DE RECONTATO ativo NUNCA recebe template
    // de follow-up. Em erro da RPC, NÃO envia (conservador, igual à trava 24h).
    {
      const { data: flags, error: flagsErr } = await supabase.rpc('crm_lead_flags_por_telefone', { p_telefone: telefone });
      if (flagsErr) {
        console.error(`[crm-agente-sdr][followup-template] flags ${telefone}: ${flagsErr.message}`);
        return false;
      }
      const f = Array.isArray(flags) ? flags[0] : flags;
      if (f?.arquivado === true) {
        tel.registrar('followup_template_pulado', { motivo: 'lead_arquivado', toque: t.toque });
        return false;
      }
      if (f?.timer_ativo === true) {
        tel.registrar('followup_template_pulado', { motivo: 'timer_recontato', toque: t.toque });
        return false;
      }
    }

    // Template do toque com variável vazia pro lead (sem nome/curso/email na base) →
    // pula (não marca o toque; se o dado for preenchido depois, sai no próximo tick).
    const varVazia = variavelVazia(t.variaveis, lead);
    if (varVazia) {
      tel.registrar('followup_template_pulado', { motivo: 'variavel_vazia', variavel: varVazia, toque: t.toque });
      return false;
    }

    // Número de saída: conta DO LEAD (resolvida na seleção — última msg num número
    // qualificador) → config do toque → conta ativa. Mantém a cadência na conversa em
    // que o lead é atendido (janela/thread são por número na Meta).
    const conta = contaSel ?? (await contaDoLead(supabase, telefone)) ?? t.wa_account_id ?? null;

    let usouFallback = false;
    let r = await enviarTemplate(telefone, { ...envioPrincipal(t), wa_account_id: conta }, lead);
    if (!r.ok) {
      tel.registrar('followup_template_falhou', { toque: t.toque, template: t.template_name, conta, status: r.status, meta_code: r.metaCode });
      if (!temFallback(t)) return false; // não marca o toque: tenta de novo no próximo tick elegível
      r = await enviarTemplate(telefone, { ...envioFallback(t), wa_account_id: conta }, lead);
      if (!r.ok) {
        tel.registrar('followup_template_fallback_falhou', { toque: t.toque, template_fallback: t.fallback_template_name, modo: 'sincrono', conta, status: r.status, meta_code: r.metaCode });
        return false;
      }
      usouFallback = true;
    }

    // Marca o toque + âncora. (A msg já está logada em crm_whatsapp_messages pelo send.)
    await atualizarLead(supabase, remotejid, {
      [colunaToque(t.toque)]: true,
      template_followup_em: new Date().toISOString(),
    });
    if (usouFallback) {
      tel.registrar('followup_template_fallback_enviado', {
        toque: t.toque, dia: t.dia, modo: 'sincrono', conta,
        template_principal: t.template_name, template_fallback: t.fallback_template_name,
      });
    } else {
      tel.registrar('followup_template_enviado', {
        toque: t.toque, dia: t.dia, template: t.template_name, conta,
        ancora: lead.timestamp_mensagem ? 'ultima_msg_lead' : 'template_inicial',
      });
    }
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
): Promise<{ candidatos: number; devidos: number; enviados: number; hora_utc: number; toques_ativos: number }> {
  const inicio = Date.now();
  const tel = criarTelemetria(supabase, 'followup-template-sweep');
  const horaAtual = Number.isFinite(opts?.horaUtc) ? (opts!.horaUtc as number) : new Date(inicio).getUTCHours();
  const cap = Number.isFinite(opts?.limite) && (opts!.limite as number) > 0 ? Math.floor(opts!.limite as number) : MAX_LEADS_POR_TICK;

  const toques = await carregarToques(supabase);
  if (!toques.length) {
    tel.registrar('followup_template_tick', { hora_utc: horaAtual, candidatos: 0, devidos: 0, enviados: 0, motivo: 'sem_toques_ativos' }, Date.now() - inicio);
    return { candidatos: 0, devidos: 0, enviados: 0, hora_utc: horaAtual, toques_ativos: 0 };
  }

  const candidatos = await selecionarCandidatos(supabase);
  const devidos: { lead: any; toque: Toque | null; resgate: boolean; conta: string | null }[] = [];
  // Régua POR CONTA: resolve a conta onde cada candidato conversa (cache por telefone —
  // query indexada em crm_whatsapp_messages) e usa a régua daquela conta (fallback: padrão).
  const contaCache = new Map<string, string | null>();
  for (const lead of candidatos) {
    const telefone = String(lead.remotejid).split('@')[0];
    let conta: string | null;
    if (contaCache.has(telefone)) {
      conta = contaCache.get(telefone) ?? null;
    } else {
      conta = await contaDoLead(supabase, telefone).catch(() => null);
      contaCache.set(telefone, conta);
    }
    const toquesLead = reguaPara(toques, conta);
    if (!toquesLead.length) continue;

    const t = proximoToque(lead, toquesLead);
    if (t && devido(lead, inicio, t)) {
      // Variável do template vazia pro lead (sem nome/curso na base) → NEM entra nos
      // devidos: o pulo tardio (processarLead) deixava esses leads OCUPANDO o cap de
      // 300 do tick a cada rodada e afogando os demais (06/07: ticks com 300 devidos
      // e só 59-82 enviados). O guard tardio continua como cinto (estado fresco).
      if (variavelVazia(t.variaveis, lead)) continue;
      // Espalhamento por horário DENTRO da janela do toque (janela sem tick elegível
      // ⇒ o toque nunca sai — a tela avisa na configuração). O catch-up do fim do dia
      // é o ÚLTIMO tick elegível da janela (não o global, que pode estar fora dela).
      const horas = horasElegiveis(t);
      if (!horas.length) continue;
      const hp = horaPreferida(lead.remotejid, inicio, horas);
      if (horaAtual !== hp && horaAtual !== horas[horas.length - 1]) continue;
      devidos.push({ lead, toque: t, resgate: false, conta });
    } else if (toquesLead.some(temFallback) && resgateCandidato(lead, inicio)) {
      // Toque recente pode ter falhado ASSÍNCRONO (webhook marcou 'failed' depois do 200).
      const hp = horaPreferida(lead.remotejid, inicio);
      if (horaAtual !== hp && horaAtual !== ULTIMA_HORA_UTC) continue; // espalha por horário
      devidos.push({ lead, toque: null, resgate: true, conta });
    }
    if (devidos.length >= cap) break;
  }

  let enviados = 0;
  await comConcorrencia(devidos, CONCORRENCIA, async (d) => {
    if (await processarLead(supabase, d.lead, d.toque, toques, d.resgate, tel, d.conta)) enviados++;
  });

  tel.registrar('followup_template_tick', {
    hora_utc: horaAtual,
    candidatos: candidatos.length,
    devidos: devidos.length,
    enviados,
    toques_ativos: toques.length,
  }, Date.now() - inicio);
  return { candidatos: candidatos.length, devidos: devidos.length, enviados, hora_utc: horaAtual, toques_ativos: toques.length };
}
