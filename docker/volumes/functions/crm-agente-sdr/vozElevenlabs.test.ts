import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  caminhoCacheVozElevenlabs, ErroVozElevenlabs, FORMATO_ELEVENLABS_PADRAO,
  LIMITE_AUDIO_VOZ_BYTES, MODELO_ELEVENLABS_PADRAO, prepararVozElevenlabs,
  validarOggOpus, VOZ_PADRAO_ELEVENLABS,
} from './vozElevenlabs';
import type { OpcoesVozElevenlabs, StorageVozElevenlabs } from './vozElevenlabs';

// Página inicial Ogg com pacote OpusHead mono. Os testes verificam o contrato de
// container/codec, não qualidade de voz: nenhuma chamada real é feita à ElevenLabs.
function audioOpus(): Uint8Array {
  const bytes = new Uint8Array(47);
  const escrever = (p: number, s: string) => bytes.set(new TextEncoder().encode(s), p);
  escrever(0, 'OggS');
  bytes[5] = 2; bytes[26] = 1; bytes[27] = 19;
  escrever(28, 'OpusHead'); bytes[36] = 1; bytes[37] = 1;
  return bytes;
}
const blob = () => new Blob([audioOpus() as BlobPart], { type: 'audio/ogg' });
const ausente = () => ({ data: null, error: { statusCode: '404', message: 'Object not found' } });
function dependencias() {
  const download = vi.fn<ReturnType<StorageVozElevenlabs['from']>['download']>().mockResolvedValue(ausente());
  const upload = vi.fn().mockResolvedValue({ data: { path: 'arquivo' }, error: null });
  const getPublicUrl = vi.fn((path: string) => ({ data: { publicUrl: `https://storage.exemplo.test/whatsapp-anexos/${path}` } }));
  const from = vi.fn(() => ({ download, upload, getPublicUrl }));
  const transporte = vi.fn<typeof fetch>().mockImplementation(async () => new Response(audioOpus() as BodyInit));
  const opts: OpcoesVozElevenlabs = { texto: 'vamos conversar sobre a pós?', chaveApi: 'segredo-sintetico',
    storage: { from }, fetchImpl: transporte };
  return { opts, download, upload, from, transporte, getPublicUrl };
}

afterEach(() => vi.restoreAllMocks());

