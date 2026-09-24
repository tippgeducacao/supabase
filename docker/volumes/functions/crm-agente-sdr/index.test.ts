import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { limparCacheContas } from './conta';

const fronteiras = vi.hoisted(() => ({
  from: vi.fn(), rpc: vi.fn(), buscarLead: vi.fn(), criarLead: vi.fn(), atualizarLead: vi.fn(),
  prepararMensagem: vi.fn(), chamarPrincipal: vi.fn(), chamarRouter: vi.fn(), enviar: vi.fn(),
  registrar: vi.fn(), bufferInserir: vi.fn(), buffer: [] as { id: number; payload: Record<string, unknown> }[],
  pausaNoDebounce: false,
  vozAtiva: false,
  raciocinioEncadeado: false,
  executar: vi.fn(), tools: vi.fn(), gravar: vi.fn(), historico: vi.fn(),
  humanizar: vi.fn(), horarios: vi.fn(), conversa: vi.fn(),
  sincronizarAudio: vi.fn(), provedorOpenai: vi.fn(), lunaTelefones: [] as string[], lunaDelay: 0 as number | null,
}));
vi.mock('https://esm.sh/@supabase/supabase-js@2.50.3', () => ({
  createClient: () => ({ from: fronteiras.from, rpc: fronteiras.rpc }),
}));
vi.mock('./historico.ts', async (original) => ({
  ...await original<typeof import('./historico')>(),
  buscarLead: fronteiras.buscarLead, criarLead: fronteiras.criarLead, atualizarLead: fronteiras.atualizarLead,
  carregarHistorico: fronteiras.historico, gravarMensagem: fronteiras.gravar,
}));
vi.mock('./agente.ts', () => ({
  carregarTools: fronteiras.tools, chamarAgentePrincipal: fronteiras.chamarPrincipal, chamarRouter: fronteiras.chamarRouter,
  provedorOpenai: fronteiras.provedorOpenai,
}));
vi.mock('./tools.ts', () => ({ executarTool: fronteiras.executar, montarToolResults: (outputs: { id: string }[]) => outputs.map((o) => ({
  type: 'tool_result', tool_use_id: o.id, content: JSON.stringify(o),
})) }));
vi.mock('./midia.ts', () => ({ prepararMensagem: fronteiras.prepararMensagem }));
vi.mock('./sincronizacaoAudio.ts', () => ({
  aguardarAudiosDoHistorico: fronteiras.sincronizarAudio, contarAudiosPendentes: vi.fn(),
}));
vi.mock('./saida.ts', () => ({
  enviarResposta: fronteiras.enviar, conversaTexto: fronteiras.conversa, horariosInventados: fronteiras.horarios,
  humanizarTexto: fronteiras.humanizar, removerRaciocinioVazado: (t: string) => t,
}));
vi.mock('./followup.ts', () => ({ rodarEsteiraFollowup: vi.fn() }));
vi.mock('./followup-template.ts', () => ({ rodarEsteiraFollowupTemplate: vi.fn() }));
vi.mock('./eventos.ts', () => ({
  criarTelemetria: () => ({ rodadaId: 'rodada-sintetica', registrar: fronteiras.registrar }),
  resumir: (valor: unknown) => valor,
}));

let handler: (req: Request) => Promise<Response>;
const leadAtivo = { remotejid: '5511999990001@s.whatsapp.net', iniciar_atendimento: true, pausa_ia: false };
const payload = {
  direcao: 'inbound', from_me: false, telefone: '5511999990001', remotejid: leadAtivo.remotejid,
  id: 'wamid.SINTETICO.PAUSA', conteudo: 'Sou veterinária formada.', tipo: 'text',
};

async function chamar(extra: Record<string, unknown> = {}) {
  return await handler(new Request('https://edge.invalid/crm-agente-sdr', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, ...extra }),
  }));
}
function semResposta() {
  expect(fronteiras.chamarPrincipal).not.toHaveBeenCalled();
  expect(fronteiras.chamarRouter).not.toHaveBeenCalled();
  expect(fronteiras.enviar).not.toHaveBeenCalled();
  expect(fronteiras.atualizarLead).not.toHaveBeenCalled();
}

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: (chave: string) => {
      if (chave === 'SUPABASE_URL') return 'https://supabase.invalid';
      if (fronteiras.vozAtiva) return ({
        AGENTE_SDR_VOZ_ATIVA: 'true', AGENTE_SDR_VOZ_TELEFONES: '5511999990001', ELEVENLABS_API_KEY: 'chave-sintetica',
      } as Record<string, string>)[chave] ?? '';
      return '';
    } },
    serve: (fn: typeof handler) => { handler = fn; },
  });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Rede não autorizada neste teste'); }));
  await import('./index');
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.resetAllMocks();
  fronteiras.buffer = [];
  fronteiras.pausaNoDebounce = false;
  fronteiras.vozAtiva = false;
  fronteiras.raciocinioEncadeado = false;
  fronteiras.lunaTelefones = [];
  fronteiras.lunaDelay = 0;
  fronteiras.sincronizarAudio.mockResolvedValue({ estado: 'pronto', esperouMs: 0, pendentes: 0 });
  fronteiras.buscarLead.mockResolvedValue({ ...leadAtivo });
  fronteiras.prepararMensagem.mockResolvedValue({ mensagem: payload.conteudo });
  fronteiras.rpc.mockImplementation(async (nome: string) => {
    if (nome === 'crm_sdr_registrar_entrada') return { data: { estado: 'ativa', gravada: false }, error: null };
    if (nome === 'crm_e_aluno_telefone') return { data: false, error: null };
    if (nome === 'crm_agente_sdr_lock_claim') return { data: false, error: null };
    throw new Error(`RPC inesperada: ${nome}`);
  });
  fronteiras.from.mockImplementation((tabela: string) => {
    if (tabela === 'crm_agente_sdr_config') return {
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { teste_telefones: [], luna_telefones: fronteiras.lunaTelefones, luna_delay_segundos: fronteiras.lunaDelay, openai_raciocinio_encadeado: fronteiras.raciocinioEncadeado }, error: null }) }) }),
    };
    if (tabela === 'crm_pipeline_settings') return {
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { agente_sdr_delay_segundos: 0 }, error: null }) }) }),
    };
    if (tabela === 'cliente_ppg_leads_sdr') return {
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { pausa_ia: fronteiras.pausaNoDebounce }, error: null }) }) }),
      update: () => ({ in: async () => ({ error: null }) }),
    };
    if (tabela === 'crm_agente_sdr_buffer') return {
      insert: fronteiras.bufferInserir.mockImplementation(async (linha: { payload: Record<string, unknown> }) => {
        fronteiras.buffer.push({ id: 1, payload: linha.payload });
        return { error: null };
      }),
      select: () => ({ eq: () => ({ order: async () => ({ data: [...fronteiras.buffer], error: null }) }) }),
      delete: () => ({ in: async () => { fronteiras.buffer = []; return { error: null }; } }),
    };
    if (tabela === 'crm_agente_sdr_lock') return { delete: () => ({ eq: async () => ({ error: null }) }) };
    throw new Error(`Tabela inesperada: ${tabela}`);
  });
});

