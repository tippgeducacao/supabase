import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Banco e WhatsApp de mentira: o histórico é uma lista em memória, o envio só anota.
const m = vi.hoisted(() => ({
  historico: [] as { role: 'user' | 'assistant'; content: any }[],
  gravadas: [] as any[],
  enviadas: [] as string[],
  ferramentas: [] as any[],
  claude: vi.fn(),
}));

vi.mock('./historico.ts', async (original) => ({
  ...(await original<typeof import('./historico.ts')>()),
  carregarHistorico: vi.fn(async () => structuredClone(m.historico)),
  gravarMensagem: vi.fn(async (_s: unknown, _r: string, msg: any) => { m.gravadas.push(msg); m.historico.push(msg); }),
  atualizarLead: vi.fn(async () => {}),
}));
vi.mock('./fichaAtendimento.ts', async (original) => ({
  ...(await original<typeof import('./fichaAtendimento.ts')>()),
  carregarFicha: vi.fn(async () => null),
}));
vi.mock('./tools.ts', async (original) => ({
  ...(await original<typeof import('./tools.ts')>()),
  executarTool: vi.fn(async (_s: unknown, chamada: any) => {
    m.ferramentas.push(chamada);
    if (chamada.name === 'confirmar_agendamento') return { id: chamada.id, resultado: 'Agendamento confirmado.', agendamento_id: 'ag-novo' };
    return chamada.name === 'pausa_ia' ? { id: chamada.id, resultado: 'IA pausada.' } : { id: chamada.id, resultado: 'Horários livres:\n- 10h de quarta, dia 2026-10-01 (vendedor_id: v1, nome: Ana)',
      slots_raw: [{ data: '2026-10-01', horario: '10:00', vendedor_id: 'v1', vendedor_nome: 'Ana' }] };
  }),
}));
vi.mock('./saida.ts', async (original) => ({
  ...(await original<typeof import('./saida.ts')>()),
  enviarResposta: vi.fn(async (_ctx: unknown, texto: string) => { m.enviadas.push(texto); return { aceitos: 1, canal: 'texto', estado: 'aceito' }; }),
}));
vi.mock('./agente.ts', async (original) => ({
  ...(await original<typeof import('./agente.ts')>()),
  chamarAgentePrincipal: m.claude,
}));

let P: typeof import('./passosRodada');
let R: typeof import('./rotasN8n');

beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: () => '' } });
  P = await import('./passosRodada');
  R = await import('./rotasN8n');
});

const JID = '5546988166051@s.whatsapp.net';
const luna = { nome: 'openai', formato: 'openai' as const, base: 'https://api.openai.com', chave: 'k', modelo: 'gpt-5.6-luna', esforco: 'high' };
const tel = () => ({ rodadaId: 'r1', eventos: [] as any[], registrar(tipo: string, dados?: any) { (this.eventos as any[]).push({ tipo, dados }); } });

function novoEstado() {
  return P.estadoInicial({
    remotejid: JID, telefone: '5546988166051', inicioRodada: Date.now(), conteudo: 'oi, quero marcar a conversa',
    itens: [{ mensagem: 'oi, quero marcar a conversa', msg_id: 'wamid.1' }], registrarFalaAposEnvio: false,
    conjuntoPrompt: 'luna', ctx: { remotejid: JID, telefone: '5546988166051', waAccountId: null, leadId: 'l', oportunidadeId: null,
      ficha: { inicioRodada: new Date().toISOString() } } as any,
    lead: { agendado: false }, pedidoPorPalavraChave: null, aberturaControlada: false, aplicarTroca: false, sinalTroca: null,
    desdeLimpeza: null, aulaPiloto: false, aulaDaCampanha: null, configLeitura: null,
  }, {
    promptAgente: 'Você é a Luna.', contextoEfetivo: 'AGORA: terça 10h', agenteEfetivo: 'agente_validacao', estaNaEscola: false,
    tools: [
      { name: 'consulta_disponibilidade', description: 'agenda', input_schema: { type: 'object', properties: {} } },
      { name: 'pausa_ia', description: 'pausa', input_schema: { type: 'object', properties: { motivo: { type: 'string' } } } },
    ],
  }, 'r1', null);
}

const deps = (t = tel()) => ({ supabase: {}, tel: t as any, provedor: luna, iaPausada: async () => false, renovar: async () => {} });
const chamada = (id: string, name: string, args: unknown) => ({ output: [{ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }], status: 'completed', usage: {} });
const fala = (texto: string) => chamada('fala', 'responder_ao_cliente', { mensagem: texto });

beforeEach(() => {
  m.historico = [{ role: 'user', content: 'oi, quero marcar a conversa' }];
  m.gravadas = []; m.enviadas = []; m.ferramentas = [];
  m.claude.mockReset();
});

