import { beforeAll, describe, expect, it, vi } from 'vitest';

let ehAcaoV9: typeof import('./rotasV9').ehAcaoV9;
let rotaV9: typeof import('./rotasV9').rotaV9;
beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: () => '' } });
  ({ ehAcaoV9, rotaV9 } = await import('./rotasV9'));
});

describe('rotas do formato v9', () => {
  it('reconhece só as ações do v9', () => {
    expect(ehAcaoV9('lead')).toBe(true);
    expect(ehAcaoV9('iniciar')).toBe(false);
  });
  it('gravar_mensagem exige role; tool exige id e nome', async () => {
    const deps = { supabase: {}, provedorDoLead: async () => null };
    expect((await rotaV9('gravar_mensagem', { remotejid: '5546988166051@s.whatsapp.net', conversation_history: {} }, deps)).status).toBe(400);
    expect((await rotaV9('tool', { remotejid: '5546988166051@s.whatsapp.net', chamada: { name: 'x' } }, deps)).status).toBe(400);
  });
  it('luna recusa telefone fora do canário', async () => {
    const deps = { supabase: {}, provedorDoLead: async () => null };
    expect((await rotaV9('luna', { remotejid: '5546988166051@s.whatsapp.net', pedido: {} }, deps)).status).toBe(409);
  });
  it('a chamada principal do v9 usa o modelo e esforço da conversa', async () => {
    const fetchAnterior = globalThis.fetch;
    const transporte = vi.fn(async (_url: string, opts: RequestInit) => {
      const p = JSON.parse(String(opts.body));
      return Response.json({ model: p.model, status: 'completed', output: [] });
    });
    globalThis.fetch = transporte as typeof fetch;
    try {
      await rotaV9('luna', { remotejid: '5546988166051@s.whatsapp.net', pedido: { messages: [] } }, {
        supabase: {}, provedorDoLead: async () => ({ nome: 'openai', formato: 'openai',
          base: 'https://api.openai.com', chave: 'sintetica', modelo: 'gpt-6-luna', esforco: 'high',
          conversa: { modelo: 'gpt-6.1-terra', esforco: 'medium' } }),
      });
      expect(JSON.parse(String(transporte.mock.calls[0][1].body))).toMatchObject({
        model: 'gpt-6.1-terra', reasoning: { effort: 'medium' },
      });
    } finally { globalThis.fetch = fetchAnterior; }
  });
});

describe('contexto da aula no v9', () => {
  it('a régua de estudante da venda vira uma linha de dado', async () => {
    const { montarContextoTemporal } = await import('./contexto');
    const { blocoElegibilidadeFormatura } = await import('./elegibilidadeFormatura');
    expect(montarContextoTemporal()).toContain(blocoElegibilidadeFormatura());
  });
});

describe('busca_carreira', () => {
  it('a ferramenta oferece os perfis da tabela e exige um', async () => {
    const { TOOL_BUSCA_CARREIRA } = await import('./rotasV9');
    expect(TOOL_BUSCA_CARREIRA.input_schema.properties.perfil.enum).toContain('plantonista');
    expect(TOOL_BUSCA_CARREIRA.input_schema.required).toEqual(['perfil']);
    expect(ehAcaoV9('carreira')).toBe(true);
  });
});

describe('agente no n8n: telemetria e saída (12/11/2026)', () => {
  it('a chamada do modelo vira llm_chamada com os mesmos campos da produção', async () => {
    const { eventoLlmDoN8n, rodadaDoN8n } = await import('./rotasV9');
    const evento = eventoLlmDoN8n({
      model: 'gpt-5.6-luna', stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
      content: [{ type: 'text', text: 'oi' }, { type: 'tool_use', id: 't1', name: 'consulta_disponibilidade', input: {} }],
    }, { nome: 'openai', formato: 'openai' } as any, { agente: 'agente_validacao', volta: 2, execucao_n8n: 4812 });
    expect(evento).toMatchObject({
      agente_pelo_n8n: true, execucao_n8n: '4812', volta: 2, agente: 'agente_validacao', provedor: 'openai',
      modelo: 'gpt-5.6-luna', tokens_entrada: 100, tokens_saida: 20, cache_lido: 900,
      blocos: ['text', 'tool_use'], texto: 'oi', tools_decididas: ['consulta_disponibilidade'],
    });
    // Só um UUID de verdade agrupa a rodada; o número da execução do n8n não serve de rodada_id.
    expect(rodadaDoN8n({ rodada_id: '4812' })).toBeUndefined();
    expect(rodadaDoN8n({ rodada_id: '3f2b6c1e-8a4d-4c2b-9e1f-0a1b2c3d4e5f' })).toBe('3f2b6c1e-8a4d-4c2b-9e1f-0a1b2c3d4e5f');
  });
  it('fracionar é ação do v9 e recusa texto vazio', async () => {
    expect(ehAcaoV9('fracionar')).toBe(true);
    const deps = { supabase: {}, provedorDoLead: async () => null };
    expect((await rotaV9('fracionar', { remotejid: '5546988166051@s.whatsapp.net', texto: '   ' }, deps)).status).toBe(400);
  });
});
