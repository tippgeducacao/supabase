// Infraestrutura compartilhada da fila durável das esteiras de follow-up.
//
// O produtor apenas descobre o trabalho e grava uma intenção idempotente. O worker
// consome poucos itens por execução; se o isolate morrer, o lease expira e o banco
// libera o item para retry. Isso evita que uma varredura de centenas de leads fique
// presa ao tempo de vida/CPU de um único isolate do Edge Runtime.

// deno-lint-ignore-file no-explicit-any

export type TipoFilaFollowup = 'janela_aberta' | 'template';

export type ItemFilaFollowup = {
  tipo: TipoFilaFollowup;
  remotejid: string;
  toque: number;
  referencia_em: string;
  dedupe_key: string;
  payload: Record<string, unknown>;
  prioridade?: number;
};

export type JobFilaFollowup = ItemFilaFollowup & {
  id: number;
  status: 'pending' | 'processing' | 'retry' | 'done' | 'dead' | 'cancelled';
  tentativas: number;
  max_tentativas: number;
  worker_id: string | null;
};

function referenciaNormalizada(valor: unknown): string {
  const ms = Date.parse(String(valor ?? ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : String(valor ?? 'sem-referencia');
}

export function chaveJanelaAberta(remotejid: string, stage: number, referencia: unknown): string {
  return `janela_aberta:${remotejid}:${stage}:${referenciaNormalizada(referencia)}`;
}

export function chaveTemplate(remotejid: string, toque: number, referencia: unknown): string {
  return `template:${remotejid}:${toque}:${referenciaNormalizada(referencia)}`;
}

export function chaveResgateTemplate(remotejid: string, agora = new Date()): string {
  // Brasília não usa horário de verão desde 2019. O deslocamento explícito evita que
  // um tick entre 21h e 23h59 BRT seja deduplicado como se já fosse o dia seguinte UTC.
  const dataBrt = new Date(agora.getTime() - 3 * 3600_000).toISOString().slice(0, 10);
  return `template-resgate:${remotejid}:${dataBrt}`;
}

export function limiteWorker(tipo: TipoFilaFollowup, solicitado?: number): number {
  const padrao = tipo === 'janela_aberta' ? 5 : 10;
  const maximo = tipo === 'janela_aberta' ? 5 : 10;
  if (!Number.isFinite(solicitado) || (solicitado as number) <= 0) return padrao;
  return Math.min(maximo, Math.floor(solicitado as number));
}

export function concorrenciaWorker(tipo: TipoFilaFollowup, quantidade: number): number {
  const maximo = tipo === 'janela_aberta' ? 5 : 3;
  return Math.max(1, Math.min(maximo, quantidade));
}

// O cliente Deno vem de esm.sh e os módulos legados das esteiras ainda o tipam como any.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function enfileirarFollowups(supabase: any, itens: ItemFilaFollowup[]): Promise<number> {
  if (!itens.length) return 0;
  const linhas = itens.map((item) => ({
    tipo: item.tipo,
    remotejid: item.remotejid,
    toque: item.toque,
    referencia_em: item.referencia_em,
    dedupe_key: item.dedupe_key,
    payload: item.payload,
    prioridade: item.prioridade ?? 0,
  }));
  const { data, error } = await supabase
    .from('crm_followup_fila')
    .upsert(linhas, { onConflict: 'dedupe_key', ignoreDuplicates: true })
    .select('id');
  if (error) throw new Error(`enfileirar follow-ups: ${error.message}`);
  return data?.length ?? 0;
}
