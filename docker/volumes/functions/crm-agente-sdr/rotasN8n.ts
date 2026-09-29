// Rotas que o agente no n8n chama no sistema (29/09/2026, projeto "Luna no n8n").
// O n8n cuida da orquestração (buffer, voltas, saída); o que é regra do sistema continua aqui e é
// exposto por estas rotas, para os dois caminhos fazerem a MESMA coisa.
// Autorização: o mesmo segredo que o gateway manda no desvio (crm_sdr_n8n.segredo, cabeçalho
// x-ppg-sdr-segredo) E o telefone na lista de teste. Número fora da lista = 403, mesmo com segredo:
// enquanto é teste, lead de verdade não passa por aqui.

import { CABECALHO_SEGREDO_N8N, vaiParaN8n, type DesvioN8n } from '../_shared/desvioN8n.ts';
import { prepararMensagem, type MensagemTratada } from './midia.ts';
import type { Telemetria } from './eventos.ts';

export const ACOES_N8N = ['midia'] as const;
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