describe('entrada HTTP: memória da pausa antes de mídia, buffer e LLM', () => {
  it.each([true, false])('barra mensagem recebida em pausa, mesmo após despausar: pausa atual=%s', async (pausaAtual) => {
    fronteiras.buscarLead.mockResolvedValue({ ...leadAtivo, pausa_ia: pausaAtual });
    fronteiras.rpc.mockResolvedValue({ data: { estado: 'pausa', gravada: true }, error: null });
    const resposta = await chamar();
    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toEqual({ ok: true, skip: 'mensagem_recebida_em_pausa' });
    expect(fronteiras.rpc).toHaveBeenCalledExactlyOnceWith('crm_sdr_registrar_entrada', {
      p_wa_message_id: payload.id, p_remotejid: payload.remotejid, p_mensagem: null, p_pausa_observada: pausaAtual,
    });
    expect(fronteiras.prepararMensagem).not.toHaveBeenCalled();
    expect(fronteiras.bufferInserir).not.toHaveBeenCalled();
    semResposta();
  });

  it('cria lead novo da campanha antes de exigir identidade SDR da primeira mensagem', async () => {
    fronteiras.buscarLead.mockResolvedValueOnce(null).mockResolvedValue({ ...leadAtivo });
    const resposta = await chamar({ agente_ia_persona: 'campanha_direta' });
    expect(resposta.status).toBe(200);
    expect(fronteiras.criarLead).toHaveBeenCalledExactlyOnceWith(expect.anything(), payload.remotejid);
    expect(fronteiras.rpc.mock.calls.some(([nome]) => nome === 'crm_sdr_registrar_entrada')).toBe(false);
    expect(fronteiras.prepararMensagem).toHaveBeenCalledOnce();
    expect(fronteiras.bufferInserir).toHaveBeenCalledOnce();
    semResposta(); // outro worker segura o lock: o teste para antes da rodada.
  });

  it('preserva o lote drenado quando a pausa é aplicada durante o debounce', async () => {
    fronteiras.pausaNoDebounce = true;
    fronteiras.rpc.mockImplementation(async (nome: string, parametros: Record<string, unknown>) => {
      if (nome === 'crm_sdr_registrar_entrada') return {
        data: { estado: parametros.p_pausa_observada ? 'pausa' : 'ativa', gravada: Boolean(parametros.p_mensagem) }, error: null,
      };
      if (nome === 'crm_e_aluno_telefone') return { data: false, error: null };
      if (nome === 'crm_agente_sdr_lock_claim') return { data: true, error: null };
      throw new Error(`RPC inesperada: ${nome}`);
    });
    expect((await chamar()).status).toBe(200);
    expect(fronteiras.rpc).toHaveBeenCalledWith('crm_sdr_registrar_entrada', {
      p_wa_message_id: payload.id, p_remotejid: payload.remotejid,
      p_mensagem: { role: 'user', content: payload.conteudo }, p_pausa_observada: true,
    });
    expect(fronteiras.registrar).toHaveBeenCalledWith('envio_abortado_pausa', { onde: 'pos_debounce', mensagens_preservadas: 1 });
    expect(fronteiras.buffer).toEqual([]);
    semResposta();
  });

  it('persona do assistente pedagógico (aluno) nunca vira João, nem como qualificador', async () => {
    const resposta = await chamar({ agente_ia_persona: 'aluno', wa_account_id: 'conta-do-suporte-ao-aluno' });
    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toEqual({ ok: true, skip: 'persona_de_outro_agente' });
    expect(fronteiras.rpc).not.toHaveBeenCalled();
    expect(fronteiras.buscarLead).not.toHaveBeenCalled();
    expect(fronteiras.bufferInserir).not.toHaveBeenCalled();
    semResposta();
  });

  it('reinjeção SEM persona pela conta do aluno ou do RH também não vira João (a persona vem da conta)', async () => {
    // O reconciliador manda só o wa_account_id: a persona do payload não existe nesse caminho.
    const base = fronteiras.from.getMockImplementation()!;
    fronteiras.from.mockImplementation((tabela: string) => tabela === 'crm_whatsapp_accounts'
      ? { select: async () => ({ data: [
        { id: 'conta-3250', agente_ia_persona: 'aluno' },
        { id: 'conta-rh', agente_ia_persona: 'rh' },
        { id: 'conta-joao', agente_ia_persona: 'qualificador' },
      ], error: null }) }
      : base(tabela));
    for (const conta of ['conta-3250', 'conta-rh']) {
      const resposta = await chamar({ wa_account_id: conta, reconciliado: true });
      expect(await resposta.json()).toEqual({ ok: true, skip: 'persona_de_outro_agente' });
    }
    expect(fronteiras.rpc).not.toHaveBeenCalled();
    expect(fronteiras.buscarLead).not.toHaveBeenCalled();
    expect(fronteiras.bufferInserir).not.toHaveBeenCalled();
    semResposta();
    // A conta comercial segue o caminho normal (chega na memória de entrada).
    await chamar({ wa_account_id: 'conta-joao', reconciliado: true });
    expect(fronteiras.buscarLead).toHaveBeenCalled();
  });

  it('falha fechada antes da mídia se a memória não puder confirmar a origem', async () => {
    fronteiras.rpc.mockResolvedValue({ data: null, error: { message: 'RPC sintética indisponível' } });
    const resposta = await chamar();
    expect(resposta.status).toBe(503);
    expect(await resposta.json()).toEqual({ error: 'historico_entrada_indisponivel' });
    expect(fronteiras.prepararMensagem).not.toHaveBeenCalled();
    semResposta();
  });
});