describe('preparação de voz ElevenLabs sem envio', () => {
  it('gera OGG/Opus, guarda pelo hash e devolve referência sem enviar mensagem', async () => {
    const d = dependencias();
    d.opts.texto = '  vamos conversar sobre a pós?\n';
    const resultado = await prepararVozElevenlabs(d.opts);
    expect(resultado).toMatchObject({ mimeType: 'audio/ogg', filename: 'audio.ogg', cacheHit: false,
      caracteres: [...d.opts.texto].length });
    expect(d.from).toHaveBeenCalledWith('whatsapp-anexos');
    expect(d.download).toHaveBeenCalledTimes(1);
    expect(d.transporte).toHaveBeenCalledTimes(1);
    const [url, pedido] = d.transporte.mock.calls[0];
    expect(url).toBe(`https://api.elevenlabs.io/v1/text-to-speech/${VOZ_PADRAO_ELEVENLABS}?output_format=${FORMATO_ELEVENLABS_PADRAO}`);
    expect(pedido).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'xi-api-key': 'segredo-sintetico' } });
    expect(pedido?.signal).toBeInstanceOf(AbortSignal);
    expect(MODELO_ELEVENLABS_PADRAO).toBe('eleven_v3');
    expect(JSON.parse(String(pedido?.body))).toEqual({ text: d.opts.texto, model_id: 'eleven_v3',
      voice_settings: { stability: 0.5 } });
    const caminho = await caminhoCacheVozElevenlabs(d.opts.texto);
    expect(d.upload).toHaveBeenCalledWith(caminho, audioOpus().buffer,
      { contentType: 'audio/ogg', upsert: false, cacheControl: '31536000' });
    expect(resultado.url).toContain(caminho);
    expect(JSON.stringify(resultado)).not.toContain('segredo-sintetico');
  });

  it('reutiliza o cache durável validado, sem TTS nem upload', async () => {
    const d = dependencias();
    d.download.mockResolvedValue({ data: blob(), error: null });
    expect(await prepararVozElevenlabs(d.opts)).toMatchObject({ cacheHit: true });
    expect(d.transporte).not.toHaveBeenCalled();
    expect(d.upload).not.toHaveBeenCalled();
  });

  it('envia somente estabilidade no V3 mesmo recebendo controles do perfil V2', async () => {
    const d = dependencias();
    await prepararVozElevenlabs({ ...d.opts,
      voiceSettings: { stability: 1, similarity_boost: 0.4, use_speaker_boost: false, style: 0.5, speed: 0.9 } });
    expect(JSON.parse(String(d.transporte.mock.calls[0][1]?.body))).toEqual({
      text: d.opts.texto, model_id: 'eleven_v3', voice_settings: { stability: 1 },
    });
  });

  it.each([0, 0.5, 1])('V3 aceita o modo de estabilidade %s', async (stability) => {
    const d = dependencias();
    await prepararVozElevenlabs({ ...d.opts, voiceSettings: { stability } });
    expect(JSON.parse(String(d.transporte.mock.calls[0][1]?.body)).voice_settings).toEqual({ stability });
  });

  it('preserva o perfil completo V2 quando o chamador escolhe esse modelo', async () => {
    const d = dependencias();
    await prepararVozElevenlabs({ ...d.opts, modelo: 'eleven_multilingual_v2', voiceSettings: { stability: 0.4 } });
    expect(JSON.parse(String(d.transporte.mock.calls[0][1]?.body))).toEqual({
      text: d.opts.texto, model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.4, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1 },
    });
  });

  it('reutiliza o vencedor após upload concorrente 409, conferindo o arquivo', async () => {
    const d = dependencias();
    d.download.mockResolvedValueOnce(ausente()).mockResolvedValueOnce({ data: blob(), error: null });
    d.upload.mockResolvedValue({ data: null, error: { statusCode: '409' } });
    expect(await prepararVozElevenlabs(d.opts)).toMatchObject({ cacheHit: true });
    expect(d.download).toHaveBeenCalledTimes(2);
    expect(d.upload).toHaveBeenCalledTimes(1);
  });

  it('aceita a resposta 400 Object not found do Storage antigo como cache ausente', async () => {
    const d = dependencias();
    d.download.mockResolvedValue({ data: null, error: { statusCode: '400', message: 'Object not found' } });
    expect(await prepararVozElevenlabs(d.opts)).toMatchObject({ cacheHit: false });
  });

  it('não sintetiza sobre cache inacessível e não propaga erros do Storage', async () => {
    const d = dependencias();
    d.download.mockResolvedValue({ data: null, error: { statusCode: '403', message: 'segredo-sintetico' } });
    await expect(prepararVozElevenlabs(d.opts)).rejects.toMatchObject({ codigo: 'CACHE_LEITURA_FALHOU', message: 'voz_elevenlabs:CACHE_LEITURA_FALHOU' });
    expect(d.transporte).not.toHaveBeenCalled();
    expect(d.upload).not.toHaveBeenCalled();
  });

  it('rejeita cache corrompido mesmo com MIME audio/ogg', async () => {
    const d = dependencias();
    d.download.mockResolvedValue({ data: new Blob(['ID3arquivo-mp3'], { type: 'audio/ogg' }), error: null });
    await expect(prepararVozElevenlabs(d.opts)).rejects.toMatchObject({ codigo: 'AUDIO_FORMATO_INVALIDO' });
    expect(d.transporte).not.toHaveBeenCalled();
    expect(d.upload).not.toHaveBeenCalled();
  });

  it.each([
    ['', 'TEXTO_INVALIDO'], ['   \n', 'TEXTO_INVALIDO'], ['á'.repeat(601), 'TEXTO_LONGO'],
  ])('barra texto inválido antes de qualquer acesso: %s', async (texto, codigo) => {
    const d = dependencias();
    await expect(prepararVozElevenlabs({ ...d.opts, texto })).rejects.toMatchObject({ codigo });
    expect(d.from).not.toHaveBeenCalled();
    expect(d.transporte).not.toHaveBeenCalled();
  });

  it('aceita exatamente 600 caracteres sem truncar nem normalizar o texto', async () => {
    const d = dependencias();
    d.opts.texto = 'á'.repeat(600);
    expect(await prepararVozElevenlabs(d.opts)).toMatchObject({ caracteres: 600 });
    expect(JSON.parse(String(d.transporte.mock.calls[0][1]?.body)).text).toBe(d.opts.texto);
  });

  it.each([
    [{ chaveApi: '' }, 'CHAVE_AUSENTE'], [{ voiceId: 'voz/com-caminho' }, 'CONFIGURACAO_INVALIDA'],
    [{ formato: 'mp3_44100_128' }, 'CONFIGURACAO_INVALIDA'], [{ timeoutMs: 0 }, 'CONFIGURACAO_INVALIDA'],
    [{ modelo: 'eleven_multilingual_v2', voiceSettings: { speed: 9 } }, 'CONFIGURACAO_INVALIDA'],
    [{ voiceSettings: { stability: 0.4 } }, 'CONFIGURACAO_INVALIDA'],
    [{ voiceSettings: { stability: Number.NaN } }, 'CONFIGURACAO_INVALIDA'],
  ])('barra configuração inválida antes de TTS: %j', async (config, codigo) => {
    const d = dependencias();
    await expect(prepararVozElevenlabs({ ...d.opts, ...config } as OpcoesVozElevenlabs)).rejects.toMatchObject({ codigo });
    expect(d.transporte).not.toHaveBeenCalled();
  });

  it('HTTP de falha não lê nem propaga body do provedor', async () => {
    const d = dependencias();
    d.transporte.mockResolvedValue(new Response('chave segredo-sintetico, texto do lead', { status: 401 }));
    await expect(prepararVozElevenlabs(d.opts)).rejects.toEqual(new ErroVozElevenlabs('ELEVENLABS_HTTP_401'));
    expect(d.upload).not.toHaveBeenCalled();
  });

  it('erro de rede é sanitizado e não gera outra tentativa', async () => {
    const d = dependencias();
    d.transporte.mockRejectedValue(new Error('https://exemplo.test?key=segredo-sintetico'));
    await expect(prepararVozElevenlabs(d.opts)).rejects.toEqual(new ErroVozElevenlabs('ELEVENLABS_REDE'));
    expect(d.transporte).toHaveBeenCalledTimes(1);
    expect(d.upload).not.toHaveBeenCalled();
  });

  it('falha no upload não devolve URL que possa ser enviada', async () => {
    const d = dependencias();
    d.upload.mockResolvedValue({ data: null, error: { message: 'credencial privada' } });
    await expect(prepararVozElevenlabs(d.opts)).rejects.toEqual(new ErroVozElevenlabs('CACHE_GRAVACAO_FALHOU'));
    expect(d.getPublicUrl).not.toHaveBeenCalled();
  });

  it('409 sem arquivo válido não é sucesso', async () => {
    const d = dependencias();
    d.upload.mockResolvedValue({ data: null, error: { statusCode: '409' } });
    await expect(prepararVozElevenlabs(d.opts)).rejects.toMatchObject({ codigo: 'CACHE_GRAVACAO_FALHOU' });
    expect(d.getPublicUrl).not.toHaveBeenCalled();
  });
});

