import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  avaliarCanalResposta, limparTagsDoCanal, NOME_TOOL_RESPOSTA, normalizarRespostaCanal,
  somarUsoModelo, TOOL_RESPONDER_AO_CLIENTE,
} from './canalResposta';
import type { Msg } from './historico';

const texto = (text: string) => ({ type: 'text', text });
const final = (mensagem = 'Como posso te ajudar?') => ({
  type: 'tool_use', id: 'resposta-local', name: NOME_TOOL_RESPOSTA, input: { mensagem },
});
const pausa = { type: 'tool_use', id: 'pausa-1', name: 'pausa_ia', input: { motivo: 'recusa' } };
const pensamento = { type: 'thinking', thinking: 'ANÁLISE INTERNA SINTÉTICA', signature: 'assinatura-preservada' };
const modelo = (content: unknown, stop_reason = 'tool_use') => ({
  model: 'modelo-sintetico', content, stop_reason,
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, output_tokens_details: { thinking_tokens: 2 } },
});
const transporte = vi.fn();
let chamarAgentePrincipal: typeof import('./agente').chamarAgentePrincipal;
let contemBastidor: (mensagem: string) => boolean;

beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: (chave: string) => chave === 'AGENTE_SDR_MODEL' ? 'modelo-sintetico' : '' } });
  vi.stubGlobal('fetch', transporte);
  ({ chamarAgentePrincipal } = await import('./agente'));
  const { contemMeta, contemRaciocinioVazado } = await import('./saida');
  contemBastidor = (mensagem) => contemMeta(mensagem) || contemRaciocinioVazado(mensagem);
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => { transporte.mockReset(); });

const entrada = () => ({
  promptAgente: 'Prompt sintético', contextoTemporal: 'Data sintética',
  messages: [{ role: 'user', content: 'Pode retirar' }] as Msg[],
  tools: [{ name: 'pausa_ia', input_schema: { type: 'object', properties: {} } }],
});
function responder(...respostas: ReturnType<typeof modelo>[]) {
  for (const resposta of respostas) transporte.mockResolvedValueOnce(new Response(JSON.stringify(resposta), { status: 200 }));
}
function pedido(indice = 0) {
  return JSON.parse(String((transporte.mock.calls[indice][1] as RequestInit).body));
}

