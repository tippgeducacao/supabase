import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LINK_ESCOLA_GRATUITA } from '../crm-agente-sdr/escolaGratuita';
import type { Estagio, Produto } from './agente';
import { type EstadoElegibilidade, VERSAO_REGRA_ELEGIBILIDADE } from '../crm-agente-sdr/elegibilidadeAgendamento';

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
  from: vi.fn(),
  rpc: vi.fn(),
  matriz: vi.fn(),
  selecionarSessao: vi.fn(),
  escreverLead: vi.fn(),
  sessao: {} as Record<string, unknown>,
}));

vi.mock('https://esm.sh/@supabase/supabase-js@2.49.4', () => ({
  createClient: () => ({
    from: mocks.from,
    rpc: mocks.rpc,
  }),
}));
vi.mock('../crm-agente-sdr/agente.ts', () => ({
  carregarTools: mocks.carregarTools,
  chamarAgentePrincipal: mocks.principal,
  chamarRouter: mocks.router,
  chamarAnthropic: mocks.matriz,
}));
vi.mock('../crm-agente-sdr/historico.ts', async (original) => ({
  ...await original<typeof import('../crm-agente-sdr/historico')>(),
  buscarLead: mocks.buscarLead,
}));
vi.mock('../crm-agente-sdr/tools.ts', () => ({
  executarTool: mocks.executarTool,
  montarToolResults: (outputs: unknown[]) => outputs,
}));
vi.mock('../crm-agente-sdr/saida.ts', async (original) => ({
  ...await original<typeof import('../crm-agente-sdr/saida')>(),
  humanizarTexto: (texto: string) => texto,
  fracionarResposta: async (texto: string) => [texto],
}));

let responderWebchat: typeof import('./agente').responderWebchat;
let aberturaWebchat: typeof import('./agente').aberturaWebchat;
let executarToolReal: typeof import('../crm-agente-sdr/tools').executarTool;
beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: (chave: string) => ({
    AGENTE_SDR_ANTHROPIC_KEY: 'chave-sintetica-sem-acesso',
    SUPABASE_URL: 'https://supabase.invalid',
    SUPABASE_SERVICE_ROLE_KEY: 'chave-sintetica-sem-acesso',
    WEBCHAT_REENVIO_WHATSAPP_COOLDOWN_MIN: '10',
  })[chave] } });
  vi.stubGlobal('fetch', mocks.fetch);
  ({ executarTool: executarToolReal } = await vi.importActual<typeof import('../crm-agente-sdr/tools')>('../crm-agente-sdr/tools.ts'));
  ({ responderWebchat, aberturaWebchat } = await import('./agente'));
});
afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  vi.resetAllMocks();
  mocks.sessao = { cronogramas_enviados: [], levado_para_whatsapp_em: null };
  mocks.selecionarSessao.mockImplementation(() => ({
    eq: () => ({ maybeSingle: async () => ({ data: mocks.sessao, error: null }) }),
  }));
  mocks.from.mockImplementation((tabela: string) => {
    if (tabela === 'webchat_sessoes') return { select: mocks.selecionarSessao, update: mocks.update };
    if (tabela === 'cliente_ppg_leads_sdr') return { update: mocks.escreverLead };
    if (tabela === 'cursos_pos_graduacao' || tabela === 'cursos') {
      const consulta = {
        eq: () => consulta,
        order: async () => ({ data: tabela === 'cursos'
          ? [{ id: '00000000-0000-4000-8000-000000000003', nome: 'PÓS | Sanidade Avícola' }, { id: '00000000-0000-4000-8000-000000000004', nome: 'PÓS | Cannabis Medicinal' }]
          : [{ pos_graduacao: 'Sanidade Avícola', pode_fazer: 'Medicina Veterinária', parcialmente_aceitas: '', status: 'ativo' }],
        error: null }),
      };
      return { select: () => consulta };
    }
    throw new Error(`Tabela não simulada neste teste: ${tabela}`);
  });
  mocks.rpc.mockImplementation(async (rpc: string) => {
    if (rpc === 'fn_sdr_api_resolver_pos_graduacao') {
      return { data: { id: '00000000-0000-4000-8000-000000000004', nome: 'PÓS | Cannabis Medicinal' }, error: null };
    }
    return { data: { success: false, code: 'elegibilidade_ausente' }, error: null };
  });
  mocks.escreverLead.mockImplementation(() => { throw new Error('Tentativa de escrita SDR em teste isolado'); });
  mocks.matriz.mockRejectedValue(new Error('Matriz não simulada neste cenário'));
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

