import { describe, expect, it, vi } from 'vitest';
import { confirmarInteracaoVoz, planejarCadenciaVoz } from './cadenciaVoz';

const chave = { contaId: '00000000-0000-4000-8000-000000000001', telefone: '5511999990001', interacaoId: '00000000-0000-4000-8000-000000000002' };

describe('cadência durável de voz', () => {
  it('usa o alvo e o contador do servidor, sem novo sorteio na leitura', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { interacao_concluida: false, audio_devido: true, alvo: 4, interacoes: 3 }, error: null });
    expect(await planejarCadenciaVoz({ rpc }, chave)).toEqual({ concluida: false, audioDevido: true, alvo: 4, interacoes: 3 });
    expect(rpc).toHaveBeenCalledExactlyOnceWith('crm_sdr_voz_planejar', {
      p_wa_account_id: chave.contaId, p_telefone: chave.telefone, p_interacao_id: chave.interacaoId,
    });
  });
  it('replay concluído nunca autoriza gerar novo áudio', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { interacao_concluida: true, audio_devido: true, alvo: 3, interacoes: 3 }, error: null });
    expect((await planejarCadenciaVoz({ rpc }, chave)).audioDevido).toBe(false);
  });
  it.each([
    null,
    { alvo: 2, interacoes: 0, audio_devido: true, interacao_concluida: false },
    { alvo: 6, interacoes: 0, audio_devido: true, interacao_concluida: false },
    { alvo: 3, interacoes: 4, audio_devido: true, interacao_concluida: false },
    { alvo: 3, interacoes: 0, audio_devido: 'true', interacao_concluida: false },
  ])('estado inválido não inventa um intervalo: %j', async (data) => {
    const rpc = vi.fn().mockResolvedValue({ data, error: null });
    await expect(planejarCadenciaVoz({ rpc }, chave)).rejects.toThrow(/cadencia_voz/);
  });
  it('confirma texto e áudio com a mesma identidade da rodada', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { confirmado: true }, error: null });
    await confirmarInteracaoVoz({ rpc }, chave, 'texto', 'wamid-confirmado');
    expect(rpc).toHaveBeenCalledExactlyOnceWith('crm_sdr_voz_confirmar', {
      p_wa_account_id: chave.contaId, p_telefone: chave.telefone, p_interacao_id: chave.interacaoId,
      p_canal: 'texto', p_wa_message_id: 'wamid-confirmado',
    });
  });
  it('erro da confirmação fica visível ao chamador sem repetir o envio', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'indisponível' } });
    await expect(confirmarInteracaoVoz({ rpc }, chave, 'audio')).rejects.toThrow('cadencia_voz_confirmacao_indisponivel');
    expect(rpc).toHaveBeenCalledOnce();
  });
});
