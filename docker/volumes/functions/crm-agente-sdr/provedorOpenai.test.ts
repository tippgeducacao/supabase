import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BLOCO_RACIOCINIO_OPENAI, hidratarRaciocinio, registrarRaciocinio,
  paraPedidoOpenai, paraRespostaAnthropic, semRaciocinioOpenai,
  type MemoriaRaciocinio,
} from './provedorOpenai';

const cfg = { modelo: 'gpt-5.6-luna', esforco: 'high' };
const pedidoAnthropic = () => ({
  model: 'claude-sonnet-5',
  max_tokens: 8192,
  thinking: { type: 'adaptive' },
  system: [
    { type: 'text', text: 'PROMPT' },
    { type: 'text', text: 'INSTRUCAO', cache_control: { type: 'ephemeral' } },
  ],
  tools: [
    { name: 'consulta_disponibilidade', description: 'Horários.', input_schema: { type: 'object', properties: { dia: { type: 'string' } } } },
    { name: 'responder_ao_cliente', strict: true, input_schema: { type: 'object', properties: {} }, cache_control: { type: 'ephemeral' } },
  ],
  messages: [
    { role: 'user', content: 'Quero agendar' },
    {
      role: 'assistant', content: [
        { type: 'thinking', thinking: 'INTERNO', signature: 'assinatura' },
        { type: 'text', text: 'Vou ver a agenda.' },
        { type: 'tool_use', id: 'toolu_1', name: 'consulta_disponibilidade', input: { dia: 'amanhã' } },
      ],
    },
    {
      role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '10h e 14h' }], cache_control: { type: 'ephemeral' } },
        { type: 'text', text: '[CONTEXTO TEMPORAL] quinta' },
      ],
    },
  ],
});

describe('pedido Anthropic → Responses API', () => {
  it('junta o system, mantém a ordem tool_result → texto e não leva raciocínio nem cache_control', () => {
    const pedido = paraPedidoOpenai(pedidoAnthropic(), cfg);
    expect(pedido).toMatchObject({
      model: 'gpt-5.6-luna', store: false, max_output_tokens: 8192,
      instructions: 'PROMPT\nINSTRUCAO', reasoning: { effort: 'high' },
    });
    expect(pedido.input).toEqual([
      { role: 'user', content: 'Quero agendar' },
      { role: 'assistant', content: 'Vou ver a agenda.', phase: 'commentary' },
      { type: 'function_call', call_id: 'toolu_1', name: 'consulta_disponibilidade', arguments: '{"dia":"amanhã"}' },
      { type: 'function_call_output', call_id: 'toolu_1', output: '10h e 14h' },
      { role: 'user', content: [{ type: 'input_text', text: '[CONTEXTO TEMPORAL] quinta' }] },
    ]);
    expect(JSON.stringify(pedido)).not.toMatch(/cache_control|INTERNO|assinatura/);
  });

  it('tools viram function; strict segue a própria tool (só o canal de resposta é estrito); sem tool_choice vale o auto', () => {
    const pedido = paraPedidoOpenai(pedidoAnthropic(), cfg) as { tools: Record<string, unknown>[]; tool_choice?: unknown };
    expect(pedido.tools).toEqual([
      { type: 'function', name: 'consulta_disponibilidade', description: 'Horários.', parameters: { type: 'object', properties: { dia: { type: 'string' } } }, strict: false },
      { type: 'function', name: 'responder_ao_cliente', description: '', parameters: { type: 'object', properties: {} }, strict: true },
    ]);
    expect(pedido.tool_choice).toBeUndefined();
  });

  it('correção e router: tool forçada, sem paralelismo e sem raciocínio', () => {
    const pedido = paraPedidoOpenai({
      ...pedidoAnthropic(), thinking: { type: 'disabled' },
      tool_choice: { type: 'tool', name: 'responder_ao_cliente', disable_parallel_tool_use: true },
    }, cfg);
    expect(pedido).toMatchObject({
      tool_choice: { type: 'function', name: 'responder_ao_cliente' }, parallel_tool_calls: false, reasoning: { effort: 'none' },
    });
  });

  it('fase do assistant: fala que o lead recebeu é final_answer; texto junto de tool é commentary; user nunca leva', () => {
    const pedido = paraPedidoOpenai({
      messages: [
        { role: 'user', content: 'Oi' },
        { role: 'assistant', content: 'Olá, tudo bem?' },
        { role: 'user', content: [{ type: 'text', text: 'Quero saber o valor' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Te mando agora.' }] },
      ],
    }, cfg) as { input: Record<string, unknown>[] };
    expect(pedido.input.map((i) => i.phase)).toEqual([undefined, 'final_answer', undefined, 'final_answer']);
    expect(pedido.input[3]).toEqual({ role: 'assistant', content: 'Te mando agora.', phase: 'final_answer' });
    expect(JSON.stringify(pedido)).not.toContain('output_text');
  });

  it('imagem do lead vira input_image', () => {
    const pedido = paraPedidoOpenai({
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }, { type: 'text', text: 'olha' }] }],
    }, cfg);
    expect(pedido.input).toEqual([{ role: 'user', content: [
      { type: 'input_image', image_url: 'data:image/png;base64,QUJD' }, { type: 'input_text', text: 'olha' },
    ] }]);
  });
});

