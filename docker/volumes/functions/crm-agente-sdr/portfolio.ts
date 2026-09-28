// Portfólio da PPGVET pelo WhatsApp — aula MVP, sem pós relacionada (28/09/2026).
//
// O roteiro da aula sempre mandou chamar envia_informacoes com conteudo="portfolio", mas o
// executor real não tinha esse conteúdo (só o simulador fingia o envio) e o enum da tool nem
// aceitava o valor. Agora o PDF sai de verdade, pela conta da conversa, como documento — o
// MESMO arquivo que o Instagram já manda (_shared/igWhatsapp.ts). A formação é confirmada
// antes (regra do Gustavo): no canário pela trava da ficha, como o cronograma; no Claude pelo
// roteiro ("a troca" da seção CRONOGRAMA).

import { IG_PORTFOLIO_ARQUIVO, IG_PORTFOLIO_URL } from '../_shared/igWhatsapp.ts';
import type { CtxConversa } from './tools.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SEND_URL = (Deno.env.get('AGENTE_SDR_SEND_URL') ?? `${SUPABASE_URL}/functions/v1/crm-whatsapp-send`).replace(/\/$/, '');

export const LEGENDA_PORTFOLIO = 'Portfólio das pós-graduações da PPGVET 📄';
/** A frase exata depois do envio (a Luna segue o retorno da tool ao pé da letra). */
export const FALA_DEPOIS_DO_PORTFOLIO = 'te enviei o portfólio por aqui. qual área chamou mais a sua atenção?';

export type EnvioPortfolio = { ok: boolean; erro?: string };

/** O retorno da tool — o mesmo texto no executor real e no simulador. */
export function resultadoPortfolio(id: string, envio: EnvioPortfolio): Record<string, unknown> {
  if (envio.ok) {
    return {
      id, portfolio_enviado: true,
      resultado: 'O portfólio (PDF com todas as pós e MBAs da PPGVET) foi enviado ao lead. '
        + `Diga exatamente: "${FALA_DEPOIS_DO_PORTFOLIO}". Quando ele disser a área, chame consulta_pos_disponiveis `
        + 'com trocar_para = a área e siga o fluxo com a pós encontrada.',
    };
  }
  return {
    id, portfolio_enviado: false, status: 'falhou',
    resultado: 'O portfólio NÃO foi enviado (falha no envio). Não diga que enviou. Diga que o arquivo não saiu agora '
      + 'e pergunte em qual área ele gostaria de se especializar.',
  };
}

export async function enviarPortfolio(ctx: CtxConversa, id: string, enviar: typeof fetch = fetch): Promise<Record<string, unknown>> {
  if (ctx.canal === 'webchat') {
    return { id, portfolio_enviado: false, resultado: 'O portfólio em PDF só sai pelo WhatsApp. Pergunte em qual área ele gostaria de se especializar.' };
  }
  let envio: EnvioPortfolio;
  try {
    const res = await enviar(SEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SERVICE_ROLE}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        telefone: ctx.telefone,
        tipo: 'document',
        origem: 'ia',
        anexo_url: IG_PORTFOLIO_URL,
        filename: IG_PORTFOLIO_ARQUIVO,
        mime_type: 'application/pdf',
        conteudo: LEGENDA_PORTFOLIO,
        wa_account_id: ctx.waAccountId,
        lead_id: ctx.leadId,
        oportunidade_id: ctx.oportunidadeId,
      }),
    });
    const corpo = await res.json().catch(() => null);
    envio = res.ok && corpo?.success === true ? { ok: true } : { ok: false, erro: `HTTP ${res.status}` };
    if (!envio.ok) console.error(`[crm-agente-sdr] portfólio não saiu para ${ctx.telefone}: ${envio.erro}`);
  } catch (e) {
    envio = { ok: false, erro: (e as Error)?.message ?? String(e) };
    console.error(`[crm-agente-sdr] portfólio não saiu para ${ctx.telefone}: ${envio.erro}`);
  }
  return resultadoPortfolio(id, envio);
}
