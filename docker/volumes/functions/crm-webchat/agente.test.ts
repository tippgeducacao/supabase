import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LINK_ESCOLA_GRATUITA } from '../crm-agente-sdr/escolaGratuita';
import type { Estagio, Produto } from './agente';

// Exercita o loop real, inclusive as guardas e os envios interceptados pelo webchat.
// Só as fronteiras com banco, rede e modelo são simuladas: nenhum lead é contatado.
const mocks = vi.hoisted(() => ({
  principal: vi.fn(),
  router: vi.fn(),
  carregarTools: vi.fn(),
  executarTool: vi.fn(),
  buscarLead: vi.fn(),
  fetch: vi.fn(),
  update: vi.fn(),
  sessao: {} as Record<string, unknown>,
}));

vi.mock('https://esm.sh/@supabase/supabase-js@2.49.4', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: mocks.sessao, error: null }) }),
      }),
      update: mocks.update,
    }),
  }),
}));
vi.mock('../crm-agente-sdr/agente.ts', () => ({
  carregarTools: mocks.carregarTools,
  chamarAgentePrincipal: mocks.principal,
  chamarRouter: mocks.router,
}));
vi.mock('../crm-agente-sdr/historico.ts', async (original) => ({
  ...await original<typeof import('../crm-agente-sdr/historico')>(),
  buscarLead: mocks.buscarLead,
}));
vi.mock('../crm-agente-sdr/tools.ts', () => ({
  executarTool: mocks.executarTool,
  montarToolResults: (outputs: unknown[]) => outputs,
}));
vi.mock('../crm-agente-sdr/saida.ts', () => ({
  humanizarTexto: (texto: string) => texto,
  fracionarResposta: async (texto: string) => [texto],
}));

let responderWebchat: typeof import('./agente').responderWebchat;
beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: (chave: string) => ({
    AGENTE_SDR_ANTHROPIC_KEY: 'chave-sintetica-sem-acesso',
    SUPABASE_URL: 'https://supabase.invalid',
    SUPABASE_SERVICE_ROLE_KEY: 'chave-sintetica-sem-acesso',
    WEBCHAT_REENVIO_WHATSAPP_COOLDOWN_MIN: '10',
  })[chave] } });
  vi.stubGlobal('fetch', mocks.fetch);
  ({ responderWebchat } = await import('./agente'));
});
afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  vi.resetAllMocks();
  mocks.sessao = { cronogramas_enviados: [], levado_para_whatsapp_em: null };
  mocks.update.mockImplementation((dados: Record<string, unknown>) => {
    Object.assign(mocks.sessao, dados);
    return { eq: async () => ({ error: null }) };
  });
  mocks.buscarLead.mockResolvedValue({ formacao_academica: 'Medicina Veterinária' });
  mocks.carregarTools.mockResolvedValue([]);
  mocks.router.mockResolvedValue('agente_validacao');
  mocks.executarTool.mockResolvedValue({ resultado: 'Atendimento pausado.', id: 'tool-1' });
  mocks.principal.mockResolvedValue({ content: [{ type: 'text', text: 'seguimos por aqui.' }] });
  // Um teste que esquecer de simular a resposta da rede precisa falhar, nunca acessar a VPS.
  mocks.fetch.mockRejectedValue(new Error('Resposta de rede não simulada no teste'));
});

