import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercita o ig-agente de ponta a ponta com banco, rede e o João simulados: nenhuma DM
// sai de verdade, nenhuma linha é escrita.
type Linha = Record<string, any>;
const mocks = vi.hoisted(() => ({
  responder: vi.fn(),
  fetch: vi.fn(),
  rpc: vi.fn(),
  estado: {} as {
    config: Linha | null; conta: Linha | null; perfil: Linha | null; segredo: Linha | null;
    mensagens: Linha[]; conversa: Linha | null;
    escritas: { tabela: string; op: string; payload: any; violacao?: string }[];
  },
}));

// Os CHECKs das tabelas REAIS. Sem eles este teste passou gravando status_entrega =
// 'enviado', que o banco recusa — e em produção a IA se pausou depois da 1ª resposta
// (24/09/2026), porque o eco da própria mensagem ficou parecendo de um humano.
const CHECKS: Record<string, (p: Linha) => string | null> = {
  ig_mensagens: (p) => {
    if (!['sent', 'delivered', 'read', 'failed'].includes(p.status_entrega ?? 'sent')) return 'ig_mensagens_status_entrega_check';
    if (!['inbound', 'outbound'].includes(p.direcao)) return 'ig_mensagens_direcao_check';
    return null;
  },
  ig_conversa_ia: (p) => (p.estagio !== undefined && !['validacao', 'qualificador'].includes(p.estagio)
    ? 'ig_conversa_ia_estagio_check' : null),
};

// Query builder mínimo do supabase-js: guarda filtros e responde conforme a tabela.
function builder(tabela: string) {
  const q: any = { op: 'select', filtros: {} as Record<string, unknown>, payload: null, violacao: null };
  const e = mocks.estado;
  const resolver = (single: boolean) => {
    if (q.violacao) return { data: null, error: { message: `new row violates check constraint "${q.violacao}"` } };
    if (q.op === 'upsert' || q.op === 'insert') return { data: null, error: null };
    if (q.op === 'update') {
      if (tabela === 'ig_conversa_ia' && e.conversa && e.conversa.pausada === q.filtros['eq:pausada']) {
        Object.assign(e.conversa, q.payload);
        return { data: [{ igsid: e.conversa.igsid }], error: null };
      }
      return { data: [], error: null };
    }
    let dado: unknown = null;
    if (tabela === 'ig_agente_config') dado = e.config;
    else if (tabela === 'ig_contas') dado = e.conta;
    else if (tabela === 'ig_perfis') dado = e.perfil;
    else if (tabela === 'ig_contas_secrets') dado = e.segredo;
    else if (tabela === 'ig_conversa_ia') dado = e.conversa;
    else if (tabela === 'ig_mensagens') {
      if (q.filtros['eq:mid']) dado = e.mensagens.find((m) => m.mid === q.filtros['eq:mid']) ?? null;
      else if (q.filtros['neq:tipo']) {
        dado = [...e.mensagens].reverse().find((m) => m.direcao === 'inbound' && m.tipo !== 'reaction') ?? null;
      } else dado = e.mensagens;
    }
    if (single) return { data: Array.isArray(dado) ? dado[0] ?? null : dado, error: null };
    return { data: dado, error: null };
  };
  const registrar = (op: string, payload: any) => {
    q.op = op; q.payload = payload;
    q.violacao = op === 'update' ? null : CHECKS[tabela]?.(payload) ?? null;
    e.escritas.push({ tabela, op, payload, ...(q.violacao ? { violacao: q.violacao } : {}) });
    return q;
  };
  Object.assign(q, {
    select: () => q,
    eq: (c: string, v: unknown) => { q.filtros[`eq:${c}`] = v; return q; },
    neq: (c: string, v: unknown) => { q.filtros[`neq:${c}`] = v; return q; },
    gte: () => q, lte: () => q, order: () => q, limit: () => q,
    upsert: (p: any) => registrar('upsert', p),
    insert: (p: any) => registrar('insert', p),
    update: (p: any) => registrar('update', p),
    maybeSingle: async () => resolver(true),
    then: (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) => Promise.resolve(resolver(false)).then(ok, erro),
  });
  return q;
}

vi.mock('https://esm.sh/@supabase/supabase-js@2.49.4', () => ({
  createClient: () => ({ from: (t: string) => builder(t), rpc: mocks.rpc }),
}));
vi.mock('../crm-webchat/agente.ts', () => ({ responderWebchat: mocks.responder }));

const SERVICE = 'service-role-sintetica';
let handler: (req: Request) => Promise<Response>;
beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: (k: string) => ({ SUPABASE_URL: 'https://supabase.invalid', SUPABASE_SERVICE_ROLE_KEY: SERVICE })[k] },
    serve: (h: typeof handler) => { handler = h; },
  });
  vi.stubGlobal('fetch', mocks.fetch);
  await import('./index');
});
afterAll(() => vi.unstubAllGlobals());
// Nenhum teste pode terminar com uma escrita que o banco real recusaria.
afterEach(() => {
  expect(mocks.estado.escritas.filter((w) => w.violacao)).toEqual([]);
});

