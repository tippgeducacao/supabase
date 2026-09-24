import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configurarVoz, conferirEstadoVoz, tentarEnviarVoz } from './envioVoz';
import { confirmarInteracaoVoz, planejarCadenciaVoz } from './cadenciaVoz';

vi.mock('./envioVoz', () => ({ configurarVoz: vi.fn(), tentarEnviarVoz: vi.fn(), conferirEstadoVoz: vi.fn() }));
vi.mock('./cadenciaVoz', () => ({ planejarCadenciaVoz: vi.fn(), confirmarInteracaoVoz: vi.fn() }));
let saida: typeof import('./saida');
const transporte = vi.fn();
const texto = 'a conversa com o monitor é para tirar suas dúvidas. qual período fica melhor para você?';
const ctx = { telefone: '5511999990001', remotejid: '5511999990001@s.whatsapp.net', waAccountId: 'conta-meta', leadId: null, oportunidadeId: null };
const opcoes = { supabase: {}, origem: 'conversa' as const, provedorResposta: 'openai' as const, historico: [], interacaoId: '00000000-0000-4000-8000-000000000001' };
beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: () => '' } });
  vi.stubGlobal('fetch', transporte);
  saida = await import('./saida');
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(configurarVoz).mockReturnValue({ chaveApi: 'sintetica', voiceId: 'voz-teste', modelo: 'eleven_v3' });
  vi.mocked(planejarCadenciaVoz).mockResolvedValue({ audioDevido: true, concluida: false, alvo: 3, interacoes: 2 });
  vi.mocked(confirmarInteracaoVoz).mockResolvedValue(undefined);
});