describe('aberturaWebchat: canal final obrigatório', () => {
  const mensagemFinal = (mensagem: string) => chamada('responder_ao_cliente', { mensagem }, 'resposta-local');

  it('só publica o campo mensagem, mesmo com preâmbulo e thinking na mesma geração', async () => {
    responderEnvio({ stop_reason: 'tool_use', content: [
      { type: 'thinking', thinking: 'ANÁLISE NATIVA SINTÉTICA', signature: 'assinatura-teste' },
      { type: 'text', text: 'Preciso decidir qual abertura oferecer ao visitante.' },
      mensagemFinal('Oi, Visitante Teste, tudo bem? Qual área te interessa?'),
    ] });
    const chunks = await aberturaWebchat('Visitante Teste', null);
    expect(chunks).toEqual(['Oi, Visitante Teste, tudo bem?', 'Qual área te interessa?']);
    expect(chunks.join(' ')).not.toMatch(/ANÁLISE|Preciso decidir|assinatura/);
    const pedido = JSON.parse(mocks.fetch.mock.calls[0][1].body);
    expect(pedido.max_tokens).toBe(400);
    expect(pedido.thinking).toEqual({ type: 'disabled' });
    expect(pedido.tools).toHaveLength(1);
    expect(pedido.tools[0]).toMatchObject({ name: 'responder_ao_cliente', strict: true });
    expect(pedido.tool_choice).toEqual({ type: 'tool', name: 'responder_ao_cliente', disable_parallel_tool_use: true });
    expect(mocks.executarTool).not.toHaveBeenCalled();
  });

  it.each([
    { caso: 'texto livre', stop_reason: 'end_turn', content: [{ type: 'text', text: 'TEXTO LIVRE NÃO PUBLICÁVEL' }] },
    { caso: 'campo com raciocínio', stop_reason: 'tool_use', content: [mensagemFinal('O lead ainda não escreveu. Vou decidir a abertura.')] },
    { caso: 'tag truncada', stop_reason: 'tool_use', content: [mensagemFinal('<thinking>Preciso decidir.')] },
    { caso: 'geração interrompida', stop_reason: 'max_tokens', content: [mensagemFinal('TEXTO PARCIAL NÃO PUBLICÁVEL')] },
    { caso: 'negócio junto da resposta', stop_reason: 'tool_use', content: [mensagemFinal('TEXTO CONCORRENTE NÃO PUBLICÁVEL'), chamada('pausa_ia')] },
    { caso: 'conteúdo inválido', stop_reason: 'tool_use', content: null },
  ])('usa apenas fallback determinístico quando recebe $caso', async ({ caso: _caso, ...respostaModelo }) => {
    responderEnvio(respostaModelo);
    const chunks = await aberturaWebchat('Visitante Teste', null);
    expect(chunks.join(' ')).toContain('qual área vc tá querendo');
    expect(chunks.join(' ')).not.toMatch(/PUBLICÁVEL|lead|thinking|decidir/);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.executarTool).not.toHaveBeenCalled();
  });

  it('silêncio explícito não é substituído pela abertura determinística', async () => {
    responderEnvio({ stop_reason: 'tool_use', content: [mensagemFinal('')] });
    expect(await aberturaWebchat('Visitante Teste', null)).toEqual([]);
  });

  it('resposta HTTP de erro não é aproveitada mesmo com campo final aparente', async () => {
    responderEnvio({ stop_reason: 'tool_use', content: [mensagemFinal('TEXTO DO ERRO NÃO PUBLICÁVEL')] }, 400);
    const chunks = await aberturaWebchat('Visitante Teste', null);
    expect(chunks.join(' ')).toContain('qual área vc tá querendo');
    expect(chunks.join(' ')).not.toContain('TEXTO DO ERRO');
  });
});