const INBOUND_EM = '2026-09-24T12:00:00.000Z';
let reservas: Linha[];
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  mocks.estado = {
    config: { modo: 'teste', usernames_teste: ['sutil_gu'], debounce_segundos: 0 },
    conta: { ig_user_id: '17841453422080445', ativo: true, agente_ia_ativo: true },
    perfil: { username: 'sutil_gu', nome: 'Gustavo Sutil' },
    segredo: { access_token: 'IGAA-sintetico' },
    mensagens: [{ mid: 'm1', direcao: 'inbound', tipo: 'text', conteudo: 'oi, quero saber da pós', created_at: INBOUND_EM }],
    conversa: { igsid: '999', pausada: false },
    escritas: [],
  };
  reservas = [
    { status: 'reservada', ultimo_inbound_em: INBOUND_EM, estagio: 'validacao', historico_desde: null, teste_tool_chamadas: [] },
    { status: 'sem_pendencia' },
  ];
  mocks.rpc.mockImplementation(async (nome: string) => (nome === 'ig_ia_reservar'
    ? { data: reservas.shift() ?? { status: 'sem_pendencia' }, error: null }
    : { data: true, error: null }));
  mocks.responder.mockResolvedValue({
    chunks: ['oi, gustavo!', 'qual área te interessa?'], estagio: 'validacao',
    tools: [{ nome: 'consulta_pos_disponiveis', input: {}, mockado: false }],
  });
  let n = 0;
  mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({ recipient_id: '999', message_id: `saida-${++n}` })));
});

// Sem EdgeRuntime o handler espera o trabalho terminar. As esperas (debounce, eco,
// ritmo entre balões) usam relógio falso: avança de segundo em segundo até resolver.
async function chamar(corpo: Record<string, unknown>, auth = SERVICE) {
  let pronto = false;
  const p = handler(new Request('https://x.invalid/ig-agente', {
    method: 'POST', headers: { Authorization: `Bearer ${auth}` }, body: JSON.stringify(corpo),
  })).finally(() => { pronto = true; });
  for (let i = 0; i < 300 && !pronto; i++) await vi.advanceTimersByTimeAsync(1_000);
  return p;
}
const inbound = (mid = 'm1') => chamar({ evento: 'inbound', conta_id: 'conta-1', igsid: '999', mid });
const textosEnviados = () => mocks.fetch.mock.calls.map(([, init]) => JSON.parse(init.body).message.text);
const liberacao = () => mocks.rpc.mock.calls.find(([nome]) => nome === 'ig_ia_liberar')?.[1];

