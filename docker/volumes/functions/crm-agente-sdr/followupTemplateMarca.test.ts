import { beforeEach, expect, it, vi } from 'vitest';

// Ordem marca → envio do toque de template: sem banco, sem WhatsApp.
const ordem: string[] = [];
const atualizarLead = vi.fn(async (_s: unknown, _j: string, patch: Record<string, unknown>) => { ordem.push(`marca:${JSON.stringify(patch)}`); });
vi.mock('./historico.ts', () => ({
  atualizarLead,
  buscarLead: async () => ({
    remotejid: '5511999990001@s.whatsapp.net', followup_ativado: true, iniciar_atendimento: true,
    timestamp_mensagem: '2000-01-01T00:00:00Z', template_followup_em: '1999-12-30T00:00:00Z',
  }),
}));
vi.mock('./conta.ts', () => ({ contaDoLead: async () => 'conta-1', phoneVariants: (t: string) => [t] }));
vi.mock('./eventos.ts', () => ({ criarTelemetria: () => ({ rodadaId: 'r', registrar: vi.fn() }) }));
vi.mock('./fila.ts', () => ({ chaveResgateTemplate: vi.fn(), chaveTemplate: vi.fn(), enfileirarFollowups: vi.fn() }));
vi.stubGlobal('Deno', { env: { get: () => undefined } });

const { processarFollowupTemplateEnfileirado } = await import('./followup-template.ts');

const supabase = {
  rpc: async (nome: string) => ({ data: nome === 'crm_agente_sdr_lock_claim' ? true : {}, error: null }),
  from: () => {
    const q: Record<string, unknown> = {
      select: () => q, eq: () => q, delete: () => q,
      order: async () => ({ data: [{ toque: 1, dia: 1, template_name: 'tpl_1', regua_wa_account_id: 'conta-1', variaveis: [] }], error: null }),
      then: (ok: (r: unknown) => unknown) => Promise.resolve({ error: null }).then(ok),
    };
    return q;
  },
};

beforeEach(() => { ordem.length = 0; atualizarLead.mockClear(); });

it('marca o toque antes de enviar e mantém a marca quando o envio sai', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { ordem.push('envio'); return new Response('{}', { status: 200 }); }));
  const ok = await processarFollowupTemplateEnfileirado(supabase, { remotejid: '5511999990001@s.whatsapp.net', toque: 1, resgate: false, conta: null });
  expect(ok).toBe(true);
  expect(ordem[0]).toContain('"template_1_dia":true');
  expect(ordem[1]).toBe('envio');
  expect(ordem).toHaveLength(2);
});

it('desfaz a marca quando a Meta recusa o envio', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { ordem.push('envio'); return new Response('{"meta_code":132015}', { status: 422 }); }));
  const ok = await processarFollowupTemplateEnfileirado(supabase, { remotejid: '5511999990001@s.whatsapp.net', toque: 1, resgate: false, conta: null });
  expect(ok).toBe(false);
  expect(ordem[1]).toBe('envio');
  expect(atualizarLead).toHaveBeenLastCalledWith(supabase, '5511999990001@s.whatsapp.net',
    { template_1_dia: false, template_followup_em: '1999-12-30T00:00:00Z' });
});
