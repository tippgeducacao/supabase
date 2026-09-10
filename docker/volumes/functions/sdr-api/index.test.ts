import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { VERSAO_REGRA_ELEGIBILIDADE } from '../crm-agente-sdr/elegibilidadeAgendamento';

// Exercita autenticação, roteamento, resolução do lead e payloads do handler real.
// Só a fronteira Supabase é simulada; nenhuma rede ou reunião real participa.
const mocks = vi.hoisted(() => ({
  from: vi.fn(), rpc: vi.fn(), fetch: vi.fn(),
  chave: null as Record<string, unknown> | null,
  lead: null as Record<string, unknown> | null,
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
  mocks.lead = { id: idLead };
  mocks.from.mockImplementation((tabela: string) => {
    const resultado = () => ({ data: tabela === 'sdr_api_keys' ? mocks.chave : mocks.lead, error: null });
    const consulta = {
      select: () => consulta, eq: () => consulta, ilike: () => consulta,
      order: () => consulta, limit: () => consulta, update: () => consulta,
      insert: () => consulta,
      maybeSingle: async () => resultado(),
      then: (resolver: (valor: ReturnType<typeof resultado>) => unknown) => Promise.resolve(resultado()).then(resolver),
    };
    return consulta;
  });
  mocks.rpc.mockResolvedValue({ data: { success: true, agendamento: { id: idAgendamento } }, error: null });
  mocks.fetch.mockRejectedValue(new Error('Rede real bloqueada neste teste'));
});

function corpoValido(): Record<string, unknown> {
  return {
    lead: { nome: 'Pessoa de teste', whatsapp: telefone },
    pos_graduacao_interesse: 'Pós de teste',
    data_agendamento: '2030-06-10T10:00:00-03:00',
    vendedor_id: '00000000-0000-4000-8000-000000000005',
    telefone,
    elegibilidade_id: idAvaliacao,
    elegibilidade_versao: VERSAO_REGRA_ELEGIBILIDADE,
  };
}

function chamar(body: Record<string, unknown>, rota = 'agendamentos-agente', auth: string | null = 'Bearer chave_sintetica') {
  return handler(new Request(`https://supabase.invalid/functions/v1/sdr-api/${rota}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify(body),
  }));
}

describe('envio real do gateway, com WhatsApp simulado', () => {
  const entrada = { whatsapp: telefone, pos: 'Pós de teste', conteudo: 'cronograma', wa_account_id: 'conta-teste' };
  const info = () => ({ success: true, curso: { nome: 'Pós de teste' },
    cronograma: { url: 'https://materiais.invalid/cronograma.pdf', nome_arquivo: 'cronograma.pdf' },
    valor_integral: 'R$ 4.200,00', valor_matricula: 'R$ 200,00' });
  beforeEach(() => {
    mocks.rpc.mockResolvedValue({ data: info(), error: null });
    mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({ success: true, wa_message_id: 'wamid.sintetico' })));
  });
  it('documento aceito devolve id e status, sem afirmar entrega', async () => {
    const resp = await chamar(entrada, 'envia-informacoes');
    expect(resp.status).toBe(200);
    expect((await resp.json()).data).toMatchObject({ cronograma_status: 'pendente', cronograma_enviado: true, wa_message_id: 'wamid.sintetico' });
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toMatchObject({ tipo: 'document', wa_account_id: 'conta-teste', filename: 'cronograma.pdf' });
  });
  it('SDR registra tentativa futura quando a recusa é transitória', async () => {
    const insert = vi.fn(); const update = vi.fn();
    const original = mocks.from.getMockImplementation()!;
    mocks.from.mockImplementation((tabela: string) => {
      if (tabela !== 'crm_mensagens_agendadas') return original(tabela);
      const resposta = { data: { id: 'reenvio-1' }, error: null };
      const q = { eq: () => q, select: () => q, maybeSingle: async () => resposta,
        then: (r: (v: typeof resposta) => unknown) => Promise.resolve(resposta).then(r) };
      return { insert: (v: unknown) => { insert(v); return q; }, update: (v: unknown) => { update(v); return q; } };
    });
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ error: 'Serviço indisponível', meta_code: 131016 }), { status: 422 }));
    const d = (await (await chamar({ ...entrada, reagendar_em_falha: true }, 'envia-informacoes')).json()).data;
    expect(d).toMatchObject({ cronograma_status: 'falhou', cronograma_enviado: false, reenvio_agendado_id: 'reenvio-1' });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ tipo_mensagem: 'midia', wa_account_id: entrada.wa_account_id, anexo_url: info().cronograma.url }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelado' }));
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });
  it('se não verifica a pendência anterior, não arrisca outro envio', async () => {
    const original = mocks.from.getMockImplementation()!;
    mocks.from.mockImplementation((tabela: string) => {
      if (tabela !== 'crm_mensagens_agendadas') return original(tabela);
      const q = { eq: () => q, then: (r: (v: unknown) => unknown) => Promise.resolve({ error: { message: 'Indisponível' } }).then(r) };
      return { update: () => q };
    });
    const res = await chamar({ ...entrada, reagendar_em_falha: true }, 'envia-informacoes');
    expect(res.status).toBe(503);
    expect((await res.json()).data).toMatchObject({ cronograma_status: 'desconhecido' });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('template usa PDF no cabeçalho e o mesmo contrato de aceite', async () => {
    const resp = await chamar({ ...entrada, template_name: 'cronograma_teste', template_params: ['Ana\nSilva'] }, 'envia-informacoes');
    expect((await resp.json()).data.cronograma_status).toBe('pendente');
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toMatchObject({ tipo: 'template',
      header_media_url: info().cronograma.url, header_media_filename: 'cronograma.pdf',
      template_components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ana Silva' }] }],
    });
  });
  it.each([200, 422])('erro do provedor preserva causa mesmo com HTTP %s', async (status) => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ error: 'PDF indisponível', code: 'anexo_indisponivel' }), { status }));
    const d = (await (await chamar({ ...entrada, conteudo: 'cronograma_e_valor' }, 'envia-informacoes')).json()).data;
    expect(d).toMatchObject({ cronograma_status: 'falhou', cronograma_enviado: false, cronograma_codigo: 'anexo_indisponivel', valor_integral: 'R$ 4.200,00' });
  });
  it('só preço não chama WhatsApp', async () => {
    const d = (await (await chamar({ ...entrada, conteudo: 'valor' }, 'envia-informacoes')).json()).data;
    expect(d).toMatchObject({ cronograma_status: 'nao_solicitado', cronograma_enviado: false });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('PDF sem cadastro falha antes de chamar o envio', async () => {
    mocks.rpc.mockResolvedValue({ data: { ...info(), cronograma: null }, error: null });
    const resp = await chamar(entrada, 'envia-informacoes');
    expect(resp.status).toBe(404);
    expect((await resp.json()).data.cronograma_status).toBe('falhou');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('falha definitiva de template permite fallback Web e preserva o id correto', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Template não aprovado' }), { status: 422 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, wa_message_id: 'uazapi.sintetico' })));
    const d = (await (await chamar({ ...entrada, template_name: 'cronograma_teste', wa_conexao_id: 'web-teste' }, 'envia-informacoes')).json()).data;
    expect(d).toMatchObject({ cronograma_status: 'pendente', wa_message_id: 'uazapi.sintetico' });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mocks.fetch.mock.calls[1][1].body)).toMatchObject({ tipo: 'document', wa_conexao_id: 'web-teste' });
  });
  it.each(['timeout', 'sem_id', 'json_invalido', 'proxy_502'])('resposta incerta (%s) não dispara fallback duplicado', async (caso) => {
    if (caso === 'timeout') mocks.fetch.mockRejectedValue(new Error('Timeout sintético'));
    else mocks.fetch.mockResolvedValue(new Response(caso === 'sem_id' ? '{"success":true}' : '<html>Proxy</html>', { status: caso === 'proxy_502' ? 502 : 200 }));
    const d = (await (await chamar({ ...entrada, template_name: 'cronograma_teste', wa_conexao_id: 'web-teste' }, 'envia-informacoes')).json()).data;
    expect(d).toMatchObject({ cronograma_status: 'desconhecido', cronograma_enviado: false });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('agendamento exclusivo da IA', () => {
  it('usa a RPC protegida e o SDR dono da chave com a prova e versão do servidor', async () => {
    const resp = await chamar({ ...corpoValido(), sdr_id: 'outro_sdr', p_sdr_id: 'outro_sdr' });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ data: { id: idAgendamento }, lead_criado: false });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('fn_sdr_api_agendar_reuniao_agente', {
      p_sdr_id: idSdrDaChave, p_lead_id: idLead, p_pos_graduacao: 'Pós de teste',
      p_data_agendamento: '2030-06-10T10:00:00-03:00', p_data_fim_agendamento: null,
      p_link_reuniao: null, p_vendedor_id: '00000000-0000-4000-8000-000000000005',
      p_forcar: false, p_origem: null, p_local_trabalho: null,
      p_principal_dor_objetivo: null, p_observacoes: null,
      p_telefone: telefone, p_avaliacao_id: idAvaliacao, p_regra_versao: VERSAO_REGRA_ELEGIBILIDADE,
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['telefone ausente', { telefone: undefined }],
    ['telefone vazio', { telefone: '   ' }],
    ['telefone numérico', { telefone: 123 }],
    ['avaliação ausente', { elegibilidade_id: undefined }],
    ['avaliação sem UUID', { elegibilidade_id: 'aprovado' }],
    ['avaliação como objeto', { elegibilidade_id: { aprovado: true } }],
    ['versão ausente', { elegibilidade_versao: undefined }],
    ['versão divergente', { elegibilidade_versao: 'versao_antiga' }],
  ])('recusa %s antes de resolver/criar lead ou chamar RPC', async (_descricao, invalido) => {
    const resp = await chamar({ ...corpoValido(), ...invalido });
    expect(resp.status).toBe(422);
    expect(mocks.from).not.toHaveBeenCalledWith('leads');
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('flags no body não removem a prova nem escolhem a rota geral', async () => {
    const resp = await chamar({
      ...corpoValido(), elegibilidade_id: undefined, aprovado: true,
      viaAgente: false, exigir_elegibilidade: false, forcar: true,
    });
    expect(resp.status).toBe(422);
    expect(mocks.from).not.toHaveBeenCalledWith('leads');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('forçar e outras flags continuam sujeitos à RPC protegida quando há prova', async () => {
    await chamar({ ...corpoValido(), forcar: true, viaAgente: false, exigir_elegibilidade: false, aprovado: true });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('fn_sdr_api_agendar_reuniao_agente', expect.objectContaining({
      p_forcar: true, p_avaliacao_id: idAvaliacao, p_regra_versao: VERSAO_REGRA_ELEGIBILIDADE,
    }));
  });

  it('UUID bem formado sem aprovação retorna a recusa do banco, sem tentar RPC antiga', async () => {
    mocks.rpc.mockResolvedValue({
      data: { success: false, code: 'elegibilidade_reprovada', error: 'A elegibilidade não está aprovada.' }, error: null,
    });
    const resp = await chamar(corpoValido());
    expect(resp.status).toBe(422);
    expect(await resp.json()).toEqual({ code: 'elegibilidade_reprovada', error: 'A elegibilidade não está aprovada.' });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc.mock.calls[0][0]).toBe('fn_sdr_api_agendar_reuniao_agente');
  });

  it('falha técnica da RPC protegida também não cai no agendamento geral', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'Banco indisponível no teste' } });
    expect((await chamar(corpoValido())).status).toBe(500);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc.mock.calls[0][0]).toBe('fn_sdr_api_agendar_reuniao_agente');
  });

  it('não deixa lead_id pronto evitar a validação da prova', async () => {
    const resp = await chamar({ ...corpoValido(), lead_id: idLead, elegibilidade_versao: 'outra_versao' });
    expect(resp.status).toBe(422);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('mantém a autenticação obrigatória', async () => {
    expect((await chamar(corpoValido(), 'agendamentos-agente', null)).status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalledWith('leads');
  });

  it('chave revogada não resolve lead nem executa a criação', async () => {
    mocks.chave = { ...mocks.chave, revoked_at: '2030-01-01' };
    expect((await chamar(corpoValido())).status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalledWith('leads');
  });
});

describe('compatibilidade do agendamento geral', () => {
  it('a rota anterior usa a mesma RPC sem exigir nem repassar prova da IA', async () => {
    const body = { ...corpoValido(), elegibilidade_id: undefined, elegibilidade_versao: 'versao_irrelevante', telefone: undefined };
    const resp = await chamar(body, 'agendamentos');
    expect(resp.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    const [nome, parametros] = mocks.rpc.mock.calls[0];
    expect(nome).toBe('fn_sdr_api_agendar_reuniao');
    expect(parametros.p_sdr_id).toBe(idSdrDaChave);
    expect(parametros).not.toHaveProperty('p_avaliacao_id');
    expect(parametros).not.toHaveProperty('p_regra_versao');
    expect(parametros).not.toHaveProperty('p_telefone');
  });

  it('PATCH humano continua reagendando pela RPC original sem prova da IA', async () => {
    const resp = await handler(new Request(`https://supabase.invalid/functions/v1/sdr-api/agendamentos/${idAgendamento}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer chave_sintetica' },
      body: JSON.stringify({ data_agendamento: '2030-06-11T10:00:00-03:00' }),
    }));
    expect(resp.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('fn_sdr_api_reagendar', expect.objectContaining({
      p_sdr_id: idSdrDaChave, p_agendamento_id: idAgendamento,
      p_data_agendamento: '2030-06-11T10:00:00-03:00',
    }));
    expect(mocks.rpc.mock.calls[0][1]).not.toHaveProperty('p_avaliacao_id');
  });
});
