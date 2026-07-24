// crm-agente-sdr/followup.ts — ESTEIRA DE FOLLOW-UP DE JANELA ABERTA do João.
//
// Port do fluxo n8n "Followup PPG - Claude (Prod)", com 3 mudanças combinadas
// com o usuário (jun/2026):
//   1. PROMPT reescrito pra ORDEM NOVA do funil (horário antes da formação) —
//      ver prompts-followup.ts.
//   2. 7 toques na janela aberta (o n8n só tinha 3 ligados + lixo de teste).
//   3. SEM teto de tentativas (a trava de 4 do n8n saiu): a esteira de janela
//      FECHADA (template) é separada e cuida do pós-24h.
//
// Como roda: cron chama o index com mode=followup (sem payload de inbound). Esta
// varredura seleciona os leads elegíveis, decide o próximo toque devido por lead
// e REABRE a conversa pelo MESMO pipeline do agente principal (fraciona + delay
// + crm-whatsapp-send). Tudo sob o lock por remotejid (não pisa numa rodada de
// inbound em andamento).
//
// Régua de produção (minutos desde a última msg do lead, ancorada em
// timestamp_mensagem): 15min · 1h · 2h · 4h · 7h · 12h · 23h. Todos DENTRO das
// 24h da janela do Meta — texto livre fora disso a Meta rejeita (erro 131047),
// é a esteira de template que assume.

// deno-lint-ignore-file no-explicit-any
import { FOLLOWUP_SYSTEM } from './prompts-followup.ts';
import { chamarAnthropic, MODELO_AGENTE } from './agente.ts';
import { extrairPrimeiroNome, montarContextoTemporal, renderPrompt } from './contexto.ts';
import {
  atualizarLead,
  buscarLead,
  carregarHistorico,
  gravarMensagem,
  MARCADOR_FOLLOWUP,
  type Msg,
} from './historico.ts';
import { enviarResposta } from './saida.ts';
import type { CtxConversa } from './tools.ts';
import { criarTelemetria, resumir, type Telemetria } from './eventos.ts';
import { contaDoLead } from './conta.ts';

// Cadência da JANELA ABERTA — 7 toques, em minutos desde a última msg do lead.
const CADENCIA_MIN = [15, 60, 120, 240, 420, 720, 1380];
const JANELA_ABERTA_MIN = 1440;   // 24h Meta: fora disso é a esteira de template
const LOCK_TTL_SEGUNDOS = 240;    // mesmo TTL do lock do inbound
// ⚠️ Teto DIMENSIONADO PRO TIMEOUT do worker (5min): cada lead custa ~40-60s (geração LLM
// + dribble de 2+ chunks com 12s de delay cada). Com 30 leads (6 ondas de 5) o tick passava
// de 5min e o worker MORRIA no meio do dribble — mensagem gerada, toque JÁ consumido
// (follow_up marca antes do envio, anti-duplicação) e NADA enviado, sem erro na telemetria
// (caso Waleska, 2026-07-03, após o disparo encher a cadência: 1.931 avaliações → 163
// envios em 6h). 10 leads = 2 ondas ≈ 2min, com folga; o tick roda a cada 2min → vazão
// de ~300/h, de sobra. NÃO subir sem repensar o dribble.
const MAX_LEADS_POR_TICK = 10;    // teto por varredura; resto vem no próximo tick
const CONCORRENCIA = 5;           // leads processados em paralelo por tick

// ── pausa noturna: NÃO reabre conversa de madrugada ─────────────────────────
// Entre 22:00 e 06:30 (Brasília) a esteira de janela aberta fica em silêncio —
// não mandar follow-up no meio da noite. A varredura é curto-circuitada por
// inteiro nesse intervalo. Quando volta às 06:30 o catch-up de proximoToqueDevido
// manda UM toque por lead que cruzou thresholds na madrugada (não uma rajada).
const PAUSA_NOTURNA_INICIO_MIN = 22 * 60;       // 22:00 BRT
const PAUSA_NOTURNA_FIM_MIN = 6 * 60 + 30;      // 06:30 BRT
function dentroDaPausaNoturna(): boolean {
  // Brasília = UTC-3 fixo (sem horário de verão desde 2019), igual ao contexto.ts.
  const br = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const min = br.getUTCHours() * 60 + br.getUTCMinutes();
  // Janela cruza a meia-noite: [22:00, 24:00) ∪ [00:00, 06:30).
  return min >= PAUSA_NOTURNA_INICIO_MIN || min < PAUSA_NOTURNA_FIM_MIN;
}