describe('formato e limite de bytes reais', () => {
  it.each(['ID3arquivo-mp3', 'OggSarquivo-sem-codec', 'RIFFarquivo-wav'])('recusa %s antes do upload', async (conteudo) => {
    const d = dependencias();
    d.transporte.mockResolvedValue(new Response(conteudo, { headers: { 'content-type': 'audio/ogg' } }));
    await expect(prepararVozElevenlabs(d.opts)).rejects.toMatchObject({ codigo: 'AUDIO_FORMATO_INVALIDO' });
    expect(d.upload).not.toHaveBeenCalled();
  });

  it('recusa página Ogg truncada, Opus estéreo ou marcador OpusHead solto', () => {
    expect(() => validarOggOpus(audioOpus().slice(0, 42))).toThrow('AUDIO_FORMATO_INVALIDO');
    const stereo = audioOpus(); stereo[37] = 2;
    expect(() => validarOggOpus(stereo)).toThrow('AUDIO_FORMATO_INVALIDO');
    const falso = audioOpus(); falso[26] = 2;
    expect(() => validarOggOpus(falso)).toThrow('AUDIO_FORMATO_INVALIDO');
  });

  it('recusa tamanho declarado maior que o limite, sem upload', async () => {
    const d = dependencias();
    d.transporte.mockResolvedValue(new Response(audioOpus() as BodyInit,
      { headers: { 'content-length': String(LIMITE_AUDIO_VOZ_BYTES + 1) } }));
    await expect(prepararVozElevenlabs(d.opts)).rejects.toMatchObject({ codigo: 'AUDIO_GRANDE' });
    expect(d.upload).not.toHaveBeenCalled();
  });

  it('interrompe stream que excede o limite mesmo sem Content-Length', async () => {
    const d = dependencias();
    const cancelar = vi.fn();
    d.transporte.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array(LIMITE_AUDIO_VOZ_BYTES)); c.enqueue(new Uint8Array(1)); }, cancel: cancelar,
    })));
    await expect(prepararVozElevenlabs(d.opts)).rejects.toMatchObject({ codigo: 'AUDIO_GRANDE' });
    expect(cancelar).toHaveBeenCalled();
    expect(d.upload).not.toHaveBeenCalled();
  });
});