type Opcoes = { produto?: Produto; modoTeste?: boolean; telefone?: string; estagio?: Estagio; curso?: string | null };
function chamada(nome: string, input: Record<string, unknown> = {}, id = 'tool-1') {
  return { type: 'tool_use', name: nome, id, input };
}
async function rodar(nome: string, input: Record<string, unknown> = {}, opcoes: Opcoes = {}) {
  mocks.principal.mockResolvedValueOnce({ content: [chamada(nome, input)] });
  return responderWebchat(
    'Visitante Teste', opcoes.telefone ?? '5500000000000', opcoes.curso === undefined ? 'Clínica de Bovinos' : opcoes.curso,
    [{ role: 'user', text: 'Pedido sintético do visitante' }], opcoes.estagio ?? 'qualificador',
    'lead-sintetico', opcoes.produto ?? 'pos', opcoes.modoTeste ?? false, 'sessao-sintetica',
  );
}
function responderEnvio(body: unknown, status = 200) {
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe('responderWebchat: encerramento completo', () => {
  it('pedido de humano recebe a transferência sem convite de despedida', async () => {
    const resposta = await rodar('pausa_ia', { motivo: 'Lead pediu atendimento humano' });
    expect(resposta.chunks).toEqual(['claro, já te passo pra alguém do time aqui.']);
    expect(mocks.principal).toHaveBeenCalledTimes(2);
  });

  it('desinteresse na pós recebe despedida e biblioteca gratuita', async () => {
    const resposta = await rodar('pausa_ia', { motivo: 'Lead demonstrou desinteresse' });
    expect(resposta.chunks[0]).toContain('agradeço sua preferência');
    expect(resposta.chunks[1]).toContain(LINK_ESCOLA_GRATUITA);
  });

  it('quem já está na Escola encerra sem convite para entrar nela', async () => {
    const resposta = await rodar('pausa_ia', { motivo: 'Lead demonstrou desinteresse' }, { produto: 'escola' });
    expect(resposta.chunks).toHaveLength(1);
    expect(resposta.chunks[0]).toContain('agradeço sua preferência');
    expect(resposta.chunks.join(' ')).not.toContain(LINK_ESCOLA_GRATUITA);
  });
});

describe('responderWebchat: efeito confirmado de cronograma', () => {
  it('registra o envio confirmado, incluindo o curso escolhido pela ferramenta', async () => {
    responderEnvio({ data: { cronograma_enviado: true } });
    const resposta = await rodar('envia_informacoes', { curso_escolhido: 'Nutrição de Bovinos' });
    expect(resposta.tools[0].efeito_whatsapp).toEqual({ tipo: 'cronograma', curso: 'Nutrição de Bovinos' });
    expect(mocks.update).toHaveBeenCalledWith({ cronogramas_enviados: ['nutrição de bovinos'] });
  });

  it('recusa sem graduação antes de tentar o envio', async () => {
    mocks.buscarLead.mockResolvedValue({ formacao_academica: '' });
    const resposta = await rodar('envia_informacoes');
    expect(resposta.tools[0].resultado).toContain('RECUSADO');
    expect(resposta.tools[0].efeito_whatsapp).toBeUndefined();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('não trata cronograma já enviado como novo envio', async () => {
    mocks.sessao.cronogramas_enviados = ['clínica de bovinos'];
    const resposta = await rodar('envia_informacoes');
    expect(resposta.tools[0].resultado).toContain('JÁ FOI ENVIADO');
    expect(resposta.tools[0].efeito_whatsapp).toBeUndefined();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('consulta apenas de valor não aciona continuidade mesmo com flag inesperado', async () => {
    responderEnvio({ data: { cronograma_enviado: true, valor_integral: '1000,00' } });
    const resposta = await rodar('envia_informacoes', { conteudo: 'valor' });
    expect(resposta.tools[0].resultado).toContain('1000,00');
    expect(resposta.tools[0].resultado).not.toContain('Cronograma ENVIADO');
    expect(resposta.tools[0].efeito_whatsapp).toBeUndefined();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each([
    { caso: 'recusa do servidor', status: 422, body: { error: 'Não foi possível enviar' } },
    { caso: 'erro explícito apesar do HTTP 200', status: 200, body: { error: 'Envio recusado', data: { cronograma_enviado: true } } },
    { caso: 'erro interno no envelope', status: 200, body: { data: { error: 'Envio recusado', cronograma_enviado: true } } },
    { caso: 'cronograma não enviado', status: 200, body: { data: { cronograma_enviado: false, cronograma_erro: 'Recusado' } } },
    { caso: 'booleano em string não confiável', status: 200, body: { data: { cronograma_enviado: 'true' } } },
    { caso: 'resposta sem confirmação', status: 200, body: { data: {} } },
  ])('não registra efeito em $caso', async ({ status, body }) => {
    responderEnvio(body, status);
    const resposta = await rodar('envia_informacoes');
    expect(resposta.tools[0].efeito_whatsapp).toBeUndefined();
    expect(resposta.tools[0].resultado).not.toContain('Cronograma ENVIADO');
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe('responderWebchat: efeito confirmado de transferência', () => {
  it('registra a transferência após o servidor aceitar o template', async () => {
    responderEnvio({ success: true, wa_message_id: 'mensagem-sintetica' });
    const resposta = await rodar('levar_para_whatsapp');
    expect(resposta.tools[0].efeito_whatsapp).toEqual({ tipo: 'transferencia', curso: 'Clínica de Bovinos' });
    expect(mocks.update).toHaveBeenCalledWith({ levado_para_whatsapp_em: expect.any(String) });
  });

  it('permite transferência sem curso, preservando essa ausência no efeito', async () => {
    responderEnvio({ success: true });
    const resposta = await rodar('levar_para_whatsapp', {}, { curso: null });
    expect(resposta.tools[0].efeito_whatsapp).toEqual({ tipo: 'transferencia', curso: null });
  });

  it('recusa transferência sem telefone', async () => {
    const resposta = await rodar('levar_para_whatsapp', {}, { telefone: '' });
    expect(resposta.tools[0].resultado).toContain('RECUSADO');
    expect(resposta.tools[0].efeito_whatsapp).toBeUndefined();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('cooldown impede novo envio e novo efeito', async () => {
    mocks.sessao.levado_para_whatsapp_em = new Date().toISOString();
    const resposta = await rodar('levar_para_whatsapp');
    expect(resposta.tools[0].resultado).toContain('menos de 10 min');
    expect(resposta.tools[0].efeito_whatsapp).toBeUndefined();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('novo pedido após o cooldown pode enviar de novo', async () => {
    mocks.sessao.levado_para_whatsapp_em = new Date(Date.now() - 11 * 60_000).toISOString();
    responderEnvio({ success: true });
    const resposta = await rodar('levar_para_whatsapp');
    expect(resposta.tools[0].efeito_whatsapp?.tipo).toBe('transferencia');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { caso: 'HTTP 422', status: 422, body: { error: 'Template recusado' } },
    { caso: 'error explícito no HTTP 200', status: 200, body: { success: true, error: 'Template recusado' } },
    { caso: 'error no envelope', status: 200, body: { success: true, data: { error: 'Template recusado' } } },
    { caso: 'ok falso apesar de success true', status: 200, body: { success: true, ok: false } },
    { caso: 'success falso', status: 200, body: { success: false } },
    { caso: 'success textual', status: 200, body: { success: 'true' } },
    { caso: 'objeto vazio', status: 200, body: {} },
    { caso: 'JSON null', status: 200, body: null },
  ])('não confirma transferência em $caso', async ({ status, body }) => {
    responderEnvio(body, status);
    const resposta = await rodar('levar_para_whatsapp');
    expect(resposta.tools[0].efeito_whatsapp).toBeUndefined();
    expect(resposta.tools[0].resultado).not.toContain('Mensagem ENVIADA');
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('HTTP 200 com corpo inválido não confirma envio nem consome cooldown', async () => {
    mocks.fetch.mockResolvedValue(new Response('resposta sem JSON', { status: 200 }));
    const resposta = await rodar('levar_para_whatsapp');
    expect(resposta.tools[0].efeito_whatsapp).toBeUndefined();
    expect(resposta.tools[0].resultado).toContain('envio não confirmado pelo servidor');
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe('responderWebchat: nenhuma tentativa vira envio por inferência de texto', () => {
  it.each(['envia_informacoes', 'levar_para_whatsapp'])('duas chamadas de %s na mesma rodada produzem um único envio', async (tool) => {
    mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({
      success: true, data: { cronograma_enviado: true },
    }), { status: 200 }));
    mocks.principal.mockResolvedValueOnce({ content: [chamada(tool), chamada(tool, {}, 'tool-2')] });
    const resposta = await responderWebchat(
      'Visitante Teste', '5500000000000', 'Clínica de Bovinos',
      [{ role: 'user', text: 'Pedido sintético de envio' }], 'qualificador',
      'lead-sintetico', 'pos', false, 'sessao-sintetica',
    );
    expect(resposta.tools.filter((registro) => registro.efeito_whatsapp)).toHaveLength(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it.each(['envia_informacoes', 'levar_para_whatsapp'])('modo teste de %s não gera efeito real', async (tool) => {
    const resposta = await rodar(tool, {}, { modoTeste: true });
    expect(resposta.tools[0].mockado).toBe(true);
    expect(resposta.tools[0].efeito_whatsapp).toBeUndefined();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each(['envia_informacoes', 'levar_para_whatsapp'])('erro de rede em %s não gera efeito', async (tool) => {
    mocks.fetch.mockRejectedValue(new Error('Rede indisponível'));
    const resposta = await rodar(tool);
    expect(resposta.tools[0].efeito_whatsapp).toBeUndefined();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each<Estagio>(['validacao', 'qualificador'])('roteiro %s espera confirmação e permite novo pedido após cooldown', async (estagio) => {
    await rodar('levar_para_whatsapp', {}, { estagio });
    const prompt = mocks.principal.mock.calls[0][0].promptAgente as string;
    expect(prompt).not.toContain('Uma vez por conversa. Se já mandou');
    expect(prompt).toContain('Aguarde o retorno da ferramenta');
    expect(prompt).toContain('10 minutos');
  });
});