describe('loop HTTP do SDR: recuperação de material', () => {
  it('pausa bloqueada mantém atendimento, suprime despedida falsa e passa histórico real ao executor', async () => {
    fronteiras.buscarLead.mockResolvedValue({ ...leadAtivo, modo_recontato: true, nome: 'Visitante' });
    const historico = [{ role: 'assistant', content: 'Em qual área você atua hoje?' }, { role: 'user', content: 'Nenhuma. Pretendo atuar em Qualidade.' }];
    fronteiras.historico.mockResolvedValue(historico);
    fronteiras.tools.mockResolvedValue([]);
    fronteiras.humanizar.mockImplementation((t: string) => t);
    fronteiras.horarios.mockReturnValue([]);
    fronteiras.conversa.mockReturnValue('');
    fronteiras.rpc.mockImplementation(async (nome: string) => {
      if (nome === 'crm_sdr_registrar_entrada') return { data: { estado: 'ativa', gravada: true }, error: null };
      if (nome === 'crm_agente_sdr_lock_claim') return { data: true, error: null };
      if (['crm_e_aluno_telefone', 'crm_esta_na_escola', 'crm_agente_sdr_lock_renovar'].includes(nome)) return { data: false, error: null };
      throw new Error(`RPC inesperada: ${nome}`);
    });
    const anterior = fronteiras.from.getMockImplementation()!;
    fronteiras.from.mockImplementation((tabela: string) => {
      if (tabela !== 'crm_whatsapp_messages') return anterior(tabela);
      const q = { select: () => q, eq: () => q, in: () => q, order: () => q, limit: async () => ({ data: [], error: null }) };
      return q;
    });
    fronteiras.executar.mockResolvedValue({ id: 'pausa-1', status: 'bloqueado', codigo: 'SEM_EVIDENCIA_SEM_GRADUACAO' });
    fronteiras.chamarPrincipal.mockResolvedValueOnce({ content: [
      { type: 'text', text: 'Sem graduação você não pode entrar na pós.' },
      { type: 'tool_use', id: 'pausa-1', name: 'pausa_ia', input: { tipo: 'sem_graduacao' } },
    ] }).mockResolvedValueOnce({ content: [{ type: 'text', text: 'O que te interessou na aula?' }] });
    expect((await chamar({ wa_account_id: 'conta-sintetica', agente_ia_persona: 'recontato' })).status).toBe(200);
    expect(fronteiras.executar.mock.calls[0][2].historicoConversa).toEqual(historico);
    expect(fronteiras.enviar).toHaveBeenCalledOnce();
    expect(fronteiras.enviar.mock.calls[0][1]).toBe('O que te interessou na aula?');
    expect(fronteiras.chamarPrincipal).toHaveBeenCalledTimes(2);
    expect(fronteiras.enviar.mock.calls[0][4]).toBeTypeOf('function');
  });

  it('relê a falha assíncrona e envia a pergunta para continuar, sem pausar', async () => {
    fronteiras.buscarLead.mockResolvedValue({ ...leadAtivo, modo_recontato: true, nome: 'Ana', curso_interesse_original: 'Curso de teste' });
    fronteiras.historico.mockResolvedValue([{ role: 'user', content: 'Não recebi o cronograma. Pode reenviar?' }]);
    fronteiras.tools.mockResolvedValue([]);
    fronteiras.humanizar.mockImplementation((t: string) => t);
    fronteiras.horarios.mockReturnValue([]);
    fronteiras.conversa.mockReturnValue('');
    fronteiras.rpc.mockImplementation(async (nome: string) => {
      if (nome === 'crm_sdr_registrar_entrada') return { data: { estado: 'ativa', gravada: true }, error: null };
      if (nome === 'crm_agente_sdr_lock_claim') return { data: true, error: null };
      if (['crm_e_aluno_telefone', 'crm_esta_na_escola', 'crm_agente_sdr_lock_renovar'].includes(nome)) return { data: false, error: null };
      throw new Error(`RPC inesperada: ${nome}`);
    });
    let status = 'sent';
    const anterior = fronteiras.from.getMockImplementation()!;
    fronteiras.from.mockImplementation((tabela: string) => {
      if (tabela !== 'crm_whatsapp_messages') return anterior(tabela);
      const query = {
        select: () => query, eq: () => query, in: () => query, order: () => query,
        limit: async () => ({ data: [{ wa_message_id: 'wamid.material', tipo: 'document', status_entrega: status,
          anexos: [{ filename: 'cronograma.pdf' }], erro: status === 'failed' ? { errors: [{ code: 131053 }] } : null }], error: null }),
      };
      return query;
    });
    fronteiras.chamarPrincipal
      .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 'envio-1', name: 'envia_informacoes', input: { curso_escolhido: 'Curso de teste', conteudo: 'cronograma' } }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'não estou conseguindo enviar o cronograma pelo WhatsApp agora. enquanto isso, podemos continuar com o agendamento?' }] });
    fronteiras.executar.mockImplementation(async (_banco, tool, ctx) => {
      if (tool.name === 'envia_informacoes') {
        status = 'failed';
        const retorno = { id: tool.id, cronograma_status: 'falhou', cronograma_enviado: false, resultado: 'Falha do arquivo' };
        ctx.enviosMateriais = new Map([['curso', retorno]]);
        return retorno;
      }
      return { id: tool.id, status: 'pausado' };
    });
    const resp = await chamar({ wa_account_id: 'conta-sintetica', agente_ia_persona: 'recontato' });
    expect(resp.status).toBe(200);
    expect(fronteiras.chamarPrincipal).toHaveBeenCalledTimes(2);
    expect(fronteiras.chamarPrincipal.mock.calls[0][0].contextoEntregaMateriais).toContain('"status":"aceito"');
    expect(fronteiras.chamarPrincipal.mock.calls[1][0].contextoEntregaMateriais).toContain('"status":"falhou"');
    expect(fronteiras.executar).toHaveBeenCalledTimes(1);
    expect(fronteiras.chamarPrincipal.mock.calls[1][0].promptAgente).toContain('FALHA NO MATERIAL NÃO ENCERRA O ATENDIMENTO');
    expect(fronteiras.enviar).toHaveBeenCalledOnce();
    expect(fronteiras.enviar.mock.calls[0][1]).toBe('não estou conseguindo enviar o cronograma pelo WhatsApp agora. enquanto isso, podemos continuar com o agendamento?');
  });
});