describe('resposta Responses API → Anthropic', () => {
  const uso = { input_tokens: 1000, input_tokens_details: { cached_tokens: 700, cache_write_tokens: 200 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 30 } };

  it('function_call vira tool_use com o call_id; raciocínio não atravessa; uso separa cache', () => {
    const r = paraRespostaAnthropic({
      id: 'resp_1', model: 'gpt-5.6-luna', status: 'completed', usage: uso,
      output: [
        { type: 'reasoning', id: 'rs_1', summary: [] },
        { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'responder_ao_cliente', arguments: '{"mensagem":"Oi"}' },
      ],
    });
    expect(r).toMatchObject({
      model: 'gpt-5.6-luna', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'call_9', name: 'responder_ao_cliente', input: { mensagem: 'Oi' } }],
      usage: { input_tokens: 100, cache_read_input_tokens: 700, cache_creation_input_tokens: 200, output_tokens: 50, output_tokens_details: { thinking_tokens: 30 } },
    });
  });

  it('texto puro é end_turn; argumento que não é JSON segue cru para a validação do canal', () => {
    expect(paraRespostaAnthropic({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Olá' }] }] }))
      .toMatchObject({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Olá' }] });
    expect(paraRespostaAnthropic({ status: 'completed', output: [{ type: 'function_call', call_id: 'c', name: 'x', arguments: '{quebrado' }] }))
      .toMatchObject({ content: [{ type: 'tool_use', input: '{quebrado' }] });
  });

  it('geração cortada e recusa não passam por resposta concluída', () => {
    expect(paraRespostaAnthropic({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }).stop_reason).toBe('max_tokens');
    expect(paraRespostaAnthropic({ status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] }).stop_reason).toBe('refusal');
    expect(paraRespostaAnthropic({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'não' }] }] }).stop_reason).toBe('refusal');
  });
});

