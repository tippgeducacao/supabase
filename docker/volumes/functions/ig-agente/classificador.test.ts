import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// A chamada ao modelo passa pelo tradutor do João (chamarAnthropic + provedorOpenai);
// aqui os dois são simulados — nenhuma requisição sai para a OpenAI ou a Anthropic.
const m = vi.hoisted(() => ({ chamar: vi.fn(), provedor: vi.fn() }));
vi.mock('../crm-agente-sdr/agente.ts', () => ({ chamarAnthropic: m.chamar, provedorOpenai: m.provedor }));

let mod: typeof import('./classificador');
beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: (k: string) => ({ AGENTE_SDR_MODEL: 'claude-sonnet-5' } as Record<string, string>)[k] } });
  mod = await import('./classificador');
});

const LUNA = { nome: 'openai', formato: 'openai', base: 'https://api.openai.com', chave: 'sk-sintetica', modelo: 'gpt-5.6-luna', esforco: 'high' };
const formulario = (input: Record<string, unknown>, model = 'gpt-5.6-luna') =>
  ({ model, content: [{ type: 'tool_use', name: 'classificar', id: 't1', input }] });
const ACEITA = { intencao: 'aceita', situacao: 'nao_informou', area: null, telefone: null, resposta_pergunta: null };

beforeEach(() => {
  vi.resetAllMocks();
  m.provedor.mockReturnValue(LUNA);
});

describe('normalizarClassificacao: só passa o que o formulário permite', () => {
  it('valores válidos passam', () => {
    expect(mod.normalizarClassificacao({
      intencao: 'aceita', situacao: 'formado', area: ' medicina veterinária ', telefone: '46 99988-2268', resposta_pergunta: null,
    })).toEqual({ intencao: 'aceita', situacao: 'formado', area: 'medicina veterinária', telefone: '46 99988-2268', resposta_pergunta: null });
  });

  it('valor fora da lista vira o neutro', () => {
    expect(mod.normalizarClassificacao({ intencao: 'talvez', situacao: 'doutor' }))
      .toMatchObject({ intencao: 'outro', situacao: 'nao_informou' });
    expect(mod.normalizarClassificacao(null)).toEqual(mod.CLASSIFICACAO_NEUTRA);
  });

  it('resposta a pergunta só existe quando a intenção é pergunta', () => {
    expect(mod.normalizarClassificacao({ intencao: 'aceita', resposta_pergunta: 'texto solto' }).resposta_pergunta).toBeNull();
    expect(mod.normalizarClassificacao({ intencao: 'pergunta', resposta_pergunta: 'É gratuita!' }).resposta_pergunta).toBe('É gratuita!');
  });
});

describe('classificar: Luna 5.6 primeiro', () => {
  it('manda para a Luna com a tool forçada, sem raciocínio e com prazo de 15 s', async () => {
    m.chamar.mockResolvedValue(formulario(ACEITA));
    const r = await mod.classificar('boas_vindas', [{ role: 'assistant', text: 'Quer receber o acesso?' }], ['quero!']);
    expect(r).toEqual({ classificacao: expect.objectContaining({ intencao: 'aceita' }), erro: null, modelo: 'gpt-5.6-luna' });

    expect(m.chamar).toHaveBeenCalledTimes(1);
    const [pedido, , provedor, prazo] = m.chamar.mock.calls[0];
    expect(provedor).toBe(LUNA);
    expect(prazo).toBe(15_000);
    expect(pedido.tool_choice).toEqual({ type: 'tool', name: 'classificar', disable_parallel_tool_use: true });
    expect(pedido.thinking).toEqual({ type: 'disabled' });
    expect(pedido.system).toContain('mais de 10 cursos');
    expect(pedido.messages[0].content).toContain('PPGVET: Quer receber o acesso?');
    expect(pedido.messages[0].content).toContain('- quero!');
  });

  it('Luna fora do ar → o Claude classifica, e o erro da Luna fica registrado', async () => {
    m.chamar
      .mockRejectedValueOnce(new Error('OpenAI: HTTP 503'))
      .mockResolvedValueOnce(formulario(ACEITA, 'claude-sonnet-5'));
    const r = await mod.classificar('boas_vindas', [], ['quero']);
    expect(r.modelo).toBe('claude-sonnet-5');
    expect(r.classificacao.intencao).toBe('aceita');
    expect(r.erro).toContain('Luna: OpenAI: HTTP 503');
    expect(m.chamar.mock.calls[1][2]).toBeNull(); // provedor null = Anthropic
    expect(m.chamar.mock.calls[1][3]).toBe(12_000);
  });

  it('Luna respondeu sem preencher o formulário → Claude', async () => {
    m.chamar
      .mockResolvedValueOnce({ model: 'gpt-5.6-luna', content: [{ type: 'text', text: 'oi' }] })
      .mockResolvedValueOnce(formulario(ACEITA, 'claude-sonnet-5'));
    const r = await mod.classificar('boas_vindas', [], ['quero']);
    expect(r.modelo).toBe('claude-sonnet-5');
    expect(r.erro).toContain('Luna: não preencheu o formulário');
  });

  it('sem chave da OpenAI → vai direto no Claude e avisa', async () => {
    m.provedor.mockReturnValue(null);
    m.chamar.mockResolvedValue(formulario(ACEITA, 'claude-sonnet-5'));
    const r = await mod.classificar('boas_vindas', [], ['quero']);
    expect(m.chamar).toHaveBeenCalledTimes(1);
    expect(m.chamar.mock.calls[0][2]).toBeNull();
    expect(r).toMatchObject({ modelo: 'claude-sonnet-5', erro: 'Luna: sem AGENTE_SDR_OPENAI_KEY' });
  });

  it('os dois falharam → classificação neutra, sem lançar', async () => {
    m.chamar.mockRejectedValue(new Error('MODELO_TEMPO_ESGOTADO'));
    const r = await mod.classificar('pergunta_formacao', [], ['sou vet']);
    expect(r.classificacao).toEqual(mod.CLASSIFICACAO_NEUTRA);
    expect(r.modelo).toBeNull();
    expect(r.erro).toContain('Luna: MODELO_TEMPO_ESGOTADO');
    expect(r.erro).toContain('Claude: MODELO_TEMPO_ESGOTADO');
  });
});
