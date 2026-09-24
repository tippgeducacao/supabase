import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProvedorIA } from './agente';
import { carregarHistorico, gravarMensagem, sanitizarHistorico, type Msg } from './historico';
import { registrarRaciocinio, type MemoriaRaciocinio } from './provedorOpenai';

// Exercita o adaptador e a persistência reais. As únicas fronteiras simuladas são
// fetch e o banco: não há executor de negócio nem transporte de WhatsApp neste teste.
const transporte = vi.fn<typeof fetch>();
let chamarAnthropic: typeof import('./agente').chamarAnthropic;
let chamarAgentePrincipal: typeof import('./agente').chamarAgentePrincipal;
type Luna = Extract<ProvedorIA, { formato: 'openai' }>;
const luna = (alteracoes: Partial<Luna> = {}): Luna => ({
  nome: 'openai', formato: 'openai', base: 'https://openai.invalid', chave: 'chave-sintetica',
  modelo: 'gpt-5.6-luna', esforco: 'high', ...alteracoes,
});
const item = {
  type: 'reasoning' as const, id: 'rs_sintetico', summary: [], encrypted_content: 'CIFRADO_SOMENTE_EM_MEMORIA',
};
const consulta = { type: 'tool_use', id: 'call_consulta', name: 'consulta_disponibilidade', input: { data: '2026-09-25' } };
const cadastro = { type: 'tool_use', id: 'call_cadastro', name: 'atualizar_dados_lead', input: { formacao: 'Medicina Veterinária' } };
const privado = /raciocinio_openai|openai_id|encrypted_content|CIFRADO_SOMENTE_EM_MEMORIA|rs_sintetico|fc_consulta|fc_cadastro/;
const tools = [consulta, cadastro].map(({ name }) => ({ name, input_schema: { type: 'object', properties: {} } }));
const mensagemInicial: Msg = { role: 'user', content: 'Sou formada em Medicina Veterinária e quero um horário amanhã' };
const resultados: Msg = { role: 'user', content: [
  { type: 'tool_result', tool_use_id: consulta.id, content: 'Horário disponível em 25/09 às 10h' },
  { type: 'tool_result', tool_use_id: cadastro.id, content: 'Cadastro atualizado' },
] };
// Capturado executando paraPedidoOpenai da revisão c768bf4223e57e20264bcf0e8568ec317b5a1e04
// com pedido(historicoComTools()). Literal independente: uma mudança no tradutor não
// pode modificar ao mesmo tempo a implementação e o esperado desta regressão.
const POST_DESLIGADO_ANTES_DA_MEMORIA = String.raw`{"model":"gpt-5.6-luna","store":false,"input":[{"role":"user","content":"Sou formada em Medicina Veterinária e quero um horário amanhã"},{"type":"function_call","call_id":"call_consulta","name":"consulta_disponibilidade","arguments":"{\"data\":\"2026-09-25\"}"},{"type":"function_call","call_id":"call_cadastro","name":"atualizar_dados_lead","arguments":"{\"formacao\":\"Medicina Veterinária\"}"},{"type":"function_call_output","call_id":"call_consulta","output":"Horário disponível em 25/09 às 10h"},{"type":"function_call_output","call_id":"call_cadastro","output":"Cadastro atualizado"}],"max_output_tokens":8192,"reasoning":{"effort":"high"},"instructions":"Prompt sintético","tools":[{"type":"function","name":"consulta_disponibilidade","description":"","parameters":{"type":"object","properties":{}},"strict":false},{"type":"function","name":"atualizar_dados_lead","description":"","parameters":{"type":"object","properties":{}},"strict":false}]}`;

beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: () => '' } });
  vi.stubGlobal('fetch', transporte);
  ({ chamarAnthropic, chamarAgentePrincipal } = await import('./agente'));
});
beforeEach(() => transporte.mockReset());
afterAll(() => vi.unstubAllGlobals());