describe('agente por passos (o loop desenhado no n8n)', () => {
  it('volta completa: pedido → ferramenta → horário inventado corrigido → fala enviada', async () => {
    const d = deps();
    let s = await P.montarVolta(d, novoEstado());
    expect(s.acao).toBe('chamar_ia');
    const pedido: any = P.montarDasPecas((s as any).pecas);
    expect((s as any).pecas.persona).toBe('Você é a Luna.');
    expect((s as any).pecas.contexto[0]).toContain('AGORA: terça 10h');
    expect(pedido.model).toBe('gpt-5.6-luna');
    expect(pedido.instructions).toContain('Você é a Luna.');
    expect(pedido.tools.map((t: any) => t.name)).toEqual(['consulta_disponibilidade', 'pausa_ia', 'responder_ao_cliente']);
    expect(s.estado.volta).toBe(1);

    // A Luna pede a agenda: o n8n recebe a lista de chamadas; a fala da ferramenta fica gravada.
    s = await P.lerResposta(d, s.estado, { resposta: chamada('c1', 'consulta_disponibilidade', {}) });
    expect(s.acao).toBe('ferramentas');
    const chamadas = (s as any).chamadas;
    expect(chamadas).toEqual([{ id: 'c1', name: 'consulta_disponibilidade', input: {} }]);
    expect(m.gravadas.at(-1).role).toBe('assistant');

    // O 04 executa (e trata) a ferramenta; o sistema grava e já devolve a volta 2.
    const r = await P.executarFerramenta(d, s.estado, chamadas[0]);
    expect(String(r.output.resultado)).toContain('10h de quarta');
    s = await P.gravarResultados(d, s.estado, chamadas, [{ output: { ...r.output, resultado: 'TRATADO no n8n. ' + r.output.resultado }, efeitos: r.efeitos }]);
    expect(s.acao).toBe('chamar_ia');
    expect(s.estado.volta).toBe(2);
    expect(JSON.stringify(m.gravadas.at(-1).content)).toContain('TRATADO no n8n');

    // Oferece 15h, que a agenda não devolveu: a trava pede correção (1x), com o motivo à vista.
    s = await P.lerResposta(d, s.estado, { resposta: fala('consigo amanhã às 15h, pode ser?') });
    expect(s.acao).toBe('corrigir');
    expect((s as any).motivo).toBe('horario_inventado');
    expect(String(m.gravadas.at(-1).content)).toContain('[CORRECAO_INTERNA_AUTO_IGNORE]');
    expect(s.estado.volta).toBe(3);

    s = await P.lerResposta(d, s.estado, { resposta: fala('consigo amanhã às 10h, pode ser?') });
    expect(s).toMatchObject({ acao: 'enviar', tipo: 'fala', texto: 'consigo amanhã às 10h, pode ser?' });

    s = await P.enviar(d, s.estado, { tipo: 'fala', texto: (s as any).texto });
    expect(s).toMatchObject({ acao: 'fim', respondeu: true });
    expect(m.enviadas).toHaveLength(1);
    expect(m.enviadas[0]).toContain('10h');
  });

  it('pausa concluída encerra com a despedida determinística', async () => {
    const d = deps();
    let s = await P.montarVolta(d, novoEstado());
    s = await P.lerResposta(d, s.estado, { resposta: chamada('p1', 'pausa_ia', { motivo: 'sem interesse' }) });
    const r = await P.executarFerramenta(d, s.estado, (s as any).chamadas[0]);
    s = await P.gravarResultados(d, s.estado, (s as any).chamadas, [r]);
    expect(s).toMatchObject({ acao: 'enviar', tipo: 'despedida' });
    expect(s.estado.pausouPorTool).toBe(true);
    s = await P.enviar(d, s.estado, { tipo: 'despedida', texto: (s as any).texto });
    expect(s).toMatchObject({ acao: 'fim', respondeu: true });
    expect(m.enviadas).toHaveLength(1);
  });

  it('a Luna falhou: a mesma volta vai para o Claude e o resto da rodada fica nele', async () => {
    m.claude.mockResolvedValue({ content: [{ type: 'text', text: 'oi! tudo bem?' }], stop_reason: 'end_turn', usage: {} });
    const t = tel();
    const d = deps(t);
    let s = await P.montarVolta(d, novoEstado());
    s = await P.lerResposta(d, s.estado, { erro: 'HTTP 500' });
    expect(m.claude).toHaveBeenCalledTimes(1);
    expect(s.estado.usarClaude).toBe(true);
    expect(s).toMatchObject({ acao: 'enviar', texto: 'oi! tudo bem?' });
    expect(t.eventos.some((ev) => ev.tipo === 'provedor_ia_fallback')).toBe(true);
  });

  it('consulta idêntica na mesma resposta não roda de novo', async () => {
    const d = deps();
    let s = await P.montarVolta(d, novoEstado());
    s = await P.lerResposta(d, s.estado, { resposta: chamada('c1', 'consulta_disponibilidade', {}) });
    const c = { id: 'c2', name: 'consulta_disponibilidade', input: {} };
    const r = await P.executarFerramenta(d, s.estado, c, [{ id: 'c1', name: 'consulta_disponibilidade', input: {} }]);
    expect(r.repetida).toBe(true);
    expect(m.ferramentas).toHaveLength(0);
  });

  it('o estado assinado: mexer em quem (telefone, conta, oportunidade) no n8n invalida', async () => {
    const e = novoEstado();
    const cfg = { ativo: true, url: 'https://n8n/webhook/sdr-luna/entrada', segredo: 'segredo', telefones: ['5546988166051'] };
    const assinatura = await R.assinarEstado(e, cfg.segredo);
    expect(await R.estadoConfere(e, assinatura, cfg)).toBe(true);
    // Editar o prompt no n8n é permitido (é o rascunho de teste).
    expect(await R.estadoConfere({ ...e, promptAgente: 'outro' }, assinatura, cfg)).toBe(true);
    expect(await R.estadoConfere({ ...e, ctx: { ...e.ctx, oportunidadeId: 'outra' } }, assinatura, cfg)).toBe(false);
    expect(await R.estadoConfere({ ...e, ctx: { ...e.ctx, waAccountId: 'outra-conta' } }, assinatura, cfg)).toBe(false);
    expect(await R.estadoConfere(e, assinatura, { ...cfg, telefones: [] })).toBe(false);
    expect(await R.estadoConfere(e, 'x', cfg)).toBe(false);
  });

  it('os pedaços remontam EXATAMENTE o pedido que o sistema monta inteiro', async () => {
    const { montarPedidoPrincipal } = await import('./agente');
    const { paraPedidoOpenai } = await import('./provedorOpenai');
    const cfg = { modelo: 'gpt-5.6-luna', esforco: 'high' };
    const tools = [{ name: 'consulta_disponibilidade', description: 'agenda', input_schema: { type: 'object', properties: {} } }];
    const casos: any[][] = [
      [{ role: 'user', content: 'oi' }],
      [{ role: 'user', content: 'oi' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'consulta_disponibilidade', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"slots_raw":[]}' }] }],
      [{ role: 'user', content: [{ type: 'text', text: 'foto' }, { type: 'text', text: 'Legenda do arquivo: veja' }] }],
    ];
    for (const messages of casos) {
      for (const extra of [{}, { contextoEntregaMateriais: 'MATERIAIS', contextoFicha: 'FICHA', comFicha: true }]) {
        const opts: any = { promptAgente: 'PERSONA', contextoTemporal: 'AGORA', messages, tools, conjunto: 'luna', ...extra };
        const inteiro = paraPedidoOpenai(montarPedidoPrincipal(opts).pedido, cfg);
        const sem = montarPedidoPrincipal({ ...opts, semBlocosDeContexto: true });
        const pecas = P.pecasDe(paraPedidoOpenai(sem.pedido, cfg), sem.contexto, 'PERSONA');
        expect(P.montarDasPecas(pecas)).toEqual(inteiro);
      }
    }
  });

  it('a agenda devolve os dados para o n8n, e eles não entram na conversa', async () => {
    const d = deps();
    let s = await P.montarVolta(d, novoEstado());
    s = await P.lerResposta(d, s.estado, { resposta: chamada('c1', 'consulta_disponibilidade', {}) });
    const chamadas = (s as any).chamadas;
    const r = await P.executarFerramenta(d, s.estado, chamadas[0]);
    await P.gravarResultados(d, s.estado, chamadas, [{ output: { ...r.output, dados: { situacao: 'ok' } }, efeitos: r.efeitos }]);
    const gravado = JSON.stringify(m.gravadas.find((g) => JSON.stringify(g.content).includes('tool_result'))?.content);
    expect(gravado).toContain('10h de quarta');
    expect(gravado).not.toContain('situacao');
  });

  it('depois de confirmar de verdade, a nota das reuniões é relida da agenda (não fica "não há reunião marcada")', async () => {
    const agenda = { data: [] as any[] };
    const d = { ...deps(), supabase: { rpc: async () => ({ data: agenda.data, error: null }) } };
    const e = novoEstado();
    e.notaReunioes = '\n\nREUNIÕES DESTE LEAD NA AGENDA (velha)\nNão há reunião marcada agora.';
    e.contextoEfetivo += e.notaReunioes;
    e.reuniaoMarcadaNaAgenda = false;
    e.tools.push({ name: 'confirmar_agendamento', description: 'agenda', input_schema: { type: 'object', properties: { horario_escolhido: { type: 'string' } } } });
    let s = await P.montarVolta(d as any, e);
    s = await P.lerResposta(d as any, s.estado, { resposta: chamada('c9', 'confirmar_agendamento', { horario_escolhido: '10:00' }) });
    const r = await P.executarFerramenta(d as any, s.estado, (s as any).chamadas[0]);
    agenda.data = [{ id: 'ag-novo', status: 'agendado', resultado_reuniao: null, data_agendamento: '2099-10-01T13:00:00Z', monitor: 'Ana',
      origem: 'API SDR', mudou_em: null, mudou_por: null }];
    s = await P.gravarResultados(d as any, s.estado, (s as any).chamadas, [r]);
    expect(s.estado.agendouNestaRodada).toBe(true);
    expect(s.estado.reuniaoMarcadaNaAgenda).toBe(true);
    expect(s.estado.contextoEfetivo).toContain('com Ana: MARCADA');
    expect(s.estado.contextoEfetivo).not.toContain('(velha)');
  });
});
