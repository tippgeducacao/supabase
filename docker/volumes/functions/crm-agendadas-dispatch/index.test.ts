import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTOR_REENVIO_MATERIAL } from '../_shared/reenvioMaterial';

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), fetch: vi.fn() }));
vi.mock('https://esm.sh/@supabase/supabase-js@2.49.4', () => ({ createClient: () => mocks }));
let handler: (req: Request) => Promise<Response>;
let linha: Record<string, unknown>;
let pausado: boolean;
let optout: boolean;
let flags: Record<string, unknown>;
let ultimoInbound: string;
let outroEnvio: Record<string, unknown> | null;
let erroLeitura: unknown;
let alteracoes: Record<string, unknown>[];
let consultas: Array<{ tabela: string; filtros: unknown[][] }>;
const agora = new Date('2030-01-01T12:00:00Z');

beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: () => 'sintetico' }, serve: (h: typeof handler) => { handler = h; } });
  vi.stubGlobal('fetch', mocks.fetch);
  await import('./index');
});
afterAll(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(agora);
  pausado = false; optout = false; flags = {}; outroEnvio = null; erroLeitura = null;
  ultimoInbound = '2030-01-01T11:50:00Z'; alteracoes = []; consultas = [];
  linha = { id: 'fila-1', telefone: '5511999990001', wa_account_id: 'conta-1',
    tipo_mensagem: 'midia', criado_por_nome: AUTOR_REENVIO_MATERIAL, criado_em: '2030-01-01T11:55:00Z',
    anexo_url: 'https://materiais.invalid/cronograma.pdf', filename: 'cronograma.pdf', mime_type: 'application/pdf' };
  mocks.rpc.mockImplementation(async (nome: string) => ({ data: nome === 'crm_agendadas_claim' ? [linha] : flags, error: null }));
  mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({ success: true, wa_message_id: 'wamid.reenvio' })));
  mocks.from.mockImplementation((tabela: string) => {
    const filtros: unknown[][] = [];
    consultas.push({ tabela, filtros });
    const resultado = () => ({ data: tabela === 'cliente_ppg_leads_sdr' ? [{ pausa_ia: pausado, nao_perturbe: optout }]
      : tabela === 'crm_whatsapp_messages' ? filtros.some((f) => f[0] === 'direcao' && f[1] === 'outbound') ? outroEnvio : { created_at: ultimoInbound }
      : null, error: tabela === 'crm_whatsapp_messages' ? erroLeitura : null });
    const q = {
      select: () => q,
      update: (dados: Record<string, unknown>) => { alteracoes.push(dados); return q; },
      eq: (...args: unknown[]) => { filtros.push(args); return q; },
      in: (...args: unknown[]) => { filtros.push(args); return q; },
      contains: (...args: unknown[]) => { filtros.push(args); return q; },
      gte: (...args: unknown[]) => { filtros.push(args); return q; },
      neq: () => q, lt: () => q, order: () => q, limit: () => q,
      maybeSingle: async () => resultado(),
      then: (resolver: (r: ReturnType<typeof resultado>) => unknown) => Promise.resolve(resultado()).then(resolver),
    };
    return q;
  });
});
async function chamar() {
  const res = await handler(new Request('https://supabase.invalid/dispatch', { method: 'POST', headers: { Authorization: 'Bearer sintetico' } }));
  expect(res.status).toBe(200);
  return (await res.json()).results['fila-1'];
}

describe('reenvio do cronograma na fila real, com transporte simulado', () => {
  it('envia pela conta original e registra o aceite com id', async () => {
    expect(await chamar()).toBe('enviado');
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toMatchObject({
      mensagem_agendada_id: 'fila-1', wa_account_id: 'conta-1', tipo: 'document', anexo_url: linha.anexo_url,
    });
    expect(alteracoes.at(-1)).toMatchObject({ status: 'enviado', wa_message_id: 'wamid.reenvio' });
    expect(consultas.filter((q) => q.tabela === 'crm_whatsapp_messages').every((q) =>
      q.filtros.some((f) => f[0] === 'wa_account_id' && f[1] === 'conta-1'))).toBe(true);
  });
  it('recusa transitória registra nova tentativa trinta minutos depois', async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ error: 'Serviço indisponível', meta_code: 131016 }), { status: 422 }));
    expect(await chamar()).toBe('reagendado');
    expect(alteracoes.at(-1)).toMatchObject({ status: 'agendado', enviar_em: '2030-01-01T12:30:00.000Z' });
  });
  it.each([200, 502])('resposta sem confirmação HTTP %s não duplica automaticamente', async (status) => {
    mocks.fetch.mockResolvedValue(new Response('{}', { status }));
    expect(await chamar()).toMatch(/^erro:/);
    expect(alteracoes.at(-1)?.status).toBe('erro');
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });
  it('timeout não vira sucesso nem outro retry', async () => {
    mocks.fetch.mockRejectedValue(new Error('Timeout simulado'));
    expect(await chamar()).toMatch(/^erro:/);
    expect(alteracoes.at(-1)?.status).toBe('erro');
  });
  it.each(['pausa', 'optout', 'arquivado', 'timer'])('cancela se o contato está em %s', async (motivo) => {
    pausado = motivo === 'pausa'; optout = motivo === 'optout';
    flags = { arquivado: motivo === 'arquivado', timer_ativo: motivo === 'timer' };
    expect(await chamar()).toBe('cancelado');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it.each(['janela', 'prazo', 'banco', 'conta'])('não envia com impedimento de %s', async (motivo) => {
    if (motivo === 'janela') ultimoInbound = '2029-12-31T12:00:00Z';
    if (motivo === 'prazo') linha.criado_em = '2030-01-01T10:59:00Z';
    if (motivo === 'banco') erroLeitura = { message: 'Indisponível' };
    if (motivo === 'conta') linha.wa_account_id = null;
    expect(await chamar()).toMatch(/^erro:/);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('cancela a pendência se alguém já enviou o mesmo arquivo depois dela', async () => {
    outroEnvio = { id: 'outro-envio' };
    expect(await chamar()).toBe('cancelado');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('preserva o envio normal das mensagens agendadas por operadores', async () => {
    linha.criado_por_nome = 'Operador'; linha.tipo_mensagem = 'texto'; linha.conteudo = 'Olá';
    expect(await chamar()).toBe('enviado');
    expect(consultas.some((q) => q.tabela === 'cliente_ppg_leads_sdr')).toBe(false);
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toMatchObject({ tipo: 'text', conteudo: 'Olá' });
  });
});