describe('ig-agente: DM de quem está no teste', () => {
  it('chama o João do chat do site no canal instagram, SEMPRE em modo teste, e responde pelo direct', async () => {
    expect((await inbound()).status).toBe(200);
    expect(mocks.responder).toHaveBeenCalledTimes(1);
    const args = mocks.responder.mock.calls[0];
    expect(args[0]).toBe('Gustavo Sutil');
    expect(args[1]).toMatch(/^000\d{8}$/); // telefone sintético, nunca de um lead
    expect(args[2]).toBeNull();
    expect(args[3]).toEqual([{ role: 'user', text: 'oi, quero saber da pós' }]);
    expect(args[7]).toBe(true); // modoTeste
    expect(args[9]).toEqual({ canal: 'instagram', elegibilidadeInicial: null });

    expect(textosEnviados()).toEqual(['oi, gustavo!', 'qual área te interessa?']);
    expect(mocks.fetch.mock.calls[0][0]).toContain('graph.instagram.com');
    expect(mocks.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer IGAA-sintetico');

    const saidas = mocks.estado.escritas.filter((w) => w.tabela === 'ig_mensagens');
    expect(saidas.map((w) => [w.op, w.payload.mid, w.payload.status_entrega, w.payload.metadata.origem])).toEqual([
      ['upsert', 'saida-1', 'sent', 'ia'], ['upsert', 'saida-2', 'sent', 'ia'],
    ]);
    expect(liberacao()).toMatchObject({ p_respondido_ate: INBOUND_EM, p_estagio: 'validacao' });
  });

  it('elegibilidade simulada de uma rodada anterior volta para o João', async () => {
    const estado = { curso: 'Sanidade Avícola', decisao: 'aprovado', motivo: 'ok', regra_versao: (await import('../crm-agente-sdr/elegibilidadeAgendamento')).VERSAO_REGRA_ELEGIBILIDADE };
    reservas[0].teste_tool_chamadas = [{ nome: 'verificar_compatibilidade_curso', elegibilidade_teste: estado }];
    await inbound();
    expect(mocks.responder.mock.calls[0][9]).toEqual({ canal: 'instagram', elegibilidadeInicial: estado });
  });
});

describe('ig-agente: quando NÃO fala', () => {
  it.each([
    ['@ fora do teste', () => { mocks.estado.perfil = { username: 'outra.pessoa' }; }],
    ['conta com a IA desligada', () => { mocks.estado.conta = { ativo: true, agente_ia_ativo: false }; }],
    ['modo desligado', () => { mocks.estado.config = { modo: 'desligado', usernames_teste: ['sutil_gu'] }; }],
    ['sem token da conta', () => { mocks.estado.segredo = null; }],
    ['sem o @ resolvido', () => { mocks.estado.perfil = null; }],
  ])('%s', async (_caso, preparar) => {
    preparar();
    await inbound();
    expect(mocks.responder).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('chegou mensagem mais nova: a execução dela responde, não esta', async () => {
    mocks.estado.mensagens.push({ mid: 'm2', direcao: 'inbound', tipo: 'text', conteudo: 'e o valor?', created_at: '2026-09-24T12:00:03.000Z' });
    await inbound('m1');
    expect(mocks.responder).not.toHaveBeenCalled();
  });

  it('reação mais nova não rouba a vez da mensagem', async () => {
    mocks.estado.mensagens.push({ mid: 'r1', direcao: 'inbound', tipo: 'reaction', conteudo: '❤️', created_at: '2026-09-24T12:00:03.000Z' });
    await inbound('m1');
    expect(mocks.responder).toHaveBeenCalledTimes(1);
  });

  it('pedido sem service_role é recusado', async () => {
    const r = await chamar({ evento: 'inbound', conta_id: 'conta-1', igsid: '999', mid: 'm1' }, 'anon');
    expect(r.status).toBe(401);
    expect(mocks.responder).not.toHaveBeenCalled();
  });
});

describe('ig-agente: envio', () => {
  it('humano assumiu no meio da rodada: para de mandar balão', async () => {
    mocks.fetch.mockImplementationOnce(async () => {
      mocks.estado.conversa!.pausada = true;
      return new Response(JSON.stringify({ message_id: 'saida-1' }));
    });
    await inbound();
    expect(textosEnviados()).toEqual(['oi, gustavo!']);
    expect(liberacao()).toMatchObject({ p_respondido_ate: INBOUND_EM });
  });

  it('token morto: grava o erro e NÃO dá a mensagem como respondida', async () => {
    mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({
      error: { message: 'Error validating access token', code: 190 },
    }), { status: 400 }));
    await inbound();
    expect(textosEnviados()).toEqual(['oi, gustavo!']);
    const erro = mocks.estado.escritas.find((w) => w.tabela === 'ig_mensagens');
    expect(erro).toMatchObject({ op: 'insert', payload: { status_entrega: 'failed', mid: null } });
    expect(liberacao()).toMatchObject({ p_respondido_ate: null });
  });

  it('João falhou: manda a desculpa, marcada como sistema', async () => {
    mocks.responder.mockRejectedValue(new Error('Anthropic fora'));
    await inbound();
    expect(textosEnviados()).toEqual(['Desculpa, tive um problema aqui e não consegui responder. Pode mandar de novo? 🙏']);
    const saida = mocks.estado.escritas.find((w) => w.tabela === 'ig_mensagens');
    expect(saida!.payload.metadata).toMatchObject({ origem: 'sistema', erro_cerebro: 'Anthropic fora' });
  });
});

describe('ig-agente: /reset', () => {
  it('zera a conversa, tira a pausa e confirma — sem chamar o João', async () => {
    mocks.estado.mensagens[0].conteudo = ' /RESET ';
    await inbound();
    expect(mocks.responder).not.toHaveBeenCalled();
    const reset = mocks.estado.escritas.find((w) => w.tabela === 'ig_conversa_ia');
    expect(reset).toMatchObject({ op: 'upsert', payload: { pausada: false, estagio: 'validacao', teste_tool_chamadas: [] } });
    expect(reset!.payload.historico_desde).toBeTruthy();
    expect(textosEnviados()[0]).toContain('conversa zerada');
    const saida = mocks.estado.escritas.find((w) => w.tabela === 'ig_mensagens');
    expect(saida!.payload.metadata).toMatchObject({ origem: 'sistema', comando: 'reset' });
  });
});

describe('ig-agente: eco (mensagem nossa)', () => {
  const eco = () => chamar({ evento: 'echo', conta_id: 'conta-1', igsid: '999', mid: 'e1' });

  it('eco de humano pelo app pausa a IA na conversa', async () => {
    mocks.estado.mensagens.push({ mid: 'e1', direcao: 'outbound', metadata: { origem: 'humano', is_echo: true } });
    await eco();
    expect(mocks.estado.conversa).toMatchObject({ pausada: true, pausa_motivo: 'humano_respondeu' });
  });

  it.each(['ia', 'sistema'])('eco do que a própria IA mandou (%s) não pausa', async (origem) => {
    mocks.estado.mensagens.push({ mid: 'e1', direcao: 'outbound', metadata: { origem } });
    await eco();
    expect(mocks.estado.conversa!.pausada).toBe(false);
    expect(mocks.estado.escritas).toEqual([]);
  });
});
