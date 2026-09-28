import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { INICIO_HISTORICO_HUMANO, MARCADOR_FOLLOWUP, type Msg } from './historico';
import {
  carregarConfigRouterJev, decisaoPorLimiar, estadoParaJev, rotearComJev, type LeituraJev,
} from './routerJev';

beforeAll(() => vi.stubGlobal('Deno', { env: { get: () => '' } }));
afterAll(() => vi.unstubAllGlobals());

const historico: Msg[] = [
  { role: 'user', content: 'oi, quero saber da pós' },
  { role: 'assistant', content: 'pra hoje tenho 15h ou 16h. algum fica bom?' },
  { role: 'user', content: '16h' },
];

/** Transporte do Jev: responde com a probabilidade pedida e guarda o corpo enviado. */
function jevQueResponde(p: number) {
  const corpos: any[] = [];
  const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
    corpos.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({
      model: 'jev-1.13.0',
      answers: { agente: { type: 'choice', choice: p >= 0.5 ? 'horario_escolhido' : 'ainda_nao', confidence: Math.abs(2 * p - 1),
        probabilities: { horario_escolhido: p, ainda_nao: 1 - p } } },
      usage: { input_tokens: 420, output_tokens: 20 },
    }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, corpos };
}

describe('estadoParaJev', () => {
  it('rotula quem fala, tira marcadores e a nota, e mascara dado pessoal', () => {
    const nota = '[NOTA DO SISTEMA — troca de número]';
    const estado = estadoParaJev([
      { role: 'user', content: INICIO_HISTORICO_HUMANO },
      { role: 'assistant', content: '[ATENDIMENTO_HUMANO] Flávia · 2026-09-28 10:00 UTC\nme chama no 46 98816-6051' },
      { role: 'user', content: `${nota}\nmeu email é ana@exemplo.com, segue https://x.com/a` },
      { role: 'assistant', content: 'show' },
      { role: 'user', content: MARCADOR_FOLLOWUP },
    ], { nota });
    expect(estado.conversa).toEqual([
      { de: 'vendedor (humano da equipe)', texto: 'me chama no [NUMERO]' },
      { de: 'lead', texto: 'meu email é [EMAIL], segue [LINK]' },
      { de: 'sdr', texto: 'show' },
    ]);
    expect(estado.nota_do_sistema).toBe(nota);
  });

  it('manda só os últimos turnos e nunca um estado vazio', () => {
    const longo: Msg[] = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `fala ${i}` }));
    const estado = estadoParaJev(longo, { janela: 4 });
    expect(estado.conversa.map((t) => t.texto)).toEqual(['fala 26', 'fala 27', 'fala 28', 'fala 29']);
    expect(estadoParaJev([]).conversa).toEqual([{ de: 'lead', texto: '[início de conversa]' }]);
  });

  it('hora e data curtas não viram [NUMERO]', () => {
    const estado = estadoParaJev([{ role: 'user', content: 'pode ser 28/09 às 20:30 ou 9 10 11h' }]);
    expect(estado.conversa[0].texto).toBe('pode ser 28/09 às 20:30 ou 9 10 11h');
  });
});

describe('decisaoPorLimiar', () => {
  it('só decide nas pontas; o meio é incerto', () => {
    expect(decisaoPorLimiar(0.95, 0.9)).toBe('agente_qualificador');
    expect(decisaoPorLimiar(0.9, 0.9)).toBe('agente_qualificador');
    expect(decisaoPorLimiar(0.05, 0.9)).toBe('agente_validacao');
    expect(decisaoPorLimiar(0.64, 0.9)).toBe('incerto');
    expect(decisaoPorLimiar(0.15, 0.9)).toBe('incerto');
  });
});

