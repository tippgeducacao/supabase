import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRAZO_MODELO_PILOTO_MS } from './prazoModelo';
import type { ProvedorIA } from './agente';

const transporte = vi.fn<typeof fetch>();
let chamar: typeof import('./agente').chamarAnthropic;
const luna: ProvedorIA = { nome: 'openai', formato: 'openai', base: 'https://api.openai.com',
  chave: 'simulada', modelo: 'modelo-teste', esforco: 'high' };
const pedido = { messages: [{ role: 'user', content: 'oi' }], tools: [] };
beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: () => '' } });
  vi.stubGlobal('fetch', transporte);
  ({ chamarAnthropic: chamar } = await import('./agente'));
});
beforeEach(() => { vi.useFakeTimers(); transporte.mockReset(); });
afterEach(() => vi.useRealTimers());
afterAll(() => vi.unstubAllGlobals());

describe('prazo HTTP real do piloto, incluindo corpo e retries', () => {
  it('interrompe fetch que nunca resolve e sinaliza cancelamento ao transporte', async () => {
    transporte.mockImplementation(() => new Promise(() => {}));
    const p = chamar(pedido, {}, luna);
    const falha = expect(p).rejects.toThrow('MODELO_TEMPO_ESGOTADO');
    await vi.advanceTimersByTimeAsync(PRAZO_MODELO_PILOTO_MS);
    await falha;
    expect(transporte.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(transporte).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([200, 503])('prazo inclui leitura do corpo HTTP %s que não termina', async (status) => {
    transporte.mockResolvedValue(new Response(new ReadableStream({ start() {} }), { status }));
    const p = chamar(pedido, {}, luna, 100);
    const falha = expect(p).rejects.toThrow('MODELO_TEMPO_ESGOTADO');
    await vi.advanceTimersByTimeAsync(100);
    await falha;
    expect(transporte.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(transporte).toHaveBeenCalledOnce();
  });
  it('retry compartilha prazo e não continua chamando depois de vencer', async () => {
    transporte.mockImplementation(async () => new Response('temporário', { status: 503 }));
    const p = chamar(pedido, {}, luna, 5000);
    const falha = expect(p).rejects.toThrow('MODELO_TEMPO_ESGOTADO');
    await vi.advanceTimersByTimeAsync(5000);
    await falha;
    await vi.advanceTimersByTimeAsync(10000);
    expect(transporte).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('400 não ganha retry e limpa o timer', async () => {
    transporte.mockResolvedValue(new Response('pedido inválido', { status: 400 }));
    await expect(chamar(pedido, {}, luna)).rejects.toThrow('HTTP 400');
    expect(transporte).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('resposta saudável conserva o adaptador Responses', async () => {
    transporte.mockResolvedValue(Response.json({ id: 'resp-teste', model: 'modelo-teste', status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'oi' }] }],
      usage: { input_tokens: 1, output_tokens: 1 } }));
    const resposta = await chamar(pedido, {}, luna);
    expect(resposta.content).toContainEqual({ type: 'text', text: 'oi' });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reserva do piloto aceita prazo explícito sem alterar chamadas Anthropic legadas', async () => {
    transporte.mockResolvedValueOnce(Response.json({ content: [] }));
    await chamar(pedido);
    expect(transporte.mock.calls[0][1]?.signal).toBeUndefined();
    transporte.mockImplementation(() => new Promise(() => {}));
    const p = chamar(pedido, {}, null, 100);
    const falha = expect(p).rejects.toThrow('MODELO_TEMPO_ESGOTADO');
    await vi.advanceTimersByTimeAsync(100);
    await falha;
    expect(transporte.mock.calls[1][1]?.signal?.aborted).toBe(true);
  });
});