// ── estado do follow no lead (coluna follow_up, texto "follow_0N") ──────────
function stageDoFollowUp(follow_up: string | null | undefined): number {
  const m = String(follow_up ?? '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}
function followUpDoStage(stage: number): string {
  return `follow_0${stage}`;
}

// Toque devido AGORA, ou null se nenhum. Retorna o ESTÁGIO ESPERADO = quantos
// toques já deveriam ter saído (thresholds cruzados), não jaEnviado+1. Isso evita
// RAJADA quando a esteira fica parada ou o cron atrasa: um lead que acumulou (ex.:
// 5h parado, nenhum follow ainda) recebe UM toque de catch-up agora (o do momento),
// não os toques perdidos em sequência. Os toques perdidos são pulados — o estilo da
// mensagem é guiado pela contagem de tentativas REAIS (marcadores no histórico),
// não pelo número do estágio, então o lead vê uma 1ª-tentativa coerente mesmo que o
// estágio "pule" pra 4. Depois de enviado, esperado==jaEnviado e só volta a disparar
// quando o elapsed cruzar o próximo threshold (cadência normal daí pra frente).
function proximoToqueDevido(elapsedMin: number, jaEnviado: number): number | null {
  if (elapsedMin >= JANELA_ABERTA_MIN) return null; // janela fechada (vira esteira de template)
  let esperado = 0;
  for (let i = 0; i < CADENCIA_MIN.length; i++) {
    if (elapsedMin >= CADENCIA_MIN[i]) esperado = i + 1;
  }
  if (esperado <= jaEnviado) return null; // já em dia
  return esperado;
}

// ── lock por remotejid (mesmas RPCs do inbound; coordena as duas esteiras) ──
async function lockClaim(supabase: any, remotejid: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('crm_agente_sdr_lock_claim', {
    p_remotejid: remotejid,
    p_ttl_segundos: LOCK_TTL_SEGUNDOS,
  });
  if (error) {
    console.error(`[crm-agente-sdr][followup] lock claim ${remotejid}: ${error.message}`);
    return false; // em erro, NÃO envia (evita double-send concorrente)
  }
  return data === true;
}
const lockRenovar = (supabase: any, remotejid: string) => async () => {
  await supabase.rpc('crm_agente_sdr_lock_renovar', { p_remotejid: remotejid, p_ttl_segundos: LOCK_TTL_SEGUNDOS });
};
async function lockSoltar(supabase: any, remotejid: string): Promise<void> {
  await supabase.from('crm_agente_sdr_lock').delete().eq('remotejid', remotejid);
}

// Lead acabou de mandar mensagem? Então deixa o inbound cuidar — não interrompe.
async function bufferTemMensagem(supabase: any, remotejid: string): Promise<boolean> {
  const { data } = await supabase
    .from('crm_agente_sdr_buffer')
    .select('id')
    .eq('remotejid', remotejid)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

// ── seleção: leads elegíveis com a última msg dentro da janela [15min, 24h) ──
// Filtro grosso no banco (booleans + janela); a decisão fina do toque é em TS,
// pra a régua CADENCIA_MIN viver num lugar só. timestamp_mensagem é texto ISO-Z
// (gravado por new Date().toISOString()), então a comparação lexicográfica
// equivale à cronológica.
async function selecionarCandidatos(supabase: any): Promise<any[]> {
  const agora = Date.now();
  const maisNovoQue = new Date(agora - JANELA_ABERTA_MIN * 60_000).toISOString();   // < 24h
  const maisVelhoQue = new Date(agora - CADENCIA_MIN[0] * 60_000).toISOString();    // >= 15min
  const { data, error } = await supabase
    .from('cliente_ppg_leads_sdr')
    .select('remotejid, nome, curso_interesse_original, formacao_academica, follow_up, timestamp_mensagem, pausa_ia, atendimento_finalizado, followup_ativado, iniciar_atendimento, modo_recontato')
    .eq('followup_ativado', true)
    .eq('iniciar_atendimento', true)
    .not('modo_recontato', 'is', true) // lead em recontato (no-show) NÃO recebe follow-up de lead novo
    .or('pausa_ia.is.null,pausa_ia.eq.false')
    .or('atendimento_finalizado.is.null,atendimento_finalizado.eq.false')
    .gt('timestamp_mensagem', maisNovoQue)
    .lt('timestamp_mensagem', maisVelhoQue)
    .order('timestamp_mensagem', { ascending: true })
    .limit(300);
  if (error) throw new Error(`selecionarCandidatos: ${error.message}`);
  return data ?? [];
}

// ── montagem das mensagens pro Claude (transcrição texto, API-válida) ───────
function blocosParaTexto(content: string | any[]): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('\n');
  }
  return '';
}

// Funde turnos consecutivos do mesmo role, garante 1ª msg user e injeta as
// INFORMAÇÕES DA TENTATIVA na última msg user (mantém os marcadores no histórico
// pro modelo contar tentativas e detectar o último estilo).
function montarMensagensFollowup(history: Msg[], tentativaAtual: number): Msg[] {
  const norm: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of history) {
    if (!m || !m.role) continue;
    const texto = blocosParaTexto(m.content).trim();
    if (!texto) continue;
    const ult = norm[norm.length - 1];
    if (ult && ult.role === m.role) ult.content += '\n' + texto;
    else norm.push({ role: m.role, content: texto });
  }
  while (norm.length && norm[0].role !== 'user') norm.shift();
  if (!norm.length) norm.push({ role: 'user', content: '[início de conversa]' });

  const info =
    MARCADOR_FOLLOWUP +
    '\n\nINFORMAÇÕES DA TENTATIVA DE FOLLOW-UP:\n' +
    `- Esta é a ${tentativaAtual}ª tentativa de follow-up.\n` +
    '- Analise o histórico, identifique o checkpoint e o último estilo usado, escolha um estilo diferente e gere a mensagem no formato JSON pedido.';

  const ult = norm[norm.length - 1];
  if (ult.role === 'user') ult.content += '\n\n' + info;
  else norm.push({ role: 'user', content: info });
  return norm as Msg[];
}

