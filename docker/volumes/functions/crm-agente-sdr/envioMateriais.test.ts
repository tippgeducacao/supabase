import { describe, expect, it, vi } from 'vitest';
import { carregarStatusMateriais, INSTRUCAO_ENVIO_MATERIAIS, montarRetornoInformacoes } from './envioMateriais';
import { interpretarEnvioMaterial } from '../_shared/resultadoEnvioMaterial';
import { AGENTE_VALIDACAO, AGENTE_QUALIFICADOR } from './prompts';
import { AGENTE_RECONTATO } from './prompts-recontato';
import { AGENTE_CAMPANHA_DIRETA } from './prompts-campanha-direta';

describe('contrato de envio do cronograma', () => {
  it('aceite com id não comprova entrega ou abertura', () => {
    const envio = interpretarEnvioMaterial(true, { success: true, wa_message_id: 'wamid.teste' });
    expect(envio).toMatchObject({ cronograma_status: 'aceito', cronograma_enviado: true, wa_message_id: 'wamid.teste' });
    const retorno = montarRetornoInformacoes(true, { data: envio }, 'cronograma', 'tool-1');
    expect(retorno.resultado).toContain('entrega ainda NÃO está confirmada');
    expect(retorno.resultado).not.toContain('enviado com sucesso');
  });

  it.each([
    { success: false, wa_message_id: 'wamid.teste' },
    { success: true, error: 'Recusado', wa_message_id: 'wamid.teste' },
    { success: true, status_entrega: 'failed', wa_message_id: 'wamid.teste' },
  ])('não transforma erro com HTTP 200 em sucesso: %j', (body) => {
    expect(interpretarEnvioMaterial(true, body).cronograma_status).toBe('falhou');
  });
  it.each([{}, { success: 'true' }, { success: true }, { success: true, wa_message_id: ' ' }])(
    'resposta incompleta é desconhecida: %j', (body) => {
      expect(interpretarEnvioMaterial(true, body)).toMatchObject({ cronograma_status: 'desconhecido', cronograma_enviado: false });
    });
  it.each([
    { data: { cronograma_enviado: false, cronograma_erro: 'Arquivo removido', cronograma_codigo: 'anexo_indisponivel' } },
    { success: false, data: { cronograma_enviado: true } },
    { error: 'Recusado', data: { cronograma_enviado: true } },
    { data: { error: 'Recusado', cronograma_enviado: true } },
  ])('falha chega ao modelo mesmo com HTTP 200: %j', (body) => {
    const retorno = montarRetornoInformacoes(true, body, 'cronograma', 'tool-1');
    expect(retorno.cronograma_status).toBe('falhou');
    expect(retorno.cronograma_enviado).toBe(false);
    expect(retorno.resultado).toContain('NÃO foi enviado');
    expect(retorno.resultado).toContain('Não chame pausa_ia');
    expect(retorno.resultado).toContain('podemos continuar com o agendamento?');
    expect(retorno.resultado).not.toContain('vai mandar em seguida');
  });
  it('preserva motivo e valores quando só o material falha', () => {
    const retorno = montarRetornoInformacoes(true, { data: {
      cronograma_enviado: false, cronograma_erro: 'Arquivo removido', cronograma_codigo: 'anexo_indisponivel',
      valor_integral: 'R$ 4.200,00', valor_matricula: 'R$ 200,00',
    } }, 'cronograma_e_valor', 'tool-1');
    expect(retorno).toMatchObject({ cronograma_erro: 'Arquivo removido', cronograma_codigo: 'anexo_indisponivel' });
    expect(retorno.resultado).toContain('R$ 4.200,00');
    expect(retorno.resultado).toContain('R$ 200,00');
  });
  it('consulta só de valor nunca confirma material', () => {
    const retorno = montarRetornoInformacoes(true, { data: { valor_integral: 'R$ 4.200,00', cronograma_enviado: true } }, 'valor', 'tool-1');
    expect(retorno).toMatchObject({ cronograma_enviado: false, cronograma_status: 'nao_solicitado' });
    expect(retorno.resultado).toContain('nenhum cronograma');
  });
  it('timeout permanece desconhecido, sem afirmar sucesso nem recusa certa', () => {
    const retorno = montarRetornoInformacoes(true, { data: {
      cronograma_enviado: false, cronograma_status: 'desconhecido', cronograma_erro: 'Sem resposta',
    } }, 'cronograma', 'tool-1');
    expect(retorno.cronograma_status).toBe('desconhecido');
    expect(retorno.resultado).toContain('Não repita automaticamente');
  });
  it.each(['entregue', 'lido'])('receipt %s não invalida pedido de reenvio', (status) => {
    const retorno = montarRetornoInformacoes(true, { data: { cronograma_enviado: true, cronograma_status: status, wa_message_id: 'wamid.teste', cronograma_wa_account_id: 'conta-teste' } }, 'cronograma', 'tool-1');
    expect(retorno.resultado).toContain('NÃO comprova abertura');
    expect(retorno.resultado).toContain('reenvie pela ferramenta');
  });
  it('booleano em string não confirma envio', () => {
    expect(montarRetornoInformacoes(true, { data: { cronograma_enviado: 'true' } }, 'cronograma', 'tool-1').cronograma_status).toBe('desconhecido');
  });
});