describe('rotearComJev', () => {
  it('off, sem config ou sem chave: só o router de sempre', async () => {
    const { fetchFn } = jevQueResponde(1);
    const deSempre = vi.fn(async () => 'agente_validacao' as const);
    expect(await rotearComJev(historico, { modo: 'off', limiar: 0.9 }, deSempre, { chave: 'k', fetchFn })).toBe('agente_validacao');
    expect(await rotearComJev(historico, null, deSempre, { chave: 'k', fetchFn })).toBe('agente_validacao');
    expect(await rotearComJev(historico, { modo: 'ativo', limiar: 0.9 }, deSempre, { fetchFn })).toBe('agente_validacao');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(deSempre).toHaveBeenCalledTimes(3);
  });

  it('ativo e seguro: o Jev decide e o router de sempre nem é chamado', async () => {
    const { fetchFn, corpos } = jevQueResponde(0.99);
    const deSempre = vi.fn(async () => 'agente_validacao' as const);
    const leituras: LeituraJev[] = [];
    const r = await rotearComJev(historico, { modo: 'ativo', limiar: 0.9 }, deSempre, { chave: 'k', fetchFn, aoLerJev: (l) => leituras.push(l) });
    expect(r).toBe('agente_qualificador');
    expect(deSempre).not.toHaveBeenCalled();
    expect(leituras[0]).toMatchObject({ modo: 'ativo', p: 0.99, decisao: 'agente_qualificador', decidiu_sozinho: true, modelo: 'jev-1.13.0', tokens_entrada: 420 });
    expect(corpos[0]).toMatchObject({ model: 'jev-latest', questions: { agente: { type: 'choice' } } });
    expect(Object.keys(corpos[0].questions.agente.criteria)).toEqual(['horario_escolhido', 'ainda_nao']);
    expect(corpos[0].state.conversa.at(-1)).toEqual({ de: 'lead', texto: '16h' });
  });

  it('ativo e seguro do outro lado: validação sem chamar o router de sempre', async () => {
    const { fetchFn } = jevQueResponde(0.02);
    const deSempre = vi.fn(async () => 'agente_qualificador' as const);
    expect(await rotearComJev(historico, { modo: 'ativo', limiar: 0.9 }, deSempre, { chave: 'k', fetchFn })).toBe('agente_validacao');
    expect(deSempre).not.toHaveBeenCalled();
  });

  it('ativo e em dúvida: quem decide é o router de sempre', async () => {
    const { fetchFn } = jevQueResponde(0.64);
    const deSempre = vi.fn(async () => 'agente_qualificador' as const);
    const leituras: LeituraJev[] = [];
    const r = await rotearComJev(historico, { modo: 'ativo', limiar: 0.9 }, deSempre, { chave: 'k', fetchFn, aoLerJev: (l) => leituras.push(l) });
    expect(r).toBe('agente_qualificador');
    expect(deSempre).toHaveBeenCalledOnce();
    expect(leituras[0]).toMatchObject({ decisao: 'incerto', decidiu_sozinho: false });
  });

  it('ativo com o Jev fora do ar: cai no router de sempre e registra só o status', async () => {
    const fetchFn = vi.fn(async () => new Response('{"eco":"conversa inteira"}', { status: 529 })) as unknown as typeof fetch;
    const deSempre = vi.fn(async () => 'agente_validacao' as const);
    const leituras: LeituraJev[] = [];
    expect(await rotearComJev(historico, { modo: 'ativo', limiar: 0.9 }, deSempre, { chave: 'k', fetchFn, aoLerJev: (l) => leituras.push(l) })).toBe('agente_validacao');
    expect(leituras[0]).toMatchObject({ decisao: 'erro', p: null, erro: 'Jev: HTTP 529' });
  });

  it('ativo com o Jev lento: o prazo corta e o router de sempre responde', async () => {
    const fetchFn = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_, rejeitar) => {
      init.signal?.addEventListener('abort', () => rejeitar(new DOMException('abortado', 'AbortError')));
    })) as unknown as typeof fetch;
    const deSempre = vi.fn(async () => 'agente_validacao' as const);
    const leituras: LeituraJev[] = [];
    expect(await rotearComJev(historico, { modo: 'ativo', limiar: 0.9 }, deSempre, { chave: 'k', fetchFn, prazoMs: 20, aoLerJev: (l) => leituras.push(l) })).toBe('agente_validacao');
    expect(leituras[0].erro).toBe('Jev: sem resposta em 20 ms');
  });

  it('sombra: decide o router de sempre, o Jev só é registrado', async () => {
    const { fetchFn } = jevQueResponde(0.97);
    const deSempre = vi.fn(async () => 'agente_validacao' as const);
    const leituras: LeituraJev[] = [];
    const r = await rotearComJev(historico, { modo: 'sombra', limiar: 0.9 }, deSempre, { chave: 'k', fetchFn, aoLerJev: (l) => leituras.push(l) });
    expect(r).toBe('agente_validacao');
    expect(deSempre).toHaveBeenCalledOnce();
    expect(leituras[0]).toMatchObject({ modo: 'sombra', decisao: 'agente_qualificador', decidiu_sozinho: false });
  });

  it('sombra com o router de sempre falhando: o erro sobe e a leitura do Jev não se perde', async () => {
    const { fetchFn } = jevQueResponde(0.03);
    const leituras: LeituraJev[] = [];
    await expect(rotearComJev(historico, { modo: 'sombra', limiar: 0.9 }, async () => { throw new Error('Anthropic: HTTP 500'); },
      { chave: 'k', fetchFn, aoLerJev: (l) => leituras.push(l) })).rejects.toThrow('HTTP 500');
    expect(leituras[0]).toMatchObject({ decisao: 'agente_validacao', p: 0.03 });
  });
});

describe('carregarConfigRouterJev', () => {
  const banco = (data: unknown, error: unknown = null) => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error }) }) }) }),
  });

  it('lê modo e limiar; qualquer coisa estranha vira off', async () => {
    expect(await carregarConfigRouterJev(banco({ router_jev_modo: 'ativo', router_jev_limiar: 0.95 }))).toEqual({ modo: 'ativo', limiar: 0.95 });
    expect(await carregarConfigRouterJev(banco({ router_jev_modo: 'sombra', router_jev_limiar: 3 }))).toEqual({ modo: 'sombra', limiar: 0.9 });
    expect(await carregarConfigRouterJev(banco({ router_jev_modo: 'off', router_jev_limiar: 0.9 }))).toBeNull();
    expect(await carregarConfigRouterJev(banco(null, { message: 'column does not exist' }))).toBeNull();
    expect(await carregarConfigRouterJev({ from: () => { throw new Error('rede'); } })).toBeNull();
  });
});