describe('SDR: texto de ferramenta nunca vira despedida', () => {
  beforeEach(() => {
    fronteiras.buscarLead.mockResolvedValue({ ...leadAtivo, modo_recontato: true, nome: 'Visitante' });
    fronteiras.historico.mockResolvedValue([{ role: 'user', content: 'Pode retirar' }]);
    fronteiras.tools.mockResolvedValue([{ name: 'pausa_ia' }]);
    fronteiras.humanizar.mockImplementation((t: string) => t);
    fronteiras.horarios.mockReturnValue([]);
    fronteiras.conversa.mockReturnValue('Pode retirar');
    fronteiras.rpc.mockImplementation(async (nome: string) => {
      if (nome === 'crm_sdr_registrar_entrada') return { data: { estado: 'ativa', gravada: true }, error: null };
      if (nome === 'crm_agente_sdr_lock_claim') return { data: true, error: null };
      if (['crm_e_aluno_telefone', 'crm_esta_na_escola', 'crm_agente_sdr_lock_renovar'].includes(nome)) return { data: false, error: null };
      throw new Error(`RPC inesperada: ${nome}`);
    });
    const anterior = fronteiras.from.getMockImplementation()!;
    fronteiras.from.mockImplementation((tabela: string) => {
      if (tabela !== 'crm_whatsapp_messages') return anterior(tabela);
      const q = { select: () => q, eq: () => q, in: () => q, order: () => q, limit: async () => ({ data: [], error: null }) };
      return q;
    });
  });

  it.each([
    'Já foi feita a pergunta de retenção antes ("tem interesse? posso retirar?"). Isso conta como retenção explícita.',
    'FORMULAÇÃO INTERNA INÉDITA SEM PALAVRAS DO DETECTOR',
    '',
  ])('despedida independe do texto junto de pausa_ia: %s', async (texto) => {
    fronteiras.executar.mockResolvedValue({ id: 'pausa', status: 'pausado' });
    fronteiras.chamarPrincipal.mockResolvedValueOnce({ stop_reason: 'tool_use', content: [
      ...(texto ? [{ type: 'text', text: texto }] : []),
      { type: 'tool_use', id: 'pausa', name: 'pausa_ia', input: { tipo: 'nao_perturbe' } },
    ] });
    await chamar({ agente_ia_persona: 'recontato', wa_account_id: 'conta-sintetica' });
    expect(fronteiras.chamarPrincipal).toHaveBeenCalledOnce();
    expect(fronteiras.enviar).toHaveBeenCalledOnce();
    const enviada = fronteiras.enviar.mock.calls[0][1];
    expect(enviada).toMatch(/^tranquilo, agradeço/);
    expect(enviada).toContain('https://escoladeespecializacao.ppgvet.com.br');
    expect(enviada).not.toMatch(/retenção|FORMULAÇÃO|Isso conta/);
    expect(fronteiras.enviar.mock.calls[0][4]).toBeUndefined();
    expect(fronteiras.gravar).toHaveBeenCalledWith(expect.anything(), payload.remotejid, { role: 'assistant', content: enviada });
  });

  it.each(['compatibilidadeIndisponivel', 'perguntaFormacaoPendente'] as const)(
    '%s faz o piloto redigir a resposta sem repetir ferramentas na rodada', async (campo) => {
      fronteiras.lunaTelefones = [payload.telefone];
      fronteiras.provedorOpenai.mockReturnValue({ nome: 'openai', formato: 'openai', modelo: 'modelo-sintetico' });
      fronteiras.tools.mockResolvedValue([{ name: 'verificar_compatibilidade_curso' }]);
      fronteiras.executar.mockImplementation(async (_banco, tool, ctx) => {
        ctx[campo] = campo === 'compatibilidadeIndisponivel' ? true : 'vc já é formado em Medicina Veterinária?';
        return { id: tool.id, output: campo === 'compatibilidadeIndisponivel' ? 'FALHA_TECNICA' : 'CONFIRMAR_CONCLUSAO' };
      });
      fronteiras.chamarPrincipal.mockResolvedValueOnce({ stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'matriz', name: 'verificar_compatibilidade_curso', input: {} },
      ] }).mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'vc já é formado em Medicina Veterinária?' }] });
      await chamar({ wa_account_id: 'conta-sintetica' });
      expect(fronteiras.executar).toHaveBeenCalledOnce();
      expect(fronteiras.chamarPrincipal).toHaveBeenCalledTimes(2);
      expect(fronteiras.chamarPrincipal.mock.calls[1][0].tools).toEqual([]);
      expect(fronteiras.enviar).toHaveBeenCalledOnce();
    });

  it('encerramento desconhecido exige nova resposta e desliga tools de negócio', async () => {
    fronteiras.executar.mockResolvedValue({ id: 'pausa', status: 'pausado' });
    fronteiras.chamarPrincipal.mockResolvedValueOnce({ stop_reason: 'tool_use', content: [
      { type: 'text', text: 'PREÂMBULO QUE NUNCA DEVE SAIR' },
      { type: 'tool_use', id: 'pausa', name: 'pausa_ia', input: { tipo: 'pausa', motivo: 'motivo não classificado' } },
    ] }).mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'certo, vou respeitar seu pedido.' }] });
    await chamar({ agente_ia_persona: 'recontato', wa_account_id: 'conta-sintetica' });
    expect(fronteiras.chamarPrincipal).toHaveBeenCalledTimes(2);
    expect(fronteiras.chamarPrincipal.mock.calls[1][0].tools).toEqual([]);
    expect(fronteiras.enviar.mock.calls[0][1]).not.toContain('PREÂMBULO');
  });

  it('erro legado da tool não autoriza afirmar que a pausa concluiu', async () => {
    fronteiras.executar.mockResolvedValue({ id: 'pausa', resultado: 'Erro ao executar pausa_ia: indisponível.' });
    fronteiras.chamarPrincipal.mockResolvedValueOnce({ content: [
      { type: 'text', text: 'ENCERRAMENTO NÃO CONFIRMADO' },
      { type: 'tool_use', id: 'pausa', name: 'pausa_ia', input: { tipo: 'nao_perturbe' } },
    ] }).mockResolvedValueOnce({ content: [] });
    await chamar({ agente_ia_persona: 'recontato', wa_account_id: 'conta-sintetica' });
    expect(fronteiras.enviar).not.toHaveBeenCalled();
    expect(fronteiras.registrar.mock.calls.some(([tipo]) => tipo === 'despedida_deterministica')).toBe(false);
  });

  // 18/09/2026: 54 rodadas em 7 dias morreram com "This model does not support assistant
  // message prefill" — o histórico chegava à API terminando num turno do assistant.
  it('vendedor respondeu dentro da espera do João: a IA se cala, sem chamar o modelo nem dar erro', async () => {
    fronteiras.historico.mockResolvedValue([
      { role: 'user', content: 'Está muito fora do meu orçamento!' },
      { role: 'assistant', content: '[ATENDIMENTO_HUMANO] Suéli · 2026-09-18 11:33:46 UTC Ah, beleza então.' },
    ]);
    await chamar({ agente_ia_persona: 'recontato', wa_account_id: 'conta-sintetica' });
    expect(fronteiras.chamarPrincipal).not.toHaveBeenCalled();
    expect(fronteiras.enviar).not.toHaveBeenCalled();
    expect(fronteiras.registrar).toHaveBeenCalledWith('humano_respondeu_antes', expect.anything());
    expect(fronteiras.registrar).toHaveBeenCalledWith('rodada_fim', expect.objectContaining({ respondeu: false, motivo: 'humano_respondeu_antes' }), expect.any(Number));
    expect(fronteiras.registrar.mock.calls.some(([tipo]) => tipo === 'erro')).toBe(false);
  });

  it('lead escreveu enquanto a fala anterior da IA era gravada: a mensagem é reapresentada como último turno', async () => {
    fronteiras.historico.mockResolvedValue([
      { role: 'user', content: 'Sou veterinária formada.' },
      { role: 'assistant', content: [{ type: 'text', text: 'show, qual pós te interessa?' }] },
    ]);
    fronteiras.chamarPrincipal.mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'perfeito, já vejo isso.' }] });
    await chamar({ agente_ia_persona: 'recontato', wa_account_id: 'conta-sintetica' });
    expect(fronteiras.chamarPrincipal).toHaveBeenCalledOnce();
    const enviadas = fronteiras.chamarPrincipal.mock.calls[0][0].messages;
    expect(enviadas.at(-1).role).toBe('user');
    expect(enviadas.at(-1).content).toContain('[MENSAGEM DO LEAD AINDA SEM RESPOSTA]');
    expect(enviadas.at(-1).content).toContain(payload.conteudo);
    expect(fronteiras.registrar).toHaveBeenCalledWith('entrada_reapresentada', expect.anything());
    // nada disso vai para o banco: o histórico não ganha a fala do lead em dobro
    expect(fronteiras.gravar.mock.calls.some(([, , m]) => String(m.content).includes('AINDA SEM RESPOSTA'))).toBe(false);
    expect(fronteiras.enviar).toHaveBeenCalledOnce();
  });

  it('histórico que termina na fala do lead segue igual: nenhum turno extra, nenhum evento novo', async () => {
    fronteiras.chamarPrincipal.mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'certo.' }] });
    await chamar({ agente_ia_persona: 'recontato', wa_account_id: 'conta-sintetica' });
    expect(fronteiras.chamarPrincipal.mock.calls[0][0].messages).toEqual([{ role: 'user', content: 'Pode retirar' }]);
    expect(fronteiras.registrar.mock.calls.some(([tipo]) => ['entrada_reapresentada', 'humano_respondeu_antes'].includes(tipo))).toBe(false);
  });

  // Canário da GPT-5.6 Luna: só o telefone listado em crm_agente_sdr_config.luna_telefones.
  const luna = { nome: 'openai', formato: 'openai', base: 'https://api.openai.com', chave: 'k', modelo: 'gpt-5.6-luna', esforco: 'high' };

  it('lead fora do canário segue no Claude: provedor nulo no principal e nas tools', async () => {
    fronteiras.lunaTelefones = ['5546000000000'];
    fronteiras.provedorOpenai.mockReturnValue(luna);
    fronteiras.chamarPrincipal.mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'certo.' }] });
    await chamar({ agente_ia_persona: 'recontato', wa_account_id: 'conta-sintetica' });
    expect(fronteiras.chamarPrincipal.mock.calls[0][0].provedor).toBeNull();
    expect(fronteiras.tools).toHaveBeenCalledWith(expect.anything(), 'agente_recontato', null);
    expect(fronteiras.registrar.mock.calls.some(([tipo]) => tipo === 'provedor_ia')).toBe(false);
  });

  it('lead do canário (casado pelos 8 últimos dígitos) sai pela Luna: tools da tabela da OpenAI e telemetria com o provedor', async () => {
    fronteiras.lunaTelefones = ['+55 (11) 9999-0001'];
    fronteiras.provedorOpenai.mockReturnValue(luna);
    fronteiras.chamarPrincipal.mockResolvedValueOnce({ stop_reason: 'end_turn', model: 'gpt-5.6-luna', content: [{ type: 'text', text: 'certo.' }] });
    await chamar({ agente_ia_persona: 'recontato', wa_account_id: 'conta-sintetica' });
    expect(fronteiras.chamarPrincipal.mock.calls[0][0].provedor).toEqual(luna);
    expect(fronteiras.tools).toHaveBeenCalledWith(expect.anything(), 'agente_recontato', luna);
    expect(fronteiras.registrar).toHaveBeenCalledWith('provedor_ia', expect.objectContaining({ provedor: 'openai', modelo: 'gpt-5.6-luna' }));
    expect(fronteiras.registrar).toHaveBeenCalledWith('llm_chamada', expect.objectContaining({ provedor: 'openai' }), expect.any(Number));
    expect(fronteiras.enviar).toHaveBeenCalledOnce();
  });

  it('com a chave ligada a rodada recebe memória privada e publica só contagens na telemetria', async () => {
    fronteiras.lunaTelefones = [payload.telefone];
    fronteiras.raciocinioEncadeado = true;
    fronteiras.provedorOpenai.mockReturnValue(luna);
    fronteiras.chamarPrincipal.mockImplementationOnce(async ({ provedor }) => {
      expect(provedor).toMatchObject({ modelo: 'gpt-5.6-luna', esforco: 'high', raciocinio: true });
      expect(provedor.memoriaRaciocinio).toBeInstanceOf(Map);
      provedor.memoriaRaciocinio.set('call_teste', { openaiId: 'fc_teste', item: { encrypted_content: 'CIFRADO_NAO_PERSISTIR' } });
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'certo.' }],
        raciocinio_encadeado: true, raciocinios_reenviados: 2 };
    });
    await chamar({ agente_ia_persona: 'recontato', wa_account_id: 'conta-sintetica' });
    expect(fronteiras.registrar).toHaveBeenCalledWith('llm_chamada', expect.objectContaining({ raciocinio_encadeado: true, raciocinios_reenviados: 2 }), expect.any(Number));
    expect(JSON.stringify(fronteiras.gravar.mock.calls)).not.toMatch(/CIFRADO_NAO_PERSISTIR|openai_id|raciocinio_openai/);
    expect(JSON.stringify(fronteiras.registrar.mock.calls)).not.toContain('CIFRADO_NAO_PERSISTIR');
  });

  it('Luna fora do ar não cala o João: a volta é refeita no Claude e o lead recebe a resposta', async () => {
    fronteiras.vozAtiva = true;
    fronteiras.lunaTelefones = ['5511999990001'];
    fronteiras.provedorOpenai.mockReturnValue(luna);
    fronteiras.chamarPrincipal
      .mockRejectedValueOnce(new Error('OpenAI: HTTP 503: upstream'))
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'certo.' }] });
    await chamar({ agente_ia_persona: 'recontato', wa_account_id: 'conta-sintetica' });
    expect(fronteiras.chamarPrincipal).toHaveBeenCalledTimes(2);
    expect(fronteiras.chamarPrincipal.mock.calls[0][0].provedor).toEqual(luna);
    expect(fronteiras.chamarPrincipal.mock.calls[1][0].provedor).toBeNull();
    expect(fronteiras.registrar).toHaveBeenCalledWith('provedor_ia_fallback', expect.objectContaining({ de: 'openai', para: 'anthropic' }));
    expect(fronteiras.registrar.mock.calls.some(([tipo]) => tipo === 'erro')).toBe(false);
    expect(fronteiras.enviar).toHaveBeenCalledOnce();
    expect(fronteiras.enviar.mock.calls[0][5]).toMatchObject({ provedorResposta: 'anthropic' });
  });

  it.each([false, true])('falha do principal e da reserva gera texto operacional respeitando pausa=%s', async (pausar) => {
    fronteiras.vozAtiva = true;
    fronteiras.lunaTelefones = [payload.telefone];
    fronteiras.provedorOpenai.mockReturnValue(luna);
    fronteiras.chamarPrincipal.mockRejectedValueOnce(new Error('MODELO_TEMPO_ESGOTADO'))
      .mockImplementationOnce(async () => { fronteiras.pausaNoDebounce = pausar; throw new Error('saldo indisponível'); });
    await chamar({ agente_ia_persona: 'recontato', wa_account_id: 'conta-sintetica' });
    expect(fronteiras.chamarPrincipal).toHaveBeenCalledTimes(2);
    expect(fronteiras.chamarPrincipal.mock.calls[1][0].prazoModeloMs).toBe(45000);
    expect(fronteiras.executar).not.toHaveBeenCalled();
    if (pausar) expect(fronteiras.enviar).not.toHaveBeenCalled();
    else {
      expect(fronteiras.enviar).toHaveBeenCalledOnce();
      const envio = fronteiras.enviar.mock.calls[0];
      expect(envio[1]).toBe('não consegui concluir sua resposta agora. pode tentar novamente em instantes?');
      expect(envio[5]).toMatchObject({ provedorResposta: 'anthropic' });
      expect(envio[6]).toBe('codigo');
    }
    expect(fronteiras.registrar).toHaveBeenCalledWith('modelo_indisponivel', expect.objectContaining({ resposta_operacional: true }));
  });

  it('canário da Luna usa o debounce DELE, não o zero do telefone de teste nem os 45 s da produção', async () => {
    fronteiras.lunaTelefones = ['5511999990001'];
    fronteiras.lunaDelay = 5;
    fronteiras.provedorOpenai.mockReturnValue(luna);
    fronteiras.chamarPrincipal.mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'certo.' }] });
    // Com debounce > 0 o agente mede o silêncio do buffer (consulta com .limit). A última
    // mensagem aqui "chegou" há 1 minuto: o silêncio já passou, então o teste não dorme.
    const base = fronteiras.from.getMockImplementation()!;
    fronteiras.from.mockImplementation((tabela: string) => {
      const t = base(tabela);
      if (tabela !== 'crm_agente_sdr_buffer') return t;
      return { ...t, select: (colunas: string) => colunas === 'criado_em'
        ? { eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: { criado_em: new Date(Date.now() - 60_000).toISOString() }, error: null }) }) }) }) }
        : t.select(colunas) };
    });
    await chamar({ agente_ia_persona: 'recontato', wa_account_id: 'conta-sintetica' });
    // O que o teste trava é QUAL debounce foi escolhido — é ele que vai para a telemetria.
    expect(fronteiras.registrar).toHaveBeenCalledWith('debounce', expect.objectContaining({ config_s: 5 }), expect.any(Number));
    expect(fronteiras.enviar).toHaveBeenCalledOnce();
  });

  it('quem NÃO está no canário segue a regra de sempre (aqui: config da produção = 0, sem evento de debounce)', async () => {
    fronteiras.lunaTelefones = ['5546000000000'];
    fronteiras.lunaDelay = 5;
    fronteiras.chamarPrincipal.mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'certo.' }] });
    await chamar({ agente_ia_persona: 'recontato', wa_account_id: 'conta-sintetica' });
    expect(fronteiras.registrar.mock.calls.some(([tipo]) => tipo === 'debounce')).toBe(false);
  });

  it('canário listado mas sem chave da OpenAI no ambiente: fica no Claude', async () => {
    fronteiras.lunaTelefones = ['5511999990001'];
    fronteiras.provedorOpenai.mockReturnValue(null);
    fronteiras.chamarPrincipal.mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'certo.' }] });
    await chamar({ agente_ia_persona: 'recontato', wa_account_id: 'conta-sintetica' });
    expect(fronteiras.chamarPrincipal.mock.calls[0][0].provedor).toBeNull();
  });

  it.each(['aceito', 'cancelado', 'desconhecido'] as const)('canário de voz só registra fala final após aceite: %s', async (estado) => {
    fronteiras.vozAtiva = true;
    fronteiras.lunaTelefones = [payload.telefone];
    fronteiras.provedorOpenai.mockReturnValue(luna);
    const texto = 'a conversa com o monitor é para tirar suas dúvidas sobre a pós.';
    fronteiras.chamarPrincipal.mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: texto }] });
    fronteiras.enviar.mockResolvedValueOnce({ estado, canal: 'audio', aceitos: estado === 'aceito' ? 1 : 0 });
    await chamar({ wa_account_id: 'conta-sintetica', agente_ia_persona: 'recontato' });
    expect(fronteiras.enviar).toHaveBeenCalledOnce();
    expect(fronteiras.enviar.mock.calls[0][5]).toMatchObject({ origem: 'conversa', provedorResposta: 'openai', referenciaMensagemId: payload.id });
    const falas = fronteiras.gravar.mock.calls.filter(([, , mensagem]) => mensagem.role === 'assistant');
    expect(falas).toHaveLength(estado === 'aceito' ? 1 : 0);
    if (estado === 'aceito') {
      expect(falas[0][2].content).toBe(texto);
      expect(fronteiras.gravar.mock.invocationCallOrder[0]).toBeGreaterThan(fronteiras.enviar.mock.invocationCallOrder[0]);
    }
  });

  it('canal bloqueado não envia nem persiste assistant vazio', async () => {
    fronteiras.chamarPrincipal.mockResolvedValueOnce({ content: [], stop_reason: 'end_turn', canal_resposta: { motivo: 'bastidor_no_canal' } });
    await chamar({ agente_ia_persona: 'recontato', wa_account_id: 'conta-sintetica' });
    expect(fronteiras.enviar).not.toHaveBeenCalled();
    expect(fronteiras.gravar.mock.calls.some(([, , mensagem]) => mensagem.role === 'assistant')).toBe(false);
    expect(fronteiras.registrar).toHaveBeenCalledWith('llm_chamada', expect.objectContaining({ canal_resposta: { motivo: 'bastidor_no_canal' } }), expect.any(Number));
  });
});

