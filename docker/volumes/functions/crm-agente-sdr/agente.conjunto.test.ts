// A IA principal recebe os blocos do conjunto pedido: 'luna' = prompts-luna.ts; sem conjunto = produção.
// prompts-luna é trocado por textos-sentinela para provar a FONTE (hoje os valores ainda são iguais).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { INSTRUCAO_MEMORIA_HUMANA } from './memoriaHumana';
import { INSTRUCAO_CANAL_RESPOSTA, NOME_TOOL_RESPOSTA } from './canalResposta';

vi.mock('./prompts-luna.ts', () => ({
  LUNA_PERSONA_ABERTURA: 'SENTINELA_PERSONA_ABERTURA', LUNA_PERSONA_FECHAMENTO: 'SENTINELA_PERSONA_FECHAMENTO',
  LUNA_ELEGIBILIDADE: 'SENTINELA_ELEGIBILIDADE', LUNA_ENVIO_MATERIAIS: 'SENTINELA_MATERIAIS',
  LUNA_MEMORIA_HUMANA: 'SENTINELA_MEMORIA', LUNA_FATOS_DO_LEAD: 'SENTINELA_FATOS', LUNA_DISPONIBILIDADE: 'SENTINELA_DISPONIBILIDADE',
  LUNA_EVENTOS: 'SENTINELA_EVENTOS', LUNA_FICHA: 'SENTINELA_FICHA', LUNA_VOZ: 'SENTINELA_VOZ',
  LUNA_CANAL_RESPOSTA: 'SENTINELA_CANAL',
  LUNA_AGENTE_VALIDACAO: 'SENTINELA_VALIDACAO', LUNA_AGENTE_QUALIFICADOR: 'SENTINELA_QUALIFICADOR',
}));

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

async function systemEnviado(conjunto?: 'luna' | 'producao'): Promise<string[]> {
  transporte.mockClear();
  await chamarAgentePrincipal({
    promptAgente: 'PERSONA', contextoTemporal: '', comFicha: true, messages: [{ role: 'user', content: 'oi' }], tools: [],
    ...(conjunto ? { conjunto } : {}),
  });
  const [, init] = transporte.mock.calls[0] as [string, RequestInit];
  return JSON.parse(String(init.body)).system.map((b: { text: string }) => b.text);
}

describe('chamarAgentePrincipal: de onde vem o texto', () => {
  it("conjunto 'luna': todos os blocos saem de prompts-luna.ts, na mesma ordem", async () => {
    expect(await systemEnviado('luna')).toEqual([
      'PERSONA', 'SENTINELA_MEMORIA', 'SENTINELA_FATOS', 'SENTINELA_DISPONIBILIDADE', 'SENTINELA_EVENTOS',
      'SENTINELA_FICHA', 'SENTINELA_VOZ', 'SENTINELA_CANAL',
    ]);
  });
  it('sem conjunto: os blocos de sempre (produção)', async () => {
    const system = await systemEnviado();
    expect(system[1]).toBe(INSTRUCAO_MEMORIA_HUMANA);
    expect(system.at(-1)).toBe(INSTRUCAO_CANAL_RESPOSTA);
    expect(system.join('\n')).not.toContain('SENTINELA');
  });
});