function contarTentativas(history: Msg[]): number {
  let n = 0;
  for (const m of history) {
    if (m.role !== 'user') continue;
    const t = blocosParaTexto(m.content);
    if (t.includes(MARCADOR_FOLLOWUP)) n++;
  }
  return n;
}

// ── GUARDA DE DESINTERESSE: retenção pendente = SILÊNCIO (2026-07-14) ───────
// Caso real (lead Lucas): o lead mandou um áudio dizendo que não é o momento
// ("tô com a neném pequena, gasta bastante"), o João fez a pergunta de retenção
// ("prefere que eu te chame quando abrir a próxima turma?") — e 16 MINUTOS depois
// esta esteira cutucou ("a neném foi crescendo um pouco e vc conseguiu respirar
// mais?"). Insistir com quem acabou de dizer que não é o momento é o pior
// movimento possível: o lead já demonstrou desinteresse e o João está ESPERANDO a
// resposta dele — a esteira não pode falar por cima disso.
//
// A pergunta de retenção é uma frase FIXA dos prompts (a oferta da PRÓXIMA TURMA),
// então a detecção é determinística: se, DEPOIS da última mensagem real do lead,
// o João ofereceu a próxima turma, a retenção está pendente → não manda follow e
// DESLIGA as esteiras (followup_ativado=false cobre janela aberta E template; a
// conversa segue normal se o lead responder — o inbound não é bloqueado).
// ⚠️ O regex TEM que casar a OFERTA de retenção ("te chame quando abrir a próxima
// turma"), não a expressão "próxima turma" solta: o template de abertura do disparo
// fala em "vagas da próxima turma" e um regex frouxo desligaria a esteira de milhares
// de leads normais (medido: 3.248 falsos positivos contra 44 retenções reais).
const RE_RETENCAO = /(te cham\w*|te avis\w*)[^.?!]{0,40}pr[óo]xima turma/i;

function ehMensagemRealDoLead(m: Msg): boolean {
  if (m.role !== 'user') return false;
  if (Array.isArray(m.content)) return false;            // tool_result, não é fala do lead
  const t = blocosParaTexto(m.content);
  return Boolean(t) && !t.includes(MARCADOR_FOLLOWUP);   // marcador de follow não é fala do lead
}

export function retencaoPendente(history: Msg[]): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (ehMensagemRealDoLead(m)) return false;           // o lead falou depois: retenção respondida
    if (m.role === 'assistant' && RE_RETENCAO.test(blocosParaTexto(m.content))) return true;
  }
  return false;
}

// Parser do JSON {steps, final_answer, message} (port de "Processa Resposta do Claude").
function parseResposta(resp: any): { message: string; final_answer: string } {
  const content = resp?.content ?? [];
  const bloco = Array.isArray(content) ? content.find((b: any) => b.type === 'text') : null;
  let texto = String(bloco?.text ?? '').trim();
  texto = texto.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  let parsed: any = null;
  try {
    parsed = JSON.parse(texto);
  } catch {
    const m = texto.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch { /* ignora */ } }
  }
  return {
    message: String(parsed?.message ?? '').trim(),
    final_answer: String(parsed?.final_answer ?? '').trim(),
  };
}

