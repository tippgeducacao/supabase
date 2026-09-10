import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CtxConversa } from './tools';

vi.mock('./agente.ts', () => ({ chamarAnthropic: vi.fn() }));
const transporte = vi.fn();
let executarTool: typeof import('./tools').executarTool;
let montarToolResults: typeof import('./tools').montarToolResults;
const contexto = (): CtxConversa => ({ telefone: '5511999990001', remotejid: '5511999990001@s.whatsapp.net',
  waAccountId: 'conta-da-conversa', leadId: null, oportunidadeId: null });
const banco = { from: vi.fn(() => { throw new Error('Consulta não prevista'); }) };
const pedido = (id = 'tool-1', conteudo = 'cronograma') => ({ id, name: 'envia_informacoes', input: { curso_escolhido: 'Curso de teste', conteudo } });
const resposta = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: () => '' } });
  vi.stubGlobal('fetch', transporte);
  ({ executarTool, montarToolResults } = await import('./tools'));
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.clearAllMocks();
  transporte.mockImplementation(async () => resposta({ data: { cronograma_enviado: true, cronograma_status: 'aceito', wa_message_id: 'wamid.teste' } }));
});

describe('executor real de materiais, com transporte isolado', () => {
  it('usa a conta da conversa e preserva id/status no tool_result', async () => {
    const resultado = await executarTool(banco, pedido(), contexto());
    expect(JSON.parse(transporte.mock.calls[0][1].body)).toMatchObject({ wa_account_id: 'conta-da-conversa', whatsapp: '5511999990001', reagendar_em_falha: true });
    const blocos = montarToolResults([resultado]);
    expect(JSON.parse(blocos[0].content)).toMatchObject({ id: 'tool-1', cronograma_status: 'aceito', wa_message_id: 'wamid.teste' });
  });
  it('webchat não solicita a recuperação automática de documento WhatsApp', async () => {
    await executarTool(banco, pedido(), { ...contexto(), canal: 'webchat' });
    expect(JSON.parse(transporte.mock.calls[0][1].body).reagendar_em_falha).toBe(false);
  });
  it('preserva a pendência registrada no resultado e pede aceite para seguir', async () => {
    transporte.mockResolvedValue(resposta({ data: { cronograma_enviado: false, cronograma_status: 'falhou',
      reenvio_agendado_id: 'fila-1', reenvio_em: '2030-01-01T12:05:00Z' } }));
    const resultado = await executarTool(banco, pedido(), contexto());
    expect(resultado).toMatchObject({ cronograma_enviado: false, reenvio_agendado_id: 'fila-1' });
    expect(resultado.resultado).toContain('Encerre esta rodada logo após essa pergunta');
    expect(resultado.resultado).toContain('Não chame pausa_ia');
  });
  it('reenvia em um novo pedido mesmo depois de envio anterior confirmado', async () => {
    transporte.mockImplementation(async () => resposta({ data: { cronograma_enviado: true, cronograma_status: 'entregue', wa_message_id: 'wamid.teste' } }));
    await executarTool(banco, pedido(), contexto());
    await executarTool(banco, pedido('tool-2'), contexto());
    expect(transporte).toHaveBeenCalledTimes(2);
  });
  it('não repete material na mesma rodada nem ao alternar para cronograma_e_valor', async () => {
    const ctx = contexto();
    await executarTool(banco, pedido(), ctx);
    const repetido = await executarTool(banco, pedido('tool-2', 'cronograma_e_valor'), ctx);
    expect(transporte).toHaveBeenCalledTimes(1);
    expect(repetido).toMatchObject({ id: 'tool-2', reutilizado_nesta_rodada: true });
    await executarTool(banco, pedido('tool-3', 'valor'), ctx);
    expect(transporte).toHaveBeenCalledTimes(2);
    expect(JSON.parse(transporte.mock.calls[1][1].body).conteudo).toBe('valor');
  });
  it('falha de rede não usa o catch genérico que escondia o erro', async () => {
    transporte.mockRejectedValue(new Error('Timeout sintético'));
    const ctx = contexto();
    const resultado = await executarTool(banco, pedido(), ctx);
    expect(resultado).toMatchObject({ cronograma_enviado: false, cronograma_status: 'desconhecido' });
    expect(resultado.resultado).toContain('DESCONHECIDO');
    await executarTool(banco, pedido('tool-2'), ctx);
    expect(transporte).toHaveBeenCalledTimes(1);
  });
  it('não manda o lead procurar acima diante do antigo código de duplicidade', async () => {
    transporte.mockResolvedValue(resposta({ code: 'cronograma_ja_enviado', error: 'Bloqueio legado' }, 409));
    const resultado = await executarTool(banco, pedido(), contexto());
    expect(resultado.cronograma_status).toBe('falhou');
    expect(resultado.resultado).not.toContain('material já está com ele');
  });
  it('não repete falha do arquivo na mesma rodada', async () => {
    transporte.mockImplementation(async () => resposta({ data: {
      cronograma_enviado: false, cronograma_erro: 'Arquivo indisponível', cronograma_codigo: 'anexo_indisponivel',
    } }));
    const ctx = contexto();
    const resultado = await executarTool(banco, pedido(), ctx);
    await executarTool(banco, pedido('tool-2'), ctx);
    expect(transporte).toHaveBeenCalledTimes(1);
    expect(resultado).toMatchObject({ cronograma_status: 'falhou', cronograma_codigo: 'anexo_indisponivel' });
  });
});