describe('fronteira entre raciocínio, ações e mensagem ao cliente', () => {
  it('publica exclusivamente o campo validado, descartando preâmbulo e thinking', async () => {
    responder(modelo([pensamento, texto('Já foi feita a pergunta de retenção. Isso conta como reiteração do não.'), final('Tudo bem, vou respeitar sua decisão.')]));
    const resposta = await chamarAgentePrincipal(entrada());
    expect(resposta.content).toEqual([texto('Tudo bem, vou respeitar sua decisão.')]);
    expect(resposta.stop_reason).toBe('end_turn');
    expect(resposta.canal_resposta).toEqual({ motivo: 'resposta_validada', stop_reason_modelo: 'tool_use' });
    expect(JSON.stringify(resposta.content)).not.toMatch(/ANÁLISE|retenção|tool_use|assinatura/);
    expect(transporte).toHaveBeenCalledTimes(1);
  });

  it('silêncio precisa ser explícito e não cria um bloco de texto vazio', async () => {
    responder(modelo([texto('Nenhuma resposta necessária.'), final(' \n ')]));
    expect(await chamarAgentePrincipal(entrada())).toMatchObject({
      content: [], stop_reason: 'end_turn', canal_resposta: { motivo: 'silencio_explicito' },
    });
    expect(transporte).toHaveBeenCalledTimes(1);
  });

  it('preserva os pares de negócio e a assinatura, sem persistir a resposta concorrente', async () => {
    const bruto = modelo([pensamento, texto('PREÂMBULO INTERNO'), final('Já está tudo resolvido.'), pausa]);
    const copia = structuredClone(bruto);
    responder(bruto);
    const resposta = await chamarAgentePrincipal(entrada());
    expect(resposta.content).toEqual([pensamento, pausa]);
    expect(resposta.stop_reason).toBe('tool_use');
    expect(resposta.canal_resposta.motivo).toBe('resposta_concorrente_descartada');
    expect(bruto).toEqual(copia);
    expect(transporte).toHaveBeenCalledTimes(1);
  });

  it('não permite repetir pausa do histórico quando a chamada só oferece resposta final', async () => {
    const opts = {
      ...entrada(), tools: [],
      messages: [
        { role: 'user', content: 'Pode retirar' },
        { role: 'assistant', content: [pausa] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: pausa.id, content: 'Atendimento pausado.' }] },
      ] as Msg[],
    };
    responder(modelo([pausa, final('Seu atendimento foi encerrado.')]));
    expect(await chamarAgentePrincipal(opts)).toMatchObject({
      content: [], canal_resposta: { motivo: 'ferramenta_nao_disponivel' },
    });
    expect(pedido().tools.map((tool: { name: string }) => tool.name)).toEqual([NOME_TOOL_RESPOSTA]);
    expect(transporte).toHaveBeenCalledTimes(1);
  });

  it('bloqueia o lote inteiro se incluir uma ferramenta não oferecida nesta chamada', async () => {
    const indevida = { type: 'tool_use', id: 'envio-indevido', name: 'envia_informacoes', input: {} };
    responder(modelo([pensamento, pausa, indevida, final('Tudo resolvido.')]));
    expect(await chamarAgentePrincipal(entrada())).toMatchObject({
      content: [], canal_resposta: { motivo: 'ferramenta_nao_disponivel' },
    });
    expect(transporte).toHaveBeenCalledTimes(1);
  });

  it('cadeia da Luna: o raciocínio cifrado fica com a tool de negócio; o canal concorrente sai', () => {
    const raciocinio = { type: 'raciocinio_openai', segue: 'fc_1', item: { type: 'reasoning', id: 'rs_1' } };
    const decisao = avaliarCanalResposta(modelo([raciocinio, { ...pausa, openai_id: 'fc_1' }, final()]), () => false, false, new Set(['pausa_ia']));
    expect(decisao).toEqual({ tipo: 'tools', content: [raciocinio, { ...pausa, openai_id: 'fc_1' }], motivo: 'resposta_concorrente_descartada' });
  });

  it('preserva uma ação oferecida normalmente sem exigir tool de resposta no mesmo turno', async () => {
    responder(modelo([pensamento, pausa]));
    expect(await chamarAgentePrincipal(entrada())).toMatchObject({
      content: [pensamento, pausa], stop_reason: 'tool_use', canal_resposta: { motivo: 'ferramentas_de_negocio' },
    });
    expect(transporte).toHaveBeenCalledTimes(1);
  });

  it.each(['max_tokens', 'pause_turn', 'refusal', 'stop_sequence', '', undefined])(
    'bloqueia parcial mesmo com canal válido quando stop_reason=%s', async (motivo) => {
      responder({ ...modelo([texto('PARCIAL'), final(), pausa]), stop_reason: motivo as string });
      expect(await chamarAgentePrincipal(entrada())).toMatchObject({
        content: [], canal_resposta: { motivo: 'geracao_nao_concluida' },
      });
      expect(transporte).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['texto sem canal', [texto('RESPOSTA LIVRE QUE NÃO DEVE SER PUBLICADA')], 'end_turn'],
    ['duas respostas', [final('Um'), { ...final('Dois'), id: 'final-2' }], 'tool_use'],
    ['mensagem não string', [{ ...final(), input: { mensagem: 7 } }], 'tool_use'],
    ['campo adicional', [{ ...final(), input: { mensagem: 'Olá', pensamento: 'INTERNO' } }], 'tool_use'],
    ['JSON em string', [{ ...final(), input: '{"mensagem":"Olá"}' }], 'tool_use'],
    ['id ausente', [{ ...final(), id: undefined }], 'tool_use'],
    ['conteúdo malformado', null, 'tool_use'],
    ['tool sem stop correto', [final()], 'end_turn'],
    ['raciocínio com tag', [final('<thinking>ANÁLISE INTERNA</thinking> Olá!')], 'tool_use'],
    ['raciocínio truncado', [final('<thinking')], 'tool_use'],
    ['meta dentro do campo', [final('O lead reiterou a recusa. Tudo bem, vou respeitar sua decisão.')], 'tool_use'],
    ['relato do caso Adriana', [final('Já foi feita a pergunta de retenção antes e ele confirmou o retirar. Isso conta como retenção explícita e reiteração do não. Antes de te deixar ir: a ppgvet tem uma biblioteca de conteúdo aberta e totalmente gratuita.')], 'tool_use'],
  ])('corrige uma vez: %s', async (_caso, content, motivo) => {
    responder(modelo(content, motivo), modelo([final('Olá, pode contar comigo.')]));
    const opts = entrada();
    const copia = structuredClone(opts);
    const resposta = await chamarAgentePrincipal(opts);
    expect(resposta.content).toEqual([texto('Olá, pode contar comigo.')]);
    expect(transporte).toHaveBeenCalledTimes(2);
    // Prefixo de cache: tools idênticas e o system original intacto antes do bloco extra.
    expect(pedido(1).tools).toEqual(pedido(0).tools);
    expect(pedido(1).system.slice(0, pedido(0).system.length)).toEqual(pedido(0).system);
    expect(pedido(1).system).toHaveLength(pedido(0).system.length + 1);
    expect(pedido(1).tool_choice).toEqual({ type: 'tool', name: NOME_TOOL_RESPOSTA, disable_parallel_tool_use: true });
    expect(pedido(1).thinking).toEqual({ type: 'disabled' });
    expect(pedido(1).messages).toEqual(pedido(0).messages);
    expect(pedido(1).model).toBe(pedido(0).model);
    expect(JSON.stringify(pedido(1))).not.toMatch(/RESPOSTA LIVRE|ANÁLISE INTERNA|O lead reiterou/);
    expect(opts).toEqual(copia);
    expect(resposta.usage).toEqual({
      input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 6, output_tokens_details: { thinking_tokens: 4 },
    });
  });

  it.each([
    ['texto livre reincidente', modelo([texto('INTERNO REINCIDENTE')], 'end_turn')],
    ['meta reincidente', modelo([final('O lead reiterou a recusa.')])],
    ['negócio indevido', modelo([pausa, final('Já pausei.')])],
    ['parcial reincidente', modelo([final('PARCIAL')], 'max_tokens')],
  ])('falha fechada, sem terceira geração nem efeitos na correção: %s', async (_caso, reincidencia) => {
    responder(modelo([texto('PRIMEIRA ANÁLISE')], 'end_turn'), reincidencia);
    const resposta = await chamarAgentePrincipal(entrada());
    expect(resposta.content).toEqual([]);
    expect(resposta.stop_reason).toBe('end_turn');
    expect(JSON.stringify(resposta)).not.toMatch(/INTERNO|PRIMEIRA|Já pausei|PARCIAL|recusa/);
    expect(transporte).toHaveBeenCalledTimes(2);
  });

  it('não expõe corpo de erro nem texto rejeitado quando a correção falha', async () => {
    responder(modelo([texto('TEXTO REJEITADO')], 'end_turn'));
    transporte.mockResolvedValueOnce(new Response('erro sintético com contexto interno', { status: 400 }));
    const resposta = await chamarAgentePrincipal(entrada());
    expect(resposta).toMatchObject({ content: [], canal_resposta: { motivo: 'falha_na_correcao', motivo_correcao: 'texto_sem_canal' } });
    expect(JSON.stringify(resposta)).not.toMatch(/TEXTO REJEITADO|contexto interno/);
    expect(transporte).toHaveBeenCalledTimes(2);
  });

  it('correção mantém o catálogo no pedido (cache) e nunca devolve ferramenta de negócio', async () => {
    const negocio = { type: 'tool_use', id: 'negocio-1', name: 'pausa_ia', input: {} };
    responder(modelo([texto('TEXTO SEM CANAL')], 'end_turn'), modelo([negocio]));
    const resposta = await chamarAgentePrincipal({ ...entrada(), tools: [{ name: 'pausa_ia' }] });
    expect(pedido(1).tools).toEqual([{ name: 'pausa_ia' }, { ...TOOL_RESPONDER_AO_CLIENTE, cache_control: { type: 'ephemeral' } }]);
    expect(pedido(1).tools).toEqual(pedido(0).tools);
    expect(pedido(1).tool_choice).toEqual({ type: 'tool', name: NOME_TOOL_RESPOSTA, disable_parallel_tool_use: true });
    expect((resposta.content ?? []).some((bloco: { type: string }) => bloco.type === 'tool_use')).toBe(false);
  });

  it('substitui homônima do catálogo e limita o cache sem mutar o chamador', async () => {
    responder(modelo([final()]));
    const opts = {
      ...entrada(),
      tools: [
        { name: 'pausa_ia', cache_control: { type: 'ephemeral' } },
        { name: NOME_TOOL_RESPOSTA, input_schema: { type: 'string' }, cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        { role: 'user', content: [{ ...texto('Oi'), cache_control: { type: 'ephemeral' } }] },
        { role: 'assistant', content: [{ ...texto('Olá'), cache_control: { type: 'ephemeral' } }] },
        { role: 'user', content: [{ ...texto('Tudo bem'), cache_control: { type: 'ephemeral' } }] },
      ] as Msg[],
    };
    const copia = structuredClone(opts);
    await chamarAgentePrincipal(opts);
    expect(pedido().tools).toEqual([{ name: 'pausa_ia' }, { ...TOOL_RESPONDER_AO_CLIENTE, cache_control: { type: 'ephemeral' } }]);
    expect(JSON.stringify(pedido()).match(/"cache_control"/g)).toHaveLength(3);
    expect(pedido().thinking).toEqual({ type: 'adaptive' });
    expect(opts).toEqual(copia);
  });
});

