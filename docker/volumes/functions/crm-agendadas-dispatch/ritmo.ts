// Ritmo de envio da fila por número (23/09/2026).
//
// Incidente: os Fluxos disparavam template por net.http_post direto, e o pg_net soltava o
// lote inteiro em paralelo. A Meta devolveu 130429 ("Rate limit hit") para 459 templates em
// 72h (64 falhas em 3s, 104 em 8s) e ninguém tentou de novo. Agora o Fluxo enfileira em
// crm_mensagens_agendadas e este dispatcher:
//   1. espaça os envios POR CONTA (no máximo ENVIOS_POR_SEGUNDO_POR_CONTA iniciados/s);
//   2. intercala as contas, para um número com fila grande não segurar os outros;
//   3. reagenda o 130429 com backoff (a Meta não aceitou ⇒ reenviar não duplica).

export const ENVIOS_POR_SEGUNDO_POR_CONTA = 20;
export const CODIGO_RATE_LIMIT = 130429;
/** Espera (min) antes da tentativa N+1. Esgotou ⇒ a última tentativa grava a falha. */
export const BACKOFF_RATE_LIMIT_MIN = [1, 2, 4, 8, 15];
export const MAX_REAGENDAMENTOS_RATE_LIMIT = BACKOFF_RATE_LIMIT_MIN.length;
/** Freio extra na conta depois de um 130429 nesta execução. */
export const PAUSA_APOS_RATE_LIMIT_MS = 2_000;

type LinhaConta = { wa_account_id?: string | null; wa_conexao_id?: string | null };

export function chaveDaConta(row: LinhaConta): string {
  if (row.wa_conexao_id) return `web:${row.wa_conexao_id}`;
  return `meta:${row.wa_account_id ?? "padrao"}`;
}

/** Round-robin entre contas, preservando a ordem de cada uma. */
export function intercalarPorConta<T extends LinhaConta>(rows: T[]): T[] {
  const filas = new Map<string, T[]>();
  for (const row of rows) {
    const k = chaveDaConta(row);
    const fila = filas.get(k);
    if (fila) fila.push(row); else filas.set(k, [row]);
  }
  const listas = [...filas.values()];
  const saida: T[] = [];
  for (let i = 0; saida.length < rows.length; i++) {
    for (const lista of listas) if (i < lista.length) saida.push(lista[i]);
  }
  return saida;
}

/** Reserva de horário por conta: cada envio ocupa 1000/porSegundo ms da conta. */
export function criarRitmo(porSegundo = ENVIOS_POR_SEGUNDO_POR_CONTA, agora: () => number = Date.now) {
  const intervalo = 1000 / porSegundo;
  const proximo = new Map<string, number>();
  return {
    /** Devolve quantos ms esperar antes de iniciar este envio (0 = já). */
    reservar(conta: string): number {
      const t = agora();
      const slot = Math.max(t, proximo.get(conta) ?? t);
      proximo.set(conta, slot + intervalo);
      return slot - t;
    },
    penalizar(conta: string, ms = PAUSA_APOS_RATE_LIMIT_MS): void {
      const t = agora();
      proximo.set(conta, Math.max(proximo.get(conta) ?? t, t + ms));
    },
  };
}

/** Horário da próxima tentativa depois de `feitas` reagendamentos, ou null se esgotou. */
export function proximaTentativaRateLimit(feitas: number, agora = Date.now()): string | null {
  const min = BACKOFF_RATE_LIMIT_MIN[feitas];
  if (min === undefined) return null;
  return new Date(agora + min * 60_000).toISOString();
}
