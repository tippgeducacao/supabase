import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEXTOS } from './fluxo';
import { IG_WA_ACCOUNT_ID } from '../_shared/igWhatsapp';

// Exercita o ig-agente de ponta a ponta com banco, rede e classificador simulados:
// nenhuma DM sai de verdade, nenhuma linha é escrita.
type Linha = Record<string, any>;
const mocks = vi.hoisted(() => ({
  classificar: vi.fn(),
  fetch: vi.fn(),
  rpc: vi.fn(),
  estado: {} as {
    config: Linha | null; conta: Linha | null; perfil: Linha | null; segredo: Linha | null;
    mensagens: Linha[]; conversa: Linha | null; conversaComErro?: boolean;
    escritas: { tabela: string; op: string; payload: any; filtros: Record<string, unknown>; violacao?: string }[];
  },
}));

// Os CHECKs das tabelas REAIS. Sem eles este teste passou gravando status_entrega =
// 'enviado', que o banco recusa — e em produção a IA se pausou depois da 1ª resposta
// (24/09/2026), porque o eco da própria mensagem ficou parecendo de um humano.
const ETAPAS = ['boas_vindas', 'pergunta_formacao', 'pergunta_data_formacao', 'pergunta_interesse', 'pergunta_whatsapp', 'escola_enviada', 'whatsapp_enviado', 'encerrada'];
const CHECKS: Record<string, (p: Linha) => string | null> = {
  ig_mensagens: (p) => {
    if (!['sent', 'delivered', 'read', 'failed'].includes(p.status_entrega ?? 'sent')) return 'ig_mensagens_status_entrega_check';
    if (!['inbound', 'outbound'].includes(p.direcao)) return 'ig_mensagens_direcao_check';
    return null;
  },
  ig_conversa_ia: (p) => {
    if (p.estagio !== undefined && !['validacao', 'qualificador'].includes(p.estagio)) return 'ig_conversa_ia_estagio_check';
    if (p.fluxo_etapa !== undefined && !ETAPAS.includes(p.fluxo_etapa)) return 'ig_conversa_ia_fluxo_etapa_check';
    if (p.situacao != null && !['formado', 'estudante'].includes(p.situacao)) return 'ig_conversa_ia_situacao_check';
    return null;
  },
};

