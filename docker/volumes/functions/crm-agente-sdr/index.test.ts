import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fronteiras = vi.hoisted(() => ({
  from: vi.fn(), rpc: vi.fn(), buscarLead: vi.fn(), criarLead: vi.fn(), atualizarLead: vi.fn(),
  prepararMensagem: vi.fn(), chamarPrincipal: vi.fn(), chamarRouter: vi.fn(), enviar: vi.fn(),
  registrar: vi.fn(), bufferInserir: vi.fn(), buffer: [] as { id: number; payload: Record<string, unknown> }[],
  pausaNoDebounce: false,
  executar: vi.fn(), tools: vi.fn(), gravar: vi.fn(), historico: vi.fn(),
  humanizar: vi.fn(), horarios: vi.fn(), conversa: vi.fn(),
  sincronizarAudio: vi.fn(),
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
    env: { get: (chave: string) => chave === 'SUPABASE_URL' ? 'https://supabase.invalid' : '' },
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
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { teste_telefones: [] }, error: null }) }) }),
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
