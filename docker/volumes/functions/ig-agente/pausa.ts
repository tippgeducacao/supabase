// Pausa da Flávia com PRAZO (2026-10-08) — espelho do crm-agente-sdr/pausa.ts.
//
// `ig_conversa_ia.pausada` segue sendo a flag; `pausada_ate` diz até quando ela vale
// (NULL = permanente, até alguém reativar no SAC). O cron `ig-pausa-ia-expirar` limpa
// quem venceu a cada minuto, mas o agente não espera por ele. Prazo ilegível conta como
// pausa (fail-closed — melhor calar do que falar por cima do time).
export interface ConversaComPausa {
  pausada?: boolean | null;
  pausada_ate?: string | null;
}

export function pausaIgVigente(c: ConversaComPausa | null | undefined, agora: number = Date.now()): boolean {
  if (c?.pausada !== true) return false;
  if (!c.pausada_ate) return true;
  const ate = Date.parse(c.pausada_ate);
  return Number.isNaN(ate) ? true : ate > agora;
}
