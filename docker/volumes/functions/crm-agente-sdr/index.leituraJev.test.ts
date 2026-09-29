import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AVISO_DOIS_ASSUNTOS, CABECALHO_LEITURA, type LeituraLead } from './leituraJev';

// Ligação da leitura do Jev na rodada (29/09/2026): banco, modelo, envio e o próprio Jev são
// fronteiras simuladas; o que se prova é o caminho leitura → jornada → ficha que a Luna recebe.
const f = vi.hoisted(() => ({
  from: vi.fn(), rpc: vi.fn(), buscarLead: vi.fn(), atualizarLead: vi.fn(), prepararMensagem: vi.fn(),
  chamarPrincipal: vi.fn(), enviar: vi.fn(), registrar: vi.fn(), historico: vi.fn(), tools: vi.fn(),
  provedorOpenai: vi.fn(), carregarFicha: vi.fn(), registrarNaJornada: vi.fn(), lerLead: vi.fn(), gravar: vi.fn(),
  buffer: [] as { id: number; payload: Record<string, unknown> }[], modoLeitura: 'ativo' as string,
}));
vi.mock('https://esm.sh/@supabase/supabase-js@2.50.3', () => ({ createClient: () => ({ from: f.from, rpc: f.rpc }) }));
vi.mock('./historico.ts', async (original) => ({
  ...await original<typeof import('./historico')>(),
  buscarLead: f.buscarLead, criarLead: vi.fn(), atualizarLead: f.atualizarLead, carregarHistorico: f.historico, gravarMensagem: f.gravar,
}));
vi.mock('./agente.ts', () => ({
  carregarTools: f.tools, chamarAgentePrincipal: f.chamarPrincipal, chamarRouter: vi.fn(), provedorOpenai: f.provedorOpenai,
}));
vi.mock('./tools.ts', () => ({ executarTool: vi.fn(), montarToolResults: () => [] }));
vi.mock('./midia.ts', () => ({ prepararMensagem: f.prepararMensagem }));
vi.mock('./sincronizacaoAudio.ts', () => ({
  aguardarAudiosDoHistorico: async () => ({ estado: 'pronto', esperouMs: 0, pendentes: 0 }), contarAudiosPendentes: vi.fn(),
}));
vi.mock('./saida.ts', () => ({
  enviarResposta: f.enviar, conversaTexto: () => '', horariosInventados: () => [], humanizarTexto: (t: string) => t,
  removerRaciocinioVazado: (t: string) => t,
}));
vi.mock('./followup.ts', () => ({ rodarEsteiraFollowup: vi.fn() }));
vi.mock('./followup-template.ts', () => ({ rodarEsteiraFollowupTemplate: vi.fn() }));
vi.mock('./eventos.ts', () => ({ criarTelemetria: () => ({ rodadaId: 'r', registrar: f.registrar }), resumir: (v: unknown) => v }));
vi.mock('./fichaAtendimento.ts', async (original) => ({
  ...await original<typeof import('./fichaAtendimento')>(),
  carregarFicha: f.carregarFicha, registrarNaJornada: f.registrarNaJornada, marcarPerguntasDaFicha: async () => [],
}));
vi.mock('./leituraJev.ts', async (original) => ({ ...await original<typeof import('./leituraJev')>(), lerLeadComJev: f.lerLead }));

let handler: (req: Request) => Promise<Response>;
const remotejid = '5511999990001@s.whatsapp.net';
const luna = { nome: 'openai', formato: 'openai', base: 'https://api.openai.com', chave: 'k', modelo: 'gpt-5.6-luna', esforco: 'high' };
const FICHA = {
  texto: '[FICHA DO ATENDIMENTO — sintética]',
  avaliacao: { grupo: 'desconhecido', faltaParaCronograma: [], liberaCronograma: true, jaPerguntou: false, proximoPasso: 'siga' },
  entrada: { cadastro: null, jornada: { coleta: {} } },
};
const LEITURA: LeituraLead = {
  conclusao: { valor: 'concluiu', confianca: 0.99 }, graduacao: { valor: 'medicina_veterinaria', confianca: 0.98 },
  informou_data: 0.02, pediu_material: 0.01, dois_assuntos: 0.95, dor_financeira: 0.02,
  modelo: 'jev-1.13.0', tokens_entrada: 900, ms: 280,
};