describe('saída com voz e fallback', () => {
  it.each(['texto', 'audio'] as const)('confirma abertura uma vez após aceite por %s', async canal => {
    vi.mocked(tentarEnviarVoz).mockResolvedValue(canal === 'audio' ? 'aceito' : 'texto');
    transporte.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, wa_message_id: 'wamid-abertura' })));
    const primeiroAceite = vi.fn(async () => undefined);
    await saida.enviarResposta(ctx, texto, vi.fn(), undefined, undefined, opcoes, 'codigo', { primeiroAceite });
    expect(primeiroAceite).toHaveBeenCalledOnce();
  });
  it('abertura recusada interrompe o envio antes do restante da resposta', async () => {
    vi.mocked(configurarVoz).mockReturnValue(null);
    const primeiroAceite = vi.fn(async () => undefined);
    transporte.mockResolvedValueOnce(new Response('recusado', { status: 400 }));
    const r = await saida.enviarResposta(ctx, 'vi que falamos por outro número da PPG\n\nqual área você quer aprofundar?', vi.fn(),
      undefined, undefined, undefined, 'codigo', { primeiroAceite });
    expect(r).toMatchObject({ aceitos: 0, estado: 'falhou' });
    expect(transporte).toHaveBeenCalledOnce();
    expect(primeiroAceite).not.toHaveBeenCalled();
  });
  it('sem comprovante de aceite não confirma abertura, mesmo sem voz ativa', async () => {
    vi.mocked(configurarVoz).mockReturnValue(null);
    const primeiroAceite = vi.fn(async () => undefined);
    transporte.mockResolvedValueOnce(new Response(JSON.stringify({ success: true })));
    const r = await saida.enviarResposta(ctx, texto, vi.fn(), undefined, undefined, undefined, 'codigo', { primeiroAceite });
    expect(r.estado).toBe('desconhecido');
    expect(primeiroAceite).not.toHaveBeenCalled();
  });
  it('usa contador de follow-up e entrega a segunda mensagem como áudio', async () => {
    const followup = { ...opcoes, origem: 'followup' as const };
    vi.mocked(planejarCadenciaVoz).mockResolvedValue({ audioDevido: true, concluida: false, alvo: 2, interacoes: 1 });
    vi.mocked(tentarEnviarVoz).mockResolvedValue('aceito');
    expect((await saida.enviarResposta(ctx, texto, vi.fn(), undefined, undefined, followup, 'codigo')).canal).toBe('audio');
    expect(planejarCadenciaVoz).toHaveBeenCalledWith(opcoes.supabase, expect.objectContaining({ origem: 'followup' }));
    expect(confirmarInteracaoVoz).toHaveBeenCalledWith(opcoes.supabase, expect.objectContaining({ origem: 'followup' }), 'audio', undefined);
    expect(tentarEnviarVoz).toHaveBeenCalledWith(expect.objectContaining({ cadenciaAtingida: true }));
    expect(transporte).not.toHaveBeenCalled();
  });
  it('primeiro follow-up é texto e só conta após aceite', async () => {
    vi.mocked(planejarCadenciaVoz).mockResolvedValue({ audioDevido: false, concluida: false, alvo: 2, interacoes: 0 });
    vi.mocked(tentarEnviarVoz).mockResolvedValue('texto');
    transporte.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, wa_message_id: 'wamid-followup-texto' })));
    expect((await saida.enviarResposta(ctx, texto, vi.fn(), undefined, undefined, { ...opcoes, origem: 'followup' }, 'codigo')).canal).toBe('texto');
    expect(tentarEnviarVoz).toHaveBeenCalledWith(expect.objectContaining({ cadenciaAtingida: false }));
    expect(confirmarInteracaoVoz).toHaveBeenCalledExactlyOnceWith(opcoes.supabase,
      expect.objectContaining({ origem: 'followup' }), 'texto', 'wamid-followup-texto');
  });
  it('falha de síntese no segundo follow-up confirma somente texto na origem correta', async () => {
    vi.mocked(planejarCadenciaVoz).mockResolvedValue({ audioDevido: true, concluida: false, alvo: 2, interacoes: 1 });
    vi.mocked(tentarEnviarVoz).mockResolvedValue('texto_revalidar');
    vi.mocked(conferirEstadoVoz).mockResolvedValue({ permitido: true, motivo: 'estado_valido' });
    transporte.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, wa_message_id: 'wamid-fallback-followup' })));
    expect((await saida.enviarResposta(ctx, texto, vi.fn(), undefined, undefined, { ...opcoes, origem: 'followup' }, 'codigo')).canal).toBe('texto');
    expect(confirmarInteracaoVoz).toHaveBeenCalledExactlyOnceWith(opcoes.supabase,
      expect.objectContaining({ origem: 'followup' }), 'texto', 'wamid-fallback-followup');
  });
  it('fallback de áudio mantém vc e kkk na mensagem escrita original', async () => {
    vi.mocked(tentarEnviarVoz).mockResolvedValue('texto_revalidar');
    vi.mocked(conferirEstadoVoz).mockResolvedValue({ permitido: true, motivo: 'estado_valido' });
    transporte.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, wa_message_id: 'wamid-texto' })));
    const original = 'imagino kkk, vc trabalha bastante. qual período fica melhor para conversar?';
    const resultado = await saida.enviarResposta(ctx, original, vi.fn(), undefined, undefined, opcoes, 'codigo');
    expect(resultado.canal).toBe('texto');
    expect(transporte).toHaveBeenCalledOnce();
    expect(JSON.parse(String(transporte.mock.calls[0][1]?.body)).conteudo).toBe(original);
  });
  it('candidato em código mantém a resposta inteira para o áudio, sem narrar break', async () => {
    vi.mocked(tentarEnviarVoz).mockResolvedValue('aceito');
    const resposta = 'a conversa é para conhecer a pós.<break>qual período fica melhor?';
    const resultado = await saida.enviarResposta(ctx, resposta, vi.fn(), undefined, undefined, opcoes, 'codigo');
    expect(resultado.canal).toBe('audio');
    expect(tentarEnviarVoz).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      texto: 'a conversa é para conhecer a pós.\n\nqual período fica melhor?',
    }));
    expect(transporte).not.toHaveBeenCalled();
  });

  it('candidato em código revalida nova entrada depois do preparo de voz', async () => {
    vi.mocked(tentarEnviarVoz).mockResolvedValue('texto_revalidar');
    vi.mocked(conferirEstadoVoz).mockResolvedValue({ permitido: false, motivo: 'entrada_nova' });
    const resultado = await saida.enviarResposta(ctx, texto, vi.fn(), undefined, undefined, opcoes, 'codigo');
    expect(resultado).toEqual({ aceitos: 0, canal: 'texto', estado: 'cancelado' });
    expect(transporte).not.toHaveBeenCalled();
    expect(confirmarInteracaoVoz).not.toHaveBeenCalled();
  });

  it('dois balões em código contam uma interação e não chamam o fracionador LLM', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(tentarEnviarVoz).mockResolvedValue('texto');
      transporte.mockImplementation(async () => new Response(JSON.stringify({ success: true, wa_message_id: 'wamid-local' })));
      const resposta = saida.enviarResposta(ctx, 'primeira ideia.\n\nsegunda ideia.', vi.fn(), undefined, undefined, opcoes, 'codigo');
      await vi.runAllTimersAsync();
      expect((await resposta).aceitos).toBe(2);
      expect(transporte).toHaveBeenCalledTimes(2);
      expect(transporte.mock.calls.every(([url]) => !url.includes('openai.com'))).toBe(true);
      expect(confirmarInteracaoVoz).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it.each(['aceito', 'desconhecido', 'cancelado'] as const)('áudio %s não gera um segundo envio por texto', async (estado) => {
    vi.mocked(tentarEnviarVoz).mockResolvedValue(estado);
    const resultado = await saida.enviarResposta(ctx, texto, vi.fn(), undefined, undefined, opcoes);
    expect(resultado).toEqual({ aceitos: estado === 'aceito' ? 1 : 0, canal: 'audio', estado });
    expect(transporte).not.toHaveBeenCalled();
    expect(confirmarInteracaoVoz).toHaveBeenCalledTimes(estado === 'aceito' ? 1 : 0);
    if (estado === 'aceito') expect(confirmarInteracaoVoz).toHaveBeenCalledWith(opcoes.supabase,
      expect.objectContaining({ interacaoId: opcoes.interacaoId }), 'audio', undefined);
  });
  it('nova entrada durante fracionamento cancela os chunks do fallback', async () => {
    vi.mocked(tentarEnviarVoz).mockResolvedValue('texto_revalidar');
    vi.mocked(conferirEstadoVoz).mockResolvedValue({ permitido: false, motivo: 'entrada_nova' });
    transporte.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      chunks: [{ message: texto, sequence_number: 1 }],
    }) } }] })));
    const resultado = await saida.enviarResposta(ctx, texto, vi.fn(), undefined, undefined, opcoes);
    expect(resultado).toEqual({ aceitos: 0, canal: 'texto', estado: 'cancelado' });
    expect(transporte).toHaveBeenCalledTimes(1); // apenas o fracionador, nenhum envio WhatsApp
    expect(transporte.mock.calls[0][0]).toContain('chat/completions');
  });
  it('texto aprovado passa pelas mesmas guardas de bastidor antes da voz', async () => {
    await saida.enviarResposta(ctx, '<thinking>análise não concluída', vi.fn(), undefined, undefined, opcoes);
    expect(tentarEnviarVoz).not.toHaveBeenCalled();
    expect(transporte).not.toHaveBeenCalled();
  });
  it('interação já confirmada não envia outra vez', async () => {
    vi.mocked(planejarCadenciaVoz).mockResolvedValue({ audioDevido: false, concluida: true, alvo: 4, interacoes: 1 });
    expect((await saida.enviarResposta(ctx, texto, vi.fn(), undefined, undefined, opcoes)).aceitos).toBe(0);
    expect(tentarEnviarVoz).not.toHaveBeenCalled();
    expect(transporte).not.toHaveBeenCalled();
  });
  it('contador indisponível preserva texto sem sortear ou confirmar um ciclo inventado', async () => {
    vi.mocked(planejarCadenciaVoz).mockRejectedValue(new Error('banco indisponível'));
    vi.mocked(tentarEnviarVoz).mockResolvedValue('texto');
    transporte.mockRejectedValueOnce(new Error('fracionador offline'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, wa_message_id: 'wamid-texto' })));
    expect((await saida.enviarResposta(ctx, texto, vi.fn(), undefined, undefined, opcoes)).aceitos).toBe(1);
    expect(tentarEnviarVoz).toHaveBeenCalledWith(expect.objectContaining({ cadenciaAtingida: false }));
    expect(confirmarInteracaoVoz).not.toHaveBeenCalled();
  });
  it('texto aceito antes do alvo conta uma vez e informa o identificador do WhatsApp', async () => {
    vi.mocked(planejarCadenciaVoz).mockResolvedValue({ audioDevido: false, concluida: false, alvo: 5, interacoes: 1 });
    vi.mocked(tentarEnviarVoz).mockResolvedValue('texto');
    transporte.mockRejectedValueOnce(new Error('fracionador offline'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, wa_message_id: 'wamid-texto' })));
    const resultado = await saida.enviarResposta(ctx, texto, vi.fn(), undefined, undefined, opcoes);
    expect(resultado.aceitos).toBe(1);
    expect(confirmarInteracaoVoz).toHaveBeenCalledExactlyOnceWith(opcoes.supabase,
      expect.objectContaining({ interacaoId: opcoes.interacaoId }), 'texto', 'wamid-texto');
    expect(tentarEnviarVoz).toHaveBeenCalledWith(expect.objectContaining({ cadenciaAtingida: false }));
  });
  it('HTTP 200 sem aceite comprovado não avança o contador', async () => {
    vi.mocked(tentarEnviarVoz).mockResolvedValue('texto');
    transporte.mockRejectedValueOnce(new Error('fracionador offline'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: false })));
    expect((await saida.enviarResposta(ctx, texto, vi.fn(), undefined, undefined, opcoes)).estado).toBe('desconhecido');
    expect(confirmarInteracaoVoz).not.toHaveBeenCalled();
  });
  it('dois balões aceitos na mesma resposta consomem uma única interação', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(tentarEnviarVoz).mockResolvedValue('texto');
      const partes = [
        'a conversa com o monitor serve para conhecer a pós e tirar suas dúvidas com calma. '.repeat(3).trim(),
        'você pode aproveitar esse momento para entender o conteúdo e conversar sobre sua rotina de estudos. '.repeat(3).trim(),
      ];
      transporte.mockImplementation(async (url: string) => new Response(JSON.stringify(url.includes('chat/completions')
        ? { choices: [{ message: { content: JSON.stringify({ chunks: partes.map((message, i) => ({ message, sequence_number: i + 1 })) }) } }] }
        : { success: true, wa_message_id: 'wamid-balao' })));
      const resposta = saida.enviarResposta(ctx, partes.join('\n'), vi.fn(), undefined, undefined, opcoes);
      await vi.runAllTimersAsync();
      expect((await resposta).aceitos).toBe(2);
      expect(confirmarInteracaoVoz).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it('erro de gravação do contador depois do áudio não provoca reenvio', async () => {
    vi.mocked(tentarEnviarVoz).mockResolvedValue('aceito');
    vi.mocked(confirmarInteracaoVoz).mockRejectedValue(new Error('banco indisponível'));
    const registrar = vi.fn();
    expect((await saida.enviarResposta(ctx, texto, vi.fn(), { registrar }, undefined, opcoes)).aceitos).toBe(1);
    expect(tentarEnviarVoz).toHaveBeenCalledOnce();
    expect(transporte).not.toHaveBeenCalled();
    expect(registrar).toHaveBeenCalledWith('voz_cadencia_confirmacao_falhou', expect.objectContaining({ canal: 'audio' }));
  });
});