// ── geração da mensagem de follow via Claude ────────────────────────────────
async function gerarFollowup(
  supabase: any,
  lead: any,
  stage: number,
  tel: Telemetria,
  history: Msg[],
): Promise<{ message: string; final_answer: string }> {
  const remotejid = lead.remotejid;
  const tentativaAtual = contarTentativas(history) + 1;

  const nome = extrairPrimeiroNome(lead.nome);
  const curso = (lead.curso_interesse_original ?? '').trim();
  // Fallback explícito quando o lead não tem nome/curso: o prompt instrui a OMITIR
  // (em vez de deixar "e aí ," ou "a pós em ." com o placeholder vazio).
  const systemPrompt = renderPrompt(FOLLOWUP_SYSTEM, {
    nome_ctx: nome || '(não informado — não use nome)',
    curso_ctx: curso || '(não informado — fale "a pós" sem nomear o curso)',
  });
  const contextoTemporal = montarContextoTemporal();
  const messages = montarMensagensFollowup(history, tentativaAtual);

  const inicio = Date.now();
  // thinking disabled EXPLÍCITO: no Sonnet 5, omitir liga o adaptativo — o follow-up
  // devolve JSON curto em 1024 tokens (thinking truncaria a resposta).
  const resp = await chamarAnthropic({
    model: MODELO_AGENTE,
    max_tokens: 1024,
    thinking: { type: 'disabled' },
    // SEM cache_control: o system é renderizado POR LEAD e o follow-up é one-shot —
    // cachear aqui era pagar 1,25x de escrita sem nenhuma leitura depois.
    system: [
      { type: 'text', text: systemPrompt },
      { type: 'text', text: contextoTemporal },
    ],
    messages,
  });
  const out = parseResposta(resp);
  tel.registrar('llm_chamada', {
    volta: 1,
    agente: 'followup',
    stage,
    tentativa: tentativaAtual,
    modelo: resp?.model ?? null,
    stop_reason: resp?.stop_reason ?? null,
    final_answer: out.final_answer,
    tokens_entrada: resp?.usage?.input_tokens ?? null,
    tokens_saida: resp?.usage?.output_tokens ?? null,
    tokens_pensamento: resp?.usage?.output_tokens_details?.thinking_tokens ?? null,
    cache_lido: resp?.usage?.cache_read_input_tokens ?? null,
    cache_escrito: resp?.usage?.cache_creation_input_tokens ?? null,
  }, Date.now() - inicio);
  return out;
}

