import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercita o handler e seu mock reais: só catálogo/autenticação e transporte do
// modelo são fixtures. Assim o ensaio não confunde consulta com mensagem enviada.
const mocks = vi.hoisted(() => ({ from: vi.fn(), fetch: vi.fn() }));
vi.mock('https://esm.sh/@supabase/supabase-js@2.50.3', () => ({
  createClient: () => ({ from: mocks.from }),
}));

let handler: (req: Request) => Promise<Response>;
beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: () => 'valor_sintetico_teste' },
    serve: (callback: typeof handler) => { handler = callback; },
  });
  vi.stubGlobal('fetch', mocks.fetch);
  await import('./index');
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.resetAllMocks();
  mocks.from.mockImplementation((tabela: string) => {
    if (!['crm_agente_sdr_config', 'lista_tools_claude'].includes(tabela)) throw new Error('Banco inesperado');
    const consulta = {
      select: () => consulta,
      eq: () => consulta,
      maybeSingle: async () => ({ data: { followup_secret: 'harness-local' }, error: null }),
      order: async () => ({ data: [{ tool: {
        name: 'envia_informacoes', description: 'Consulta material e preço.',
        input_schema: { type: 'object', properties: { conteudo: { type: 'string' }, curso_escolhido: { type: 'string' } } },
      } }], error: null }),
    };
    return consulta;
  });
  mocks.fetch.mockRejectedValue(new Error('Rede inesperada'));
});

describe('contrato do mock de consulta de valor', () => {
  it('informa preço ao modelo sem simular envio de cronograma ou de mensagem ao cliente', async () => {
    const respostas = [
      { content: [{ type: 'tool_use', id: 'consulta-valor', name: 'envia_informacoes',
        input: { conteudo: 'valor', curso_escolhido: 'Sanidade Avícola' } }], stop_reason: 'tool_use' },
      { content: [{ type: 'tool_use', id: 'resposta-final', name: 'responder_ao_cliente',
        input: { mensagem: 'O valor integral é R$ 4.200,00.' } }], stop_reason: 'tool_use' },
    ];
    mocks.fetch.mockImplementation(async (url: string) => {
      if (url !== 'https://api.anthropic.com/v1/messages' || !respostas.length) throw new Error('Chamada externa inesperada');
      return Response.json(respostas.shift());
    });
    const resposta = await handler(new Request('https://harness.invalid', {
      method: 'POST', headers: { 'x-followup-key': 'harness-local' },
      body: JSON.stringify({ persona: 'qualificador', curso: 'Sanidade Avícola', mensagens: ['Qual o valor integral?'] }),
    }));
    const resultado = await resposta.json();
    expect(resposta.status).toBe(200);
    const segundaChamada = JSON.parse(mocks.fetch.mock.calls[1][1].body);
    const bloco = segundaChamada.messages.at(-1).content.find((item: { type: string }) => item.type === 'tool_result');
    const consulta = JSON.parse(bloco.content);
    expect(consulta).toMatchObject({ cronograma_status: 'nao_solicitado', cronograma_enviado: false,
      cronograma_entregue: false, curso: 'Sanidade Avícola', wa_message_id: null });
    expect(consulta.resultado).toContain('nenhum cronograma foi solicitado ou enviado');
    expect(consulta.resultado).toContain('Valor integral da pós: R$ 4.200,00');
    expect(resultado.transcript.filter((item: { quem: string }) => item.quem === 'joao')).toEqual([
      { quem: 'joao', texto: 'O valor integral é R$ 4.200,00.', turno: 1 },
    ]);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.from.mock.calls.map(([tabela]) => tabela)).toEqual(['crm_agente_sdr_config', 'lista_tools_claude']);
  });
});
