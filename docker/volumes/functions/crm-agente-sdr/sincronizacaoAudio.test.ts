import { describe, expect, it, vi } from 'vitest';
import { aguardarAudiosDoHistorico, contarAudiosPendentes, ESPERA_AUDIO_MS } from './sincronizacaoAudio';

function relogio() {
  let ms = 0;
  return { agora: () => ms, dormir: vi.fn(async (tempo: number) => { ms += tempo; }) };
}

describe('espera da memória de áudio antes de responder', () => {
  it('caso Ricardo: espera a conclusão tardia antes de liberar router e principal', async () => {
    const tempo = relogio();
    const renovar = vi.fn();
    const contar = vi.fn(async () => tempo.agora() < 5300 ? 1 : 0);
    const resultado = await aguardarAudiosDoHistorico({ ...tempo, contar, renovar, pausada: async () => false });
    expect(resultado).toEqual({ estado: 'pronto', esperouMs: 6000, pendentes: 0 });
    expect(renovar).toHaveBeenCalledTimes(3);
  });
  it('sem pendência, não adiciona espera', async () => {
    const tempo = relogio();
    expect(await aguardarAudiosDoHistorico({ ...tempo, contar: async () => 0, renovar: vi.fn(), pausada: async () => false }))
      .toEqual({ estado: 'pronto', esperouMs: 0, pendentes: 0 });
    expect(tempo.dormir).not.toHaveBeenCalled();
  });
  it('atinge o prazo sem liberar resposta com contexto incompleto', async () => {
    const tempo = relogio();
    expect(await aguardarAudiosDoHistorico({ ...tempo, contar: async () => 2, renovar: vi.fn(), pausada: async () => false }))
      .toEqual({ estado: 'aguardando', esperouMs: ESPERA_AUDIO_MS, pendentes: 2 });
  });
  it('pausa durante a espera interrompe antes da próxima consulta', async () => {
    const tempo = relogio();
    const contar = vi.fn(async () => 1);
    expect(await aguardarAudiosDoHistorico({ ...tempo, contar, renovar: vi.fn(), pausada: async () => tempo.agora() >= 2000 }))
      .toEqual({ estado: 'pausado', esperouMs: 2000, pendentes: 1 });
    expect(contar).toHaveBeenCalledOnce();
  });
  it('falha de consulta não equivale a fila vazia', async () => {
    await expect(aguardarAudiosDoHistorico({
      contar: async () => { throw new Error('falha de leitura'); },
      renovar: vi.fn(), pausada: async () => false,
    })).rejects.toThrow('falha de leitura');
  });
});

describe('consulta de áudio restrita à conversa', () => {
  const agora = Date.parse('2026-09-10T21:25:56Z');
  function banco(origens: unknown[], jobs: unknown[] = [], erro?: string) {
    const filtros: unknown[][] = [];
    const from = vi.fn((tabela: string) => {
      const q = {
        select: () => q, order: () => q, not: () => q, limit: () => q,
        eq: (...args: unknown[]) => { filtros.push([tabela, ...args]); return q; },
        in: (...args: unknown[]) => { filtros.push([tabela, ...args]); return q; },
        abortSignal: async () => ({ data: tabela === 'cliente_ppg_mensagens_sdr' ? origens : jobs,
          error: erro ? { message: erro } : null }),
      };
      return q;
    });
    return { from, filtros };
  }
  it('consulta apenas origens recentes do remotejid, com timestamps dos dois formatos', async () => {
    const db = banco([
      { crm_mensagem_origem_id: 'audio-1', timestamp: '2026-09-10 21:25:00.770457+00' },
      { crm_mensagem_origem_id: 'audio-2', timestamp: '2026-09-10T21:25:09Z' },
      { crm_mensagem_origem_id: 'antigo', timestamp: '2026-09-10T20:00:00Z' },
      { crm_mensagem_origem_id: 'invalido', timestamp: 'x' },
    ], [{ mensagem_id: 'audio-1' }]);
    expect(await contarAudiosPendentes(db, 'conversa-sintetica', agora)).toBe(1);
    expect(db.filtros).toEqual([
      ['cliente_ppg_mensagens_sdr', 'remotejid', 'conversa-sintetica'],
      ['crm_sdr_historico_audio_fila', 'mensagem_id', ['audio-1', 'audio-2']],
      ['crm_sdr_historico_audio_fila', 'status', ['pending', 'processing']],
    ]);
  });
  it('sem origem recente, não consulta a fila global', async () => {
    const db = banco([]);
    expect(await contarAudiosPendentes(db, 'conversa-sintetica', agora)).toBe(0);
    expect(db.from).toHaveBeenCalledOnce();
  });
  it('concluído ou falho não prende o atendimento em espera', async () => {
    const db = banco([{ crm_mensagem_origem_id: 'audio', timestamp: '2026-09-10T21:25:00Z' }], []);
    expect(await contarAudiosPendentes(db, 'conversa-sintetica', agora)).toBe(0);
    expect(db.filtros.at(-1)).toEqual(['crm_sdr_historico_audio_fila', 'status', ['pending', 'processing']]);
  });
  it('erro no histórico interrompe sem consultar outras conversas', async () => {
    const db = banco([], [], 'erro sintético');
    await expect(contarAudiosPendentes(db, 'conversa-sintetica', agora)).rejects.toThrow('histórico indisponível');
    expect(db.from).toHaveBeenCalledOnce();
  });
});