describe('raciocínio encadeado (A/B de 24/09/2026)', () => {
  const comRaciocinio = { ...cfg, raciocinio: true };
  const rs = (id: string, segue: string) => ({
    type: 'raciocinio_openai', segue,
    item: { type: 'reasoning', id, summary: [], encrypted_content: `CIFRADO_${id}` },
  });
  const tu = (id: string, openaiId?: string) => ({
    type: 'tool_use', id, name: 'consulta_disponibilidade', input: { dia: 'amanhã' }, ...(openaiId ? { openai_id: openaiId } : {}),
  });
  const cadeia = (assistant: unknown[]) => ({ messages: [
    { role: 'user', content: 'Quero agendar' },
    { role: 'assistant', content: assistant },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '10h' }, { type: 'tool_result', tool_use_id: 'call_2', content: '14h' }] },
  ] });

  it('resposta: o item cifrado vira bloco próprio, amarrado ao id do function_call seguinte', () => {
    const r = paraRespostaAnthropic({
      status: 'completed',
      output: [
        { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'CIFRADO' },
        { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'consulta_disponibilidade', arguments: '{}' },
      ],
    }, comRaciocinio);
    expect(r.content).toEqual([
      { type: 'raciocinio_openai', item: { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'CIFRADO' }, segue: 'fc_1' },
      { type: 'tool_use', id: 'call_1', name: 'consulta_disponibilidade', input: {}, openai_id: 'fc_1' },
    ]);
  });

  it('pedido: raciocínio volta antes do function_call, que leva o id; paralelas da mesma resposta também', () => {
    const pedido = paraPedidoOpenai(cadeia([rs('rs_1', 'fc_1'), tu('call_1', 'fc_1'), tu('call_2', 'fc_2')]), comRaciocinio) as { input: unknown[]; include?: unknown };
    expect(pedido.include).toEqual(['reasoning.encrypted_content']);
    expect(pedido.input).toEqual([
      { role: 'user', content: 'Quero agendar' },
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'CIFRADO_rs_1' },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'consulta_disponibilidade', arguments: '{"dia":"amanhã"}' },
      { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'consulta_disponibilidade', arguments: '{"dia":"amanhã"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '10h' },
      { type: 'function_call_output', call_id: 'call_2', output: '14h' },
    ]);
  });

  it('desligado (produção): mesmo histórico sai como antes — sem raciocínio, sem id, sem include', () => {
    const pedido = paraPedidoOpenai(cadeia([rs('rs_1', 'fc_1'), tu('call_1', 'fc_1')]), cfg) as { input: Record<string, unknown>[]; include?: unknown };
    expect(pedido.include).toBeUndefined();
    expect(JSON.stringify(pedido.input)).not.toMatch(/CIFRADO|fc_1|"reasoning"/);
  });

  it('raciocínio cujo item seguinte saiu do histórico não volta, e o function_call vai sem id', () => {
    // Ex.: o seguinte era responder_ao_cliente, descartado pelo canal junto da tool de negócio.
    const pedido = paraPedidoOpenai(cadeia([rs('rs_1', 'fc_responder'), tu('call_1', 'fc_1')]), comRaciocinio) as { input: Record<string, unknown>[] };
    expect(pedido.input[1]).toEqual({ type: 'function_call', call_id: 'call_1', name: 'consulta_disponibilidade', arguments: '{"dia":"amanhã"}' });
    expect(JSON.stringify(pedido.input)).not.toContain('CIFRADO');
  });

  it('caminho Anthropic (reserva): bloco e openai_id saem; nada muda sem eles', () => {
    const corpo = cadeia([rs('rs_1', 'fc_1'), tu('call_1', 'fc_1')]);
    expect(semRaciocinioOpenai(corpo).messages[1]).toEqual({ role: 'assistant', content: [tu('call_1')] });
    const limpo = { messages: [{ role: 'user', content: 'Oi' }] };
    expect(semRaciocinioOpenai(limpo)).toBe(limpo);
  });
});

