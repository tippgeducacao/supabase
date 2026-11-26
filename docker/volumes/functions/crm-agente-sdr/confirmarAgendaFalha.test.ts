import { beforeAll, expect, it, vi } from 'vitest';

// Agenda do Google falhando DEPOIS de a reunião existir: sem banco, sem rede real.
vi.mock('./agente.ts', () => ({ chamarAnthropic: vi.fn() }));
vi.mock('./elegibilidadeAgendamento.ts', async (original) => ({
  ...(await original<typeof import('./elegibilidadeAgendamento.ts')>()),
  consultarAprovacao: vi.fn(async () => ({ aprovada: true, avaliacaoId: 'avaliacao-1' })),
}));

let executarTool: typeof import('./tools.ts').executarTool;
beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: (k: string) => (k === 'AGENTE_SDR_SDRAPI_URL' ? 'https://sdr-api.invalid' : undefined) } });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {
    id: 'ag-1', vendedor_id: 'vend-1', vendedor: { name: 'Monitor Teste' },  // sem id_calendar ⇒ agenda falha
    data_agendamento: '2030-01-02T13:00:00Z', link_reuniao: 'https://meet.invalid/abc',
  } })));
  ({ executarTool } = await import('./tools.ts'));
});

it('agenda do Google falhou após criar a reunião: devolve o agendamento e a confirmação', async () => {
  const r = await executarTool({} as never, { id: 't1', name: 'confirmar_agendamento', input: {
    curso_escolhido: 'Curso', vendedor_id: 'vend-1', data_escolhida: '2030-01-02', horario_escolhido: '10:00',
  } }, { remotejid: '5500000000000@s.whatsapp.net', telefone: '5500000000000', waAccountId: null, leadId: 'lead-1', oportunidadeId: null });
  expect(r.agendamento_id).toBe('ag-1');
  expect(r.confirmacao).toMatchObject({ monitor: 'Monitor Teste', link: 'https://meet.invalid/abc' });
});
