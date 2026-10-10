import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { VERSAO_REGRA_ELEGIBILIDADE } from '../crm-agente-sdr/elegibilidadeAgendamento';

// Trava do 3C no gateway da API SDR: a recusa da RPC (code 'trava_3c' / 'vendedor_indisponivel')
// e a do trigger a_trava_3c_agendamento (SQLSTATE PT423) viram respostas HTTP próprias — 423 e
// 409 — com os números da trava, em vez de 422/500 genéricos. Um status só por code: 'trava_3c'
// é sempre 423 e 'vendedor_indisponivel' é sempre 409, venha da RPC ou do trigger.
// Só a fronteira Supabase é simulada.
const mocks = vi.hoisted(() => ({
  from: vi.fn(), rpc: vi.fn(), fetch: vi.fn(),
  chave: null as Record<string, unknown> | null,
}));
vi.mock('https://esm.sh/@supabase/supabase-js@2.50.3', () => ({
  createClient: () => ({ from: mocks.from, rpc: mocks.rpc }),
}));

const idLead = '00000000-0000-4000-8000-000000000001';
const idSdrDaChave = '00000000-0000-4000-8000-000000000002';
const idAvaliacao = '00000000-0000-4000-8000-000000000003';
const idAgendamento = '00000000-0000-4000-8000-000000000004';
const telefone = '00000000000';
let handler: (req: Request) => Promise<Response>;

/** O resumo que trava_3c_avaliar põe no HINT do PT423 e no `trava` da RPC. */
const resumo = {
  estado: 'travado', falta_para_destravar_seg: 9600, meta_ate_hoje_seg: 10800, feito_semana_seg: 900,
  tolerancia_seg: 300, semana_inicio: '2026-10-07', alcancavel_hoje: false,
};
const MENSAGEM = 'Marcação travada pela regra do 3C';

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: () => 'valor_sintetico_teste' },
    serve: (callback: typeof handler) => { handler = callback; },
  });
  vi.stubGlobal('fetch', mocks.fetch);
  await import('./index');
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.resetAllMocks();
  mocks.chave = { id: 'chave_teste', sdr_id: idSdrDaChave, ativo: true, revoked_at: null };
  mocks.from.mockImplementation((tabela: string) => {
    const resultado = () => ({ data: tabela === 'sdr_api_keys' ? mocks.chave : { id: idLead }, error: null });
    const consulta = {
      select: () => consulta, eq: () => consulta, ilike: () => consulta,
      order: () => consulta, limit: () => consulta, update: () => consulta,
      insert: () => consulta,
      maybeSingle: async () => resultado(),
      then: (resolver: (valor: ReturnType<typeof resultado>) => unknown) => Promise.resolve(resultado()).then(resolver),
    };
    return consulta;
  });
  mocks.fetch.mockRejectedValue(new Error('Rede real bloqueada neste teste'));
});

function agendar(rota: 'agendamentos' | 'agendamentos-agente' = 'agendamentos') {
  return handler(new Request(`https://supabase.invalid/functions/v1/sdr-api/${rota}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer chave_sintetica' },
    body: JSON.stringify({
      lead_id: idLead,
      pos_graduacao_interesse: 'Pós de teste',
      data_agendamento: '2030-06-10T10:00:00-03:00',
      telefone,
      elegibilidade_id: idAvaliacao,
      elegibilidade_versao: VERSAO_REGRA_ELEGIBILIDADE,
    }),
  }));
}

function reagendar() {
  return handler(new Request(`https://supabase.invalid/functions/v1/sdr-api/agendamentos/${idAgendamento}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer chave_sintetica' },
    body: JSON.stringify({ data_agendamento: '2030-06-11T10:00:00-03:00' }),
  }));
}

describe('trava do 3C: recusa da RPC (resposta com success=false)', () => {
  it("code 'trava_3c' vira 423 e leva os números em `trava`", async () => {
    mocks.rpc.mockResolvedValue({ data: { success: false, code: 'trava_3c', error: MENSAGEM, trava: resumo }, error: null });
    const resp = await agendar();
    expect(resp.status).toBe(423);
    expect(await resp.json()).toEqual({ error: MENSAGEM, code: 'trava_3c', trava: resumo });
  });

  it("code 'vendedor_indisponivel' (escopo e2a) vira 409, sem números", async () => {
    mocks.rpc.mockResolvedValue({
      data: { success: false, code: 'vendedor_indisponivel', error: 'Vendedor indisponível agora' }, error: null,
    });
    const resp = await agendar();
    expect(resp.status).toBe(409);
    expect(await resp.json()).toEqual({ error: 'Vendedor indisponível agora', code: 'vendedor_indisponivel' });
  });
});

describe('trava do 3C: erro PT423 do trigger vindo da RPC', () => {
  it('vira 423 (não 500) com o code, o DETAIL e os números do HINT — também na rota da IA', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: 'PT423', message: MENSAGEM, details: 'trava_3c_autor', hint: JSON.stringify(resumo) },
    });
    for (const rota of ['agendamentos', 'agendamentos-agente'] as const) {
      const resp = await agendar(rota);
      expect(resp.status).toBe(423);
      expect(await resp.json()).toEqual({ error: MENSAGEM, code: 'trava_3c', detail: 'trava_3c_autor', trava: resumo });
    }
  });

  it("no destino (DETAIL trava_3c_destino, HINT '{}') o code é o neutro, o status é 409 e não há números", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: 'PT423', message: 'Vendedor indisponível agora', details: 'trava_3c_destino', hint: '{}' },
    });
    const resp = await agendar();
    expect(resp.status).toBe(409);
    expect(await resp.json()).toEqual({
      error: 'Vendedor indisponível agora', code: 'vendedor_indisponivel', detail: 'trava_3c_destino',
    });
  });

  it("'vendedor_indisponivel' tem o MESMO status pelos dois caminhos (resposta da RPC e PT423 do trigger)", async () => {
    mocks.rpc.mockResolvedValue({
      data: { success: false, code: 'vendedor_indisponivel', error: 'Vendedor indisponível agora' }, error: null,
    });
    const pelaRpc = await agendar();
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: 'PT423', message: 'Vendedor indisponível agora', details: 'trava_3c_destino', hint: '{}' },
    });
    const peloTrigger = await agendar();
    expect([pelaRpc.status, peloTrigger.status]).toEqual([409, 409]);
    expect((await pelaRpc.json()).code).toBe('vendedor_indisponivel');
    expect((await peloTrigger.json()).code).toBe('vendedor_indisponivel');
  });

  it('HINT fora do formato não derruba a resposta', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: 'PT423', message: MENSAGEM, details: 'trava_3c_registro', hint: 'não é json' },
    });
    const resp = await agendar();
    expect(resp.status).toBe(423);
    expect(await resp.json()).toEqual({ error: MENSAGEM, code: 'trava_3c', detail: 'trava_3c_registro' });
  });

  it('o PATCH (reagendar) também devolve 423', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: 'PT423', message: MENSAGEM, details: 'trava_3c_autor', hint: JSON.stringify(resumo) },
    });
    const resp = await reagendar();
    expect(resp.status).toBe(423);
    expect((await resp.json()).code).toBe('trava_3c');
  });

  it('outro erro técnico continua 500, como antes', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'Falha sintética do banco' } });
    const resp = await agendar();
    expect(resp.status).toBe(500);
    expect(await resp.json()).toEqual({ error: 'Falha sintética do banco' });
  });
});
