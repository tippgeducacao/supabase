// Pausa da IA com PRAZO (2026-09-11).
//
// `cliente_ppg_leads_sdr.pausa_ia` continua sendo a flag; `pausa_ia_ate` diz até
// quando ela vale (NULL = permanente, até alguém reativar). O cron
// `crm-pausa-ia-expirar` limpa a flag de quem venceu a cada minuto, mas o agente
// não espera por ele: confere o prazo na hora, tanto no guard de entrada quanto no
// recheck fresco antes de falar/entre chunks. Prazo ilegível conta como pausa
// (fail-closed — melhor calar do que falar por cima do atendente).
export interface LeadComPausa {
  pausa_ia?: boolean | null;
  pausa_ia_ate?: string | null;
}

export function pausaVigente(lead: LeadComPausa | null | undefined, agora: number = Date.now()): boolean {
  if (lead?.pausa_ia !== true) return false;
  if (!lead.pausa_ia_ate) return true;
  const ate = Date.parse(lead.pausa_ia_ate);
  return Number.isNaN(ate) ? true : ate > agora;
}