describe('receipts atuais na memória do SDR', () => {
  function banco() {
    const resposta = { data: [{ wa_message_id: 'wamid.teste', tipo: 'document', template_name: null,
      status_entrega: 'failed', erro: { errors: [{ code: 131053 }] },
      anexos: [{ filename: 'cronograma.pdf', url: 'https://nao-expor.invalid' }], created_at: '2026-09-10T15:00:00Z' }], error: null as unknown };
    const consulta: any = { then: (resolver: any) => Promise.resolve(resposta).then(resolver) };
    for (const metodo of ['select', 'eq', 'in', 'order', 'limit']) consulta[metodo] = vi.fn(() => consulta);
    return { supabase: { from: vi.fn(() => consulta) }, consulta, resposta };
  }
  it('busca telefone/conta da conversa e atualiza o status sem editar histórico', async () => {
    const { supabase, consulta, resposta } = banco();
    const contexto = { telefone: '5511999990001', waAccountId: 'conta-teste' };
    resposta.data[0].status_entrega = 'sent';
    expect(await carregarStatusMateriais(supabase, contexto)).toContain('"status":"aceito"');
    resposta.data[0].status_entrega = 'failed';
    const atualizado = await carregarStatusMateriais(supabase, contexto);
    expect(atualizado).toContain('"status":"falhou"');
    expect(atualizado).toContain('131053');
    expect(atualizado).toContain('cronograma.pdf');
    expect(atualizado).not.toContain('https://nao-expor.invalid');
    expect(consulta.eq).toHaveBeenCalledWith('wa_account_id', 'conta-teste');
    expect(consulta.eq).toHaveBeenCalledWith('direcao', 'outbound');
    expect(consulta.in).toHaveBeenCalledWith('telefone', expect.arrayContaining(['5511999990001', '551199990001']));
    expect(consulta.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(consulta.limit).toHaveBeenCalledWith(12);
    expect(supabase.from.mock.calls.every(([t]) => t === 'crm_whatsapp_messages')).toBe(true);
  });
  it('falha da leitura não transforma histórico antigo em prova de entrega', async () => {
    const { supabase, resposta } = banco();
    resposta.error = { message: 'Banco indisponível' };
    expect(await carregarStatusMateriais(supabase, { telefone: '5511999990001', waAccountId: 'conta' })).toContain('INDISPONÍVEL');
  });
  it('sem conta não mistura linhas de WhatsApp', async () => {
    const { supabase } = banco();
    expect(await carregarStatusMateriais(supabase, { telefone: '5511999990001', waAccountId: null })).toContain('INDISPONÍVEL');
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

describe('roteiro das quatro personas', () => {
  it.each([AGENTE_VALIDACAO, AGENTE_QUALIFICADOR, AGENTE_RECONTATO, AGENTE_CAMPANHA_DIRETA])(
    'permite recuperar material e não confirma automaticamente', (prompt) => {
      expect(prompt).toContain(INSTRUCAO_ENVIO_MATERIAIS);
      expect(prompt).not.toMatch(/se já (?:existe|consta)[^\n]+(?:\*\*NÃO\*\* reenvie|não reenvie)/);
      expect(prompt).not.toContain('te mandei o cronograma completo aqui em cima');
    });
});

describe('continuidade após falha de material', () => {
  it('só oferece nova tentativa posterior quando a fila confirmou o registro', () => {
    const data = { cronograma_status: 'falhou', cronograma_enviado: false, reenvio_agendado_id: 'fila-1', reenvio_em: '2030-01-01T12:05:00Z' };
    const retorno = montarRetornoInformacoes(true, { data }, 'cronograma', 'tool');
    expect(retorno).toMatchObject({ reenvio_agendado_id: 'fila-1', reenvio_em: data.reenvio_em });
    expect(retorno.resultado).toContain('Assim que normalizar');
    expect(retorno.resultado).toContain('Aguarde o aceite');
    expect(retorno.resultado).toContain('mantendo as verificações de elegibilidade');
  });
  it.each([undefined, '', ' ', true])('não inventa reenvio com id inválido %s', (id) => {
    const r = montarRetornoInformacoes(true, { data: { cronograma_enviado: false, reenvio_agendado_id: id } }, 'cronograma', 'tool');
    expect(r).not.toHaveProperty('reenvio_agendado_id');
    expect(r.resultado).toContain('nenhuma nova tentativa ficou registrada');
  });
  it('503 da verificação de pendência permanece desconhecido', () => {
    const r = montarRetornoInformacoes(false, { data: { cronograma_status: 'desconhecido' } }, 'cronograma', 'tool');
    expect(r.cronograma_status).toBe('desconhecido');
    expect(r.resultado).toContain('Não chame pausa_ia');
  });
});
