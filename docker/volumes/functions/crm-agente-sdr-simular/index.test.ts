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
    if (!['crm_agente_sdr_config', 'lista_tools_claude', 'lista_tools_openai'].includes(tabela)) throw new Error('Banco inesperado');
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
  it('reutiliza memória entre tools do turno, renova no próximo e não a passa ao Claude', async () => {
    const agente = await import('../crm-agente-sdr/agente');
    // Spy preserva a implementação: o handler, o loop, o adaptador e o mock da
    // ferramenta continuam reais. Só as respostas HTTP são sintetizadas abaixo.
    const principal = vi.spyOn(agente, 'chamarAgentePrincipal');
    const raciocinio = (turno: number) => ({ type: 'reasoning', id: `rs_turno_${turno}`,
      summary: [], encrypted_content: `CIFRADO_TURNO_${turno}` });
    const consulta = (turno: number) => [raciocinio(turno), {
      type: 'function_call', id: `fc_consulta_${turno}`, call_id: `call_consulta_${turno}`,
      name: 'envia_informacoes', arguments: JSON.stringify({ conteudo: 'valor', curso_escolhido: 'Sanidade Avícola' }),
    }];
    const final = (turno: number) => [{ type: 'function_call', id: `fc_fala_${turno}`,
      call_id: `call_fala_${turno}`, name: 'responder_ao_cliente',
      arguments: JSON.stringify({ mensagem: 'O valor integral é R$ 4.200,00.' }) }];
    const saidas = [consulta(1), final(1), consulta(2), final(2)];
    mocks.fetch.mockImplementation(async (url: string) => {
      if (url === 'https://api.openai.com/v1/responses' && saidas.length) {
        return Response.json({ status: 'completed', model: 'gpt-5.6-luna', output: saidas.shift() });
      }
      if (url === 'https://api.anthropic.com/v1/messages') {
        return Response.json({ stop_reason: 'tool_use', content: [{ type: 'tool_use',
          id: 'fala-claude', name: 'responder_ao_cliente', input: { mensagem: 'Tudo bem, e você?' } }] });
      }
      throw new Error('Transporte inesperado; nenhum envio de WhatsApp é permitido');
    });
    const requisicao = (body: Record<string, unknown>) => new Request('https://harness.invalid', {
      method: 'POST', headers: { 'x-followup-key': 'harness-local' }, body: JSON.stringify(body),
    });
    try {
      const resposta = await handler(requisicao({ persona: 'qualificador', provedor: 'openai',
        modelo_openai: 'gpt-5.6-luna', raciocinio_encadeado: true, curso: 'Sanidade Avícola',
        mensagens: ['Qual o valor integral?', 'Confirma o valor novamente?'] }));
      expect(resposta.status).toBe(200);
      const resultado = await resposta.json();
      expect(principal).toHaveBeenCalledTimes(4);
      const provedores = principal.mock.calls.map(([opts]) => opts.provedor);
      const memorias = provedores.map((p) => p?.formato === 'openai' ? p.memoriaRaciocinio : undefined);
      expect(memorias[0]).toBeInstanceOf(Map);
      expect(memorias[0]).toBe(memorias[1]);
      expect(memorias[2]).toBeInstanceOf(Map);
      expect(memorias[2]).toBe(memorias[3]);
      expect(memorias[0]).not.toBe(memorias[2]);
      expect(memorias[2]?.has('call_consulta_1')).toBe(false);
      const pedidos = mocks.fetch.mock.calls.map(([, init]) => JSON.parse(String(init.body)));
      expect(pedidos.map((p) => p.input.filter((item: { type?: string }) => item.type === 'reasoning')))
        .toEqual([[], [raciocinio(1)], [], [raciocinio(2)]]);
      expect(pedidos[2].input).toContainEqual({ type: 'function_call', call_id: 'call_consulta_1',
        name: 'envia_informacoes', arguments: JSON.stringify({ conteudo: 'valor', curso_escolhido: 'Sanidade Avícola' }) });
      expect(resultado.chamadas.map((c: { turno: number; volta: number; raciocinios_reenviados: number }) =>
        [c.turno, c.volta, c.raciocinios_reenviados])).toEqual([[1, 1, 0], [1, 2, 1], [2, 1, 0], [2, 2, 1]]);
      expect(JSON.stringify(resultado)).not.toMatch(/CIFRADO_TURNO_|encrypted_content|openai_id|raciocinio_openai/);

      const claude = await handler(requisicao({ persona: 'qualificador', provedor: 'anthropic', mensagens: ['Tudo bem?'] }));
      expect(claude.status).toBe(200);
      expect(principal.mock.calls[4][0].provedor).toBeNull();
      expect(String(mocks.fetch.mock.calls[4][1].body)).not.toMatch(/CIFRADO_TURNO_|encrypted_content|openai_id|raciocinio_openai/);
      expect(mocks.fetch).toHaveBeenCalledTimes(5);
    } finally {
      principal.mockRestore();
    }
  });
  it('piloto acrescenta abertura só na primeira fala e leva o aviso ao histórico do próximo turno', async () => {
    mocks.fetch.mockImplementation(async (url: string) => {
      if (url !== 'https://api.openai.com/v1/responses') throw new Error('Transporte inesperado');
      return Response.json({ status: 'completed', model: 'modelo-openai-teste',
        output: [{ type: 'function_call', name: 'responder_ao_cliente', call_id: 'resposta-teste',
          arguments: JSON.stringify({ mensagem: 'qual área você gostaria de aprofundar?' }) }] });
    });
    const res = await handler(new Request('https://harness.invalid', {
      method: 'POST', headers: { 'x-followup-key': 'harness-local' },
      body: JSON.stringify({ persona: 'validacao', provedor: 'openai', ficha: true, nome_lead: 'Marina',
        troca_de_numero: { conta_anterior: 'PPG A', conta_atual: 'PPG B' }, mensagens: ['Oi', 'Nutrição'] }),
    }));
    expect(res.status).toBe(200);
    const falas = (await res.json()).transcript.filter((r: { quem: string }) => r.quem === 'joao');
    expect(falas).toHaveLength(2);
    expect(falas[0].texto).toContain('vou continuar seu atendimento por aqui');
    expect(falas[1].texto).not.toContain('outro número');
    expect(JSON.stringify(JSON.parse(mocks.fetch.mock.calls[1][1].body))).toContain('vou continuar seu atendimento por aqui');
    expect(JSON.stringify(JSON.parse(mocks.fetch.mock.calls[0][1].body))).toContain('Não escreva outro aviso');
  });
  it('principal OpenAI recebe a distinção entre a pós de Cannabis e o título profissional', async () => {
    mocks.fetch.mockImplementation(async (url: string) => {
      if (url !== 'https://api.openai.com/v1/responses') throw new Error('Transporte inesperado');
      return Response.json({ status: 'completed', model: 'modelo-openai-teste',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'o título depende do processo da AMEC-VET' }] }] });
    });
    const res = await handler(new Request('https://harness.invalid', {
      method: 'POST', headers: { 'x-followup-key': 'harness-local' },
      body: JSON.stringify({ persona: 'validacao', provedor: 'openai', ficha: true, nome_lead: 'Marina',
        curso: 'Cannabis Medicinal Veterinária', mensagens: ['Essa pós dá o título reconhecido pelo CFMV?'] }),
    }));
    expect(res.status).toBe(200);
    const pedido = JSON.stringify(JSON.parse(mocks.fetch.mock.calls[0][1].body));
    expect(pedido).toContain('AMEC-VET');
    expect(pedido).toContain('Concluir a pós da PPG não concede automaticamente');
  });
  it('aula do piloto recebe a mesma missão de conexão usada na produção', async () => {
    mocks.fetch.mockImplementation(async (url: string) => {
      if (url !== 'https://api.openai.com/v1/responses') throw new Error('Transporte inesperado');
      return Response.json({ status: 'completed', model: 'modelo-openai-teste',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'o que te chamou a atenção na nutrição de bovinos?' }] }] });
    });
    const res = await handler(new Request('https://harness.invalid', {
      method: 'POST', headers: { 'x-followup-key': 'harness-local' },
      body: JSON.stringify({ persona: 'aula', provedor: 'openai', ficha: true, nome_lead: 'Gustavo',
        curso: 'Reprodução, Nutrição e Gestão de Bovinos (3em1)', mensagens: ['Quero saber da aula'],
        aula: { titulo: 'Nutrição na prática', inicio_em: '2099-09-30T22:00:00Z', curso_nome: 'Reprodução, Nutrição e Gestão de Bovinos (3em1)' } }),
    }));
    expect(res.status).toBe(200);
    const pedido = JSON.parse(mocks.fetch.mock.calls[0][1].body);
    expect(JSON.stringify(pedido)).toContain('Condução do piloto de aulas');
    expect(JSON.stringify(pedido)).toContain('MISSÃO DA CAMPANHA');
    expect(JSON.stringify(pedido)).toContain('Nutrição na prática');
    expect(mocks.from.mock.calls.map(([tabela]) => tabela)).toEqual(['crm_agente_sdr_config', 'lista_tools_openai']);
  });
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