function responder(output: unknown[]) {
  transporte.mockResolvedValueOnce(Response.json({
    id: 'resp_sintetica', model: 'gpt-5.6-luna', status: 'completed', output,
    usage: { input_tokens: 50, output_tokens: 20, output_tokens_details: { reasoning_tokens: 10 } },
  }));
}
function responderTools() {
  responder([item,
    { type: 'function_call', id: 'fc_consulta', call_id: consulta.id, name: consulta.name, arguments: JSON.stringify(consulta.input) },
    { type: 'function_call', id: 'fc_cadastro', call_id: cadastro.id, name: cadastro.name, arguments: JSON.stringify(cadastro.input) },
  ]);
}
function responderCanal() {
  responder([{ type: 'function_call', id: 'fc_resposta', call_id: 'call_resposta', name: 'responder_ao_cliente',
    arguments: JSON.stringify({ mensagem: 'Tenho amanhã às 10h, fica bom para você?' }) }]);
}
const pedidoEnviado = (indice: number) => JSON.parse(String(transporte.mock.calls[indice][1]?.body));
const pedido = (messages: Msg[]) => ({
  model: 'claude-sonnet-5', max_tokens: 8192, thinking: { type: 'adaptive' },
  system: [{ type: 'text', text: 'Prompt sintético', cache_control: { type: 'ephemeral' } }],
  tools, messages,
});
const principal = (messages: Msg[], provedor: ProvedorIA) => ({
  promptAgente: 'Prompt sintético', contextoTemporal: '', tools, messages, provedor,
});
function memoriaDaCadeia(): MemoriaRaciocinio {
  const memoria: MemoriaRaciocinio = new Map();
  registrarRaciocinio(memoria, { output: [
    structuredClone(item),
    { type: 'function_call', id: 'fc_consulta', call_id: consulta.id, name: consulta.name, arguments: JSON.stringify(consulta.input) },
    { type: 'function_call', id: 'fc_cadastro', call_id: cadastro.id, name: cadastro.name, arguments: JSON.stringify(cadastro.input) },
  ] });
  return memoria;
}
const historicoComTools = (): Msg[] => structuredClone([
  mensagemInicial, { role: 'assistant', content: [consulta, cadastro] }, resultados,
]);
function congelar<T>(valor: T): T {
  if (valor && typeof valor === 'object') {
    for (const filho of Object.values(valor)) congelar(filho);
    Object.freeze(valor);
  }
  return valor;
}
function bancoEmMemoria() {
  const linhas: { id: number; remotejid: string; conversation_history: Msg; timestamp: string }[] = [];
  const insert = vi.fn(async (linha) => {
    // O round trip JSON reproduz a perda das referências da rodada ao persistir.
    linhas.push({ id: linhas.length + 1, ...JSON.parse(JSON.stringify(linha)) });
    return { error: null };
  });
  const from = vi.fn((tabela: string) => {
    expect(tabela).toBe('cliente_ppg_mensagens_sdr');
    const query = {
      select: vi.fn(() => query), eq: vi.fn(() => query), order: vi.fn(() => query),
      limit: vi.fn(async () => ({ data: structuredClone(linhas), error: null })), insert,
    };
    return query;
  });
  return { supabase: { from }, insert, linhas };
}