async function chamar() {
  return await handler(new Request('https://edge.invalid/crm-agente-sdr', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      direcao: 'inbound', from_me: false, telefone: '5511999990001', remotejid, id: 'wamid.SINTETICO', tipo: 'text',
      conteudo: 'Sou veterinária formada. E o link não abre', agente_ia_persona: 'recontato', wa_account_id: 'conta-sintetica',
    }),
  }));
}

beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: (k: string) => (k === 'SUPABASE_URL' ? 'https://supabase.invalid' : '') }, serve: (fn: typeof handler) => { handler = fn; } });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Rede não autorizada neste teste'); }));
  await import('./index');
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.resetAllMocks();
  f.buffer = [];
  f.modoLeitura = 'ativo';
  f.provedorOpenai.mockReturnValue(luna);
  f.buscarLead.mockResolvedValue({ remotejid, iniciar_atendimento: true, pausa_ia: false, modo_recontato: true, nome: 'Visitante' });
  f.prepararMensagem.mockResolvedValue({ mensagem: 'Sou veterinária formada. E o link não abre' });
  f.historico.mockResolvedValue([{ role: 'user', content: 'Sou veterinária formada. E o link não abre' }]);
  f.tools.mockResolvedValue([]);
  f.carregarFicha.mockResolvedValue(FICHA);
  f.registrarNaJornada.mockResolvedValue({});
  f.lerLead.mockResolvedValue(LEITURA);
  f.chamarPrincipal.mockResolvedValue({ stop_reason: 'end_turn', model: 'gpt-5.6-luna', content: [{ type: 'text', text: 'certo.' }] });
  f.rpc.mockImplementation(async (nome: string) => {
    if (nome === 'crm_sdr_registrar_entrada') return { data: { estado: 'ativa', gravada: true }, error: null };
    if (nome === 'crm_agente_sdr_lock_claim') return { data: true, error: null };
    if (['crm_e_aluno_telefone', 'crm_esta_na_escola', 'crm_agente_sdr_lock_renovar'].includes(nome)) return { data: false, error: null };
    throw new Error(`RPC inesperada: ${nome}`);
  });
  f.from.mockImplementation((tabela: string) => {
    const unico = (data: unknown) => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error: null }) }) }) });
    if (tabela === 'crm_agente_sdr_config') return unico({
      teste_telefones: [], luna_telefones: ['5511999990001'], luna_delay_segundos: 0,
      ficha_jev_modo: f.modoLeitura, ficha_jev_limiar: 0.9,
    });
    if (tabela === 'crm_pipeline_settings') return unico({ agente_sdr_delay_segundos: 0 });
    if (tabela === 'cliente_ppg_leads_sdr') return { ...unico({ pausa_ia: false }), update: () => ({ in: async () => ({ error: null }) }) };
    if (tabela === 'crm_agente_sdr_buffer') return {
      insert: async (linha: { payload: Record<string, unknown> }) => { f.buffer.push({ id: 1, payload: linha.payload }); return { error: null }; },
      select: () => ({ eq: () => ({ order: async () => ({ data: [...f.buffer], error: null }) }) }),
      delete: () => ({ in: async () => { f.buffer = []; return { error: null }; } }),
    };
    if (tabela === 'crm_agente_sdr_lock') return { delete: () => ({ eq: async () => ({ error: null }) }) };
    const q: any = { select: () => q, eq: () => q, in: () => q, order: () => q, limit: async () => ({ data: [], error: null }), maybeSingle: async () => ({ data: null, error: null }) };
    return q;
  });
});