describe('memória de raciocínio por rodada', () => {
  const raciocinio = { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'RESUMO_SINTETICO' }], encrypted_content: 'CIFRADO_SINTETICO' };
  const chamada = (n: number) => ({ type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name: 'consulta_disponibilidade', arguments: '{}' });
  const resposta = () => ({ status: 'completed', output: [structuredClone(raciocinio), chamada(1), chamada(2)] });
  const comMemoria = (memoria: MemoriaRaciocinio) => ({ ...cfg, raciocinio: true, memoriaRaciocinio: memoria });
  const mensagens = (content: unknown[]) => [
    { role: 'user', content: 'Quero agendar' },
    { role: 'assistant', content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '10h' }, { type: 'tool_result', tool_use_id: 'call_2', content: '14h' }] },
  ];
  const pedido = (messages: unknown[], memoria: MemoriaRaciocinio) => paraPedidoOpenai({ messages: hidratarRaciocinio(messages, memoria) }, comMemoria(memoria)) as { input: any[] };
  const congelar = (valor: any): any => {
    if (valor && typeof valor === 'object') {
      Object.values(valor).forEach(congelar);
      Object.freeze(valor);
    }
    return valor;
  };

  it('registra ids das paralelas e ancora o raciocínio só na chamada imediatamente seguinte', () => {
    const memoria: MemoriaRaciocinio = new Map();
    registrarRaciocinio(memoria, resposta());
    expect([...memoria]).toEqual([
      ['call_1', { openaiId: 'fc_1', item: raciocinio, ancoraCallId: 'call_1' }],
      ['call_2', { openaiId: 'fc_2', ancoraCallId: 'call_1' }],
    ]);
  });

  it('hidrata a cadeia com um raciocínio antes da primeira tool e ids nas duas paralelas', () => {
    const memoria: MemoriaRaciocinio = new Map();
    const resp = resposta();
    registrarRaciocinio(memoria, resp);
    const limpo = paraRespostaAnthropic(resp, comMemoria(memoria)).content as unknown[];
    expect(pedido(mensagens(limpo), memoria).input).toEqual([
      { role: 'user', content: 'Quero agendar' },
      raciocinio,
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'consulta_disponibilidade', arguments: '{}' },
      { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'consulta_disponibilidade', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: '10h' },
      { type: 'function_call_output', call_id: 'call_2', output: '14h' },
    ]);
  });

  it('o retorno para canal e histórico fica limpo mesmo quando a memória ainda está vazia', () => {
    const memoria: MemoriaRaciocinio = new Map();
    const atual = paraRespostaAnthropic(resposta(), comMemoria(memoria));
    expect(atual).toEqual(paraRespostaAnthropic(resposta()));
    expect(JSON.stringify(atual)).not.toMatch(/raciocinio_openai|openai_id|CIFRADO|RESUMO_SINTETICO/);
    expect(memoria.size).toBe(0);
  });

  it('âncora descartada pelo canal: paralela preservada sai sem raciocínio e sem id nativo', () => {
    const memoria: MemoriaRaciocinio = new Map();
    registrarRaciocinio(memoria, resposta());
    const sobrevivente = { type: 'tool_use', id: 'call_2', name: 'consulta_disponibilidade', input: {} };
    const itens = pedido(mensagens([sobrevivente]), memoria).input;
    expect(itens.filter((item) => item.type === 'function_call')).toEqual([
      { type: 'function_call', call_id: 'call_2', name: 'consulta_disponibilidade', arguments: '{}' },
    ]);
    expect(itens.some((item) => item.type === 'reasoning')).toBe(false);
  });

  it('grupo órfão não herda o raciocínio de outro grupo contíguo na mesma mensagem', () => {
    const memoria: MemoriaRaciocinio = new Map();
    const segundoRaciocinio = { ...raciocinio, id: 'rs_2' };
    const resp = { output: [raciocinio, chamada(1), segundoRaciocinio, { ...chamada(2), name: 'responder_ao_cliente' }, chamada(3)] };
    registrarRaciocinio(memoria, resp);
    const limpo = (paraRespostaAnthropic(resp, comMemoria(memoria)).content as any[]).filter((tool) => tool.id !== 'call_2');
    const hidratadas = hidratarRaciocinio(mensagens(limpo), memoria);
    expect(hidratadas[1].content.find((tool: any) => tool.id === 'call_3')).not.toHaveProperty('openai_id');
    expect(pedido(mensagens(limpo), memoria).input.filter((item) => ['reasoning', 'function_call'].includes(item.type))).toEqual([
      raciocinio,
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'consulta_disponibilidade', arguments: '{}' },
      { type: 'function_call', call_id: 'call_3', name: 'consulta_disponibilidade', arguments: '{}' },
    ]);
  });

  it('duas cadeias contíguas completas preservam cada raciocínio e suas próprias paralelas', () => {
    const memoria: MemoriaRaciocinio = new Map();
    const segundoRaciocinio = { ...raciocinio, id: 'rs_2' };
    const resp = { output: [raciocinio, chamada(1), segundoRaciocinio, chamada(2), chamada(3)] };
    registrarRaciocinio(memoria, resp);
    const limpo = paraRespostaAnthropic(resp, comMemoria(memoria)).content as unknown[];
    expect(pedido(mensagens(limpo), memoria).input.filter((item) => ['reasoning', 'function_call'].includes(item.type))).toEqual([
      raciocinio,
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'consulta_disponibilidade', arguments: '{}' },
      segundoRaciocinio,
      { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'consulta_disponibilidade', arguments: '{}' },
      { type: 'function_call', id: 'fc_3', call_id: 'call_3', name: 'consulta_disponibilidade', arguments: '{}' },
    ]);
  });

  it('nova resposta sem raciocínio não herda grupo de uma resposta anterior na memória', () => {
    const memoria: MemoriaRaciocinio = new Map();
    registrarRaciocinio(memoria, { output: [raciocinio, chamada(1)] });
    registrarRaciocinio(memoria, { output: [chamada(2)] });
    const limpo = paraRespostaAnthropic({ output: [chamada(1), chamada(2)] }, comMemoria(memoria)).content as unknown[];
    const hidratadas = hidratarRaciocinio(mensagens(limpo), memoria);
    expect(hidratadas[1].content.find((tool: any) => tool.id === 'call_2')).not.toHaveProperty('openai_id');
    const chamadas = pedido(mensagens(limpo), memoria).input.filter((item) => item.type === 'function_call');
    expect(chamadas[0].id).toBe('fc_1');
    expect(chamadas[1]).not.toHaveProperty('id');
  });

  it.each([
    [{ type: 'text', text: 'Preâmbulo entre chamadas' }],
    [{ type: 'message', id: 'msg_1', content: [] }],
  ])('a quebra entre chamadas encerra o grupo na resposta e na hidratação: %j', (intervalo) => {
    const memoria: MemoriaRaciocinio = new Map();
    registrarRaciocinio(memoria, { output: [raciocinio, chamada(1), intervalo, chamada(2)] });
    expect(memoria.get('call_2')).not.toHaveProperty('ancoraCallId');
    const limpo = paraRespostaAnthropic({ output: [chamada(1), chamada(2)] }, comMemoria(memoria)).content as unknown[];
    expect(hidratarRaciocinio(mensagens(limpo), memoria)[1].content.find((tool: any) => tool.id === 'call_2')).not.toHaveProperty('openai_id');

    registrarRaciocinio(memoria, resposta());
    const separado = [limpo[0], { type: 'text', text: 'Texto entre chamadas no histórico' }, limpo[1]];
    expect(hidratarRaciocinio(mensagens(separado), memoria)[1].content.find((tool: any) => tool.id === 'call_2')).not.toHaveProperty('openai_id');
  });

  it('reasoning que antecede mensagem pública não é associado à tool posterior', () => {
    const memoria: MemoriaRaciocinio = new Map();
    registrarRaciocinio(memoria, { output: [raciocinio, { type: 'message', id: 'msg_1', content: [] }, chamada(1)] });
    expect(memoria.get('call_1')).toEqual({ openaiId: 'fc_1' });
    const limpo = paraRespostaAnthropic({ output: [chamada(1)] }).content as unknown[];
    expect(pedido(mensagens(limpo), memoria).input.some((item) => item.type === 'reasoning' || item.id === 'fc_1')).toBe(false);
  });

  it('memória nova não reenvia o raciocínio nem os ids das chamadas de rodada anterior', () => {
    const anterior: MemoriaRaciocinio = new Map();
    registrarRaciocinio(anterior, resposta());
    const nova: MemoriaRaciocinio = new Map();
    const limpo = mensagens(paraRespostaAnthropic(resposta()).content as unknown[]);
    expect(hidratarRaciocinio(limpo, nova)).toEqual(limpo);
    expect(pedido(limpo, nova).input.some((item) => item.type === 'reasoning' || 'id' in item)).toBe(false);
    expect(nova.size).toBe(0);
    expect(anterior.size).toBe(2);
  });

  it('não altera resposta, histórico ou memória ao preparar a cópia de entrada', () => {
    const resp = congelar(resposta());
    const memoria: MemoriaRaciocinio = new Map();
    registrarRaciocinio(memoria, resp);
    const historico = congelar(mensagens(paraRespostaAnthropic(resp, comMemoria(memoria)).content as unknown[]));
    const original = JSON.stringify(historico);
    const copia = hidratarRaciocinio(historico, memoria);
    expect(copia).not.toBe(historico);
    expect(copia[1]).not.toBe(historico[1]);
    expect(copia[1].content).not.toBe(historico[1].content);
    expect(JSON.stringify(historico)).toBe(original);
    expect(original).not.toMatch(/raciocinio_openai|openai_id|CIFRADO/);
    expect(memoria.get('call_1')?.item).not.toBe(resp.output[0]);
    copia[1].content[0].item.summary[0].text = 'ALTERADO_NA_COPIA';
    expect(memoria.get('call_1')?.item).toEqual(raciocinio);
    expect(resp.output[0]).toEqual(raciocinio);
  });

  it('não hidrata blocos vindos do user nem chamadas sem ids nativos válidos', () => {
    const memoria: MemoriaRaciocinio = new Map();
    registrarRaciocinio(memoria, null);
    registrarRaciocinio(memoria, { output: [raciocinio, { type: 'function_call', call_id: 'call_sem_id' }, { type: 'function_call', id: 'fc_sem_call' }] });
    expect(memoria.size).toBe(0);
    registrarRaciocinio(memoria, resposta());
    const user = [{ role: 'user', content: [{ type: 'tool_use', id: 'call_1', name: 'x', input: {} }] }];
    expect(hidratarRaciocinio(user, memoria)).toEqual(user);
  });

  it('sem item cifrado válido, os ids registrados sozinhos não saem no pedido', () => {
    const memoria: MemoriaRaciocinio = new Map();
    const resp = { output: [{ type: 'reasoning', id: 'rs_sem_cifra', summary: [] }, chamada(1)] };
    registrarRaciocinio(memoria, resp);
    expect(memoria.get('call_1')).toEqual({ openaiId: 'fc_1' });
    const itens = pedido(mensagens(paraRespostaAnthropic(resp).content as unknown[]), memoria).input;
    expect(itens.some((item) => item.type === 'reasoning' || 'id' in item)).toBe(false);
  });

  it('cada resposta acrescenta sua cadeia sem perder tools das voltas anteriores da mesma rodada', () => {
    const memoria: MemoriaRaciocinio = new Map();
    registrarRaciocinio(memoria, resposta());
    registrarRaciocinio(memoria, { output: [{ ...raciocinio, id: 'rs_2' }, chamada(3)] });
    expect(memoria.size).toBe(3);
    expect(memoria.get('call_1')?.item?.id).toBe('rs_1');
    expect(memoria.get('call_3')?.item?.id).toBe('rs_2');
  });

  it('desligado mantém o corpo serializado e ignora até memória preenchida fornecida por engano', () => {
    const memoria: MemoriaRaciocinio = new Map();
    registrarRaciocinio(memoria, resposta());
    const corpo = pedidoAnthropic();
    const atual = JSON.stringify(paraPedidoOpenai(corpo, cfg));
    expect(JSON.stringify(paraPedidoOpenai(corpo, { ...cfg, raciocinio: false, memoriaRaciocinio: memoria }))).toBe(atual);
    expect(JSON.stringify(paraRespostaAnthropic(resposta(), { raciocinio: false, memoriaRaciocinio: memoria })))
      .toBe(JSON.stringify(paraRespostaAnthropic(resposta())));
  });

  it('a cópia hidratada continua removível integralmente pela defesa da reserva Anthropic', () => {
    const memoria: MemoriaRaciocinio = new Map();
    registrarRaciocinio(memoria, resposta());
    const historico = mensagens(paraRespostaAnthropic(resposta(), comMemoria(memoria)).content as unknown[]);
    const hidratadas = hidratarRaciocinio(historico, memoria);
    expect(JSON.stringify(hidratadas)).toContain(BLOCO_RACIOCINIO_OPENAI);
    expect(semRaciocinioOpenai({ messages: hidratadas })).toEqual({ messages: historico });
  });
});

