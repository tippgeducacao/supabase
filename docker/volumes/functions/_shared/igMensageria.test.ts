import { describe, expect, it, vi } from 'vitest';
import { bytesUtf8, dividirPorBytes, ehTokenInvalido, enviarTextoIg, IG_GRAPH_URL } from './igMensageria';

describe('dividirPorBytes: limite de 1000 bytes UTF-8 da Meta', () => {
  it('texto curto sai inteiro (e aparado)', () => {
    expect(dividirPorBytes('  oi, tudo bem?  ')).toEqual(['oi, tudo bem?']);
    expect(dividirPorBytes('   ')).toEqual([]);
  });

  it('conta BYTES, não caracteres: acento e emoji pesam mais', () => {
    const texto = 'ã'.repeat(600); // 600 caracteres, 1200 bytes
    const partes = dividirPorBytes(texto);
    expect(partes.length).toBe(2);
    for (const p of partes) expect(bytesUtf8(p)).toBeLessThanOrEqual(1000);
    expect(partes.join('')).toBe(texto);
  });

  it('nunca corta um emoji no meio', () => {
    const texto = '🐄'.repeat(300); // 4 bytes cada = 1200 bytes
    const partes = dividirPorBytes(texto, 1000);
    for (const p of partes) {
      expect(bytesUtf8(p)).toBeLessThanOrEqual(1000);
      expect(Array.from(p).every((c) => c === '🐄')).toBe(true);
    }
    expect(partes.join('')).toBe(texto);
  });

  it('prefere cortar no último espaço', () => {
    const texto = `${'a'.repeat(30)} ${'b'.repeat(30)} ${'c'.repeat(30)}`;
    expect(dividirPorBytes(texto, 70)).toEqual([`${'a'.repeat(30)} ${'b'.repeat(30)}`, 'c'.repeat(30)]);
  });

  it('palavra maior que o limite é cortada sem perder nada', () => {
    const texto = 'x'.repeat(25);
    expect(dividirPorBytes(texto, 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  });
});

describe('enviarTextoIg', () => {
  it('manda para /me/messages com o token no header e devolve o message_id', async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ recipient_id: '123', message_id: 'mid.abc' })));
    const ok = await enviarTextoIg('TOKEN', '123', 'oi', f as unknown as typeof fetch);
    expect(ok).toEqual({ ok: true, mid: 'mid.abc' });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(`${IG_GRAPH_URL}/me/messages`);
    expect(init.headers.Authorization).toBe('Bearer TOKEN');
    expect(JSON.parse(init.body)).toEqual({ recipient: { id: '123' }, message: { text: 'oi' } });
  });

  it('erro da Meta vira erro legível, e o 190 é token morto', async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'Error validating access token', code: 190, error_subcode: 460 },
    }), { status: 400 }));
    const r = await enviarTextoIg('T', '1', 'oi', f as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.erro).toMatchObject({ status: 400, code: 190, subcode: 460 });
      expect(ehTokenInvalido(r.erro)).toBe(true);
    }
  });

  it('200 sem message_id não conta como enviado', async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ recipient_id: '1' })));
    const r = await enviarTextoIg('T', '1', 'oi', f as unknown as typeof fetch);
    expect(r.ok).toBe(false);
  });

  it('falha de rede não lança', async () => {
    const f = vi.fn().mockRejectedValue(new Error('rede caiu'));
    const r = await enviarTextoIg('T', '1', 'oi', f as unknown as typeof fetch);
    expect(r).toEqual({ ok: false, erro: { status: 0, message: 'rede caiu' } });
  });
});
