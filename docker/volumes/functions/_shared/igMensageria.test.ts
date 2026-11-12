import { describe, expect, it, vi } from 'vitest';
import {
  bytesUtf8, dividirPorBytes, ehTokenInvalido, enviarRespostaPrivadaIg, enviarTextoIg, IG_GRAPH_URL,
} from './igMensageria';

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

describe('enviarRespostaPrivadaIg: resposta a um comentário (12/11/2026)', () => {
  const generico = () => new Response(JSON.stringify({ error: { message: 'An unknown error has occurred.', code: 1 } }), { status: 500 });

  it('endereça pelo comment_id, por /me/messages (o mesmo da DM), e devolve o message_id', async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ recipient_id: '123', message_id: 'mid.privada' })));
    const ok = await enviarRespostaPrivadaIg('TOKEN', '17890018740485756', 'oi', '17841453422080445', f as unknown as typeof fetch);
    expect(ok).toEqual({ ok: true, mid: 'mid.privada' });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(`${IG_GRAPH_URL}/me/messages`);
    expect(init.headers.Authorization).toBe('Bearer TOKEN');
    expect(JSON.parse(init.body)).toEqual({ recipient: { comment_id: '17890018740485756' }, message: { text: 'oi' } });
  });

  it('erro genérico da Meta: tenta UMA vez pelo endereço da conta (o documentado)', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(generico())
      .mockResolvedValueOnce(new Response(JSON.stringify({ message_id: 'mid.2' })));
    const r = await enviarRespostaPrivadaIg('T', 'c1', 'oi', '1784', f as unknown as typeof fetch);
    expect(r).toEqual({ ok: true, mid: 'mid.2' });
    expect(f.mock.calls.map((c) => c[0])).toEqual([`${IG_GRAPH_URL}/me/messages`, `${IG_GRAPH_URL}/1784/messages`]);
  });

  it('os dois endereços com erro genérico: devolve o erro, sem terceira tentativa', async () => {
    const f = vi.fn().mockImplementation(async () => generico());
    const r = await enviarRespostaPrivadaIg('T', 'c1', 'oi', '1784', f as unknown as typeof fetch);
    expect(r).toMatchObject({ ok: false, erro: { status: 500, code: 1 } });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('recusa com motivo (live encerrada) não tenta de novo', async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'fora da janela', code: 10 } }), { status: 400 }));
    const r = await enviarRespostaPrivadaIg('T', 'c1', 'oi', '1784', f as unknown as typeof fetch);
    expect(r).toEqual({ ok: false, erro: { status: 400, code: 10, subcode: undefined, message: 'fora da janela' } });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('sem o id da conta não há segundo endereço', async () => {
    const f = vi.fn().mockImplementation(async () => generico());
    await enviarRespostaPrivadaIg('T', 'c1', 'oi', null, f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
