import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configurarVoz, conferirEstadoVoz, tentarEnviarVoz } from './envioVoz';
import { prepararVozElevenlabs, ErroVozElevenlabs } from './vozElevenlabs';

vi.mock('./vozElevenlabs', async (original) => ({
  ...await original<typeof import('./vozElevenlabs')>(), prepararVozElevenlabs: vi.fn(),
}));

const ctx = { telefone: '5511999990001', remotejid: '5511999990001@s.whatsapp.net', waAccountId: 'conta-meta', leadId: null, oportunidadeId: null };
const texto = 'a conversa com o monitor é para tirar suas dúvidas sobre a pós. qual período fica melhor para você?';
const configuracao: Record<string, string> = {
  AGENTE_SDR_VOZ_ATIVA: 'true', AGENTE_SDR_VOZ_TELEFONES: ctx.telefone, ELEVENLABS_API_KEY: 'segredo-simulado',
};
const entrada = (id = 'entrada-1', em = Date.now()) => ({ data: [{ id, created_at: new Date(em).toISOString() }] });

type RespostaConsulta = { data: Record<string, unknown>[]; error?: { message: string } | null };
const metodosConsulta = ['select', 'eq', 'in', 'order', 'limit', 'gte', 'neq'] as const;
type Consulta = PromiseLike<RespostaConsulta> & {
  [K in typeof metodosConsulta[number]]: (...args: unknown[]) => Consulta;
};

function banco(entradas: RespostaConsulta[] = [entrada(), { data: [] }, entrada()]) {
  const filas: Record<string, RespostaConsulta[]> = {
    cliente_ppg_leads_sdr: [0, 1].map(() => ({ data: [{ remotejid: ctx.remotejid, iniciar_atendimento: true, followup_ativado: true }] })),
    crm_agente_sdr_buffer: [{ data: [] }, { data: [] }],
    crm_whatsapp_messages: entradas,
  };
  const consultas: unknown[][] = [];
  const supabase = {
    storage: {}, rpc: vi.fn().mockResolvedValue({ data: null as string | null, error: null as { message: string } | null }),
    from(tabela: string) {
      const q = {} as Consulta;
      for (const metodo of metodosConsulta) {
        q[metodo] = (...args: unknown[]) => { consultas.push([tabela, metodo, ...args]); return q; };
      }
      q.then = (resolve, reject) => Promise.resolve(filas[tabela]?.shift() ?? { data: [] }).then(resolve, reject);
      return q;
    },
  };
  return { supabase, filas, consultas };
}

function preparar(entradas?: RespostaConsulta[]) {
  const db = banco(entradas);
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ success: true, wa_message_id: 'wamid-1' })));
  const tel = { registrar: vi.fn() };
  return { ...db, opts: {
    ctx, texto, opcoes: { supabase: db.supabase, origem: 'followup' as const, provedorResposta: 'openai' as const, historico: [], etapaFollowup: 2 },
    cadenciaAtingida: true,
    renovarLock: vi.fn().mockResolvedValue(undefined), tel, sendUrl: 'https://local.test/send', serviceRole: 'service-simulado',
    env: (nome: string) => configuracao[nome], fetchImpl,
  } };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prepararVozElevenlabs).mockResolvedValue({
    url: 'https://storage.test/sdr-voz/hash.ogg', mimeType: 'audio/ogg', filename: 'audio.ogg', cacheHit: false, caracteres: texto.length,
  });
});

