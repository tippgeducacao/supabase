import { describe, expect, it, vi } from 'vitest';
import { mensagemPreparada, persistirEntradasDoLote, registrarEntrada } from './historicoEntradaPausa.ts';

const jid = '5511999990001@s.whatsapp.net';
const entrada = { msg_id: 'wamid.SINTETICO.1', mensagem: 'Sou veterinária e trabalho com bovinos.' };
function banco(estado = 'ativa', gravada = true) {
  return { rpc: vi.fn().mockResolvedValue({ data: { estado, gravada, historico_id: 1 }, error: null }) };
}

describe('memória de entradas durante a pausa', () => {
  it('guarda fala do lead como user e mantém análise de arquivo em blocos text', () => {
    expect(mensagemPreparada(entrada)).toEqual({ role: 'user', content: entrada.mensagem });
    expect(mensagemPreparada({ arquivo: 'Arquivo analisado', mensagem: 'Minha legenda' })).toEqual({
      role: 'user', content: [{ type: 'text', text: 'Arquivo analisado' }, { type: 'text', text: 'Minha legenda' }],
    });
  });
  it('consulta identidade antes da preparação sem fabricar conteúdo', async () => {
    const db = banco('pausa');
    expect((await registrarEntrada(db, jid, entrada, { pausaObservada: true })).estado).toBe('pausa');
    expect(db.rpc).toHaveBeenCalledWith('crm_sdr_registrar_entrada', {
      p_wa_message_id: entrada.msg_id, p_remotejid: jid, p_mensagem: null, p_pausa_observada: true,
    });
  });
  it('replay de fala recebida em pausa não entra na rodada nem duplica histórico', async () => {
    const db = banco('pausa');
    const legado = vi.fn();
    expect(await persistirEntradasDoLote(db, jid, [entrada], false, legado)).toEqual([]);
    expect(legado).not.toHaveBeenCalled();
  });
  it('pausa durante debounce preserva cada origem e não libera geração', async () => {
    const db = banco('pausa');
    const legado = vi.fn();
    expect(await persistirEntradasDoLote(db, jid, [entrada, { ...entrada, msg_id: 'wamid.SINTETICO.2' }], true, legado)).toEqual([]);
    expect(db.rpc.mock.calls.map(([, args]) => args.p_wa_message_id)).toEqual([entrada.msg_id, 'wamid.SINTETICO.2']);
    expect(db.rpc.mock.calls.every(([, args]) => args.p_pausa_observada && args.p_mensagem.role === 'user')).toBe(true);
    expect(legado).not.toHaveBeenCalled();
  });
  it('lote misto gera somente para entrada ativa sem perder a memória persistida', async () => {
    const db = banco();
    db.rpc.mockResolvedValueOnce({ data: { estado: 'pausa', gravada: true }, error: null });
    const nova = { msg_id: 'wamid.SINTETICO.2', mensagem: 'Agora posso conversar.' };
    const legado = vi.fn();
    expect(await persistirEntradasDoLote(db, jid, [entrada, nova], false, legado)).toEqual([nova]);
    expect(legado).not.toHaveBeenCalled();
  });
  it('reexecução ativa reaproveita a gravação por origem sem acrescentar turno legado', async () => {
    const db = banco('ativa', false);
    const legado = vi.fn();
    expect(await persistirEntradasDoLote(db, jid, [entrada], false, legado)).toEqual([entrada]);
    expect(legado).not.toHaveBeenCalled();
  });
  it('uma origem de outro contato nunca vira fala deste lead', async () => {
    const db = banco('contato_invalido', false);
    const legado = vi.fn();
    expect(await persistirEntradasDoLote(db, jid, [entrada], false, legado)).toEqual([]);
    expect(legado).not.toHaveBeenCalled();
  });
  it('mantém compatibilidade de buffers legados sem tentar deduplicar pelo texto', async () => {
    const db = banco('legado', false);
    const legado = vi.fn().mockResolvedValue(undefined);
    const itens = [entrada, { mensagem: 'Outra mensagem', arquivo: 'Arquivo' }];
    expect(await persistirEntradasDoLote(db, jid, itens, false, legado)).toEqual(itens);
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(legado.mock.calls.map(([m]) => m)).toEqual([
      { role: 'user', content: 'Arquivo' }, { role: 'user', content: entrada.mensagem + '\nOutra mensagem' },
    ]);
  });
  it('drenar_orfao vazio não fabrica fala do lead', async () => {
    const db = banco();
    const legado = vi.fn();
    expect(await persistirEntradasDoLote(db, jid, [{ mensagem: '' }], false, legado)).toEqual([]);
    expect(db.rpc).not.toHaveBeenCalled();
    expect(legado).not.toHaveBeenCalled();
  });
  it('preserva buffer legado se a pausa foi aplicada durante a espera', async () => {
    const db = banco('sem_origem', false);
    const legado = vi.fn().mockResolvedValue(undefined);
    expect(await persistirEntradasDoLote(db, jid, [entrada], true, legado)).toEqual([]);
    expect(legado).toHaveBeenCalledWith({ role: 'user', content: entrada.mensagem });
  });
  it.each([
    { data: null, error: { message: 'falha' } },
    { data: { estado: 'desconhecido', gravada: true }, error: null },
    { data: { estado: 'ativa' }, error: null },
  ])('interrompe em falha de memória em vez de gerar com histórico parcial: %j', async (resultado) => {
    const db = { rpc: vi.fn().mockResolvedValue(resultado) };
    const legado = vi.fn();
    await expect(persistirEntradasDoLote(db, jid, [entrada], false, legado)).rejects.toThrow(/histórico/);
    expect(legado).not.toHaveBeenCalled();
  });
});