describe('transporte com provedor openai', () => {
  const transporte = vi.fn();
  let agente: typeof import('./agente');
  beforeAll(async () => {
    vi.stubGlobal('Deno', { env: { get: (chave: string) => chave === 'AGENTE_SDR_OPENAI_KEY' ? 'chave-sintetica' : '' } });
    vi.stubGlobal('fetch', transporte);
    agente = await import('./agente');
  });
  afterAll(() => vi.unstubAllGlobals());
  beforeEach(() => transporte.mockReset());

  it('chama /v1/responses com Bearer e devolve a resposta já no formato da Anthropic', async () => {
    transporte.mockResolvedValueOnce(new Response(JSON.stringify({
      model: 'gpt-5.6-luna', status: 'completed',
      output: [{ type: 'function_call', call_id: 'call_1', name: 'responder_ao_cliente', arguments: '{"mensagem":"Olá"}' }],
    }), { status: 200 }));
    const resposta = await agente.chamarAgentePrincipal({
      promptAgente: 'Prompt', contextoTemporal: 'Agora', messages: [{ role: 'user', content: 'Oi' }], tools: [],
      provedor: agente.provedorOpenai(),
    });
    const [url, init] = transporte.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.headers).toMatchObject({ authorization: 'Bearer chave-sintetica' });
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'gpt-5.6-luna', reasoning: { effort: 'high' }, store: false });
    expect(resposta.content).toEqual([{ type: 'text', text: 'Olá' }]);
    expect(resposta.canal_resposta).toMatchObject({ motivo: 'resposta_validada' });
  });
});