describe('sincronização de áudio na entrada HTTP', () => {
  function adquirirLock() {
    const anterior = fronteiras.rpc.getMockImplementation()!;
    fronteiras.rpc.mockImplementation(async (nome: string, ...args: unknown[]) =>
      nome === 'crm_agente_sdr_lock_claim' ? { data: true, error: null } : anterior(nome, ...args));
  }
  it('só lê a conversa para router e principal depois de a transcrição ficar pronta', async () => {
    let transcrito = false;
    fronteiras.buscarLead.mockResolvedValue({ ...leadAtivo, agente_atual: 'agente_validacao' });
    fronteiras.sincronizarAudio.mockImplementation(async () => {
      transcrito = true;
      return { estado: 'pronto', esperouMs: 6000, pendentes: 0 };
    });
    fronteiras.rpc.mockImplementation(async (nome: string) => {
      if (nome === 'crm_sdr_registrar_entrada') return { data: { estado: 'ativa', gravada: true }, error: null };
      if (nome === 'crm_agente_sdr_lock_claim') return { data: true, error: null };
      if (['crm_e_aluno_telefone', 'crm_esta_na_escola'].includes(nome)) return { data: false, error: null };
      throw new Error('RPC inesperada no caso de áudio: ' + nome);
    });
    const mensagemAudio = { role: 'assistant', content: '[ATENDIMENTO_HUMANO] Atendente\n[Transcrição do áudio enviado pelo atendente]\nSobre seu interesse em Sanidade Avícola, qual sua graduação?' };
    fronteiras.historico.mockImplementation(async () => {
      expect(transcrito).toBe(true);
      return [mensagemAudio, { role: 'user', content: 'A última vez que atuei na área técnica foi em 2016.' }];
    });
    fronteiras.chamarRouter.mockResolvedValue('agente_validacao');
    fronteiras.tools.mockResolvedValue([]);
    fronteiras.humanizar.mockImplementation((t: string) => t);
    fronteiras.horarios.mockReturnValue([]);
    fronteiras.conversa.mockReturnValue('');
    const anterior = fronteiras.from.getMockImplementation()!;
    fronteiras.from.mockImplementation((tabela: string) => {
      if (tabela !== 'crm_whatsapp_messages') return anterior(tabela);
      const q = { select: () => q, eq: () => q, in: () => q, order: () => q, limit: async () => ({ data: [], error: null }) };
      return q;
    });
    fronteiras.chamarPrincipal.mockResolvedValue({ content: [{ type: 'text', text: 'E qual é sua graduação?' }] });
    expect((await chamar({ wa_account_id: 'conta-sintetica' })).status).toBe(200);
    expect(fronteiras.chamarRouter).toHaveBeenCalledOnce();
    expect(JSON.stringify(fronteiras.chamarRouter.mock.calls[0][0])).toContain('Sanidade Avícola');
    expect(JSON.stringify(fronteiras.chamarPrincipal.mock.calls[0][0].messages)).toContain('Sanidade Avícola');
    expect(fronteiras.enviar).toHaveBeenCalledOnce();
  });
  it('prazo excedido preserva o buffer para o reconciliador e não chama o modelo', async () => {
    adquirirLock();
    fronteiras.sincronizarAudio.mockResolvedValue({ estado: 'aguardando', esperouMs: 30000, pendentes: 1 });
    expect((await chamar()).status).toBe(200);
    expect(fronteiras.buffer).toHaveLength(1);
    expect(fronteiras.buffer[0].payload.mensagem).toBe(payload.conteudo);
    expect(fronteiras.from).toHaveBeenCalledWith('crm_agente_sdr_lock');
    semResposta();
  });
  it('erro de leitura preserva a entrada sem gerar resposta', async () => {
    adquirirLock();
    fronteiras.sincronizarAudio.mockRejectedValue(new Error('fila indisponível'));
    expect((await chamar()).status).toBe(200);
    expect(fronteiras.buffer).toHaveLength(1);
    semResposta();
  });
  it('pausa durante a espera preserva a fala no histórico e esvazia o lote sem responder', async () => {
    adquirirLock();
    fronteiras.sincronizarAudio.mockResolvedValue({ estado: 'pausado', esperouMs: 2000, pendentes: 1 });
    expect((await chamar()).status).toBe(200);
    expect(fronteiras.buffer).toEqual([]);
    expect(fronteiras.rpc).toHaveBeenCalledWith('crm_sdr_registrar_entrada', expect.objectContaining({ p_pausa_observada: true }));
    semResposta();
  });
});

