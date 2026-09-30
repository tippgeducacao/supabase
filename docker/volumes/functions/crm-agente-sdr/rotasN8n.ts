// Rotas que o agente no n8n chama no sistema (29/09/2026, projeto "Luna no n8n").
// O n8n cuida da orquestração (buffer, voltas, saída); o que é regra do sistema continua aqui e é
// exposto por estas rotas, para os dois caminhos fazerem a MESMA coisa.
// Autorização: o mesmo segredo que o gateway manda no desvio (crm_sdr_n8n.segredo, cabeçalho
// x-ppg-sdr-segredo) E o telefone na lista de teste. Número fora da lista = 403, mesmo com segredo:
// enquanto é teste, lead de verdade não passa por aqui.

import { CABECALHO_SEGREDO_N8N, telefoneCanonico, vaiParaN8n, type DesvioN8n } from '../_shared/desvioN8n.ts';
import { prepararMensagem, type MensagemTratada } from './midia.ts';
import type { Telemetria } from './eventos.ts';
import type { ProvedorIA } from './agente.ts';
import type { CtxConversa } from './tools.ts';

// midia: áudio/imagem → texto · rodada: o lote do buffer do n8n vira uma rodada do agente
// ferramenta: o 04 do n8n executa uma ferramenta com o ctx da rodada
// iniciar → definir → volta ⇄ executar/gravar → enviar: o agente POR PASSOS (passosRodada.ts), o loop desenhado no n8n.
// fim: o n8n avisa que a rodada quebrou no meio (solta a trava do lead).
export const ACOES_N8N = ['midia', 'rodada', 'ferramenta', 'iniciar', 'definir', 'volta', 'executar', 'gravar', 'enviar', 'fim'] as const;
export const PASSOS_COM_ESTADO = new Set<string>(['definir', 'volta', 'executar', 'gravar', 'enviar']);
export type AcaoN8n = typeof ACOES_N8N[number];

export function ehAcaoN8n(v: unknown): v is AcaoN8n {
  return (ACOES_N8N as readonly string[]).includes(String(v));
}