describe('responderWebchat: encerramento completo', () => {
  it.each(['silencio_explicito', 'bastidor_no_canal', 'falha_na_correcao', 'geracao_nao_concluida'])('canal vazio por %s não vira pergunta automática', async (motivo) => {
    mocks.principal.mockResolvedValueOnce({ content: [], stop_reason: 'end_turn', canal_resposta: { motivo } });
    const resposta = await responderWebchat('Visitante Teste', '5500000000000', 'Clínica de Bovinos', [
      { role: 'user', text: 'Obrigado' },
    ], 'qualificador');
    expect(resposta.chunks).toEqual([]);
    expect(mocks.executarTool).not.toHaveBeenCalled();
    expect(mocks.principal).toHaveBeenCalledTimes(1);
  });

  it.each(['silencio_explicito', 'bastidor_no_canal'])('despedida confirmada permanece se a volta final fica vazia: %s', async (motivo) => {
    mocks.principal.mockResolvedValue({ content: [], stop_reason: 'end_turn', canal_resposta: { motivo } });
    const resposta = await rodar('pausa_ia', { tipo: 'nao_perturbe' });
    expect(resposta.chunks[0]).toContain('agradeço sua preferência');
    expect(resposta.chunks[1]).toContain(LINK_ESCOLA_GRATUITA);
    expect(mocks.principal.mock.calls[1][0].tools).toEqual([]);
  });

  it('pausa de motivo desconhecido não libera outras ações na volta da resposta final', async () => {
    const resposta = await rodar('pausa_ia', { motivo: 'situação específica' });
    expect(mocks.principal).toHaveBeenCalledTimes(2);
    expect(mocks.principal.mock.calls[1][0].tools).toEqual([]);
    expect(resposta.chunks).toEqual(['seguimos por aqui.']);
  });

  it.each([
    { status: 'bloqueado' }, { status: 'erro' }, { ok: false },
    { resultado: 'Erro ao executar pausa_ia: indisponível' },
  ])('pausa recusada ou falha não impõe despedida: %j', async (saidaTool) => {
    mocks.executarTool.mockResolvedValueOnce(saidaTool);
    const resposta = await rodar('pausa_ia', { tipo: 'nao_perturbe' });
    expect(resposta.chunks).toEqual(['seguimos por aqui.']);
    expect(mocks.principal.mock.calls[1][0].tools).not.toEqual([]);
  });

  it.each([false, true])('recusa sem graduação inventada sem executar pausa ou impor despedida (teste=%s)', async (modoTeste) => {
    mocks.principal.mockResolvedValueOnce({ content: [
      { type: 'text', text: 'Sem graduação não pode cursar a pós.' },
      chamada('pausa_ia', { tipo: 'sem_graduacao', motivo: 'não atua em nenhuma área' }),
    ] }).mockResolvedValueOnce({ content: [{ type: 'text', text: 'O que te interessou na aula?' }] });
    const resposta = await responderWebchat('Visitante Teste', '5500000000000', 'Clínica de Bovinos', [
      { role: 'assistant', text: 'Você atua em qual área?' },
      { role: 'user', text: 'Nenhuma. Pretendo atuar em Qualidade.' },
    ], 'validacao', 'lead-sintetico', 'pos', modoTeste, 'sessao-sintetica');
    expect(mocks.executarTool).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(resposta.chunks).toEqual(['O que te interessou na aula?']);
    expect(resposta.tools[0].resultado).toContain('Pausa e arquivamento NÃO executados');
    expect(mocks.principal).toHaveBeenCalledTimes(2);
  });

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

describe('responderWebchat: elegibilidade isolada do harness', () => {
  const curso = 'Sanidade Avícola';
  const aprovada: EstadoElegibilidade = {
    curso, decisao: 'aprovado', motivo: 'APROVADO', regra_versao: VERSAO_REGRA_ELEGIBILIDADE,
  };
  const verificacao = {
    formacao_academica: 'Medicina Veterinária', curso_interesse: curso, contexto_qualificacao: 'normal',
  };
  beforeEach(() => {
    mocks.sessao.modo_teste = true;
    mocks.executarTool.mockImplementation(executarToolReal);
    mocks.matriz.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify({
      formacao_identificada: 'Medicina Veterinária', e_medico_veterinario: true,
      curso_solicitado: curso, pode_cursar: true, compativel: true,
      curso_exclusivo_veterinario: true, curso_alternativo_recomendado: false,
      curso_alternativo: null, mensagem_para_lead: 'Formação compatível.', output: 'APROVADO',
    }) }] });
  });

  function restaurarLogs(...estados: EstadoElegibilidade[]) {
    mocks.sessao.teste_tool_chamadas = estados.map((estado) => ({ elegibilidade_teste: estado }));
  }
  function teste(nome: string, input: Record<string, unknown> = {}) {
    return rodar(nome, input, { modoTeste: true, curso });
  }
  async function sequencia(tools: ReturnType<typeof chamada>[]) {
    mocks.principal.mockResolvedValueOnce({ content: tools });
    return responderWebchat(
      'Visitante Teste', '5500000000000', curso,
      [{ role: 'user', text: 'Pedido sintético do harness' }], 'qualificador',
      'lead-sintetico', 'pos', true, 'sessao-sintetica',
    );
  }

  it('passa modoTeste ao executor real e registra a aprovação simulada no log', async () => {
    const resposta = await teste('verificar_compatibilidade_curso', verificacao);
    expect(mocks.executarTool).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      name: 'verificar_compatibilidade_curso',
    }), expect.objectContaining({ modoTeste: true }));
    expect(mocks.matriz).toHaveBeenCalledTimes(1);
    expect(resposta.tools[0]).toMatchObject({ mockado: false, elegibilidade_teste: aprovada });
    expect(mocks.principal.mock.calls[0][0].contextoTemporal).toContain('AMBIENTE DE TESTE: elegibilidade_simulada=true');
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.escreverLead).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('restaura a aprovação do log serializado numa segunda rodada de sessão de teste', async () => {
    const primeira = await teste('verificar_compatibilidade_curso', verificacao);
    mocks.sessao.teste_tool_chamadas = JSON.parse(JSON.stringify(primeira.tools));
    const segunda = await teste('confirmar_agendamento', { curso_escolhido: curso });
    expect(segunda.tools[0]).toMatchObject({ mockado: true, elegibilidade_teste: aprovada });
    expect(segunda.tools[0].resultado).toContain('Agendamento confirmado. id: teste-seguro');
    expect(mocks.executarTool).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([false, undefined, 'true'])('não restaura aprovação se modo_teste da sessão é %j', async (flag) => {
    mocks.sessao.modo_teste = flag;
    restaurarLogs(aprovada);
    const resposta = await teste('confirmar_agendamento', { curso_escolhido: curso });
    expect(resposta.tools[0].resultado).toContain('RECUSADO');
    expect(resposta.tools[0].elegibilidade_teste).toBeUndefined();
    expect(mocks.executarTool).not.toHaveBeenCalled();
  });

  it('produção ignora logs de simulação mesmo quando existem na sessão', async () => {
    restaurarLogs(aprovada);
    const resposta = await rodar('confirmar_agendamento', { curso_escolhido: curso }, { curso, modoTeste: false });
    expect(resposta.tools[0].mockado).toBe(false);
    expect(resposta.tools[0].resultado).toContain('RECUSADO');
    expect(resposta.tools[0].elegibilidade_teste).toBeUndefined();
    expect(mocks.selecionarSessao).not.toHaveBeenCalled();
    expect(mocks.principal.mock.calls[0][0].contextoTemporal).not.toContain('AMBIENTE DE TESTE');
    expect(mocks.executarTool.mock.calls[0][2]).toMatchObject({ modoTeste: false });
    expect(mocks.executarTool.mock.calls[0][2].ultimaElegibilidade).toBeUndefined();
    expect(mocks.rpc).toHaveBeenCalledWith('crm_agente_elegibilidade_consultar', expect.anything());
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each<EstadoElegibilidade['decisao']>(['pendente', 'reprovado'])(
    'a decisão %s mais recente substitui aprovação antiga do log', async (decisao) => {
      restaurarLogs(aprovada, { ...aprovada, decisao, motivo: 'Revisão posterior' });
      const resposta = await teste('confirmar_agendamento', { curso_escolhido: curso });
      expect(resposta.tools[0].resultado).toContain('RECUSADO');
      expect(resposta.tools[0].elegibilidade_teste?.decisao).toBe(decisao);
    },
  );

  it('não restaura aprovação registrada sob versão antiga da regra', async () => {
    restaurarLogs({ ...aprovada, regra_versao: 'regra-antiga' });
    const resposta = await teste('confirmar_agendamento', { curso_escolhido: curso });
    expect(resposta.tools[0].resultado).toContain('RECUSADO');
    expect(resposta.tools[0].elegibilidade_teste).toBeUndefined();
  });

  it.each([
    { formacao: 'Zootecnia' },
    { tempo_formacao: 'concluo em 2028' },
  ])('alteração de qualificação invalida antes da confirmação na mesma rodada: %j', async (input) => {
    restaurarLogs(aprovada);
    const resposta = await sequencia([
      chamada('atualizar_dados_lead', input),
      chamada('confirmar_agendamento', { curso_escolhido: curso }, 'confirmar-2'),
    ]);
    expect(resposta.tools[0].elegibilidade_teste).toMatchObject({ decisao: 'pendente', motivo: 'dados_alterados' });
    expect(resposta.tools[1].resultado).toContain('RECUSADO');
    expect(mocks.executarTool).not.toHaveBeenCalled();
    expect(mocks.escreverLead).not.toHaveBeenCalled();
  });

  it('alteração apenas de nome conserva aprovação e evita requalificação desnecessária', async () => {
    restaurarLogs(aprovada);
    const resposta = await sequencia([
      chamada('atualizar_dados_lead', { nome: 'Nome corrigido' }),
      chamada('confirmar_agendamento', { curso_escolhido: curso }, 'confirmar-2'),
    ]);
    expect(resposta.tools[1].resultado).toContain('Agendamento confirmado. id: teste-seguro');
    expect(mocks.escreverLead).not.toHaveBeenCalled();
  });

  it('troca de curso usa executor real, invalida aprovação e não escreve interesse no SDR', async () => {
    restaurarLogs(aprovada);
    const resposta = await sequencia([
      chamada('consulta_pos_disponiveis', { trocar_para: 'Cannabis Medicinal' }),
      chamada('confirmar_agendamento', { curso_escolhido: 'Cannabis Medicinal' }, 'confirmar-2'),
    ]);
    expect(resposta.tools[0]).toMatchObject({ mockado: false, elegibilidade_teste: {
      curso: 'Cannabis Medicinal', decisao: 'pendente', motivo: 'dados_alterados',
    } });
    expect(resposta.tools[1].resultado).toContain('RECUSADO');
    expect(mocks.escreverLead).not.toHaveBeenCalled();
    // Correspondência exata já resolve o curso; a RPC serve aos nomes alternativos.
    expect(resposta.tools[0].resultado).toContain('Interesse simulado: Cannabis Medicinal');
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('prazo reprovado pelo executor real permanece reprovado e não pode ser confirmado no mock', async () => {
    const resposta = await sequencia([
      chamada('verificar_compatibilidade_curso', {
        ...verificacao, contexto_qualificacao: 'estudante_fora_do_prazo',
        conclusao_graduacao_bruta: 'concluo em dezembro de 2099', conclusao_graduacao: '12/2099',
      }),
      chamada('confirmar_agendamento', { curso_escolhido: curso }, 'confirmar-2'),
    ]);
    expect(resposta.tools[0].elegibilidade_teste).toMatchObject({ decisao: 'reprovado', motivo: 'REPROVADO_PRAZO' });
    expect(resposta.tools[1].resultado).toContain('RECUSADO');
    expect(mocks.matriz).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.escreverLead).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe('responderWebchat: canal instagram (direct do Instagram, teste de 24/09/2026)', () => {
  const historico = [{ role: 'user' as const, text: 'oi, quero saber da pós' }];

  it('troca SÓ a nota de canal: o direct no lugar do chat do site', async () => {
    await responderWebchat('Gustavo', '00012345678', null, historico, 'validacao', null, 'pos', true, null, { canal: 'instagram' });
    const prompt = mocks.principal.mock.calls[0][0].promptAgente as string;
    expect(prompt).toContain('CANAL: DIRECT DO INSTAGRAM');
    expect(prompt).not.toContain('CHAT DO SITE');
    expect(prompt).toContain('NUNCA REPITA');
    expect(prompt).toContain('Catálogo é SÓ agro');
  });

  it('sem opções continua sendo o chat do site', async () => {
    await responderWebchat('Gustavo', '5546999999999', 'Clínica de Bovinos', historico, 'validacao');
    const prompt = mocks.principal.mock.calls[0][0].promptAgente as string;
    expect(prompt).toContain('CANAL: CHAT DO SITE');
    expect(prompt).toContain('Esta conversa veio da página da pós **"Clínica de Bovinos"**');
    expect(prompt).not.toContain('DIRECT DO INSTAGRAM');
  });

  it('conversa que começou por uma mensagem nossa no direct ganha o marcador do direct', async () => {
    await responderWebchat('Gustavo', '00012345678', null, [
      { role: 'assistant', text: 'oi! vi seu perfil' }, { role: 'user', text: 'oi' },
    ], 'validacao', null, 'pos', true, null, { canal: 'instagram' });
    const mensagens = mocks.principal.mock.calls[0][0].messages;
    expect(JSON.stringify(mensagens[0])).toContain('começou por uma mensagem nossa');
    expect(JSON.stringify(mensagens)).not.toContain('abriu o chat');
  });

  it('elegibilidade herdada libera a confirmação SIMULADA sem webchat_sessoes', async () => {
    const aprovado: EstadoElegibilidade = {
      curso: 'Clínica de Bovinos', decisao: 'aprovado', motivo: 'ok', regra_versao: VERSAO_REGRA_ELEGIBILIDADE,
    } as EstadoElegibilidade;
    mocks.principal.mockResolvedValueOnce({ content: [chamada('confirmar_agendamento', { curso_escolhido: 'Clínica de Bovinos' })] });
    const r = await responderWebchat('Gustavo', '00012345678', null, historico, 'qualificador', null, 'pos', true, null, {
      canal: 'instagram', elegibilidadeInicial: aprovado,
    });
    expect(r.tools[0]).toMatchObject({ nome: 'confirmar_agendamento', mockado: true });
    expect(r.tools[0].resultado).toContain('Agendamento confirmado');
    expect(mocks.executarTool).not.toHaveBeenCalled();
  });

  it('sem elegibilidade herdada a confirmação simulada continua recusada', async () => {
    mocks.principal.mockResolvedValueOnce({ content: [chamada('confirmar_agendamento', { curso_escolhido: 'Clínica de Bovinos' })] });
    const r = await responderWebchat('Gustavo', '00012345678', null, historico, 'qualificador', null, 'pos', true, null, { canal: 'instagram' });
    expect(r.tools[0].resultado).not.toContain('Agendamento confirmado');
  });
});