// ── processa um lead (sob lock, com revalidação fresca) ─────────────────────
async function processarFollowupLead(supabase: any, leadSel: any, stageSel: number): Promise<boolean> {
  const remotejid = leadSel.remotejid;
  if (!(await lockClaim(supabase, remotejid))) return false; // inbound em andamento, pula
  const tel = criarTelemetria(supabase, remotejid);
  try {
    // Lead acabou de responder? Deixa o inbound assumir.
    if (await bufferTemMensagem(supabase, remotejid)) {
      tel.registrar('followup_pulado', { motivo: 'buffer_inbound_ativo', stage: stageSel });
      return false;
    }
    // Revalida com o estado FRESCO (mudou entre a seleção e agora?).
    const lead = await buscarLead(supabase, remotejid);
    if (!lead) return false;
    if (lead.followup_ativado !== true) return false;
    if (lead.iniciar_atendimento !== true) return false;
    if (lead.modo_recontato === true) return false; // virou recontato no meio-tempo
    if (lead.pausa_ia === true) return false;
    if (lead.atendimento_finalizado === true) return false;

    const ts = Date.parse(lead.timestamp_mensagem ?? '');
    if (!Number.isFinite(ts)) return false;
    const elapsedMin = (Date.now() - ts) / 60_000;
    const stage = proximoToqueDevido(elapsedMin, stageDoFollowUp(lead.follow_up));
    if (stage === null) {
      tel.registrar('followup_pulado', { motivo: 'nao_mais_devido', elapsed_min: Math.round(elapsedMin) });
      return false; // lead respondeu / já fez o toque / janela fechou nesse meio-tempo
    }

    tel.registrar('followup_avaliacao', { stage, elapsed_min: Math.round(elapsedMin), ja_enviado: stageDoFollowUp(lead.follow_up) });

    // GUARDA DE DESINTERESSE (ver retencaoPendente): o João ofereceu a próxima
    // turma e o lead ainda não respondeu → silêncio, e as esteiras são desligadas
    // (janela aberta E template). Insistir com quem acabou de dizer que não é o
    // momento é o pior movimento possível.
    const history = await carregarHistorico(supabase, remotejid);
    if (retencaoPendente(history)) {
      await atualizarLead(supabase, remotejid, { followup_ativado: false });
      tel.registrar('followup_pulado', { motivo: 'retencao_pendente', stage, esteiras: 'desligadas' });
      return false;
    }

    const { message, final_answer } = await gerarFollowup(supabase, lead, stage, tel, history);
    if (!message) {
      // Modelo julgou que não cabe follow agora: consome o toque pra não reavaliar todo tick.
      await atualizarLead(supabase, remotejid, { follow_up: followUpDoStage(stage) });
      tel.registrar('followup_pulado', { motivo: 'mensagem_vazia', stage, final_answer });
      return false;
    }

    // Com 2+ números qualificadores em produção, o texto livre TEM que sair pelo
    // número onde a janela de 24h do lead está aberta = o do último INBOUND dele
    // (a janela da Meta é por número×lead). null (lead sem inbound rastreável) →
    // conta ativa, comportamento antigo.
    const telefone = String(remotejid).split('@')[0];
    const contaLead = await contaDoLead(supabase, telefone, { direcao: 'inbound' });
    const ctx: CtxConversa = {
      remotejid,
      telefone,
      waAccountId: contaLead,
      leadId: null,
      oportunidadeId: null,
    };
    // Avança o estágio ANTES de enviar (claim do toque): evita reenvio duplicado
    // se algo falhar no meio. No pior caso pula UM toque (invisível) em vez de
    // mandar a mesma mensagem duas vezes.
    await atualizarLead(supabase, remotejid, { follow_up: followUpDoStage(stage) });
    // Marcador no histórico (conta a tentativa; o agente principal ignora).
    await gravarMensagem(supabase, remotejid, { role: 'user', content: MARCADOR_FOLLOWUP });
    // Envia pelo MESMO pipeline (fraciona + delay + crm-whatsapp-send).
    await enviarResposta(ctx, message, lockRenovar(supabase, remotejid), tel);
    // Fala do follow no histórico (pro próximo toque detectar o estilo usado).
    await gravarMensagem(supabase, remotejid, { role: 'assistant', content: [{ type: 'text', text: message }] });
    tel.registrar('followup_enviado', { stage, final_answer, conta: contaLead, message: resumir(message, 300) });
    return true;
  } catch (e) {
    tel.registrar('erro', { onde: 'processarFollowupLead', remotejid }, undefined, (e as Error).message);
    console.error(`[crm-agente-sdr][followup] ${remotejid}:`, e);
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

// ── entrada da esteira (chamada pelo index quando mode=followup) ────────────
// limite: teto de leads neste disparo (default MAX_LEADS_POR_TICK). Use um valor
// baixo (ex.: ?limite=3) pra um teste controlado antes de liberar geral.
export async function rodarEsteiraFollowup(supabase: any, limite?: number): Promise<{ candidatos: number; devidos: number; enviados: number }> {
  const telSweep = criarTelemetria(supabase, 'followup-sweep');
  const inicio = Date.now();

  // Pausa noturna (22:00–06:30 BRT): não reabre conversa de madrugada.
  if (dentroDaPausaNoturna()) {
    telSweep.registrar('followup_tick', { pausa_noturna: true, candidatos: 0, devidos: 0, enviados: 0 }, Date.now() - inicio);
    return { candidatos: 0, devidos: 0, enviados: 0 };
  }

  const cap = Number.isFinite(limite) && (limite as number) > 0 ? Math.floor(limite as number) : MAX_LEADS_POR_TICK;
  const candidatos = await selecionarCandidatos(supabase);

  const agora = Date.now();
  const devidos: { lead: any; stage: number }[] = [];
  for (const lead of candidatos) {
    const ts = Date.parse(lead.timestamp_mensagem ?? '');
    if (!Number.isFinite(ts)) continue;
    const elapsedMin = (agora - ts) / 60_000;
    const stage = proximoToqueDevido(elapsedMin, stageDoFollowUp(lead.follow_up));
    if (stage !== null) devidos.push({ lead, stage });
    if (devidos.length >= cap) break;
  }

  let enviados = 0;
  await comConcorrencia(devidos, CONCORRENCIA, async (d) => {
    const ok = await processarFollowupLead(supabase, d.lead, d.stage);
    if (ok) enviados++;
  });

  telSweep.registrar('followup_tick', {
    candidatos: candidatos.length,
    devidos: devidos.length,
    enviados,
  }, Date.now() - inicio);
  return { candidatos: candidatos.length, devidos: devidos.length, enviados };
}