function mesmoTexto(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

/** 401 sem segredo certo; 403 com segredo certo mas telefone fora da lista de teste. */
export function autorizarN8n(
  cfg: DesvioN8n | null, segredoRecebido: string | null, telefoneOuJid: unknown,
): { ok: true } | { ok: false; status: 401 | 403; erro: string } {
  if (!cfg?.ativo || !cfg.segredo || !segredoRecebido || !mesmoTexto(segredoRecebido, cfg.segredo)) {
    return { ok: false, status: 401, erro: 'unauthorized' };
  }
  if (!vaiParaN8n(cfg, telefoneOuJid)) return { ok: false, status: 403, erro: 'telefone_fora_do_teste' };
  return { ok: true };
}

/** remotejid e telefone são do MESMO número (com ou sem o 9º dígito)? */
export function mesmoTelefone(a: unknown, b: unknown): boolean {
  const x = telefoneCanonico(a);
  return Boolean(x) && x === telefoneCanonico(b);
}

export function segredoDoPedido(req: Request): string | null {
  return req.headers.get(CABECALHO_SEGREDO_N8N);
}

/**
 * Mídia → texto, igual ao agente do sistema (processarInbound): áudio transcrito e imagem/vídeo
 * descritos pelo Gemini (só Gemini, sem reserva). Texto e documento voltam como vieram.
 * Entrada: o payload do gateway, o mesmo que o desvio entrega ao n8n.
 */
export async function tratarMidiaN8n(payload: any, tel?: Telemetria): Promise<MensagemTratada & { tipo: string }> {
  const tratada = await prepararMensagem(payload, tel);
  return { tipo: String(payload?.tipo ?? 'text'), ...tratada };
}

// ═══ O AGENTE PELO n8n (30/09/2026) ══════════════════════════════════════════
// O loop do agente (travas, correções, confirmação, envio) continua AQUI, o mesmo da produção e
// coberto pelos testes. O que passa pelo n8n são as duas pontas que o Gustavo quer ver e editar:
//   · a chamada da Luna  → webhook `<base>/v1/responses` (fluxo "03 Luna"), mesmo corpo da OpenAI;
//   · cada ferramenta    → webhook `<base>/ferramenta` (fluxo "04 Ferramentas"), que chama de volta
//                          `?mode=n8n&acao=ferramenta` e passa o retorno pelo nó de tratamento dela.

/** Base dos webhooks do agente: a URL de entrada sem o "/entrada" do fim. */
export function baseDoN8n(cfg: DesvioN8n): string {
  return cfg.url.replace(/\/+$/, '').replace(/\/entrada$/, '');
}

/** A MESMA Luna da rodada, só que a chamada sai pelo webhook do n8n, com o segredo no cabeçalho. */
export function provedorPeloN8n(provedor: ProvedorIA, cfg: DesvioN8n): ProvedorIA {
  if (provedor.formato !== 'openai') return provedor;
  return { ...provedor, base: baseDoN8n(cfg), chave: 'n8n', cabecalhos: { [CABECALHO_SEGREDO_N8N]: cfg.segredo } };
}

/** ctx da rodada em JSON (o cache de envio de materiais é um Map). */
export function ctxParaJson(ctx: CtxConversa): Record<string, unknown> {
  const { enviosMateriais, ...resto } = ctx;
  return { ...resto, ...(enviosMateriais?.size ? { enviosMateriais: [...enviosMateriais.entries()] } : {}) };
}

export function ctxDeJson(bruto: unknown): CtxConversa | null {
  if (!bruto || typeof bruto !== 'object') return null;
  const o = bruto as Record<string, unknown>;
  if (typeof o.remotejid !== 'string' || typeof o.telefone !== 'string') return null;
  const { enviosMateriais, ...resto } = o;
  return {
    ...(resto as unknown as CtxConversa),
    ...(Array.isArray(enviosMateriais) ? { enviosMateriais: new Map(enviosMateriais as [string, Record<string, unknown>][]) } : {}),
  };
}

// O que uma ferramenta pode mudar no ctx durante a rodada (tools.ts e elegibilidadeAgendamento.ts).
// O resto (telefone, conta, lead, histórico) NUNCA volta do n8n: é o sistema que decide.
const MUTAVEIS_DO_CTX = ['compatibilidadeIndisponivel', 'perguntaFormacaoPendente', 'ultimaElegibilidade', 'enviosMateriais'] as const;

export function aplicarMudancasDoCtx(ctx: CtxConversa, depois: CtxConversa | null): void {
  if (!depois) return;
  for (const campo of MUTAVEIS_DO_CTX) {
    if (depois[campo] !== undefined) (ctx as Record<string, unknown>)[campo] = depois[campo];
  }
}

/**
 * Executa a ferramenta pelo fluxo 04 do n8n. Falha de rede/HTTP vira o mesmo tipo de retorno de
 * erro que a IA já sabe ler: a rodada segue e a IA explica ou tenta de novo.
 */
export async function executarFerramentaPeloN8n(
  cfg: DesvioN8n, chamada: { id: string; name: string; input: unknown }, ctx: CtxConversa,
  transporte: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  try {
    const res = await transporte(`${baseDoN8n(cfg)}/ferramenta`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CABECALHO_SEGREDO_N8N]: cfg.segredo },
      body: JSON.stringify({ chamada, ctx: ctxParaJson(ctx) }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const dados = await res.json();
    const output = dados?.output;
    if (!output || typeof output !== 'object') throw new Error('resposta sem output');
    aplicarMudancasDoCtx(ctx, ctxDeJson(dados?.ctx));
    // O id é o da chamada, venha o que vier do tratamento: é ele que casa o resultado com o pedido.
    return { ...output, id: chamada.id };
  } catch (e) {
    // status 'erro' + "Erro ao executar": toolConcluida (encerramento.ts) não conta como feita.
    return { id: chamada.id, status: 'erro',
      resultado: `Erro ao executar ${chamada.name}: o n8n não respondeu (${(e as Error)?.message ?? e}). Não diga ao lead que foi feito.` };
  }
}

/**
 * Lote do buffer do n8n → itens no formato do buffer do sistema (o que rodadaAgente recebe).
 * Conta/persona/lead/oportunidade vêm da mensagem ou, sem ela, do lote (o 02 guarda só o texto no Redis).
 */
export function itensDoLoteN8n(lote: any): Record<string, unknown>[] {
  const mensagens = Array.isArray(lote?.mensagens) ? lote.mensagens : [];
  const de = (m: any, campo: string) => m?.[campo] ?? lote?.[campo] ?? null;
  return mensagens.filter((m: unknown) => m && typeof m === 'object').map((m: any) => ({
    mensagem: String(m.conteudo ?? ''),
    ...(m.arquivo ? { arquivo: String(m.arquivo) } : {}),
    msg_id: m.id ?? null,
    timestamp: m.timestamp ?? null,
    wa_account_id: de(m, 'wa_account_id'),
    agente_ia_persona: de(m, 'agente_ia_persona'),
    lead_id: de(m, 'lead_id'),
    oportunidade_id: de(m, 'oportunidade_id'),
  }));
}

/** Payload de entrada (o do gateway) de cada mensagem do lote, para passar pelos MESMOS gates. */
export function payloadDaMensagem(lote: any, item: Record<string, unknown>): Record<string, unknown> {
  return {
    direcao: 'inbound', from_me: false,
    remotejid: lote?.remotejid, telefone: lote?.telefone,
    id: item.msg_id, conteudo: item.mensagem, timestamp: item.timestamp,
    wa_account_id: item.wa_account_id, agente_ia_persona: item.agente_ia_persona,
    lead_id: item.lead_id, oportunidade_id: item.oportunidade_id,
  };
}

// ═══ ASSINATURA DO ESTADO (30/09/2026) ═══════════════════════════════════════
// O estado da rodada viaja no n8n e pode ser editado lá (é o que permite testar um prompt sem
// deploy). O que NÃO pode mudar é QUEM: o lead, o telefone, a conta e a oportunidade. Esses campos
// são assinados com o segredo do desvio; mexeu em algum, o sistema recusa o passo.
function quemDoEstado(e: { rodadaId?: unknown; remotejid?: unknown; telefone?: unknown; ctx?: any }): string {
  const c = e?.ctx ?? {};
  return JSON.stringify([e?.rodadaId ?? null, e?.remotejid ?? null, e?.telefone ?? null,
    c.remotejid ?? null, c.telefone ?? null, c.waAccountId ?? null, c.leadId ?? null, c.oportunidadeId ?? null]);
}

async function hmac(segredo: string, texto: string): Promise<string> {
  const chave = await crypto.subtle.importKey('raw', new TextEncoder().encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const assinatura = await crypto.subtle.sign('HMAC', chave, new TextEncoder().encode(texto));
  return [...new Uint8Array(assinatura)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function assinarEstado(e: Record<string, any>, segredo: string): Promise<string> {
  return await hmac(segredo, quemDoEstado(e));
}

/** O estado é de um número de teste, coerente (ctx = lead do estado) e com a assinatura certa? */
export async function estadoConfere(e: any, assinatura: unknown, cfg: DesvioN8n): Promise<boolean> {
  if (!e || typeof e !== 'object' || typeof assinatura !== 'string' || !cfg.segredo) return false;
  if (!mesmoTelefone(e.remotejid, e.telefone) || e.ctx?.remotejid !== e.remotejid || !mesmoTelefone(e.ctx?.telefone, e.telefone)) return false;
  if (!vaiParaN8n(cfg, e.telefone)) return false;
  return mesmoTexto(await assinarEstado(e, cfg.segredo), assinatura);
}