describe('piloto de voz exige configuração explícita', () => {
  it('usa a voz escolhida, com chave apenas no servidor', () => {
    expect(configurarVoz(ctx.telefone, (nome) => configuracao[nome], 'openai')).toMatchObject({ voiceId: 'lvkgCBi6spByiTZMPJEK', modelo: 'eleven_v3' });
  });
  it('reproduz o perfil do painel somente para o clone pessoal com Multilingual v2', () => {
    const perfil = { ...configuracao, AGENTE_SDR_ELEVENLABS_VOICE_ID: 'kg0vrevk3kmdbBvFCQr0', AGENTE_SDR_ELEVENLABS_MODEL: 'eleven_multilingual_v2' };
    const ler = (nome: string) => perfil[nome as keyof typeof perfil];
    expect(configurarVoz(ctx.telefone, ler, 'openai')).toMatchObject({
      voiceId: 'kg0vrevk3kmdbBvFCQr0', modelo: 'eleven_multilingual_v2',
      voiceSettings: { stability: 0.69, similarity_boost: 1, style: 0.63, use_speaker_boost: true, speed: 0.97 },
    });
    expect(configurarVoz(ctx.telefone, (nome) => nome === 'AGENTE_SDR_ELEVENLABS_MODEL' ? 'eleven_v3' : ler(nome), 'openai')?.voiceSettings).toBeUndefined();
    expect(configurarVoz(ctx.telefone, (nome) => nome === 'AGENTE_SDR_ELEVENLABS_VOICE_ID' ? 'outra-voz' : ler(nome), 'openai')?.voiceSettings).toBeUndefined();
    expect(configurarVoz(ctx.telefone, ler, 'anthropic')).toBeNull();
    expect(configurarVoz('5511999990002', ler, 'openai')).toBeNull();
  });
  it.each(['AGENTE_SDR_VOZ_ATIVA', 'AGENTE_SDR_VOZ_TELEFONES', 'ELEVENLABS_API_KEY'])('não ativa sem %s', (chave) => {
    expect(configurarVoz(ctx.telefone, (nome) => nome === chave ? undefined : configuracao[nome], 'openai')).toBeNull();
  });
  it('não confunde o mesmo final de telefone em outro DDD com o canário', () => {
    expect(configurarVoz('5521999990001', (nome) => configuracao[nome], 'openai')).toBeNull();
  });
  it.each(['anthropic', 'deepseek', undefined])('nega voz para provedor %s mesmo com chave e telefone liberados', (provedor) => {
    expect(configurarVoz(ctx.telefone, (nome) => configuracao[nome], provedor)).toBeNull();
  });
  it('nega outro lead da mesma região, mesmo com provedor OpenAI', () => {
    expect(configurarVoz('5511999990002', (nome) => configuracao[nome], 'openai')).toBeNull();
  });
});

