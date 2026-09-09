import { describe, expect, it, vi } from 'vitest';
import { processarWebhookModulosPraticos, validarPayloadModulosPraticos } from './modulosPraticos.ts';

const inscricao = (patch: Record<string, unknown> = {}) => ({
  evento: 'inscricao.criada',
  inscricao_id: 'matricula-externa-001',
  modulo_codigo: 'modulo-catalogado',
  inscrito_em: '2026-09-09T09:15:00.123456-03:00',
  contato: { nome: 'Pessoa de Teste', telefone: '(46) 99999-9999', email: 'Pessoa@EXAMPLE.COM' },
  ...patch,
});

function dependencias() {
  const rpc = vi.fn(async (_nome: string, _args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> => ({
    data: { ok: true, status: 'criado', inscricao_id: 'matricula-externa-001', lead_id: 'lead-1', oportunidade_id: 'card-1', funil_id: 'funil-1', etapa_id: 'etapa-1', validacao: false, duplicado: false, acao: 'criar', lead_criado: true, op_criada: true },
    error: null,
  }));
  const registrarLog = vi.fn();
  const executar = (payload: unknown = inscricao()) => processarWebhookModulosPraticos({
    integracaoId: 'integracao-1', payload, cliente: { rpc }, registrarLog,
  });
  return { rpc, registrarLog, executar };
}

describe('contrato de inscrições em módulos práticos', () => {
  it('preserva o ID e o instante original, normaliza contato e envia só a RPC dedicada', async () => {
    const { rpc, executar } = dependencias();
    const resposta = await executar();
    expect(resposta).toMatchObject({ statusHttp: 200, body: { ok: true, status: 'criado', inscricao_id: 'matricula-externa-001', lead_criado: true, op_criada: true } });
    expect(rpc).toHaveBeenCalledExactlyOnceWith('crm_modulos_praticos_receber', {
      p_integracao_id: 'integracao-1', p_validar: false,
      p_payload: {
        ...inscricao(),
        contato: { nome: 'Pessoa de Teste', telefone: '5546999999999', email: 'pessoa@example.com' },
      },
    });
  });

  it('retroativa mantém a data histórica e usa recebimento idempotente com escrita habilitada', async () => {
    const { rpc, executar } = dependencias();
    await executar(inscricao({ evento: 'inscricao.retroativa', inscrito_em: '2024-02-29T23:00:00Z' }));
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_validar: false, p_payload: { evento: 'inscricao.retroativa', inscrito_em: '2024-02-29T23:00:00Z' } });
  });

  it('validar chama somente a RPC com p_validar=true e não devolve ACK de gravação', async () => {
    const { rpc, executar } = dependencias();
    rpc.mockResolvedValue({ data: { ok: true, status: 'validado', validacao: true, inscricao_id: 'matricula-externa-001', funil_id: 'funil-1', etapa_id: 'etapa-1' }, error: null });
    const resposta = await executar(inscricao({ evento: 'validar' }));
    expect(resposta.body).toMatchObject({ ok: true, status: 'validado', validacao: true });
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_validar: true, p_payload: { evento: 'validar' } });
  });

  it('aceita ACK existente para o mesmo ID sem executar outra RPC ou acionar mensagens', async () => {
    const { rpc, executar } = dependencias();
    rpc.mockResolvedValue({ data: { ok: true, status: 'existente', inscricao_id: 'matricula-externa-001', duplicado: true, acao: 'ja_processada' }, error: null });
    expect((await executar()).body).toMatchObject({ status: 'existente', duplicado: true, acao: 'ja_processada' });
    expect(rpc).toHaveBeenCalledOnce();
  });

  it.each([
    ['(55) 99912-3456', '5555999123456'],
    ['+55 (46) 99999-9999', '5546999999999'],
    ['46 9999-9999', '5546999999999'],
    ['+1 631 578 2741', '16315782741'],
    ['+39 331 234 5678', '393312345678'],
    ['+351 912 345 678', '351912345678'],
  ])('canonicaliza %s sem confundir DDD55 ou adicionar DDI brasileiro a estrangeiro', (telefone, esperado) => {
    const normalizado = validarPayloadModulosPraticos(inscricao({ contato: { nome: 'Teste', telefone } }));
    expect(normalizado).toMatchObject({ contato: { telefone: esperado } });
    expect(normalizado).not.toHaveProperty('contato.telefone_original');
  });

  it('preserva telefone impossível apenas no campo interno quando o contato tem e-mail válido', async () => {
    const { rpc, registrarLog, executar } = dependencias();
    const resposta = await executar(inscricao({ contato: { nome: 'Contato', telefone: ' +5513712837128 ', email: 'Contato@Example.com' } }));
    expect(resposta.statusHttp).toBe(200);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('crm_modulos_praticos_receber', expect.objectContaining({
      p_payload: expect.objectContaining({ contato: { nome: 'Contato', telefone_original: '+5513712837128', email: 'contato@example.com' } }),
    }));
    expect(JSON.stringify(registrarLog.mock.calls)).not.toContain('+5513712837128');
    expect(resposta.body).not.toHaveProperty('telefone_original');
  });

  it('CPF válido também permite preservar telefone inválido, sem usá-lo como identificador', async () => {
    const { rpc, executar } = dependencias();
    const resposta = await executar(inscricao({ contato: { nome: 'Contato', telefone: '+5513712837128', cpf: '529.982.247-25' } }));
    expect(resposta.statusHttp).toBe(200);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_payload: { contato: { nome: 'Contato', telefone_original: '+5513712837128', cpf: '52998224725' } } });
    expect(rpc.mock.calls[0][1]).not.toHaveProperty('p_payload.contato.telefone');
  });

  it('telefone impossível sem outro identificador continua sendo telefone_invalido terminal', async () => {
    const { rpc, executar } = dependencias();
    expect(await executar(inscricao({ contato: { nome: 'Contato', telefone: '+5513712837128' } })))
      .toMatchObject({ statusHttp: 422, body: { ok: false, erro: 'telefone_invalido', repetir: false } });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(['ramal não informado', '+55+55 11 95087-6718', '123'])('formato inválido é preservado com identificador alternativo válido (%s)', async telefone => {
    const { rpc, executar } = dependencias();
    expect((await executar(inscricao({ contato: { nome: 'Contato', telefone, email: 'contato@example.com' } }))).statusHttp).toBe(200);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_payload: { contato: { telefone_original: telefone } } });
    expect(rpc.mock.calls[0][1]).not.toHaveProperty('p_payload.contato.telefone');
  });

  it.each([null, 5513712837128, {}, [], '', '   ', '1'.repeat(41), '+5513712837128\u0000', '+5513712837128\n'])('não relaxa tipo, preenchimento, limite ou controles do telefone mesmo com e-mail válido (%j)', async telefone => {
    const { rpc, executar } = dependencias();
    expect(await executar(inscricao({ contato: { nome: 'Contato', telefone, email: 'contato@example.com' } })))
      .toMatchObject({ statusHttp: 400, body: { erro: 'campo_invalido', repetir: false } });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    { nome: 'Contato', telefone: '+5513712837128', email: 'invalido' },
    { nome: 'Contato', telefone: '+5513712837128', cpf: '52998224724' },
    { nome: 'Contato', telefone: '+5513712837128', email: 'invalido', cpf: '52998224725' },
    { nome: 'Contato', telefone: '+5513712837128', email: 'contato@example.com', cpf: '52998224724' },
  ])('e-mail/CPF informados continuam sujeitos à validação atual (%j)', async contato => {
    const { rpc, executar } = dependencias();
    expect((await executar(inscricao({ contato }))).statusHttp).toBe(422);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    { nome: 'Contato', email: 'contato@example.com', telefone_original: '+5513712837128' },
    { nome: 'Contato', telefone: '46999999999', telefone_original: '+5513712837128' },
  ])('remetente HTTP não pode fornecer o campo interno telefone_original (%j)', async contato => {
    const { rpc, executar } = dependencias();
    expect(await executar(inscricao({ contato }))).toMatchObject({ statusHttp: 400, body: { erro: 'campo_nao_permitido', repetir: false } });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([true, false, '+5513712837128'])('ACK expõe somente a flag booleana de telefone inválido (%j)', async telefone_invalido => {
    const { rpc, executar } = dependencias();
    rpc.mockResolvedValue({ data: { ok: true, status: 'existente', inscricao_id: 'matricula-externa-001', telefone_invalido, telefone_original: '+5513712837128' }, error: null });
    const resposta = await executar();
    expect(resposta.statusHttp).toBe(200);
    expect(resposta.body).not.toHaveProperty('telefone_original');
    if (typeof telefone_invalido === 'boolean') expect(resposta.body.telefone_invalido).toBe(telefone_invalido);
    else expect(resposta.body).not.toHaveProperty('telefone_invalido');
  });

  it('CPF é opcional, preserva zeros e só normaliza um documento efetivamente informado', () => {
    const comCpf = validarPayloadModulosPraticos(inscricao({ contato: { nome: 'Teste', cpf: '529.982.247-25' } }));
    expect(comCpf).toMatchObject({ contato: { nome: 'Teste', cpf: '52998224725' } });
    const semCpf = validarPayloadModulosPraticos(inscricao({ contato: { nome: 'Teste', email: 'teste@example.com' } }));
    expect(semCpf).toMatchObject({ contato: { nome: 'Teste', email: 'teste@example.com' } });
    expect('contato' in semCpf && semCpf.contato).not.toHaveProperty('cpf');
  });

  it.each([
    null, [], 'JSON em texto', 123,
    inscricao({ evento: 'outro' }),
    inscricao({ inscricao_id: 123 }),
    inscricao({ inscricao_id: 'x'.repeat(201) }),
    inscricao({ modulo_codigo: 'x'.repeat(121) }),
    inscricao({ contato: { nome: 'x'.repeat(201), telefone: '46999999999' } }),
    inscricao({ contato: { nome: 'Teste\u0000', telefone: '46999999999' } }),
    inscricao({ contato: { nome: { valor: 'Teste' }, telefone: '46999999999' } }),
    inscricao({ contato: { nome: 'Teste', telefone: 46999999999 } }),
    inscricao({ contato: { nome: 'Teste', telefone: null } }),
    inscricao({ contato: { nome: 'Teste', telefone: '' } }),
    inscricao({ contato: [] }),
    inscricao({ token: 'nao-aceitar-campos-extras' }),
    inscricao({ contato: { nome: 'Teste', email: 'teste@example.com', responsavel_id: 'forjado' } }),
  ])('recusa corpo ou tipo inválido sem coerção e sem chamar o banco (%j)', async payload => {
    const { rpc, executar } = dependencias();
    const resposta = await executar(payload);
    expect([400, 422]).toContain(resposta.statusHttp);
    expect(resposta.body).toMatchObject({ ok: false, repetir: false });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    { nome: 'Teste' },
    { nome: 'Teste', email: 'sem-dominio' },
    { nome: 'Teste', email: 'a..b@example.com' },
    { nome: 'Teste', email: '.a@example.com' },
    { nome: 'Teste', email: 'a@-example.com' },
    { nome: 'Teste', telefone: 'telefone 46999999999' },
    { nome: 'Teste', telefone: '+55+55 11 95087-6718' },
    { nome: 'Teste', telefone: '123' },
    { nome: 'Teste', cpf: '00000000000' },
    { nome: 'Teste', cpf: '52998224724' },
    { nome: 'Teste', cpf: '52998224725x' },
  ])('não inventa nem aceita um identificador inválido (%j)', async contato => {
    const { rpc, executar } = dependencias();
    expect((await executar(inscricao({ contato }))).statusHttp).toBe(422);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    '2026-09-09', '2026-09-09T09:00:00', '09/09/2026 09:00',
    '2026-02-29T09:00:00Z', '2024-02-30T09:00:00Z', '2026-04-31T09:00:00Z',
    '1900-02-29T09:00:00Z', '2026-13-01T09:00:00Z', '2026-00-01T09:00:00Z',
    '2026-09-00T09:00:00Z', '2026-09-09T24:00:00Z', '2026-09-09T09:60:00Z',
    '2026-09-09T09:00:60Z', '2026-09-09T09:00:00+24:00', '2026-09-09T09:00:00-03:60',
  ])('exige ISO completo com data real e offset (%s)', async inscrito_em => {
    const { rpc, executar } = dependencias();
    expect((await executar(inscricao({ inscrito_em }))).statusHttp).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('aceita os limites de identificadores sem truncar, inclusive ano secular bissexto', () => {
    const payload = inscricao({ inscricao_id: 'i'.repeat(200), modulo_codigo: 'm'.repeat(120), inscrito_em: '2000-02-29T00:00:00+00:00' });
    expect(validarPayloadModulosPraticos(payload)).toMatchObject({ inscricao_id: payload.inscricao_id, modulo_codigo: payload.modulo_codigo, inscrito_em: payload.inscrito_em });
  });
});

describe('catálogo, erros e logs sem dados pessoais', () => {
  it('catálogo não envia contato à RPC e só expõe os campos de módulo permitidos', async () => {
    const { rpc, registrarLog, executar } = dependencias();
    rpc.mockResolvedValue({ data: { ok: true, modulos: [{ codigo: 'codigo-oficial', nome: 'Módulo', ano: null, funil_id: 'funil', etapa_id: 'etapa', contato: { email: 'privado@example.com' }, email: 'privado@example.com', token: 'segredo' }] }, error: null });
    const resposta = await executar({ evento: 'catalogo' });
    expect(rpc).toHaveBeenCalledExactlyOnceWith('crm_modulos_praticos_catalogo', { p_integracao_id: 'integracao-1' });
    expect(resposta.body).toEqual({ ok: true, status: 'catalogo', modulos: [{ codigo: 'codigo-oficial', nome: 'Módulo', ano: null, funil_id: 'funil', etapa_id: 'etapa' }] });
    expect(registrarLog).toHaveBeenCalledWith({ evento: 'catalogo', resultado: 'catalogo', statusHttp: 200, codigo: null });
  });

  it('catálogo recusa PII no corpo em vez de misturar cadastro e consulta', async () => {
    const { rpc, executar } = dependencias();
    expect((await executar({ evento: 'catalogo', contato: { nome: 'Teste' } })).statusHttp).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['integracao_inativa', 403], ['integracao_invalida', 403], ['payload_invalido', 400],
    ['contato_ambiguo', 409], ['inscricao_conflitante', 409], ['modulo_nao_mapeado', 422],
    ['oportunidade_ambigua', 409], ['destino_invalido', 422],
  ])('mapeia P0001 %s para HTTP%s sem orientar reenvio cego', async (codigo, statusHttp) => {
    const { rpc, executar } = dependencias();
    rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: codigo, details: 'dado privado' } });
    expect(await executar()).toMatchObject({ statusHttp, body: { ok: false, erro: codigo, repetir: false } });
  });

  it.each([
    { code: '23505', message: 'Unique constraint com pessoa@example.com e token privado' },
    { code: 'P0001', message: 'mensagem desconhecida com CPF 52998224725' },
    { code: '08006', message: 'Conexão caiu' },
  ])('oculta erro de infraestrutura e devolve retry para falhas desconhecidas', async error => {
    const { rpc, registrarLog, executar } = dependencias();
    rpc.mockResolvedValue({ data: null, error });
    const resposta = await executar();
    expect(resposta).toEqual({ statusHttp: 500, body: { ok: false, erro: 'falha_interna', mensagem: 'Não foi possível processar agora. Tente novamente.', repetir: true } });
    const logs = JSON.stringify(registrarLog.mock.calls);
    expect(logs).not.toContain('pessoa@example.com');
    expect(logs).not.toContain('52998224725');
    expect(logs).not.toContain('privado');
  });

  it('captura rejeição da rede e não deixa o callback de auditoria derrubar ACK confirmado', async () => {
    const falha = dependencias();
    falha.rpc.mockRejectedValue(new Error('segredo não deve aparecer'));
    expect((await falha.executar()).statusHttp).toBe(500);
    const sucesso = dependencias();
    sucesso.registrarLog.mockRejectedValue(new Error('Auditoria indisponível'));
    expect((await sucesso.executar()).body).toMatchObject({ ok: true, status: 'criado' });
  });

  it('log de sucesso não contém payload, nome, telefone, CPF, email ou identificador externo', async () => {
    const { registrarLog, executar } = dependencias();
    await executar(inscricao({ contato: { nome: 'Pessoa Secreta', telefone: '46999999999', email: 'secreto@example.com', cpf: '52998224725' } }));
    expect(registrarLog).toHaveBeenCalledExactlyOnceWith({ evento: 'inscricao.criada', resultado: 'criado', statusHttp: 200, codigo: null });
    const log = JSON.stringify(registrarLog.mock.calls);
    for (const dado of ['Pessoa Secreta', '46999999999', '52998224725', 'secreto@example.com', 'matricula-externa-001']) expect(log).not.toContain(dado);
  });

  it.each([
    null, [], { ok: false },
    { ok: true, status: 'criado', inscricao_id: 'outra-inscricao' },
    { ok: true, status: 'validado', inscricao_id: 'matricula-externa-001' },
    { ok: true, status: 'criado' },
  ])('não confirma entrega quando a RPC responde com ACK incompatível (%j)', async data => {
    const { rpc, executar } = dependencias();
    rpc.mockResolvedValue({ data, error: null });
    expect((await executar()).statusHttp).toBe(500);
  });

  it('validar rejeita ACK de gravação real e remove campos pessoais de respostas válidas', async () => {
    const { rpc, executar } = dependencias();
    expect((await executar(inscricao({ evento: 'validar' }))).statusHttp).toBe(500);
    rpc.mockResolvedValue({ data: { ok: true, status: 'criado', inscricao_id: 'matricula-externa-001', email: 'privado@example.com', contato: { cpf: '52998224725' } }, error: null });
    const resposta = await executar();
    expect(resposta.body).not.toHaveProperty('email');
    expect(resposta.body).not.toHaveProperty('contato');
  });
});
