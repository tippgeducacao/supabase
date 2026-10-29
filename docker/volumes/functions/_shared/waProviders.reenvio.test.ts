import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWaProvider } from './waProviders.ts';

// 29/10/2026: 77 cobranças saíram EM DOBRO. O uazapi enfileira sob rajada e responde depois dos 12 s; o adapter
// abortava, REPETIA o envio (o uazapi já tinha aceitado o primeiro) e ainda registrava erro. Tempo esgotado
// não pode repetir uma mensagem; erro de rede (a requisição nem chegou) continua podendo.

afterEach(() => vi.unstubAllGlobals());

const tempoEsgotado = () => new DOMException('The signal has been aborted', 'AbortError');
const aceito = () => new Response(JSON.stringify({ id: 'msg-1' }), { status: 200 });
const NUMERO = '5511900000000';

describe('uazapi: tempo esgotado não repete o envio', () => {
  it.each(['texto', 'mídia', 'reação'])('%s: sem resposta no limite NÃO tenta de novo', async (qual) => {
    const fetchMock = vi.fn().mockRejectedValue(tempoEsgotado());
    vi.stubGlobal('fetch', fetchMock);
    const provider = getWaProvider('uazapi');
    const chamada = qual === 'texto'
      ? provider.sendText('https://p.test', 'token', NUMERO, 'oi')
      : qual === 'mídia'
        ? provider.sendMedia('https://p.test', 'token', NUMERO, { tipo: 'image', url: 'https://m.test/a.png' })
        : provider.sendReaction('https://p.test', 'token', NUMERO, 'id-da-mensagem', '👍');
    await expect(chamada).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('erro de rede (a requisição nem chegou ao servidor) ainda é repetido uma vez', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue(aceito());
    vi.stubGlobal('fetch', fetchMock);
    const r = await getWaProvider('uazapi').sendText('https://p.test', 'token', NUMERO, 'oi');
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('resposta HTTP com erro nunca é repetida (o servidor recebeu)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'x' }), { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await getWaProvider('uazapi').sendText('https://p.test', 'token', NUMERO, 'oi');
    expect(r.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