describe('leitura do Jev na rodada do canário', () => {
  it('ativo: lê as mensagens novas, preenche o que a ficha não sabia e avisa a Luna', async () => {
    await chamar();
    expect(f.lerLead).toHaveBeenCalledOnce();
    expect(f.lerLead.mock.calls[0][1]).toEqual(['Sou veterinária formada. E o link não abre']);
    // A escrita relê a jornada e só entra o campo que continua vazio.
    const mutar = f.registrarNaJornada.mock.calls.find(([, , fn]) => typeof fn === 'function')?.[2];
    const depois = mutar({ coleta: { graduacao: 'Zootecnia' } });
    expect(depois.coleta).toMatchObject({ graduacao: 'Zootecnia', graduacao_concluida: 'sim' });
    const contexto = f.chamarPrincipal.mock.calls[0][0].contextoFicha as string;
    expect(contexto).toContain(CABECALHO_LEITURA);
    expect(contexto).toContain(AVISO_DOIS_ASSUNTOS);
    expect(f.registrar).toHaveBeenCalledWith('leitura_jev', expect.objectContaining({
      modo: 'ativo', aplicado: ['conclusao:sim', 'graduacao:medicina_veterinaria', 'aviso:dois_assuntos'],
    }), 280);
    expect(f.enviar).toHaveBeenCalledOnce();
  });

  it('sombra: registra o que faria, sem tocar na jornada nem na ficha da Luna', async () => {
    f.modoLeitura = 'sombra';
    await chamar();
    expect(f.lerLead).toHaveBeenCalledOnce();
    expect(f.registrarNaJornada.mock.calls.some(([, , fn]) => typeof fn === 'function')).toBe(false);
    expect(f.chamarPrincipal.mock.calls[0][0].contextoFicha).not.toContain(CABECALHO_LEITURA);
    expect(f.registrar).toHaveBeenCalledWith('leitura_jev', expect.objectContaining({ modo: 'sombra', faria: expect.any(Array) }), 280);
  });

  it('off: o Jev nem é chamado', async () => {
    f.modoLeitura = 'off';
    await chamar();
    expect(f.lerLead).not.toHaveBeenCalled();
    expect(f.registrar.mock.calls.some(([tipo]) => tipo === 'leitura_jev')).toBe(false);
    expect(f.enviar).toHaveBeenCalledOnce();
  });

  it('Jev fora do ar: a rodada segue com a ficha de sempre', async () => {
    f.lerLead.mockResolvedValue({ ...LEITURA, conclusao: null, graduacao: null, dois_assuntos: null, erro: 'Jev: HTTP 529' });
    await chamar();
    expect(f.chamarPrincipal.mock.calls[0][0].contextoFicha).not.toContain(CABECALHO_LEITURA);
    expect(f.registrar).toHaveBeenCalledWith('leitura_jev', expect.objectContaining({ erro: 'Jev: HTTP 529', aplicado: [] }), 280);
    expect(f.enviar).toHaveBeenCalledOnce();
  });
});

// Travas da fala no canário (29/09/2026, travasDeterministicas.ts): a regra de ouro de valor saiu do
// prompt; o código confere. 1ª vez a fala volta para a IA corrigir; a corrigida é a que sai.
describe('travas da fala na rodada do canário', () => {
  it('preço que não veio de ferramenta: não sai, volta para correção, e sai a fala corrigida', async () => {
    f.modoLeitura = 'off';
    f.chamarPrincipal
      .mockResolvedValueOnce({ stop_reason: 'end_turn', model: 'gpt-5.6-luna', content: [{ type: 'text', text: 'fica em torno de R$ 300 por mês' }] })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', model: 'gpt-5.6-luna', content: [{ type: 'text', text: 'o valor o monitor te mostra na conversa' }] });
    await chamar();
    const correcao = f.gravar.mock.calls.map((c) => c[2]).find((m) => String(m?.content ?? '').startsWith('[CORRECAO_INTERNA_AUTO_IGNORE]'));
    expect(correcao?.role).toBe('user');
    expect(String(correcao?.content)).toContain('R$ 300');
    expect(f.registrar).toHaveBeenCalledWith('trava_fala', expect.objectContaining({ motivo: 'valor', acao: 'reinstruido' }));
    expect(f.enviar).toHaveBeenCalledOnce();
    expect(f.enviar.mock.calls[0][1]).toContain('o valor o monitor te mostra');
  });
});