describe('prazo cobre resposta, bytes e Storage', () => {
  it('cancela leitura de corpo que ficou aberta após o HTTP 200', async () => {
    const d = dependencias();
    const cancelar = vi.fn();
    d.transporte.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel: cancelar })));
    const pedido = prepararVozElevenlabs({ ...d.opts, timeoutMs: 50 });
    await expect(pedido).rejects.toMatchObject({ codigo: 'TEMPO_ESGOTADO' });
    expect(d.transporte.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(cancelar).toHaveBeenCalled();
    expect(d.upload).not.toHaveBeenCalled();
  });

  it('limita fetch que nunca resolve e aborta o sinal recebido pelo transporte', async () => {
    const d = dependencias();
    d.transporte.mockImplementation(() => new Promise(() => {}));
    await expect(prepararVozElevenlabs({ ...d.opts, timeoutMs: 50 })).rejects.toMatchObject({ codigo: 'TEMPO_ESGOTADO' });
    expect(d.transporte.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('cache atrasado não começa TTS depois do timeout global', async () => {
    const d = dependencias();
    let resolver: ((r: ReturnType<typeof ausente>) => void) | undefined;
    d.download.mockImplementation(() => new Promise((resolve) => { resolver = resolve; }));
    await expect(prepararVozElevenlabs({ ...d.opts, timeoutMs: 50 })).rejects.toMatchObject({ codigo: 'TEMPO_ESGOTADO' });
    resolver?.(ausente());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(d.transporte).not.toHaveBeenCalled();
    expect(d.upload).not.toHaveBeenCalled();
  });

  it('sinal externo já cancelado não acessa cache nem provedor', async () => {
    const d = dependencias();
    const controle = new AbortController(); controle.abort(new Error('segredo no motivo'));
    await expect(prepararVozElevenlabs({ ...d.opts, signal: controle.signal })).rejects.toEqual(new ErroVozElevenlabs('CANCELADO'));
    expect(d.from).not.toHaveBeenCalled();
    expect(d.transporte).not.toHaveBeenCalled();
  });

  it('limpa timer e listener externo ao concluir', async () => {
    const d = dependencias();
    const controle = new AbortController();
    const remove = vi.spyOn(controle.signal, 'removeEventListener');
    const limpar = vi.spyOn(globalThis, 'clearTimeout');
    await prepararVozElevenlabs({ ...d.opts, signal: controle.signal });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(limpar).toHaveBeenCalled();
    controle.abort();
    expect(d.transporte.mock.calls[0][1]?.signal?.aborted).toBe(false);
  });
});

describe('identidade do cache', () => {
  it('hash não expõe texto e é determinístico para texto e configuração idênticos', async () => {
    const a = await caminhoCacheVozElevenlabs('olá');
    expect(a).toMatch(/^sdr-voz\/[a-f0-9]{64}\.ogg$/);
    expect(await caminhoCacheVozElevenlabs('olá')).toBe(a);
    expect(await caminhoCacheVozElevenlabs('olá', { voiceSettings: { style: 0, stability: 0.5 } }))
      .toBe(await caminhoCacheVozElevenlabs('olá', { voiceSettings: { stability: 0.5, style: 0 } }));
  });

  it('cada mudança de texto exato, voz, modelo, formato, versão e parâmetros muda o arquivo', async () => {
    const caminhos = await Promise.all([
      caminhoCacheVozElevenlabs('olá'), caminhoCacheVozElevenlabs('olá '), caminhoCacheVozElevenlabs('ola'),
      caminhoCacheVozElevenlabs('olá', { voiceId: 'outraVoz' }),
      caminhoCacheVozElevenlabs('olá', { modelo: 'eleven_turbo_v2_5' }),
      caminhoCacheVozElevenlabs('olá', { formato: 'opus_48000_32' }),
      caminhoCacheVozElevenlabs('olá', { versaoCache: 'sdr-voz-v2' }),
      caminhoCacheVozElevenlabs('olá', { voiceSettings: { stability: 1 } }),
    ]);
    expect(new Set(caminhos).size).toBe(caminhos.length);
  });

  it('V3 ignora no hash parâmetros que não envia; V2 diferencia os seus controles', async () => {
    const baseV3 = await caminhoCacheVozElevenlabs('olá');
    expect(await caminhoCacheVozElevenlabs('olá', {
      voiceSettings: { similarity_boost: 0.4, use_speaker_boost: false, style: 0.8, speed: 0.9 },
    })).toBe(baseV3);
    const baseV2 = await caminhoCacheVozElevenlabs('olá', { modelo: 'eleven_multilingual_v2' });
    expect(baseV2).not.toBe(baseV3);
    expect(await caminhoCacheVozElevenlabs('olá', {
      modelo: 'eleven_multilingual_v2', voiceSettings: { speed: 0.9 },
    })).not.toBe(baseV2);
  });
});
