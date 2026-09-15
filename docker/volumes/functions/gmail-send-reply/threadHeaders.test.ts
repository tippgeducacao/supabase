import { describe, expect, it, vi } from 'vitest';
import { resolverHeadersRespostaGmail } from './threadHeaders';

describe('cabeçalhos da resposta Gmail', () => {
  const pai = { id: 'local', gmail_message_id: '19fff001', message_id: null, references_header: '<raiz@x>' };
  it('usa o RFC salvo sem chamar o provedor', async () => {
    const deps = { buscar: vi.fn(), salvar: vi.fn() };
    await expect(resolverHeadersRespostaGmail({ ...pai, message_id: '<pai@x>' }, deps))
      .resolves.toEqual({ inReplyTo: '<pai@x>', references: '<raiz@x> <pai@x>' });
    expect(deps.buscar).not.toHaveBeenCalled();
  });
  it('repara mensagem antiga por metadata e conserva a cadeia oficial', async () => {
    const deps = { buscar: vi.fn().mockResolvedValue({ headers: [
      { name: 'Message-ID', value: '<real@x>' }, { name: 'References', value: '<raiz@x> <anterior@x>' },
    ] }), salvar: vi.fn().mockResolvedValue(undefined) };
    await expect(resolverHeadersRespostaGmail(pai, deps)).resolves.toEqual({
      inReplyTo: '<real@x>', references: '<raiz@x> <anterior@x> <real@x>',
    });
    expect(deps.buscar).toHaveBeenCalledWith('19fff001');
    expect(deps.salvar).toHaveBeenCalledWith('local', { message_id: '<real@x>', references_header: '<raiz@x> <anterior@x>' });
  });
  it('não inventa pai quando o Gmail não fornece Message-ID', async () => {
    const deps = { buscar: vi.fn().mockResolvedValue({ headers: [] }), salvar: vi.fn() };
    await expect(resolverHeadersRespostaGmail(pai, deps)).rejects.toThrow('cabeçalho');
    expect(deps.salvar).not.toHaveBeenCalled();
  });
  it('falha de consulta ou persistência interrompe a preparação antes do envio', async () => {
    await expect(resolverHeadersRespostaGmail(pai, { buscar: vi.fn().mockRejectedValue(new Error('falha')), salvar: vi.fn() })).rejects.toThrow('falha');
    await expect(resolverHeadersRespostaGmail(null, { buscar: vi.fn(), salvar: vi.fn() })).rejects.toThrow('mensagem para responder');
  });
});
