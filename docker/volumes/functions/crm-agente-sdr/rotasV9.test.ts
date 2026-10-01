import { beforeAll, describe, expect, it, vi } from 'vitest';

let ehAcaoV9: typeof import('./rotasV9').ehAcaoV9;
let rotaV9: typeof import('./rotasV9').rotaV9;
beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: () => '' } });
  ({ ehAcaoV9, rotaV9 } = await import('./rotasV9'));
});

describe('rotas do formato v9', () => {
  it('reconhece só as ações do v9', () => {
    expect(ehAcaoV9('lead')).toBe(true);
    expect(ehAcaoV9('iniciar')).toBe(false);
  });
  it('gravar_mensagem exige role; tool exige id e nome', async () => {
    const deps = { supabase: {}, provedorDoLead: async () => null };
    expect((await rotaV9('gravar_mensagem', { remotejid: '5546988166051@s.whatsapp.net', conversation_history: {} }, deps)).status).toBe(400);
    expect((await rotaV9('tool', { remotejid: '5546988166051@s.whatsapp.net', chamada: { name: 'x' } }, deps)).status).toBe(400);
  });
  it('luna recusa telefone fora do canário', async () => {
    const deps = { supabase: {}, provedorDoLead: async () => null };
    expect((await rotaV9('luna', { remotejid: '5546988166051@s.whatsapp.net', pedido: {} }, deps)).status).toBe(409);
  });
});
