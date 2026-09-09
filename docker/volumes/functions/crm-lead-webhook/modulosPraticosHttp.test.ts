import { describe, expect, it, vi } from 'vitest';
import { receberModulosPraticosHttp } from './modulosPraticosHttp';

const requisicao = (body: string, tipo = 'application/json') => new Request('https://example.test/webhook', {
  method: 'POST', headers: { 'content-type': tipo }, body,
});

describe('HTTP de inscrições de módulos práticos', () => {
  it('entrega o JSON ao processador uma única vez', async () => {
    const processar = vi.fn().mockResolvedValue({ statusHttp: 200, body: { ok: true } });
    expect(await receberModulosPraticosHttp(requisicao('{"evento":"catalogo"}', 'application/json; charset=utf-8'), processar))
      .toEqual({ statusHttp: 200, body: { ok: true } });
    expect(processar).toHaveBeenCalledExactlyOnceWith({ evento: 'catalogo' });
  });

  it.each([
    ['{"dado":"valor"}', 'text/plain', 415],
    ['não é JSON', 'application/json', 400],
    ['{"dado":"' + 'á'.repeat(17000) + '"}', 'application/json', 413],
  ])('rejeita corpo inválido sem executar ações (%s)', async (body, tipo, status) => {
    const processar = vi.fn();
    const resultado = await receberModulosPraticosHttp(requisicao(body, tipo), processar);
    expect(resultado.statusHttp).toBe(status);
    expect(processar).not.toHaveBeenCalled();
    expect(JSON.stringify(resultado.body)).not.toContain(body);
  });

  it('interrompe upload excedente mesmo sem Content-Length', async () => {
    const cancelar = vi.fn();
    const stream = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(20_000).fill(32)); },
      cancel: cancelar,
    });
    const req = new Request('https://example.test/webhook', {
      method: 'POST', body: stream, duplex: 'half', headers: { 'content-type': 'application/json' },
    } as RequestInit);
    const processar = vi.fn();
    expect((await receberModulosPraticosHttp(req, processar)).statusHttp).toBe(413);
    expect(cancelar).toHaveBeenCalledOnce();
    expect(processar).not.toHaveBeenCalled();
  });
});