describe('troca de número: nota ao router e ao principal, ratchet e telemetria', () => {
  const A = 'conta-a-ia-sdr';
  const B = 'conta-b-amanda';
  const agora = Date.now();
  const iso = (minAtras: number) => new Date(agora - minAtras * 60_000).toISOString();
  // Conversa em A até o lead escolher horário; template de B; a resposta do lead em B é a do lote.
  const mensagensCrm = [
    { wa_account_id: A, direcao: 'outbound', tipo: 'text', conteudo: 'tenho 15h30, funciona?', created_at: iso(300), wa_message_id: 'wamid.a1', status_entrega: 'read' },
    { wa_account_id: A, direcao: 'inbound', tipo: 'text', conteudo: '15h30 pode ser', created_at: iso(290), wa_message_id: 'wamid.a2', status_entrega: 'delivered' },
    { wa_account_id: B, direcao: 'outbound', tipo: 'template', template_name: 'escola_prorrogacao', conteudo: 'Foi prorrogado o acesso da Escola', created_at: iso(120), wa_message_id: 'wamid.b1', status_entrega: 'read' },
    { wa_account_id: B, direcao: 'inbound', tipo: 'text', conteudo: 'Oi, quero saber mais', created_at: iso(1), wa_message_id: payload.id, status_entrega: 'delivered' },
  ];
  const historicoCompartilhado = [
    { role: 'assistant', content: 'tenho 15h30, funciona?' }, { role: 'user', content: '15h30 pode ser' },
    { role: 'assistant', content: 'Foi prorrogado o acesso da Escola' }, { role: 'user', content: 'Oi, quero saber mais' },
  ];
  let updatesDoLead: Record<string, unknown>[] = [];
  let consultasCrm: string[] = [];

  function prepararRodada(modo: string, lead: Record<string, unknown>) {
    limparCacheContas();
    updatesDoLead = [];
    consultasCrm = [];
    fronteiras.buscarLead.mockResolvedValue({ ...leadAtivo, nome: 'Marta', ...lead });
    fronteiras.historico.mockResolvedValue(historicoCompartilhado.map((m) => ({ ...m })));
    fronteiras.rpc.mockImplementation(async (nome: string) => {
      if (nome === 'crm_sdr_registrar_entrada') return { data: { estado: 'ativa', gravada: true }, error: null };
      if (nome === 'crm_agente_sdr_lock_claim') return { data: true, error: null };
      if (['crm_e_aluno_telefone', 'crm_esta_na_escola', 'crm_agente_sdr_lock_renovar'].includes(nome)) return { data: false, error: null };
      throw new Error(`RPC inesperada: ${nome}`);
    });
    fronteiras.tools.mockResolvedValue([]);
    fronteiras.humanizar.mockImplementation((t: string) => t);
    fronteiras.horarios.mockReturnValue([]);
    fronteiras.conversa.mockReturnValue('');
    fronteiras.chamarRouter.mockResolvedValue('agente_validacao');
    fronteiras.chamarPrincipal.mockResolvedValue({ content: [{ type: 'text', text: 'oi Marta! vi que a gente já se falou por outro número da PPG. sobre a Escola, me conta o que vc quer saber?' }] });
    const base = fronteiras.from.getMockImplementation()!;
    fronteiras.from.mockImplementation((tabela: string) => {
      if (tabela === 'crm_agente_sdr_config') return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { teste_telefones: [], troca_numero_modo: modo, luna_telefones: fronteiras.lunaTelefones, luna_delay_segundos: 0 }, error: null }) }) }),
      };
      if (tabela === 'crm_whatsapp_accounts') return { select: async () => ({ data: [
        { id: A, agente_ia_persona: 'qualificador', nome: 'IA SDR', numero_display: '+55 46 9970-8477' },
        { id: B, agente_ia_persona: 'qualificador', nome: 'Amanda PPGVET', numero_display: '46 9 9901-3539' },
      ], error: null }) };
      if (tabela === 'cliente_ppg_leads_sdr') return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { pausa_ia: false }, error: null }) }) }),
        // atualizarAgenteComRatchet grava pelo atualizarLead REAL do módulo (não pelo mock).
        update: (campos: Record<string, unknown>) => { updatesDoLead.push(campos); return { in: async () => ({ error: null }) }; },
      };
      if (tabela === 'crm_whatsapp_messages') {
        let selecao = '';
        const q: Record<string, unknown> = {};
        q.select = (campos: string) => { selecao = campos; consultasCrm.push(campos); return q; };
        for (const m of ['eq', 'in', 'not', 'order']) q[m] = () => q;
        // Só a consulta da troca (wa_account_id, direcao, …) enxerga as linhas; a do status de
        // materiais (envioMateriais.ts, também com template_name) recebe vazio.
        q.limit = async () => ({ data: selecao.includes('wa_account_id, direcao') ? mensagensCrm : [], error: null });
        return q;
      }
      return base(tabela);
    });
  }
  const ultimoTurnoDoRouter = () => {
    const historico = fronteiras.chamarRouter.mock.calls[0][0] as { role: string; content: string }[];
    return historico[historico.length - 1];
  };

  it("modo 'ativo': router recebe a nota fundida à fala do lead, o ratchet não segura o qualificador e o principal recebe a nota no contexto", async () => {
    prepararRodada('ativo', { agente_atual: 'agente_qualificador', agendado: false });
    expect((await chamar({ wa_account_id: B, agente_ia_persona: 'qualificador' })).status).toBe(200);
    expect(consultasCrm.some((c) => c.includes('wa_account_id, direcao'))).toBe(true);
    const ultimo = ultimoTurnoDoRouter();
    expect(ultimo.role).toBe('user');
    expect(ultimo.content).toContain('[NOTA INTERNA');
    expect(ultimo.content).toContain('TROCA DE NÚMERO');
    expect(ultimo.content).toContain('Oi, quero saber mais');
    // Nota nunca vai para o histórico persistido.
    for (const [, , msg] of fronteiras.gravar.mock.calls) expect(JSON.stringify(msg)).not.toContain('NOTA INTERNA');
    expect(updatesDoLead).toContainEqual({ agente_atual: 'agente_validacao' });
    const chamada = fronteiras.chamarPrincipal.mock.calls[0][0];
    expect(chamada.contextoTemporal).toContain('TROCA DE NÚMERO');
    expect(chamada.contextoTemporal).toContain('«Amanda PPGVET» (final 3539)');
    expect(chamada.contextoTemporal).toContain('«IA SDR» (final 8477)');
    expect(chamada.contextoTemporal).toContain('Foi prorrogado o acesso da Escola');
    expect(chamada.promptAgente).not.toContain('NOTA INTERNA');
    expect(fronteiras.registrar).toHaveBeenCalledWith('troca_de_numero', expect.objectContaining({
      trocou: true, modo: 'ativo', aplicado: true, ratchet_ignorado: true, conta_anterior: A, conta_atual: B,
      template_na_troca: 'escola_prorrogacao', agente_atual_antes: 'agente_qualificador', agendado: false,
    }));
    expect(fronteiras.registrar).toHaveBeenCalledWith('router_decisao', expect.objectContaining({
      decidiu: 'agente_validacao', efetivo: 'agente_validacao', anterior: 'agente_qualificador', troca_numero: true, ratchet_ignorado: true,
    }), expect.anything());
    expect(fronteiras.registrar).toHaveBeenCalledWith('rodada_inicio', expect.objectContaining({ wa_account_id: B }));
    expect(fronteiras.enviar).toHaveBeenCalledOnce();
  });

  it("modo 'sombra': só registra a troca; router sem nota, ratchet valendo, contexto sem nota", async () => {
    prepararRodada('sombra', { agente_atual: 'agente_qualificador', agendado: false });
    expect((await chamar({ wa_account_id: B, agente_ia_persona: 'qualificador' })).status).toBe(200);
    expect(ultimoTurnoDoRouter().content).not.toContain('NOTA INTERNA');
    expect(updatesDoLead).toContainEqual({ agente_atual: 'agente_qualificador' });
    expect(fronteiras.chamarPrincipal.mock.calls[0][0].contextoTemporal).not.toContain('TROCA DE NÚMERO');
    expect(fronteiras.registrar).toHaveBeenCalledWith('troca_de_numero', expect.objectContaining({ trocou: true, modo: 'sombra', aplicado: false, ratchet_ignorado: false }));
    expect(fronteiras.registrar).toHaveBeenCalledWith('router_decisao', expect.objectContaining({ efetivo: 'agente_qualificador', troca_numero: true, ratchet_ignorado: false }), expect.anything());
  });

  it('piloto sem voz guarda abertura aceita e não repete mesmo com o mesmo sinal reprocessado', async () => {
    prepararRodada('ativo', { agente_atual: 'agente_validacao', agendado: false });
    fronteiras.lunaTelefones = [payload.telefone];
    fronteiras.provedorOpenai.mockReturnValue({ nome: 'openai', formato: 'openai', modelo: 'gpt-5.6-luna' });
    fronteiras.chamarPrincipal.mockResolvedValue({ content: [{ type: 'text', text: 'sobre a Escola, o que você gostaria de saber?' }] });
    let jornada: Record<string, unknown> = {};
    const base = fronteiras.from.getMockImplementation()!;
    fronteiras.from.mockImplementation(tabela => {
      if (tabela !== 'cliente_ppg_leads_sdr') return base(tabela);
      const legado = base(tabela);
      return { ...legado,
        select: () => ({ ...legado.select(), in: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: { id: 1, jornada }, error: null }) }) }) }) }),
        update: (campos: Record<string, unknown>) => ({ ...legado.update(campos), eq: async () => { jornada = campos.jornada as Record<string, unknown>; return { error: null }; } }),
      };
    });
    fronteiras.enviar.mockImplementation(async (_ctx, _fala, _r, _tel, _p, _v, _f, controle) => {
      await controle?.primeiroAceite(); return { aceitos: 1, canal: 'texto', estado: 'aceito' };
    });
    await chamar({ wa_account_id: B, agente_ia_persona: 'qualificador' });
    expect(fronteiras.enviar.mock.calls[0][1]).toContain('vou continuar seu atendimento por aqui');
    expect(JSON.stringify(jornada)).toContain('enviada');
    expect(fronteiras.chamarPrincipal.mock.calls[0][0].contextoTemporal).toContain('Não escreva outro aviso');
    expect(fronteiras.gravar.mock.calls.some(([, , msg]) => String(msg.content).includes('vou continuar seu atendimento por aqui'))).toBe(true);
    await chamar({ wa_account_id: B, agente_ia_persona: 'qualificador' });
    expect(fronteiras.enviar.mock.calls[1][1]).toBe('sobre a Escola, o que você gostaria de saber?');
  });

  it("modo 'ativo' com reunião confirmada: a nota entra, mas o ratchet segura o qualificador", async () => {
    prepararRodada('ativo', { agente_atual: 'agente_qualificador', agendado: true });
    expect((await chamar({ wa_account_id: B, agente_ia_persona: 'qualificador' })).status).toBe(200);
    expect(ultimoTurnoDoRouter().content).toContain('reunião CONFIRMADA');
    expect(updatesDoLead).toContainEqual({ agente_atual: 'agente_qualificador' });
    expect(fronteiras.chamarPrincipal.mock.calls[0][0].contextoTemporal).toContain('reunião CONFIRMADA');
    expect(fronteiras.registrar).toHaveBeenCalledWith('troca_de_numero', expect.objectContaining({ aplicado: true, ratchet_ignorado: false, agendado: true }));
  });

  it("modo 'ativo' sem troca (conversa já vive neste número): comportamento antigo, sem nota e sem evento", async () => {
    prepararRodada('ativo', { agente_atual: 'agente_qualificador', agendado: false });
    // O João já respondeu em B depois da conversa em A → não é troca.
    mensagensCrm.splice(3, 0, { wa_account_id: B, direcao: 'outbound', tipo: 'text', conteudo: 'oi Marta!', created_at: iso(60), wa_message_id: 'wamid.b2', status_entrega: 'read' });
    try {
      expect((await chamar({ wa_account_id: B, agente_ia_persona: 'qualificador' })).status).toBe(200);
      expect(ultimoTurnoDoRouter().content).not.toContain('NOTA INTERNA');
      expect(updatesDoLead).toContainEqual({ agente_atual: 'agente_qualificador' });
      expect(fronteiras.registrar.mock.calls.some(([tipo]) => tipo === 'troca_de_numero')).toBe(false);
    } finally {
      mensagensCrm.splice(3, 1);
    }
  });

  it("modo 'off' (ou coluna ausente): não consulta o CRM pela troca nem registra evento", async () => {
    prepararRodada('off', { agente_atual: 'agente_qualificador', agendado: false });
    expect((await chamar({ wa_account_id: B, agente_ia_persona: 'qualificador' })).status).toBe(200);
    expect(consultasCrm.some((c) => c.includes('wa_account_id, direcao'))).toBe(false);
    expect(ultimoTurnoDoRouter().content).not.toContain('NOTA INTERNA');
    expect(updatesDoLead).toContainEqual({ agente_atual: 'agente_qualificador' });
    expect(fronteiras.registrar.mock.calls.some(([tipo]) => tipo === 'troca_de_numero')).toBe(false);
  });
});
