import { afterEach, describe, expect, it, vi } from 'vitest';
import { digitosParaEnvio, telefoneEnviavel } from '../_shared/telefone.ts';
import { getWaProvider } from '../_shared/waProviders.ts';
import { canonicalConversationPhone, phoneVariants } from './telefoneConversa.ts';

afterEach(() => vi.unstubAllGlobals());

describe('destino internacional do envio WhatsApp', () => {
  it.each([
    ['5491162118884', '5491162118884'],
    ['+54 9 (11) 6211-8884', '5491162118884'],
    ['+1 631 578 2741', '16315782741'],
    ['+1 239 555 0123', '12395550123'],
    ['+39 02 123456', '3902123456'],
    ['351912345678', '351912345678'],
    ['971501234567', '971501234567'],
  ])('preserva %s na validação, envio, busca de linha e histórico', (entrada, destino) => {
    expect(telefoneEnviavel(entrada)).toBe(true);
    expect(digitosParaEnvio(entrada)).toBe(destino);
    expect(phoneVariants(entrada)).toEqual([destino]);
    expect(canonicalConversationPhone(entrada)).toBe(destino);
  });

  it.each(['text', 'image', 'audio', 'document', 'sticker', 'reaction'])('o adapter envia %s ao número argentino original', async (tipo) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'mensagem-teste' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = getWaProvider('uazapi');
    const destino = digitosParaEnvio('5491162118884')!;
    if (tipo === 'text') {
      await provider.sendText('https://provider.test', 'token-teste', destino, 'Teste local');
    } else if (tipo === 'reaction') {
      await provider.sendReaction('https://provider.test', 'token-teste', destino, 'mensagem-original', '👍');
    } else {
      await provider.sendMedia('https://provider.test', 'token-teste', destino, { tipo, url: 'https://midia.test/arquivo' });
    }
    expect(fetchMock).toHaveBeenCalledOnce();
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.number).toBe('5491162118884');
  });

  it('mantém DDD 55, zero de tronco e variantes brasileiras', () => {
    expect(digitosParaEnvio('55999123456')).toBe('5555999123456');
    expect(digitosParaEnvio('5501499668988')).toBe('551499668988');
    expect(digitosParaEnvio('46999746930')).toBe('5546999746930');
    expect(canonicalConversationPhone('554699974693')).toBe('5546999974693');
    expect(phoneVariants('5546999746930')).toEqual(expect.arrayContaining(['46999746930', '5546999746930', '4699746930', '554699746930']));
  });

  it('continua impedindo o destino impossível da LP', () => {
    expect(telefoneEnviavel('5553474634534')).toBe(false);
    expect(digitosParaEnvio('5553474634534')).toBeNull();
    expect(phoneVariants('5553474634534')).toEqual([]);
  });
});