describe('envio de áudio preserva o contrato do SDR', () => {
  it('sintetiza e registra a versão falada, preservando o original para fallback', async () => {
    const { opts } = preparar();
    const original = 'imagino kkk, vc trabalha bastante. qdo fica melhor conversar sobre a pós?';
    const falado = 'imagino, você trabalha bastante. quando fica melhor conversar sobre a pós?';
    opts.texto = original;
    expect(await tentarEnviarVoz(opts)).toBe('aceito');
    expect(prepararVozElevenlabs).toHaveBeenCalledWith(expect.objectContaining({ texto: falado }));
    expect(JSON.parse(String(opts.fetchImpl.mock.calls[0][1]?.body)).conteudo).toBe(falado);
    expect(opts.tel.registrar).toHaveBeenCalledWith('voz_preparada', expect.objectContaining({ texto_normalizado: true }));
    expect(opts.texto).toBe(original);
  });
  it('texto que ultrapassa o limite ao expandir abreviações volta para texto sem TTS', async () => {
    const { opts } = preparar();
    const real = await vi.importActual<typeof import('./vozElevenlabs')>('./vozElevenlabs');
    vi.mocked(prepararVozElevenlabs).mockImplementation(real.prepararVozElevenlabs);
    opts.texto = 'vc '.repeat(150).trim();
    expect(await tentarEnviarVoz(opts)).toBe('texto_revalidar');
    expect(opts.fetchImpl).not.toHaveBeenCalled();
    expect(opts.tel.registrar).toHaveBeenCalledWith('voz_fallback_texto', { motivo: 'preparo_falhou', codigo: 'TEXTO_LONGO' });
    expect(opts.texto).toBe('vc '.repeat(150).trim());
  });
  it('só marcas de risada não geram áudio vazio', async () => {
    const { opts } = preparar();
    opts.texto = 'kkk '.repeat(15).trim();
    expect(await tentarEnviarVoz(opts)).toBe('texto_revalidar');
    expect(prepararVozElevenlabs).not.toHaveBeenCalled();
    expect(opts.fetchImpl).not.toHaveBeenCalled();
  });
  it('encaminha o modelo e os ajustes do painel à síntese do piloto', async () => {
    const { opts } = preparar();
    const perfil: Record<string, string> = { ...configuracao,
      AGENTE_SDR_ELEVENLABS_VOICE_ID: 'kg0vrevk3kmdbBvFCQr0', AGENTE_SDR_ELEVENLABS_MODEL: 'eleven_multilingual_v2' };
    expect(await tentarEnviarVoz({ ...opts, env: (nome) => perfil[nome] })).toBe('aceito');
    expect(prepararVozElevenlabs).toHaveBeenCalledWith(expect.objectContaining({
      texto, voiceId: 'kg0vrevk3kmdbBvFCQr0', modelo: 'eleven_multilingual_v2',
      voiceSettings: { stability: 0.69, similarity_boost: 1, style: 0.63, use_speaker_boost: true, speed: 0.97 },
    }));
  });
  it('follow-up Claude não consulta banco, sintetiza ou despacha áudio', async () => {
    const { opts, supabase } = preparar();
    expect(await tentarEnviarVoz({ ...opts, opcoes: { ...opts.opcoes, provedorResposta: 'anthropic' } })).toBe('texto');
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(prepararVozElevenlabs).not.toHaveBeenCalled();
    expect(opts.fetchImpl).not.toHaveBeenCalled();
  });
  it('só envia na conta da conversa, conta uma parte aceita e associa a fala ao wamid', async () => {
    const { opts, consultas } = preparar();
    expect(await tentarEnviarVoz(opts)).toBe('aceito');
    const corpo = JSON.parse(String(opts.fetchImpl.mock.calls[0][1]?.body));
    expect(corpo).toMatchObject({ tipo: 'audio', origem: 'ia', wa_account_id: ctx.waAccountId, mime_type: 'audio/ogg' });
    expect(opts.tel.registrar).toHaveBeenCalledWith('chunk_enviado', expect.objectContaining({ ok: true, canal: 'audio', texto, wa_message_id: 'wamid-1' }));
    expect(consultas).toContainEqual(['crm_whatsapp_messages', 'eq', 'wa_account_id', ctx.waAccountId]);
  });
  it('erro da síntese libera somente o texto aprovado, sem despachar áudio ou vazar erro', async () => {
    const { opts } = preparar();
    vi.mocked(prepararVozElevenlabs).mockRejectedValue(new Error('credencial-secreta'));
    expect(await tentarEnviarVoz(opts)).toBe('texto_revalidar');
    expect(opts.fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(opts.tel.registrar.mock.calls)).not.toContain('credencial-secreta');
    expect(opts.tel.registrar).toHaveBeenCalledWith('voz_fallback_texto', { motivo: 'preparo_falhou', codigo: 'ERRO_NAO_CLASSIFICADO' });
  });
  it('registra o código local do preparo, sem detalhes do provedor ou chave', async () => {
    const { opts } = preparar();
    vi.mocked(prepararVozElevenlabs).mockRejectedValue(new ErroVozElevenlabs('CACHE_LEITURA_FALHOU'));
    expect(await tentarEnviarVoz(opts)).toBe('texto_revalidar');
    expect(opts.tel.registrar).toHaveBeenCalledWith('voz_fallback_texto', { motivo: 'preparo_falhou', codigo: 'CACHE_LEITURA_FALHOU' });
  });
  it('pausa durante a síntese impede áudio e fallback texto', async () => {
    const { opts } = preparar();
    const interrompido = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await tentarEnviarVoz({ ...opts, opcoes: { ...opts.opcoes, interrompido } })).toBe('cancelado');
    expect(opts.fetchImpl).not.toHaveBeenCalled();
  });
  it('entrada nova durante TTS cancela a fala antiga mesmo sem buffer pendente', async () => {
    const { opts } = preparar([entrada(), { data: [] }, entrada('entrada-2')]);
    expect(await tentarEnviarVoz(opts)).toBe('cancelado');
    expect(opts.fetchImpl).not.toHaveBeenCalled();
  });
  it('janela fechada na mesma conta impede a geração de áudio', async () => {
    const { opts } = preparar([entrada('antiga', Date.now() - 24 * 3600_000 - 1)]);
    expect(await tentarEnviarVoz(opts)).toBe('cancelado');
    expect(prepararVozElevenlabs).not.toHaveBeenCalled();
  });
  it('bloqueio/erro de consulta nunca autorizam envio', async () => {
    const { opts, supabase } = preparar();
    supabase.rpc.mockResolvedValue({ data: 'recontato_timer', error: null });
    expect(await tentarEnviarVoz(opts)).toBe('cancelado');
    expect(prepararVozElevenlabs).not.toHaveBeenCalled();
    supabase.rpc.mockResolvedValue({ data: null, error: { message: 'erro' } } as never);
    await expect(conferirEstadoVoz(ctx, opts.opcoes)).rejects.toThrow('voz_estado_indisponivel');
  });
  it('antes de atingir a cadência não gasta síntese nem consulta guardas de envio de áudio', async () => {
    const { opts, supabase } = preparar();
    expect(await tentarEnviarVoz({ ...opts, cadenciaAtingida: false })).toBe('texto');
    expect(prepararVozElevenlabs).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
  it('entrada diferente da que gerou o LLM não é adotada como nova referência', async () => {
    const { opts } = preparar();
    expect(await tentarEnviarVoz({ ...opts, opcoes: { ...opts.opcoes, referenciaMensagemId: 'wamid-original' } })).toBe('cancelado');
    expect(prepararVozElevenlabs).not.toHaveBeenCalled();
  });
  it('última saída em áudio impede dois áudios consecutivos mesmo com cadência vencida', async () => {
    const { opts } = preparar([entrada(), { data: [{ tipo: 'audio' }] }]);
    expect(await tentarEnviarVoz(opts)).toBe('texto');
    expect(prepararVozElevenlabs).not.toHaveBeenCalled();
  });
  it('teste solicitado libera uma resposta após o wamid exato, na mesma conta e voz', async () => {
    const { opts, filas, consultas } = preparar([entrada(), { data: [{ tipo: 'audio', wa_message_id: 'audio-anterior' }] }, entrada()]);
    filas.crm_agente_sdr_eventos = [{ data: [{ id: 123 }] }];
    expect(await tentarEnviarVoz({ ...opts, opcoes: { ...opts.opcoes, origem: 'conversa' } })).toBe('aceito');
    expect(consultas).toContainEqual(['crm_agente_sdr_eventos', 'eq', 'remotejid', ctx.remotejid]);
    expect(consultas).toContainEqual(['crm_agente_sdr_eventos', 'eq', 'tipo', 'voz_teste_proxima_resposta']);
    expect(consultas).toContainEqual(['crm_agente_sdr_eventos', 'eq', 'dados->>wa_account_id', ctx.waAccountId]);
    expect(consultas).toContainEqual(['crm_agente_sdr_eventos', 'eq', 'dados->>apos_wa_message_id', 'audio-anterior']);
    expect(consultas).toContainEqual(['crm_agente_sdr_eventos', 'eq', 'dados->>voz', 'lvkgCBi6spByiTZMPJEK']);
    const prazo = consultas.find(([tabela, metodo]) => tabela === 'crm_agente_sdr_eventos' && metodo === 'gte');
    expect(Date.now() - Date.parse(String(prazo?.[3]))).toBeGreaterThanOrEqual(2 * 3600_000);
    expect(Date.now() - Date.parse(String(prazo?.[3]))).toBeLessThan(2 * 3600_000 + 5000);
    expect(opts.tel.registrar).toHaveBeenCalledWith('voz_teste_autorizado', { solicitacao_id: 123 });
  });
  it.each(['sem_pedido', 'erro', 'novo_wamid'])('teste não libera áudio com %s', async (cenario) => {
    const anterior = cenario === 'novo_wamid' ? 'outro-audio' : 'audio-anterior';
    const { opts, filas, consultas } = preparar([entrada(), { data: [{ tipo: 'audio', wa_message_id: anterior }] }]);
    filas.crm_agente_sdr_eventos = [{ data: [], error: cenario === 'erro' ? { message: 'indisponível' } : null }];
    expect(await tentarEnviarVoz({ ...opts, opcoes: { ...opts.opcoes, origem: 'conversa' } })).toBe('texto');
    expect(consultas).toContainEqual(['crm_agente_sdr_eventos', 'eq', 'dados->>apos_wa_message_id', anterior]);
    expect(prepararVozElevenlabs).not.toHaveBeenCalled();
  });
  it('exceção solicitada não libera áudio consecutivo em follow-up', async () => {
    const { opts, filas, consultas } = preparar([entrada(), { data: [{ tipo: 'audio', wa_message_id: 'audio-anterior' }] }]);
    filas.crm_agente_sdr_eventos = [{ data: [{ id: 123 }] }];
    expect(await tentarEnviarVoz(opts)).toBe('texto');
    expect(consultas.some(([tabela]) => tabela === 'crm_agente_sdr_eventos')).toBe(false);
    expect(prepararVozElevenlabs).not.toHaveBeenCalled();
  });
  it.each(['rede', 'http', 'sem_id'])('envio %s fica desconhecido, sem repetir nem cair para texto', async (modo) => {
    const { opts } = preparar();
    if (modo === 'rede') opts.fetchImpl.mockRejectedValue(new Error('timeout após aceite'));
    else opts.fetchImpl.mockResolvedValue(new Response(JSON.stringify({ success: modo !== 'http' }), { status: modo === 'http' ? 502 : 200 }));
    expect(await tentarEnviarVoz(opts)).toBe('desconhecido');
    expect(opts.fetchImpl).toHaveBeenCalledTimes(1);
    expect(opts.tel.registrar.mock.calls.some(([tipo, dados]) => tipo === 'chunk_enviado' && dados?.ok)).toBe(false);
  });
});