describe('carregarTools: cada provedor lê a SUA tabela', () => {
  let agente: typeof import('./agente');
  beforeAll(async () => {
    vi.stubGlobal('Deno', { env: { get: () => '' } });
    agente = await import('./agente');
  });
  afterAll(() => vi.unstubAllGlobals());

  const banco = (linhas: Record<string, unknown[]>, erro: string | null = null) => {
    const lidas: string[] = [];
    const client = {
      from: (tabela: string) => {
        lidas.push(tabela);
        const q: Record<string, unknown> = {};
        q.select = () => q; q.eq = () => q;
        q.order = async () => ({ data: erro ? null : (linhas[tabela] ?? []).map((tool) => ({ tool })), error: erro ? { message: erro } : null });
        return q;
      },
    };
    return { client, lidas };
  };
  const luna = { nome: 'openai', formato: 'openai' as const, base: 'https://api.openai.com', chave: 'k', modelo: 'gpt-5.6-luna', esforco: 'high' };
  const linhaOpenai = { type: 'function', name: 'pausa_ia', description: 'TEXTO DA TABELA DA OPENAI', parameters: { type: 'object', properties: { tipo: { type: 'string' } } }, strict: false };

  it('openai: lê lista_tools_openai, converte para o contrato interno e NÃO aplica o acréscimo do código', async () => {
    const { client, lidas } = banco({ lista_tools_openai: [linhaOpenai] });
    const tools = await agente.carregarTools(client, 'agente_recontato', luna);
    expect(lidas).toEqual(['lista_tools_openai']);
    // o modelo recebe exatamente a linha: sem o prefixo que descreverToolsSdr põe em pausa_ia
    expect(tools).toEqual([{ name: 'pausa_ia', description: 'TEXTO DA TABELA DA OPENAI', input_schema: linhaOpenai.parameters }]);
  });

  it('openai: strict da linha atravessa; ida e volta pelo tradutor devolve a mesma function tool', async () => {
    const estrita = { ...linhaOpenai, strict: true };
    const { client } = banco({ lista_tools_openai: [estrita] });
    const tools = await agente.carregarTools(client, 'agente_recontato', luna);
    expect(tools[0].strict).toBe(true);
    const pedido = paraPedidoOpenai({ messages: [], tools }, { modelo: 'gpt-5.6-luna', esforco: 'high' }) as { tools: unknown[] };
    expect(pedido.tools).toEqual([estrita]);
  });

  it('openai: persona sem linha na tabela é erro, nunca um agente sem ferramentas em silêncio', async () => {
    await expect(agente.carregarTools(banco({}).client, 'agente_aula', luna)).rejects.toThrow(/nenhuma tool para agente_aula/);
    await expect(agente.carregarTools(banco({}, 'permission denied').client, 'agente_aula', luna)).rejects.toThrow(/permission denied/);
  });

  it('sem provedor (Claude): segue lendo lista_tools_claude com o acréscimo do código', async () => {
    const { client, lidas } = banco({ lista_tools_claude: [{ name: 'agendar_retorno', description: 'BASE', input_schema: { type: 'object', properties: {} } }] });
    const tools = await agente.carregarTools(client, 'agente_recontato');
    expect(lidas).toEqual(['lista_tools_claude']);
    expect(tools[0].description.endsWith('BASE')).toBe(true);
    expect(tools[0].description.length).toBeGreaterThan('BASE'.length);
  });
});
