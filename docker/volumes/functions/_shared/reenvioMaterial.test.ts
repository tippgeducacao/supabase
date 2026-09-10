import { describe, expect, it, vi } from 'vitest';
import { agendarReenvioMaterial, cancelarReenvioMaterial, proximaTentativaMaterial, AUTOR_REENVIO_MATERIAL } from './reenvioMaterial';
import { resultadoMaterial } from './resultadoEnvioMaterial';

const documento = { telefone: '5511999990001', wa_account_id: 'conta', anexo_url: 'https://materiais.invalid/cronograma.pdf' };
const falha = resultadoMaterial('falhou', null, 'Serviço indisponível', '131016');
function banco(erro: unknown = null) {
  const resultado = { data: erro ? null : { id: 'fila-1' }, error: erro };
  const q = { eq: vi.fn(() => q), in: vi.fn(() => q), select: vi.fn(() => q),
    maybeSingle: async () => resultado, then: (r: (v: typeof resultado) => unknown) => Promise.resolve(resultado).then(r) };
  const insert = vi.fn(() => q); const update = vi.fn(() => q);
  return { from: vi.fn(() => ({ insert, update, select: () => q })), insert, update, q };
}
describe('registro durável da nova tentativa', () => {
  it('só devolve id depois da gravação, sem transformar falha em sucesso', async () => {
    const db = banco();
    expect(await agendarReenvioMaterial(db, documento, falha, 0)).toMatchObject({
      cronograma_status: 'falhou', cronograma_enviado: false, reenvio_agendado_id: 'fila-1', reenvio_em: '1970-01-01T00:30:00.000Z',
    });
    expect(db.insert).toHaveBeenCalledWith(expect.objectContaining({ ...documento, criado_por_nome: AUTOR_REENVIO_MATERIAL, tipo_mensagem: 'midia' }));
  });
  it('falha no banco não autoriza promessa', async () => {
    expect(await agendarReenvioMaterial(banco({ message: 'Indisponível' }), documento, falha)).toEqual(falha);
  });
  it.each(['190', '131047', '131026', '131049', 'anexo_indisponivel', 'cronograma_nao_cadastrado', 'codigo_novo'])('recusa %s não agenda retry', async (code) => {
    const db = banco();
    const r = resultadoMaterial('falhou', null, 'Erro', code);
    expect(await agendarReenvioMaterial(db, documento, r)).toEqual(r);
    expect(db.insert).not.toHaveBeenCalled();
  });
  it.each(['desconhecido', 'aceito'] as const)('status %s não agenda retry', async (status) => {
    const db = banco(); await agendarReenvioMaterial(db, documento, resultadoMaterial(status));
    expect(db.insert).not.toHaveBeenCalled();
  });
  it('limita a duração das tentativas a uma hora', () => {
    expect(proximaTentativaMaterial(falha, new Date(0).toISOString(), 29 * 60_000)).toBe('1970-01-01T00:59:00.000Z');
    expect(proximaTentativaMaterial(falha, new Date(0).toISOString(), 31 * 60_000)).toBeNull();
  });
  it('novo pedido cancela somente a pendência do mesmo material e conta', async () => {
    const db = banco(); await cancelarReenvioMaterial(db, documento);
    expect(db.q.eq).toHaveBeenCalledWith('status', 'agendado');
    expect(db.q.eq).toHaveBeenCalledWith('criado_por_nome', AUTOR_REENVIO_MATERIAL);
    expect(db.q.eq).toHaveBeenCalledWith('wa_account_id', documento.wa_account_id);
    expect(db.q.eq).toHaveBeenCalledWith('telefone', documento.telefone);
    expect(db.q.eq).toHaveBeenCalledWith('anexo_url', documento.anexo_url);
  });
});