describe('provedor é argumento da chamada, nunca estado global', () => {
  const deepseek = { nome: 'deepseek', formato: 'anthropic' as const, base: 'https://api.deepseek.com/anthropic', chave: 'chave-sintetica' };

  it('sem provedor a chamada vai para a Anthropic; com ele, muda só base e chave', async () => {
    responder(modelo([final()]), modelo([final()]));
    await chamarAgentePrincipal(entrada());
    expect(transporte.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages');
    await chamarAgentePrincipal({ ...entrada(), provedor: deepseek });
    expect(transporte.mock.calls[1][0]).toBe('https://api.deepseek.com/anthropic/v1/messages');
    expect((transporte.mock.calls[1][1] as RequestInit).headers).toMatchObject({ 'x-api-key': 'chave-sintetica' });
    expect(pedido(1)).toEqual(pedido(0));
  });

  it('dois leads ao mesmo tempo, cada um no seu provedor: uma chamada não contamina a outra', async () => {
    responder(modelo([final()]), modelo([final()]), modelo([final()]));
    await Promise.all([
      chamarAgentePrincipal({ ...entrada(), provedor: deepseek }),
      chamarAgentePrincipal(entrada()),
    ]);
    await chamarAgentePrincipal(entrada());
    const urls = transporte.mock.calls.map(([url]) => url).sort();
    expect(urls).toEqual([
      'https://api.anthropic.com/v1/messages', 'https://api.anthropic.com/v1/messages',
      'https://api.deepseek.com/anthropic/v1/messages',
    ]);
  });

  it('a correção do canal sai pelo MESMO provedor da chamada original', async () => {
    responder(modelo([texto('TEXTO SEM CANAL')], 'end_turn'), modelo([final('Olá')]));
    await chamarAgentePrincipal({ ...entrada(), provedor: deepseek });
    expect(transporte.mock.calls.map(([url]) => url)).toEqual([
      'https://api.deepseek.com/anthropic/v1/messages', 'https://api.deepseek.com/anthropic/v1/messages',
    ]);
  });
});

describe('normalização defensiva do contrato', () => {
  it('remove campos arbitrários e contabiliza apenas números finitos de uso', () => {
    const bruto = { ...modelo([final()]), pensamento: 'PRIVADO' };
    expect(normalizarRespostaCanal(bruto, avaliarCanalResposta(bruto, () => false))).not.toHaveProperty('pensamento');
    expect(somarUsoModelo({ input_tokens: 3, pensamento: 'PRIVADO', output_tokens: NaN }, { input_tokens: 5 })).toEqual({ input_tokens: 8 });
  });
});

// 15-16/09/2026: 21 mensagens a 17 leads saíram com "</mensagem>" no fim (caso Andressa).
describe('rótulo da tool vazando no campo mensagem', () => {
  it('remove </mensagem> e variantes, sem tocar em texto legítimo', () => {
    expect(limparTagsDoCanal('me confirma que já procuro um encaixe pra hj?</mensagem>')).toBe('me confirma que já procuro um encaixe pra hj?');
    expect(limparTagsDoCanal('<mensagem>oi</ mensagem >')).toBe('oi');
    expect(limparTagsDoCanal('</MENSAGEM>\n')).toBe('');
    expect(limparTagsDoCanal('a mensagem chegou? me avisa')).toBe('a mensagem chegou? me avisa');
  });
  it('o canal entrega a fala limpa e trata só a tag como silêncio', () => {
    expect(avaliarCanalResposta(modelo([final('me confirma que topa?</mensagem>')]), () => false))
      .toEqual({ tipo: 'resposta', mensagem: 'me confirma que topa?', motivo: 'resposta_validada' });
    expect(avaliarCanalResposta(modelo([final('</mensagem>')]), () => false))
      .toEqual({ tipo: 'resposta', mensagem: '', motivo: 'silencio_explicito' });
  });
});
