import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProvedorIA } from './agente';

let agente: typeof import('./agente');
const transporte = vi.fn();
const apoio = (): ProvedorIA => ({ nome: 'openai', formato: 'openai', base: 'https://api.openai.com',
  chave: 'chave-sintetica', modelo: 'gpt-6-luna', esforco: 'high',
  conversa: { modelo: 'gpt-6.1-terra', esforco: 'medium' } });
const pedido = { model: 'modelo-legado', max_tokens: 8192, thinking: { type: 'adaptive' },
  system: [{ type: 'text', text: 'Atenda com clareza.' }],
  messages: [{ role: 'user', content: 'Quero conhecer a pós.' }],
  tools: [{ name: 'responder_ao_cliente', input_schema: { type: 'object', properties: { mensagem: { type: 'string' } } } }] };
const resposta = (nome = 'responder_ao_cliente') => ({ type: 'function_call', call_id: 'call_sintetica',
  name: nome, arguments: JSON.stringify(nome === 'router_output' ? { agent: 'agente_validacao' } : { mensagem: 'Como posso ajudar?' }) });

beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: () => '' } });
  vi.stubGlobal('fetch', transporte);
  agente = await import('./agente');
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  transporte.mockReset();
  transporte.mockImplementation(async (url: string, opts: RequestInit) => {
    expect(url).toBe('https://api.openai.com/v1/responses');
    const p = JSON.parse(String(opts.body));
    return Response.json({ model: p.model, status: 'completed',
      output: [resposta(p.tools?.some((t: { name: string }) => t.name === 'router_output') ? 'router_output' : undefined)] });
  });
});
const pedidos = () => transporte.mock.calls.map(([, opts]) => JSON.parse(String(opts.body)));

describe('Terra exclusivo da conversa principal', () => {
  it('router e chamada de apoio ficam na Luna; principal usa Terra medium sem mutar o provedor', async () => {
    const p = apoio();
    await agente.chamarRouter([{ role: 'user', content: 'Quero conhecer a pós.' }], undefined, p);
    const resultado = await agente.executarPedidoPrincipal(pedido, { provedor: p });
    await agente.chamarAnthropic({ ...pedido, thinking: { type: 'disabled' } }, {}, p);
    expect(pedidos().map((p) => [p.model, p.reasoning.effort])).toEqual([
      ['gpt-6-luna', 'none'], ['gpt-6.1-terra', 'medium'], ['gpt-6-luna', 'none'],
    ]);
    expect(resultado.model).toBe('gpt-6.1-terra');
    expect(p).toMatchObject({ modelo: 'gpt-6-luna', esforco: 'high' });
    expect(pedidos().every((p) => p.store === false)).toBe(true);
  });
  it('a correção do canal também usa Terra, com raciocínio desligado', async () => {
    transporte.mockImplementationOnce(async () => Response.json({ model: 'gpt-6.1-terra', status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Como posso ajudar?' }] }] }));
    await agente.executarPedidoPrincipal(pedido, { provedor: apoio() });
    expect(pedidos().map((p) => [p.model, p.reasoning.effort])).toEqual([
      ['gpt-6.1-terra', 'medium'], ['gpt-6.1-terra', 'none'],
    ]);
  });
  it('desligar a configuração conserva a Luna com o esforço anterior', async () => {
    const { conversa: _conversa, ...p } = apoio() as Extract<ProvedorIA, { formato: 'openai' }>;
    await agente.executarPedidoPrincipal(pedido, { provedor: p });
    expect(pedidos()[0]).toMatchObject({ model: 'gpt-6-luna', reasoning: { effort: 'high' } });
    expect(agente.provedorDaConversa(null)).toBeNull();
  });
});