// Query builder mínimo do supabase-js: guarda filtros e responde conforme a tabela.
function builder(tabela: string) {
  const q: any = { op: 'select', filtros: {} as Record<string, unknown>, payload: null, violacao: null };
  const e = mocks.estado;
  const resolver = (single: boolean) => {
    if (q.violacao) return { data: null, error: { message: `new row violates check constraint "${q.violacao}"` } };
    if (q.op === 'upsert' || q.op === 'insert') return { data: null, error: null };
    if (q.op === 'update') {
      if (tabela === 'ig_conversa_ia' && e.conversa) {
        const bate = Object.entries(q.filtros).every(([k, v]) => {
          const campo = k.replace(/^eq:/, '');
          return !(campo in e.conversa!) || e.conversa![campo] === v;
        });
        if (bate) {
          Object.assign(e.conversa, q.payload);
          return { data: [{ igsid: e.conversa.igsid }], error: null };
        }
      }
      return { data: [], error: null };
    }
    let dado: unknown = null;
    if (tabela === 'ig_agente_config') dado = e.config;
    else if (tabela === 'ig_contas') dado = e.conta;
    else if (tabela === 'ig_perfis') dado = e.perfil;
    else if (tabela === 'ig_contas_secrets') dado = e.segredo;
    else if (tabela === 'ig_conversa_ia') {
      if (e.conversaComErro) return { data: null, error: { message: 'banco fora' } };
      dado = e.conversa;
    } else if (tabela === 'ig_mensagens') {
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
    q.violacao = CHECKS[tabela]?.(payload) ?? null;
    e.escritas.push({ tabela, op, payload, filtros: q.filtros, ...(q.violacao ? { violacao: q.violacao } : {}) });
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
vi.mock('./classificador.ts', () => ({ classificar: mocks.classificar }));

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
const neutra = { intencao: 'outro', situacao: 'nao_informou', area: null, telefone: null, conclusao: null, resposta_pergunta: null };
let reservas: Linha[];
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  mocks.estado = {
    config: { modo: 'teste', usernames_teste: ['sutil_gu'], debounce_segundos: 0 },
    conta: { ig_user_id: '17841453422080445', ativo: true, agente_ia_ativo: true },
    perfil: { username: 'sutil_gu', nome: 'Gustavo Sutil' },
    segredo: { access_token: 'IGAA-sintetico' },
    mensagens: [{ mid: 'm1', direcao: 'inbound', tipo: 'text', conteudo: 'quero!', created_at: INBOUND_EM }],
    conversa: { igsid: '999', pausada: false, fluxo_etapa: 'boas_vindas', fluxo_tentativas: 0, situacao: null, respondido_ate: null, historico_desde: null },
    escritas: [],
  };
  reservas = [
    { status: 'reservada', ultimo_inbound_em: INBOUND_EM, estagio: 'validacao', historico_desde: null, teste_tool_chamadas: [] },
    { status: 'sem_pendencia' },
  ];
  mocks.rpc.mockImplementation(async (nome: string) => (nome === 'ig_ia_reservar'
    ? { data: reservas.shift() ?? { status: 'sem_pendencia' }, error: null }
    : nome === 'ig_whatsapp_capturar'
    ? { data: { lead_id: 'lead-1', oportunidade_id: 'op-1', lead_novo: true, card_novo: true }, error: null }
    : { data: true, error: null }));
  mocks.classificar.mockResolvedValue({ classificacao: { ...neutra, intencao: 'aceita' }, erro: null, modelo: 'gpt-5.6-luna' });
  let n = 0;
  mocks.fetch.mockImplementation(async (url: string) => (String(url).includes('crm-whatsapp-send')
    ? new Response(JSON.stringify({ ok: true, wa_message_id: 'wamid.recibo' }))
    : new Response(JSON.stringify({ recipient_id: '999', message_id: `saida-${++n}` }))));
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
const chamadasInstagram = () => mocks.fetch.mock.calls.filter(([url]) => String(url).includes('graph.instagram.com'));
const textosEnviados = () => chamadasInstagram().map(([, init]) => JSON.parse(init.body).message.text);
const envioDoRecibo = () => mocks.fetch.mock.calls.find(([url]) => String(url).includes('crm-whatsapp-send'));
const liberacao = () => mocks.rpc.mock.calls.find(([nome]) => nome === 'ig_ia_liberar')?.[1];
const captura = () => mocks.rpc.mock.calls.find(([nome]) => nome === 'ig_whatsapp_capturar')?.[1];
// A gravação da etapa é a de quem segura a trava (filtro por reserva_token); a marca do
// recibo, feita antes, não conta.
const gravacaoDaEtapa = () => mocks.estado.escritas.find((w) => w.tabela === 'ig_conversa_ia' && w.op === 'update' && 'eq:reserva_token' in w.filtros);
const marcaDoRecibo = () => mocks.estado.escritas.find((w) => w.tabela === 'ig_conversa_ia' && w.op === 'update' && 'recibo_enviado_em' in (w.payload ?? {}));

describe('ig-agente: o roteiro do direct', () => {
  it('resposta à boas-vindas → pergunta da formação com o nome, e a etapa anda', async () => {
    expect((await inbound()).status).toBe(200);
    expect(mocks.classificar).toHaveBeenCalledWith('boas_vindas', [], ['quero!']);
    expect(textosEnviados()).toEqual([TEXTOS.apresentacao, TEXTOS.perguntaFormacao('Gustavo')]);
    expect(mocks.fetch.mock.calls[0][0]).toContain('graph.instagram.com');
    expect(mocks.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer IGAA-sintetico');

    const saida = mocks.estado.escritas.find((w) => w.tabela === 'ig_mensagens');
    expect(saida).toMatchObject({ op: 'upsert', payload: { mid: 'saida-1', status_entrega: 'sent' } });
    expect(saida!.payload.metadata).toMatchObject({ origem: 'ia', modo_teste: true, fluxo_etapa: 'pergunta_formacao' });

    // A etapa só é gravada por quem segura a trava.
    expect(gravacaoDaEtapa()).toMatchObject({ payload: { fluxo_etapa: 'pergunta_formacao', fluxo_tentativas: 0 } });
    expect(Object.keys(gravacaoDaEtapa()!.filtros)).toContain('eq:reserva_token');
    expect(liberacao()).toMatchObject({ p_respondido_ate: INBOUND_EM, p_estagio: null });
    expect(liberacao().p_tools[0]).toMatchObject({ nome: 'roteiro', etapa: 'boas_vindas', proxima: 'pergunta_formacao', modelo: 'gpt-5.6-luna' });
  });

  it('só as mensagens NOVAS vão para o classificador; o resto é contexto', async () => {
    mocks.estado.conversa!.respondido_ate = '2026-09-24T11:59:00.000Z';
    mocks.estado.mensagens = [
      { mid: 'm0', direcao: 'inbound', tipo: 'text', conteudo: 'oi', created_at: '2026-09-24T11:58:00.000Z' },
      { mid: 'e0', direcao: 'outbound', tipo: 'text', conteudo: 'Quer receber o acesso?', created_at: '2026-09-24T11:58:30.000Z' },
      { mid: 'm1', direcao: 'inbound', tipo: 'text', conteudo: 'quero!', created_at: INBOUND_EM },
    ];
    await inbound();
    expect(mocks.classificar).toHaveBeenCalledWith('boas_vindas',
      [{ role: 'user', text: 'oi' }, { role: 'assistant', text: 'Quer receber o acesso?' }], ['quero!']);
  });

  it('passou o WhatsApp → card no CRM + RECIBO no WhatsApp, e só então confirma no direct', async () => {
    vi.setSystemTime(new Date('2026-09-25T15:00:00Z'));
    Object.assign(mocks.estado.conversa!, { fluxo_etapa: 'pergunta_whatsapp', situacao: 'formado' });
    mocks.estado.mensagens[0].conteudo = '46 9 9988-2268';
    mocks.classificar.mockResolvedValue({ classificacao: neutra, erro: null });
    await inbound();

    expect(captura()).toMatchObject({
      p_conta_id: 'conta-1', p_igsid: '999', p_telefone: '5546999882268', p_nome: 'Gustavo Sutil',
      p_etapa_crm: 'Formados', p_data_formacao: null, p_wa_account_id: IG_WA_ACCOUNT_ID,
    });
    const [url, init] = envioDoRecibo()!;
    expect(url).toBe('https://supabase.invalid/functions/v1/crm-whatsapp-send');
    expect(init.headers.Authorization).toBe(`Bearer ${SERVICE}`);
    expect(JSON.parse(init.body)).toEqual({
      wa_account_id: IG_WA_ACCOUNT_ID, telefone: '5546999882268', tipo: 'template',
      template_name: 'comprovante_cadastro_utility', template_lang: 'pt_BR',
      template_components: [{ type: 'body', parameters: [
        { type: 'text', text: 'Gustavo' }, { type: 'text', text: 'Veterinária e Agro' }, { type: 'text', text: '25/09/2026, pelo Instagram' },
      ] }],
      lead_id: 'lead-1', oportunidade_id: 'op-1',
    });
    // O recibo sai ANTES da frase do direct: a IA só diz "te mandei" depois de mandar.
    const ordem = mocks.fetch.mock.calls.map(([u]) => (String(u).includes('crm-whatsapp-send') ? 'recibo' : 'direct'));
    expect(ordem).toEqual(['recibo', 'direct']);
    expect(textosEnviados()).toEqual([TEXTOS.confirmacaoWhatsapp]);
    expect(TEXTOS.confirmacaoWhatsapp).toContain('(46) 9 9901-2001');

    // O PDF fica pendente até a pessoa responder no WhatsApp (o webhook procura pelo telefone).
    expect(marcaDoRecibo()!.payload).toMatchObject({ telefone: '5546999882268', recibo_erro: null, portfolio_enviado_em: null });
    expect(marcaDoRecibo()!.payload.recibo_enviado_em).toBeTruthy();
    expect(gravacaoDaEtapa()!.payload).toMatchObject({ fluxo_etapa: 'whatsapp_enviado', telefone: '5546999882268' });
    expect(liberacao().p_tools[0].whatsapp).toMatchObject({ ok: true, situacao: 'formado', etapa_crm: 'Formados', lead_id: 'lead-1' });
  });

  it('o recibo NÃO saiu (Meta recusou) → não diz "te mandei"; pede o número de novo', async () => {
    Object.assign(mocks.estado.conversa!, { fluxo_etapa: 'pergunta_whatsapp', situacao: 'formado' });
    mocks.estado.mensagens[0].conteudo = '46 9 9988-2268';
    mocks.classificar.mockResolvedValue({ classificacao: neutra, erro: null });
    const direct = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (url: string, init: any) => (String(url).includes('crm-whatsapp-send')
      ? new Response(JSON.stringify({ error: 'Recipient phone number not in allowed list', meta_code: 131030 }), { status: 422 })
      : direct(url, init)));
    await inbound();
    expect(textosEnviados()).toEqual([TEXTOS.whatsappNaoFoi]);
    expect(gravacaoDaEtapa()!.payload).toMatchObject({ fluxo_etapa: 'pergunta_whatsapp' });
    expect(gravacaoDaEtapa()!.payload.telefone).toBeUndefined();
    expect(marcaDoRecibo()).toBeUndefined();
    const erro = mocks.estado.escritas.find((w) => w.tabela === 'ig_conversa_ia' && 'recibo_erro' in (w.payload ?? {}));
    expect(erro!.payload.recibo_erro).toContain('131030');
    expect(liberacao().p_tools[0]).toMatchObject({ proxima: 'pergunta_whatsapp', whatsapp: { ok: false } });
  });

  it('o CRM falhou → nem manda o recibo; pede o número de novo', async () => {
    Object.assign(mocks.estado.conversa!, { fluxo_etapa: 'pergunta_whatsapp', situacao: 'formado' });
    mocks.estado.mensagens[0].conteudo = '46 9 9988-2268';
    mocks.classificar.mockResolvedValue({ classificacao: neutra, erro: null });
    const padrao = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (nome: string, args: any) => (nome === 'ig_whatsapp_capturar'
      ? { data: null, error: { message: 'telefone inválido' } }
      : padrao(nome, args)));
    await inbound();
    expect(envioDoRecibo()).toBeUndefined();
    expect(textosEnviados()).toEqual([TEXTOS.whatsappNaoFoi]);
    expect(gravacaoDaEtapa()!.payload).toMatchObject({ fluxo_etapa: 'pergunta_whatsapp' });
  });

  it('formado → pergunta se quer o portfólio; "sim" → pede o WhatsApp (o PDF não vai pelo insta)', async () => {
    mocks.estado.conversa!.fluxo_etapa = 'pergunta_formacao';
    mocks.classificar.mockResolvedValueOnce({ classificacao: { ...neutra, situacao: 'formado', area: 'medicina veterinária' }, erro: null, modelo: 'gpt-5.6-luna' });
    await inbound();
    expect(textosEnviados()).toEqual([TEXTOS.perguntaInteresse]);
    expect(gravacaoDaEtapa()!.payload).toMatchObject({ fluxo_etapa: 'pergunta_interesse', situacao: 'formado' });
  });

  it('"sim" na pergunta do portfólio → pede o WhatsApp', async () => {
    mocks.estado.conversa!.fluxo_etapa = 'pergunta_interesse';
    await inbound();
    expect(textosEnviados()).toEqual([TEXTOS.pedirWhatsapp]);
    expect(gravacaoDaEtapa()!.payload).toMatchObject({ fluxo_etapa: 'pergunta_whatsapp' });
  });

  it('estudante diz quando se forma → a data é gravada e a pergunta do portfólio sai', async () => {
    Object.assign(mocks.estado.conversa!, { fluxo_etapa: 'pergunta_data_formacao', situacao: 'estudante' });
    mocks.estado.mensagens[0].conteudo = 'me formo em julho de 2027';
    mocks.classificar.mockResolvedValue({ classificacao: neutra, erro: null, modelo: 'gpt-5.6-luna' });
    await inbound();
    expect(textosEnviados()).toEqual([TEXTOS.perguntaInteresse]);
    expect(gravacaoDaEtapa()!.payload).toMatchObject({ fluxo_etapa: 'pergunta_interesse', data_formacao: '2027-07-31' });
  });

  it('estudante de vet que forma em julho/2027 passa o número → card em "Forma em 2027/06"', async () => {
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'));
    Object.assign(mocks.estado.conversa!, { fluxo_etapa: 'pergunta_whatsapp', situacao: 'estudante', area: 'veterinária', data_formacao: '2027-07-31' });
    mocks.estado.mensagens[0].conteudo = '46 9 9988-2268';
    mocks.classificar.mockResolvedValue({ classificacao: neutra, erro: null, modelo: 'gpt-5.6-luna' });
    await inbound();
    expect(captura()).toMatchObject({ p_etapa_crm: 'Forma em 2027/06', p_data_formacao: '2027-07-31', p_area: 'veterinária' });
    expect(JSON.parse(envioDoRecibo()![1].body).template_components[0].parameters[1]).toEqual({ type: 'text', text: 'Medicina Veterinária' });
    expect(liberacao().p_tools[0].whatsapp).toMatchObject({
      ok: true, situacao: 'estudante', data_formacao: '2027-07-31', etapa_crm: 'Forma em 2027/06',
    });
  });

  it('nem formado nem estudante → link da Escola e fim, sem WhatsApp', async () => {
    mocks.estado.conversa!.fluxo_etapa = 'pergunta_formacao';
    mocks.classificar.mockResolvedValue({ classificacao: { ...neutra, situacao: 'nenhum' }, erro: null });
    await inbound();
    expect(textosEnviados()).toEqual([TEXTOS.escola]);
    expect(gravacaoDaEtapa()!.payload).toMatchObject({ fluxo_etapa: 'escola_enviada' });
    expect(liberacao().p_tools[0].whatsapp).toBeUndefined();
  });

  it('classificador fora do ar → segue com a classificação neutra (repergunta), sem desculpa', async () => {
    mocks.estado.conversa!.fluxo_etapa = 'pergunta_formacao';
    mocks.classificar.mockResolvedValue({ classificacao: neutra, erro: 'Anthropic HTTP 529' });
    await inbound();
    expect(textosEnviados()).toEqual([TEXTOS.reperguntarFormacao]);
    expect(liberacao().p_tools[0]).toMatchObject({ erro_classificador: 'Anthropic HTTP 529' });
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
    expect(mocks.classificar).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('modo ligado, conversa que o TIME começou: a IA fica de fora (26/09/2026)', async () => {
    mocks.estado.config = { modo: 'ligado', usernames_teste: [], debounce_segundos: 0 };
    mocks.estado.perfil = { username: 'lead.qualquer', nome: 'Ana' };
    mocks.estado.conversa = null;
    mocks.estado.mensagens.unshift({ mid: 'm0', direcao: 'outbound', tipo: 'text', metadata: { origem: 'humano' },
      conteudo: 'Sou a Flávia aqui da PPGVET! 💜 Vi seu perfil e notei que é da área da veterinária', created_at: '2026-09-24T11:00:00.000Z' });
    await inbound();
    expect(mocks.classificar).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('modo ligado, conversa aberta pelo ManyChat ("Oii, tudo bem?"): a IA responde qualquer @', async () => {
    mocks.estado.config = { modo: 'ligado', usernames_teste: [], debounce_segundos: 0 };
    mocks.estado.perfil = { username: 'lead.qualquer', nome: 'Ana' };
    mocks.estado.conversa = null;
    mocks.estado.mensagens.unshift({ mid: 'm0', direcao: 'outbound', tipo: 'text', metadata: { origem: 'humano' },
      conteudo: 'Oii, tudo bem?', created_at: '2026-09-24T11:00:00.000Z' });
    await inbound();
    expect(mocks.classificar).toHaveBeenCalledTimes(1);
  });

  it('chegou mensagem mais nova: a execução dela responde, não esta', async () => {
    mocks.estado.mensagens.push({ mid: 'm2', direcao: 'inbound', tipo: 'text', conteudo: 'e o valor?', created_at: '2026-09-24T12:00:03.000Z' });
    await inbound('m1');
    expect(mocks.classificar).not.toHaveBeenCalled();
  });

  it('reação mais nova não rouba a vez da mensagem', async () => {
    mocks.estado.mensagens.push({ mid: 'r1', direcao: 'inbound', tipo: 'reaction', conteudo: '❤️', created_at: '2026-09-24T12:00:03.000Z' });
    await inbound('m1');
    expect(mocks.classificar).toHaveBeenCalledTimes(1);
  });

  it('pedido sem service_role é recusado', async () => {
    const r = await chamar({ evento: 'inbound', conta_id: 'conta-1', igsid: '999', mid: 'm1' }, 'anon');
    expect(r.status).toBe(401);
    expect(mocks.classificar).not.toHaveBeenCalled();
  });
});

describe('ig-agente: envio', () => {
  it('humano assumiu no meio da rodada: para de mandar balão', async () => {
    mocks.classificar.mockResolvedValue({ classificacao: { ...neutra, intencao: 'pergunta', resposta_pergunta: 'É gratuita, sim!' }, erro: null });
    mocks.fetch.mockImplementationOnce(async () => {
      mocks.estado.conversa!.pausada = true;
      return new Response(JSON.stringify({ message_id: 'saida-1' }));
    });
    await inbound();
    expect(textosEnviados()).toEqual([TEXTOS.apresentacao]);
    expect(liberacao()).toMatchObject({ p_respondido_ate: INBOUND_EM });
  });

  it('token morto: grava a falha e NÃO dá a mensagem nem a etapa como resolvidas', async () => {
    mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({
      error: { message: 'Error validating access token', code: 190 },
    }), { status: 400 }));
    await inbound();
    expect(textosEnviados()).toEqual([TEXTOS.apresentacao]);
    const falha = mocks.estado.escritas.find((w) => w.tabela === 'ig_mensagens');
    expect(falha).toMatchObject({ op: 'insert', payload: { status_entrega: 'failed', mid: null } });
    expect(gravacaoDaEtapa()).toBeUndefined();
    expect(liberacao()).toMatchObject({ p_respondido_ate: null });
  });

  it('banco fora ao ler o estado: manda a desculpa, marcada como sistema', async () => {
    mocks.estado.conversaComErro = true;
    await inbound();
    expect(textosEnviados()).toEqual(['Desculpa, tive um problema aqui e não consegui responder. Pode mandar de novo? 🙏']);
    const saida = mocks.estado.escritas.find((w) => w.tabela === 'ig_mensagens');
    expect(saida!.payload.metadata).toMatchObject({ origem: 'sistema' });
    expect(saida!.payload.metadata.erro_cerebro).toContain('banco fora');
  });
});

describe('ig-agente: /reset', () => {
  it('zera a conversa e o roteiro, tira a pausa e confirma — sem classificar', async () => {
    mocks.estado.mensagens[0].conteudo = ' /RESET ';
    await inbound();
    expect(mocks.classificar).not.toHaveBeenCalled();
    const reset = mocks.estado.escritas.find((w) => w.tabela === 'ig_conversa_ia');
    expect(reset).toMatchObject({
      op: 'upsert',
      payload: { pausada: false, fluxo_etapa: 'boas_vindas', fluxo_tentativas: 0, situacao: null, telefone: null, teste_tool_chamadas: [] },
    });
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
