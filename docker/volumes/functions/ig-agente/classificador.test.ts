import { beforeAll, describe, expect, it, vi } from 'vitest';

let mod: typeof import('./classificador');
beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: (k: string) => ({ AGENTE_SDR_ANTHROPIC_KEY: 'chave-sintetica' } as Record<string, string>)[k] } });
  mod = await import('./classificador');
});

const resposta = (content: unknown[], status = 200) =>
  vi.fn().mockResolvedValue(new Response(JSON.stringify({ content }), { status }));
const usoTool = (input: Record<string, unknown>) => ({ type: 'tool_use', name: 'classificar', id: 't1', input });

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

describe('classificar', () => {
  it('força a tool, desliga o thinking e manda a conversa com as mensagens novas', async () => {
    const f = resposta([usoTool({ intencao: 'aceita', situacao: 'nao_informou', area: null, telefone: null, resposta_pergunta: null })]);
    const r = await mod.classificar('boas_vindas', [{ role: 'assistant', text: 'Quer receber o acesso?' }], ['quero!'], f as unknown as typeof fetch);
    expect(r).toEqual({ classificacao: expect.objectContaining({ intencao: 'aceita' }), erro: null });
    const pedido = JSON.parse(f.mock.calls[0][1].body);
    expect(pedido.tool_choice).toEqual({ type: 'tool', name: 'classificar', disable_parallel_tool_use: true });
    expect(pedido.thinking).toEqual({ type: 'disabled' });
    expect(pedido.messages[0].content).toContain('PPGVET: Quer receber o acesso?');
    expect(pedido.messages[0].content).toContain('- quero!');
    expect(pedido.system).toContain('mais de 10 cursos');
  });

  it.each([
    ['erro HTTP', () => resposta([], 529)],
    ['modelo não preencheu', () => resposta([{ type: 'text', text: 'oi' }])],
    ['rede caiu', () => vi.fn().mockRejectedValue(new Error('timeout'))],
  ])('%s → classificação neutra com o erro, sem lançar', async (_caso, criar) => {
    const r = await mod.classificar('pergunta_formacao', [], ['sou vet'], criar() as unknown as typeof fetch);
    expect(r.classificacao).toEqual(mod.CLASSIFICACAO_NEUTRA);
    expect(r.erro).toBeTruthy();
  });
});
