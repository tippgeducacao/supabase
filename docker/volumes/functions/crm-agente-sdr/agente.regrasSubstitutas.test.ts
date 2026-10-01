// Ensaio de prompt (01/10/2026): o simulador pode trocar TODOS os blocos fixos por um texto só.
// A produção não passa `regrasSubstitutas`, e o pedido dela continua com os blocos de sempre.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NOME_TOOL_RESPOSTA } from './canalResposta';

const transporte = vi.fn();
let chamarAgentePrincipal: typeof import('./agente').chamarAgentePrincipal;

beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: () => '' } });
  vi.stubGlobal('fetch', transporte);
  ({ chamarAgentePrincipal } = await import('./agente'));
  transporte.mockImplementation(async () => new Response(JSON.stringify({
    model: 'modelo-sintetico', usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'r', name: NOME_TOOL_RESPOSTA, input: { mensagem: 'ok' } }],
  }), { status: 200 }));
});
afterAll(() => vi.unstubAllGlobals());

async function systemEnviado(regrasSubstitutas?: string): Promise<string[]> {
  transporte.mockClear();
  await chamarAgentePrincipal({
    promptAgente: 'PERSONA', contextoTemporal: '', messages: [{ role: 'user', content: 'oi' }], tools: [],
    ...(regrasSubstitutas ? { regrasSubstitutas } : {}),
  });
  const corpo = JSON.parse(String(transporte.mock.calls[0][1].body));
  return corpo.system.map((b: { text: string }) => b.text);
}

describe('regras substitutas (só o simulador)', () => {
  it('com o campo, o pedido leva só a persona e o texto novo', async () => {
    expect(await systemEnviado('REGRAS NOVAS')).toEqual(['PERSONA', 'REGRAS NOVAS']);
  });

  it('sem o campo (produção), os blocos fixos de sempre continuam', async () => {
    const system = await systemEnviado();
    expect(system[0]).toBe('PERSONA');
    expect(system.length).toBeGreaterThan(4);
    expect(system).not.toContain('REGRAS NOVAS');
  });
});