describe('raciocínio em memória na chamada real do agente', () => {
  it.each(['opção ausente', 'opção false com memória preenchida'])(
    '%s conserva o POST byte a byte do tradutor anterior', async (caso) => {
      const memoria = memoriaDaCadeia();
      const provedor = luna(caso === 'opção ausente' ? {} : { raciocinio: false, memoriaRaciocinio: memoria });
      const body = congelar(pedido(historicoComTools()));
      const esperado = POST_DESLIGADO_ANTES_DA_MEMORIA;
      const memoriaAntes = structuredClone(memoria);
      responderTools();

      const resposta = await chamarAnthropic(body, {}, provedor);

      expect(transporte.mock.calls[0][1]?.body).toBe(esperado);
      expect(esperado).not.toMatch(privado);
      expect(esperado).not.toContain('reasoning.encrypted_content');
      expect(resposta.content).toEqual([consulta, cadastro]);
      expect(memoria).toEqual(memoriaAntes);
      expect(transporte).toHaveBeenCalledOnce();
    },
  );

  it('persiste tools limpas e reinsere a cadeia somente no POST seguinte após reler o banco', async () => {
    const provedor = luna({ raciocinio: true, memoriaRaciocinio: new Map() });
    const { supabase, insert, linhas } = bancoEmMemoria();
    const remotejid = 'lead-sintetico@s.whatsapp.net';
    const messages = congelar([structuredClone(mensagemInicial)]);
    const inicialAntes = JSON.stringify(messages);
    responderTools();
    responderCanal();

    const primeira = await chamarAgentePrincipal(principal(messages, provedor));
    expect(primeira.content).toEqual([consulta, cadastro]);
    expect(primeira).toMatchObject({ raciocinio_encadeado: true, raciocinios_reenviados: 0 });
    expect(JSON.stringify(primeira)).not.toMatch(privado);
    await gravarMensagem(supabase, remotejid, mensagemInicial);
    await gravarMensagem(supabase, remotejid, { role: 'assistant', content: primeira.content });
    await gravarMensagem(supabase, remotejid, resultados);
    const recarregado = congelar(sanitizarHistorico(await carregarHistorico(supabase, remotejid)));
    const recarregadoAntes = JSON.stringify(recarregado);

    const segunda = await chamarAgentePrincipal(principal(recarregado, provedor));
    await gravarMensagem(supabase, remotejid, { role: 'assistant', content: segunda.content });

    const enviado = pedidoEnviado(1);
    const indiceRaciocinio = enviado.input.findIndex((bloco: { type?: string }) => bloco.type === 'reasoning');
    expect(enviado.input.slice(indiceRaciocinio, indiceRaciocinio + 3)).toEqual([
      item,
      { type: 'function_call', id: 'fc_consulta', call_id: consulta.id, name: consulta.name, arguments: JSON.stringify(consulta.input) },
      { type: 'function_call', id: 'fc_cadastro', call_id: cadastro.id, name: cadastro.name, arguments: JSON.stringify(cadastro.input) },
    ]);
    expect(enviado.input.filter((bloco: { type?: string }) => bloco.type === 'function_call_output')).toHaveLength(2);
    expect(segunda).toMatchObject({ raciocinio_encadeado: true, raciocinios_reenviados: 1,
      content: [{ type: 'text', text: 'Tenho amanhã às 10h, fica bom para você?' }] });
    expect(JSON.stringify(segunda)).not.toMatch(privado);
    expect(JSON.stringify(insert.mock.calls)).not.toMatch(privado);
    expect(JSON.stringify(linhas)).not.toMatch(privado);
    expect(JSON.stringify(messages)).toBe(inicialAntes);
    expect(JSON.stringify(recarregado)).toBe(recarregadoAntes);
    expect(transporte).toHaveBeenCalledTimes(2);
  });

  it('nova rodada não reconstrói raciocínio das tools antigas do mesmo histórico', async () => {
    const messages = congelar(historicoComTools());
    const anterior = luna({ raciocinio: true, memoriaRaciocinio: memoriaDaCadeia() });
    const nova = luna({ raciocinio: true, memoriaRaciocinio: new Map() });
    responderCanal();
    responderCanal();

    await chamarAnthropic(pedido(messages), {}, anterior);
    const respostaNova = await chamarAnthropic(pedido(messages), {}, nova);

    expect(pedidoEnviado(0).input).toContainEqual(item);
    const inputNovo = pedidoEnviado(1).input;
    expect(inputNovo.some((bloco: { type?: string }) => bloco.type === 'reasoning')).toBe(false);
    expect(inputNovo.filter((bloco: { type?: string }) => bloco.type === 'function_call'))
      .toEqual([consulta, cadastro].map((tool) => ({ type: 'function_call', call_id: tool.id,
        name: tool.name, arguments: JSON.stringify(tool.input) })));
    expect(JSON.stringify(inputNovo)).not.toMatch(privado);
    expect(respostaNova).toMatchObject({ raciocinio_encadeado: true, raciocinios_reenviados: 0 });
    expect(anterior.memoriaRaciocinio).not.toBe(nova.memoriaRaciocinio);
    expect(nova.memoriaRaciocinio?.has(consulta.id)).toBe(false);
  });

  it('falha da OpenAI no meio da cadeia permite refazer no Claude sem o conteúdo privado', async () => {
    const provedor = luna({ raciocinio: true, memoriaRaciocinio: new Map() });
    responderTools();
    const primeira = await chamarAnthropic(pedido([mensagemInicial]), {}, provedor);
    const body = congelar(pedido([
      mensagemInicial, { role: 'assistant', content: primeira.content }, resultados,
    ]));
    const antes = JSON.stringify(body);
    transporte.mockResolvedValueOnce(new Response('falha sintética', { status: 400 }));
    transporte.mockResolvedValueOnce(Response.json({ content: [{ type: 'text', text: 'Tenho amanhã às 10h' }], stop_reason: 'end_turn' }));

    await expect(chamarAnthropic(body, {}, provedor)).rejects.toThrow('HTTP 400');
    const reserva = await chamarAnthropic(body, {}, null);

    expect(pedidoEnviado(1).input).toContainEqual(item);
    expect(transporte.mock.calls[2][0]).toBe('https://api.anthropic.com/v1/messages');
    expect(transporte.mock.calls[2][1]?.body).toBe(antes);
    expect(JSON.stringify(pedidoEnviado(2))).not.toMatch(privado);
    expect(JSON.stringify(body)).toBe(antes);
    expect(reserva.content).toEqual([{ type: 'text', text: 'Tenho amanhã às 10h' }]);
    expect(transporte).toHaveBeenCalledTimes(3);
  });

  it('defesa da reserva remove também os blocos legados sem alterar o histórico recebido', async () => {
    const legado = congelar(pedido([
      mensagemInicial,
      { role: 'assistant', content: [
        { type: 'raciocinio_openai', item, segue: 'fc_consulta' },
        { ...consulta, openai_id: 'fc_consulta' }, { ...cadastro, openai_id: 'fc_cadastro' },
      ] },
      resultados,
    ]));
    const antes = JSON.stringify(legado);
    transporte.mockResolvedValueOnce(Response.json({ content: [], stop_reason: 'end_turn' }));

    await chamarAnthropic(legado, {}, null);

    expect(pedidoEnviado(0).messages).toEqual(historicoComTools());
    expect(JSON.stringify(pedidoEnviado(0))).not.toMatch(privado);
    expect(JSON.stringify(legado)).toBe(antes);
  });

  it('HTTP 400 que ecoa o conteúdo cifrado conserva o status sem vazar o corpo ao erro ou à reserva', async () => {
    const provedor = luna({ raciocinio: true, memoriaRaciocinio: memoriaDaCadeia() });
    const body = congelar(pedido(historicoComTools()));
    const corpoAntes = JSON.stringify(body);
    transporte.mockResolvedValueOnce(Response.json({ error: {
      type: 'invalid_request_error', param: 'input',
      message: `Conteúdo ecoado: ${JSON.stringify(item)}`,
      encrypted_content: item.encrypted_content,
    } }, { status: 400 }));
    transporte.mockResolvedValueOnce(Response.json({
      content: [{ type: 'text', text: 'Tenho amanhã às 10h' }], stop_reason: 'end_turn',
    }));

    let erro: unknown;
    try { await chamarAnthropic(body, {}, provedor); } catch (falha) { erro = falha; }
    expect(erro).toBeInstanceOf(Error);
    expect((erro as Error).message).toBe('OpenAI: HTTP 400: {"error":{}}');
    expect(String(erro)).not.toMatch(privado);
    expect(String(erro)).not.toContain('Conteúdo ecoado');

    const reserva = await chamarAnthropic(body, {}, null);

    expect(pedidoEnviado(0).input).toContainEqual(item);
    expect(transporte.mock.calls[1][0]).toBe('https://api.anthropic.com/v1/messages');
    expect(transporte.mock.calls[1][1]?.body).toBe(corpoAntes);
    expect(JSON.stringify(pedidoEnviado(1))).not.toMatch(privado);
    expect(JSON.stringify(reserva)).not.toMatch(privado);
    expect(JSON.stringify(body)).toBe(corpoAntes);
    expect(transporte).toHaveBeenCalledTimes(2);
  });

  it('correção do canal soma os reenvios das duas chamadas e permanece limpa para persistir', async () => {
    const provedor = luna({ raciocinio: true, memoriaRaciocinio: memoriaDaCadeia() });
    // Texto sem a ferramenta de resposta exige a correção já existente do canal.
    responder([{ type: 'message', content: [{ type: 'output_text', text: 'Tenho amanhã às 10h' }] }]);
    responderCanal();

    const resposta = await chamarAgentePrincipal(principal(congelar(historicoComTools()), provedor));

    expect(resposta).toMatchObject({ raciocinio_encadeado: true, raciocinios_reenviados: 2,
      content: [{ type: 'text', text: 'Tenho amanhã às 10h, fica bom para você?' }] });
    expect(pedidoEnviado(0).input).toContainEqual(item);
    expect(pedidoEnviado(1).input).toContainEqual(item);
    expect(pedidoEnviado(1).reasoning).toEqual({ effort: 'none' });
    expect(JSON.stringify(resposta)).not.toMatch(privado);
    expect(transporte).toHaveBeenCalledTimes(2);
  });
});
