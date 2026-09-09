import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CtxConversa } from './tools';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), modelo: vi.fn() }));
vi.mock('./agente.ts', () => ({ chamarAnthropic: mocks.modelo }));
const contexto: CtxConversa = {
  telefone: '5500000000000', remotejid: '5500000000000@s.whatsapp.net',
  waAccountId: 'conta-teste', leadId: null, oportunidadeId: null,
};
const supabase = { from: vi.fn(() => { throw new Error('Consulta não prevista'); }) };
let executarTool: typeof import('./tools').executarTool;

beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: (chave: string) => chave === 'SUPABASE_URL' ? 'https://supabase.invalid' : undefined } });
  vi.stubGlobal('fetch', mocks.fetch);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  ({ executarTool } = await import('./tools'));
});
afterAll(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
beforeEach(() => {
  vi.clearAllMocks();
  responder({ cronograma_enviado: true });
});

function responder(data: Record<string, unknown>, status = 200) {
  mocks.fetch.mockImplementation(async () => Response.json({ data }, { status }));
}
function chamar(conteudo = 'cronograma') {
  return executarTool(supabase, {
    id: 'tool-teste', name: 'envia_informacoes', input: { curso_escolhido: 'Sanidade Avícola', conteudo },
  }, contexto);
}
function semEntregaOuPromessa(resposta: Record<string, unknown>) {
  expect(resposta.cronograma_entregue).toBe(false);
  expect(resposta.resultado).not.toContain('Há confirmação de entrega');
  expect(resposta.resultado).not.toMatch(/Diga (?:ao lead )?que vai (?:enviar|mandar)|material já está com ele e siga/i);
}

describe('tool envia_informacoes: fala proporcional à evidência', () => {
  it('o booleano legado true significa aceite pendente, não entregue', async () => {
    const resposta = await chamar();
    expect(resposta).toMatchObject({ cronograma_enviado: true, cronograma_status: 'pendente' });
    expect(resposta.resultado).toContain('PENDENTE');
    semEntregaOuPromessa(resposta);
  });

  it.each(['delivered', 'read'])('informa entrega confirmada com status %s e referência da mensagem', async (status) => {
    responder({ cronograma_enviado: true, cronograma_status: status,
      cronograma_wa_message_id: 'wamid-teste', cronograma_wa_account_id: 'conta-teste' });
    const resposta = await chamar();
    expect(resposta).toMatchObject({ cronograma_entregue: true, cronograma_status: status, cronograma_wa_message_id: 'wamid-teste' });
    expect(resposta.resultado).toContain('Há confirmação de entrega');
    expect(resposta.resultado).toContain('atenda o novo pedido');
  });

  it('não aceita delivered sem referência rastreável', async () => {
    responder({ cronograma_enviado: true, cronograma_status: 'delivered', cronograma_entregue: true });
    semEntregaOuPromessa(await chamar());
  });

  it('erro explícito prevalece sobre campos de sucesso contraditórios', async () => {
    responder({ cronograma_enviado: true, cronograma_status: 'read', cronograma_erro: 'Entrega falhou',
      cronograma_wa_message_id: 'wamid-teste', cronograma_wa_account_id: 'conta-teste' });
    const resposta = await chamar();
    expect(resposta).toMatchObject({ cronograma_enviado: false, cronograma_status: 'falhou' });
    semEntregaOuPromessa(resposta);
  });

  it.each([
    { error: 'Não cadastrado', code: 'cronograma_nao_cadastrado' },
    { error: 'Envio anterior', code: 'cronograma_ja_enviado' },
    { error: 'Recusado' },
  ])('falha $code não vira promessa de envio futuro', async (data) => {
    responder(data, 422);
    const resposta = await chamar();
    expect(resposta.cronograma_status).toBe('falhou');
    expect(resposta.resultado).toContain('pedido explícito de novo envio');
    semEntregaOuPromessa(resposta);
  });

  it('HTTP 200 com erro no envelope não confirma sucesso', async () => {
    mocks.fetch.mockImplementation(async () => Response.json({ error: 'Recusado', data: { cronograma_enviado: true } }));
    semEntregaOuPromessa(await chamar());
  });

  it('erro de rede não afirma envio nem agenda uma promessa inexistente', async () => {
    mocks.fetch.mockRejectedValue(new Error('Conexão interrompida'));
    const resposta = await chamar();
    semEntregaOuPromessa(resposta);
    expect(resposta.resultado).toContain('não agendou nova tentativa');
  });

  it('novo pedido pode executar novo envio mesmo após entrega confirmada', async () => {
    responder({ cronograma_enviado: true, cronograma_status: 'delivered',
      cronograma_wa_message_id: 'wamid-teste', cronograma_wa_account_id: 'conta-teste' });
    await chamar();
    await chamar();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    const payload = JSON.parse(mocks.fetch.mock.calls[1][1].body);
    expect(payload.wa_account_id).toBe(contexto.waAccountId);
  });

  it('consulta de valor não confirma um cronograma incidental na resposta', async () => {
    responder({ cronograma_enviado: true, valor_integral: '1000,00' });
    const resposta = await chamar('valor');
    expect(resposta.resultado).toContain('1000,00');
    expect(resposta.cronograma_enviado).toBeUndefined();
    expect(resposta.resultado).not.toContain('Cronograma');
  });
});
