import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('https://esm.sh/@supabase/supabase-js@2.45.0', () => ({ createClient: () => db }));
vi.mock('../_shared/gmail.ts', () => ({
  ensureToken: async () => 'token-sintetico', parsePayload: vi.fn(), parseHeaders: vi.fn(),
  parseAddress: vi.fn(), parseAddressList: vi.fn(), isTokenRevokedError: () => false,
  markCaixaTokenRevoked: vi.fn(), markCaixaTransient: vi.fn(),
  isScopeInsufficientError: () => false, markCaixaEscopoInsuficiente: vi.fn(),
}));
let handler: (req: Request) => Promise<Response>;
let autoriza = true;
let livre = true;
let history: string | null = '10';
let falhar = false;
let escritas: unknown[] = [];
beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: () => 'sintetico' }, serve: (fn: typeof handler) => { handler = fn; } });
  await import('./index.ts');
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  autoriza = true; livre = true; history = '10'; falhar = false; escritas = [];
  vi.clearAllMocks();
  db.rpc.mockImplementation(async (nome: string) => ({ data: nome === 'email_sync_validar_cron' ? autoriza : livre, error: null }));
  db.from.mockImplementation((tabela: string) => {
    const resultado = () => ({ data: tabela === 'sac_v2_email_rotas' ? [{ caixa_id: 'caixa' }] :
      tabela === 'email_caixas_conectadas' ? { id: 'caixa', ativo: true, provider: 'gmail', history_id: history, integ: {} } : [], error: null });
    const q = {
      select: () => q, eq: () => q, in: () => q, range: () => q,
      update: (v: unknown) => { escritas.push(v); return q; },
      maybeSingle: async () => resultado(),
      then: (fn: (v: unknown) => unknown) => Promise.resolve(resultado()).then(fn),
    };
    return q;
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    expect(url).toContain('/history?');
    if (falhar) return new Response('histórico expirado', { status: 404 });
    return Response.json({ historyId: '11', history: [] });
  }));
});
const chamar = () => handler(new Request('https://teste.invalid/sync', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-email-sync-secret': 'segredo-sintetico' },
  body: JSON.stringify({ rapido: true }),
}));

describe('sincronização rápida do atendimento', () => {
  it('consulta só o delta e não varre estados/pastas da caixa', async () => {
    expect((await chamar()).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(escritas).toEqual([expect.objectContaining({ history_id: '11' })]);
    expect(db.from.mock.calls.map(([t]) => t)).not.toContain('email_threads');
    expect(db.rpc).toHaveBeenCalledWith('email_sync_liberar', expect.objectContaining({ p_caixa: 'caixa' }));
  });
  it('rejeita cron sem autorização antes de consultar caixas', async () => {
    autoriza = false;
    expect((await chamar()).status).toBe(401);
    expect(db.from).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('não inicia outro processamento enquanto a caixa está ocupada', async () => {
    livre = false;
    expect((await (await chamar()).json()).results[0].reason).toBe('em_andamento');
    expect(fetch).not.toHaveBeenCalled();
    expect(escritas).toEqual([]);
  });
  it('deixa a carga inicial para a rotina completa', async () => {
    history = null;
    expect((await (await chamar()).json()).results[0].reason).toBe('aguardando_sync_completo');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('libera a posse após erro sem avançar cursor nem iniciar varredura completa', async () => {
    falhar = true;
    const result = await (await chamar()).json();
    expect(result.results[0].error).toContain('gmail_404');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(escritas).toEqual([]);
    expect(db.rpc).toHaveBeenLastCalledWith('email_sync_liberar', expect.objectContaining({ p_caixa: 'caixa' }));
  });
});
