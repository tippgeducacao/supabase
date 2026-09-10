// 10/09/2026, caso Ricardo: o áudio humano ficou pronto durante a geração.
// Esperamos ANTES de drenar o buffer; no prazo excedido, o reconciliador existente
// retoma a entrada original. Nunca regravar nem inventar uma mensagem do lead.
// deno-lint-ignore-file no-explicit-any
export const ESPERA_AUDIO_MS = 30_000;
const IDADE_AUDIO_MS = 15 * 60_000;
const LIMITE_ORIGENS = 100;

type OrigemAudio = { crm_mensagem_origem_id: string | null; timestamp: string };
// Cliente injetado: runtime Deno e simulador usam transportes distintos.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function contarAudiosPendentes(supabase: any, remotejid: string, agora = Date.now()): Promise<number> {
  const { data: origens, error: erroHistorico } = await supabase
    .from('cliente_ppg_mensagens_sdr')
    .select('crm_mensagem_origem_id, timestamp')
    .eq('remotejid', remotejid)
    .not('crm_mensagem_origem_id', 'is', null)
    .order('id', { ascending: false })
    .limit(LIMITE_ORIGENS)
    .abortSignal(AbortSignal.timeout(5000));
  if (erroHistorico) throw new Error('sincronizacao_audio: histórico indisponível');
  // timestamp é TEXT e possui formatos ISO e PostgreSQL. A janela é comparada
  // como instante, nunca lexicograficamente; áudio antigo não bloqueia nova sessão.
  const ids = [...new Set(((origens ?? []) as OrigemAudio[]).filter(o => {
    const instante = Date.parse(o.timestamp);
    return Number.isFinite(instante) && instante >= agora - IDADE_AUDIO_MS;
  }).map(o => o.crm_mensagem_origem_id).filter(Boolean))];
  if (!ids.length) return 0;
  const { data, error } = await supabase.from('crm_sdr_historico_audio_fila')
    .select('mensagem_id')
    .in('mensagem_id', ids)
    .in('status', ['pending', 'processing'])
    .limit(LIMITE_ORIGENS)
    .abortSignal(AbortSignal.timeout(5000));
  if (error) throw new Error('sincronizacao_audio: fila indisponível');
  return data?.length ?? 0;
}

type Dependencias = {
  contar: () => Promise<number>;
  pausada: () => Promise<boolean>;
  renovar: () => Promise<void>;
  agora?: () => number;
  dormir?: (ms: number) => Promise<void>;
};

export async function aguardarAudiosDoHistorico(deps: Dependencias): Promise<{
  estado: 'pronto' | 'aguardando' | 'pausado'; esperouMs: number; pendentes: number;
}> {
  const agora = deps.agora ?? Date.now;
  const dormir = deps.dormir ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const inicio = agora();
  let pendentes = 0;
  while (true) {
    if (await deps.pausada()) return { estado: 'pausado', esperouMs: agora() - inicio, pendentes };
    pendentes = await deps.contar();
    if (!pendentes) return { estado: 'pronto', esperouMs: agora() - inicio, pendentes };
    const restante = ESPERA_AUDIO_MS - (agora() - inicio);
    if (restante <= 0) return { estado: 'aguardando', esperouMs: agora() - inicio, pendentes };
    await deps.renovar();
    await dormir(Math.min(2000, restante));
  }
}
