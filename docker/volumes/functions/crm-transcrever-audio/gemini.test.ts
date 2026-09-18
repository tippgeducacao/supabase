import { describe, it, expect, vi, afterEach } from 'vitest';
import { transcreverAudio, codigoErroSeguro, ErroTranscricao } from './transcricao';
import { resolverGemini } from './configuracao';
import { LIMITE_GEMINI_INLINE_BYTES } from './gemini';
import { processarHistoricoSdr } from './historicoSdr';
const url = 'https://storage.exemplo.test/audio.ogg';
const audio = (tamanho = 3) => new Response(new Uint8Array(tamanho).fill(1), { headers: { 'content-type': 'audio/ogg; codecs=opus' } });
const resposta = (texto = 'Amanhã às treze horas.', finishReason = 'STOP') => Response.json({
  candidates: [{ finishReason, content: { parts: [{ thought: true, text: 'não deve entrar' }, { text: JSON.stringify({ transcricao: texto }) }] } }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 12 },
});
const config = (fetchImpl: typeof fetch) => ({ gemini: { chave: 'google-ficticia' }, fetchImpl });
afterEach(() => vi.useRealTimers());

describe('transcrição só pelo Gemini', () => {
  it('uma chamada ao Gemini, com o áudio baixado uma vez e telemetria sem segredo', async () => {
    const registrar = vi.fn();
    const rede = vi.fn<typeof fetch>().mockResolvedValueOnce(audio()).mockResolvedValueOnce(resposta());
    expect(await transcreverAudio(url, 'audio/ogg', { ...config(rede), registrar })).toBe('Amanhã às treze horas.');
    expect(rede).toHaveBeenCalledTimes(2);
    const [endereco, envio] = rede.mock.calls[1];
    expect(endereco).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(envio?.headers).toMatchObject({ 'x-goog-api-key': 'google-ficticia' });
    const corpo = JSON.parse(envio?.body as string);
    expect(corpo.contents[0].parts[1].inlineData).toEqual({ mimeType: 'audio/ogg', data: 'AQEB' });
    expect(corpo.generationConfig.responseMimeType).toBe('application/json');
    expect(registrar).toHaveBeenCalledTimes(1);
    expect(registrar).toHaveBeenCalledWith(expect.objectContaining({ fase: 'concluida', provedor: 'gemini', tokensEntrada: 100 }));
    expect(JSON.stringify(registrar.mock.calls)).not.toMatch(/ficticia|storage|treze/);
  });
  it.each([400, 401, 403, 429, 500, 503])('HTTP %i do Gemini registra a falha e não tenta mais nada', async status => {
    const registrar = vi.fn();
    const rede = vi.fn<typeof fetch>().mockResolvedValueOnce(audio()).mockResolvedValueOnce(new Response('', { status }));
    await expect(transcreverAudio(url, 'audio/ogg', { ...config(rede), registrar })).rejects.toMatchObject({ codigo: 'GEMINI_HTTP_' + status });
    expect(rede).toHaveBeenCalledTimes(2);
    expect(registrar).toHaveBeenCalledTimes(1);
    expect(registrar).toHaveBeenCalledWith({ fase: 'falhou', provedor: 'gemini', codigo: 'GEMINI_HTTP_' + status });
  });
  it('falha de rede no Gemini vira código seguro, sem vazar o erro original', async () => {
    const rede = vi.fn<typeof fetch>().mockResolvedValueOnce(audio()).mockRejectedValueOnce(new Error('URL privada e token'));
    await expect(transcreverAudio(url, 'audio/ogg', config(rede))).rejects.toMatchObject({ codigo: 'TRANSCRICAO_FALHOU' });
    expect(rede).toHaveBeenCalledTimes(2);
  });
  it('prazo total aborta Gemini; não devolve resposta tardia nem inicia outra tentativa', async () => {
    vi.useFakeTimers();
    const rede = vi.fn<typeof fetch>().mockResolvedValueOnce(audio())
      .mockImplementationOnce((_u, o) => new Promise((_resolve, reject) => o?.signal?.addEventListener('abort', () => reject(new Error('cancelado')), { once: true })));
    const p = expect(transcreverAudio(url, 'audio/ogg', config(rede))).rejects.toMatchObject({ codigo: 'TEMPO_ESGOTADO' });
    await vi.advanceTimersByTimeAsync(45000); await p;
    expect(rede).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['html', 'download', 'vazio'])('falha de mídia %s não aciona o provedor', async tipo => {
    const rede = vi.fn<typeof fetch>().mockResolvedValue(tipo === 'html' ? new Response('erro', { headers: { 'content-type': 'text/html' } })
      : tipo === 'download' ? new Response('', { status: 404 }) : audio(0));
    await expect(transcreverAudio(url, 'audio/ogg', config(rede))).rejects.toBeInstanceOf(ErroTranscricao);
    expect(rede).toHaveBeenCalledTimes(1);
  });
  it.each(['MAX_TOKENS', 'SAFETY', 'RECITATION'])('não salva saída Gemini interrompida: %s', async motivo => {
    const rede = vi.fn<typeof fetch>().mockResolvedValueOnce(audio()).mockResolvedValueOnce(resposta('trecho incompleto', motivo));
    await expect(transcreverAudio(url, 'audio/ogg', config(rede))).rejects.toBeInstanceOf(ErroTranscricao);
  });
  it('silêncio real e JSON inválido continuam sendo falhas distinguíveis', async () => {
    const finais = [resposta(''), Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'um resumo' }] } }] })];
    const codigos = ['TRANSCRICAO_VAZIA', 'GEMINI_RESPOSTA_INVALIDA'];
    for (const [i, final] of finais.entries()) {
      const rede = vi.fn<typeof fetch>().mockResolvedValueOnce(audio()).mockResolvedValueOnce(final);
      await expect(transcreverAudio(url, 'audio/ogg', config(rede))).rejects.toMatchObject({ codigo: codigos[i] });
    }
    expect(codigoErroSeguro(new ErroTranscricao('GEMINI_HTTP_429'))).toBe('GEMINI_HTTP_429');
    expect(codigoErroSeguro(new ErroTranscricao('GEMINI_HTTP_429 token=segredo'))).toBe('TRANSCRICAO_FALHOU');
    // Código do provedor aposentado não é mais reconhecido como seguro.
    expect(codigoErroSeguro(new ErroTranscricao('WHISPER_HTTP_429'))).toBe('TRANSCRICAO_FALHOU');
  });
  it.each([true, false])('áudio grande usa Files API e remove o arquivo mesmo se a geração falha (%s)', async sucesso => {
    const rede = vi.fn<typeof fetch>().mockResolvedValueOnce(audio(LIMITE_GEMINI_INLINE_BYTES + 1))
      .mockResolvedValueOnce(new Response('', { headers: { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/arquivo' } }))
      .mockResolvedValueOnce(Response.json({ file: { name: 'files/audio-teste', uri: 'https://generativelanguage.googleapis.com/v1beta/files/audio-teste', state: 'ACTIVE' } }))
      .mockResolvedValueOnce(sucesso ? resposta() : new Response('', { status: 503 })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    const r = transcreverAudio(url, 'audio/ogg', config(rede));
    if (sucesso) await expect(r).resolves.toBe('Amanhã às treze horas.'); else await expect(r).rejects.toMatchObject({ codigo: 'GEMINI_HTTP_503' });
    expect((rede.mock.calls[2][1]?.body as ArrayBuffer).byteLength).toBe(LIMITE_GEMINI_INLINE_BYTES + 1);
    const corpo = JSON.parse(rede.mock.calls[3][1]?.body as string);
    expect(corpo.contents[0].parts[1]).toHaveProperty('fileData');
    expect(rede.mock.calls[4][1]?.method).toBe('DELETE');
  });
  it('upload não encaminha credencial para domínio externo', async () => {
    const rede = vi.fn<typeof fetch>().mockResolvedValueOnce(audio(LIMITE_GEMINI_INLINE_BYTES + 1))
      .mockResolvedValueOnce(new Response('', { headers: { 'x-goog-upload-url': 'https://externo.test/arquivo' } }));
    await expect(transcreverAudio(url, 'audio/ogg', config(rede))).rejects.toMatchObject({ codigo: 'GEMINI_UPLOAD_INVALIDO' });
    expect(rede).toHaveBeenCalledTimes(2);
  });
});

describe('configuração Google do sistema', () => {
  const banco = (resultado: unknown) => ({ from: () => {
    const q = { select: () => q, eq: () => q, order: () => q, limit: () => q, abortSignal: () => q, maybeSingle: async () => resultado }; return q;
  } });
  it('prefere a chave ativa do cadastro', async () => {
    expect(await resolverGemini(banco({ data: { api_key: 'chave-cadastro' } }), () => 'chave-ambiente')).toMatchObject({ chave: 'chave-cadastro' });
  });
  it('erro do banco usa ambiente e ausência total devolve nulo (sem provedor alternativo)', async () => {
    expect(await resolverGemini(banco({ error: {} }), n => n === 'GOOGLE_API_KEY' ? 'ambiente' : undefined)).toMatchObject({ chave: 'ambiente' });
    expect(await resolverGemini(banco({ error: {} }), () => undefined)).toBeNull();
  });
  it('o interruptor antigo da reserva não desliga mais o único provedor', async () => {
    const env = (n: string) => n === 'CRM_AUDIO_GEMINI_FALLBACK' ? 'false' : undefined;
    expect(await resolverGemini(banco({ data: { api_key: 'chave-cadastro' } }), env)).toMatchObject({ chave: 'chave-cadastro' });
  });
});

describe('fila mantém a mesma mensagem', () => {
  it.each([true, false])('Gemini conclui ou registra falha sem iniciar atendimento (%s)', async sucesso => {
    const rpc = vi.fn(async (nome: string) => nome === 'crm_sdr_historico_audio_reivindicar'
      ? { data: [{ mensagem_id: 'mensagem-original', tentativa: 3, audio_url: url, mime_type: 'audio/ogg', transcricao_cache: null }], error: null }
      : { data: true, error: null });
    const rede = vi.fn<typeof fetch>().mockResolvedValueOnce(audio())
      .mockResolvedValueOnce(sucesso ? resposta() : new Response('', { status: 503 }));
    const r = await processarHistoricoSdr({ rpc, transcrever: (u, m) => transcreverAudio(u, m, config(rede)) });
    expect(r.concluidos).toBe(sucesso ? 1 : 0); expect(r.falhas).toBe(sucesso ? 0 : 1);
    expect(rpc).toHaveBeenCalledWith(sucesso ? 'crm_sdr_historico_audio_concluir' : 'crm_sdr_historico_audio_falhar',
      { p_mensagem_id: 'mensagem-original', p_tentativa: 3, ...(sucesso ? { p_transcricao: 'Amanhã às treze horas.' } : { p_erro: 'GEMINI_HTTP_503' }) });
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
