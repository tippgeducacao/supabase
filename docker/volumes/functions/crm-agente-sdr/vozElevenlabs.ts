// 22/09/2026: prepara a nota de voz; não envia WhatsApp nem altera a conversa.
// Só o texto já aprovado pela saída entra aqui. Chave/configuração vêm do chamador,
// sem ler env no import, para o canário e os testes não dependerem do runtime Deno.
// Contrato oficial: https://elevenlabs.io/docs/api-reference/text-to-speech/convert
// opus_48000_64 consta do enum do SDK oficial elevenlabs/elevenlabs-js.

export const VOZ_PADRAO_ELEVENLABS = 'lvkgCBi6spByiTZMPJEK';
export const MODELO_ELEVENLABS_PADRAO = 'eleven_v3';
export const FORMATO_ELEVENLABS_PADRAO = 'opus_48000_64';
export const VERSAO_CACHE_VOZ = 'sdr-voz-v1';
export const LIMITE_TEXTO_VOZ = 600;
export const LIMITE_AUDIO_VOZ_BYTES = 16_000_000;
const BUCKET = 'whatsapp-anexos';
const TIMEOUT_PADRAO_MS = 25_000;

export type FormatoVozElevenlabs = `opus_48000_${32 | 64 | 96 | 128 | 192}`;
export type ConfiguracoesVozElevenlabs = {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
  speed: number;
};
type ErroStorage = { statusCode?: string | number; status?: string | number; code?: string; message?: string; originalError?: unknown };
export type StorageVozElevenlabs = {
  from(bucket: string): {
    download(path: string): PromiseLike<{ data: Blob | null; error: ErroStorage | null }>;
    upload(path: string, bytes: ArrayBuffer, options: { contentType: string; upsert: boolean; cacheControl: string }):
      PromiseLike<{ data: unknown; error: ErroStorage | null }>;
    getPublicUrl(path: string): { data: { publicUrl: string } };
  };
};
export type OpcoesVozElevenlabs = {
  texto: string;
  chaveApi: string;
  storage: StorageVozElevenlabs;
  voiceId?: string;
  modelo?: string;
  formato?: FormatoVozElevenlabs;
  versaoCache?: string;
  voiceSettings?: Partial<ConfiguracoesVozElevenlabs>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
};
export type VozElevenlabsPreparada = {
  url: string;
  mimeType: 'audio/ogg';
  filename: 'audio.ogg';
  cacheHit: boolean;
  caracteres: number;
};
type CodigoErroVoz = 'TEXTO_INVALIDO' | 'TEXTO_LONGO' | 'CHAVE_AUSENTE' | 'CONFIGURACAO_INVALIDA'
  | 'TEMPO_ESGOTADO' | 'CANCELADO' | 'CACHE_LEITURA_FALHOU' | 'CACHE_GRAVACAO_FALHOU'
  | 'CACHE_URL_INVALIDA' | 'ELEVENLABS_REDE' | 'AUDIO_GRANDE' | 'AUDIO_FORMATO_INVALIDO'
  | `ELEVENLABS_HTTP_${number}`;

/** Somente códigos locais: nunca propagar body, texto do lead ou erro de rede com URL/chave. */
export class ErroVozElevenlabs extends Error {
  constructor(readonly codigo: CodigoErroVoz) {
    super(`voz_elevenlabs:${codigo}`);
    this.name = 'ErroVozElevenlabs';
  }
}

function configuracao(opts: Pick<OpcoesVozElevenlabs, 'voiceId' | 'modelo' | 'formato' | 'versaoCache' | 'voiceSettings'>) {
  const voiceId = opts.voiceId ?? VOZ_PADRAO_ELEVENLABS;
  const modelo = opts.modelo ?? MODELO_ELEVENLABS_PADRAO;
  const formato = opts.formato ?? FORMATO_ELEVENLABS_PADRAO;
  const versao = opts.versaoCache ?? VERSAO_CACHE_VOZ;
  if (![voiceId, modelo, versao].every((s) => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(s))
    || !/^opus_48000_(32|64|96|128|192)$/.test(formato)) {
    throw new ErroVozElevenlabs('CONFIGURACAO_INVALIDA');
  }
  const v = opts.voiceSettings ?? {};
  if (modelo === 'eleven_v3') {
    // Escolha do usuário em 22/09/2026: V3 padrão, não V3 Conversational.
    // O V3 usa modos discretos de estabilidade. Não herda os controles de V2:
    // similarity/speaker boost/speed não estão disponíveis, e não dependemos de
    // style ser ignorado. O cache recebe SOMENTE o perfil efetivamente enviado.
    const settings = { stability: v.stability ?? 0.5 };
    if (![0, 0.5, 1].includes(settings.stability)) throw new ErroVozElevenlabs('CONFIGURACAO_INVALIDA');
    return { voiceId, modelo, formato, versao, settings };
  }
  // Valores explícitos preservam o perfil V2 quando escolhido na configuração.
  // Ordem fixa torna o hash independente da ordem das propriedades recebidas.
  const settings: ConfiguracoesVozElevenlabs = {
    stability: v.stability ?? 0.5,
    similarity_boost: v.similarity_boost ?? 0.75,
    style: v.style ?? 0,
    use_speaker_boost: v.use_speaker_boost ?? true,
    speed: v.speed ?? 1,
  };
  if (![settings.stability, settings.similarity_boost, settings.style].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)
    || typeof settings.use_speaker_boost !== 'boolean'
    || !Number.isFinite(settings.speed) || settings.speed < 0.7 || settings.speed > 1.2) {
    throw new ErroVozElevenlabs('CONFIGURACAO_INVALIDA');
  }
  return { voiceId, modelo, formato, versao, settings };
}

/** Texto EXATO, voz, modelo, formato, parâmetros enviados e versão participam do cache. */
export async function caminhoCacheVozElevenlabs(
  texto: string,
  opts: Pick<OpcoesVozElevenlabs, 'voiceId' | 'modelo' | 'formato' | 'versaoCache' | 'voiceSettings'> = {},
): Promise<string> {
  const conteudo = JSON.stringify({ texto, ...configuracao(opts) });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(conteudo));
  const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return `sdr-voz/${hash}.ogg`;
}

/** Confere o cabeçalho do PRIMEIRO pacote Ogg, não uma extensão ou MIME declarados. */
export function validarOggOpus(bytes: Uint8Array): void {
  if (bytes.byteLength > LIMITE_AUDIO_VOZ_BYTES) throw new ErroVozElevenlabs('AUDIO_GRANDE');
  const iguais = (inicio: number, texto: string) => [...texto].every((c, i) => bytes[inicio + i] === c.charCodeAt(0));
  const segmentos = bytes[26] ?? 0;
  const inicioPacote = 27 + segmentos;
  const tamanhoPagina = Array.from(bytes.subarray(27, inicioPacote)).reduce((total, n) => total + n, 0);
  if (!iguais(0, 'OggS') || bytes[4] !== 0 || (bytes[5] & 2) !== 2
    || segmentos < 1 || bytes[27] < 19 || bytes[27] === 255
    || bytes.byteLength < inicioPacote + tamanhoPagina || !iguais(inicioPacote, 'OpusHead')
    || bytes[inicioPacote + 8] !== 1 || bytes[inicioPacote + 9] !== 1) {
    // Nota de voz mono. Não aceitar Ogg/Vorbis ou MP3 com nome .ogg.
    throw new ErroVozElevenlabs('AUDIO_FORMATO_INVALIDO');
  }
}

function faltaObjeto(erro: ErroStorage): boolean {
  const status = Number(erro.statusCode ?? erro.status);
  return status === 404 || ['NoSuchKey', 'NoSuchObject', 'not_found'].includes(erro.code ?? '')
    // O Storage self-hosted antigo responde 400 para objeto inexistente.
    || (status === 400 && /^(?:object|resource|the resource)(?: was)? not found[.!]?$/i.test(erro.message ?? ''));
}

async function cacheAusente(erro: ErroStorage): Promise<boolean> {
  if (faltaObjeto(erro)) return true;
  // 22/09/2026: o SDK 2.50.3 usa storage-js 2.7.1. download passa
  // noResolveJson=true; o 400/404 vem como StorageUnknownError.originalError
  // (Response), sem status/message normalizados. O cache vazio travava TODO
  // primeiro áudio antes do TTS. Não confundir 400 de autenticação com ausência.
  const resposta = erro.originalError;
  if (!(resposta instanceof Response)) return false;
  if (resposta.status === 404) return true;
  if (resposta.status !== 400) return false;
  try {
    const corpo: unknown = await resposta.clone().json();
    if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) return false;
    const dado = corpo as Record<string, unknown>;
    return faltaObjeto({ status: resposta.status,
      code: typeof dado.code === 'string' ? dado.code : typeof dado.error === 'string' ? dado.error : undefined,
      message: typeof dado.message === 'string' ? dado.message : undefined });
  } catch { return false; }
}

async function lerAudio(resposta: Response, sinal: AbortSignal): Promise<Uint8Array> {
  const declarado = Number(resposta.headers.get('content-length'));
  if (declarado > LIMITE_AUDIO_VOZ_BYTES) {
    void resposta.body?.cancel().catch(() => {});
    throw new ErroVozElevenlabs('AUDIO_GRANDE');
  }
  if (!resposta.body) throw new ErroVozElevenlabs('AUDIO_FORMATO_INVALIDO');
  const leitor = resposta.body.getReader();
  const abortar = () => { void leitor.cancel().catch(() => {}); };
  sinal.addEventListener('abort', abortar, { once: true });
  const partes: Uint8Array[] = [];
  let tamanho = 0;
  try {
    while (true) {
      sinal.throwIfAborted();
      const { done, value } = await leitor.read();
      sinal.throwIfAborted();
      if (done) break;
      tamanho += value.byteLength;
      if (tamanho > LIMITE_AUDIO_VOZ_BYTES) {
        void leitor.cancel().catch(() => {});
        throw new ErroVozElevenlabs('AUDIO_GRANDE');
      }
      partes.push(value);
    }
  } finally {
    sinal.removeEventListener('abort', abortar);
    leitor.releaseLock();
  }
  const bytes = new Uint8Array(tamanho);
  let posicao = 0;
  for (const parte of partes) { bytes.set(parte, posicao); posicao += parte.byteLength; }
  return bytes;
}

export async function prepararVozElevenlabs(opts: OpcoesVozElevenlabs): Promise<VozElevenlabsPreparada> {
  if (typeof opts.texto !== 'string' || !opts.texto.trim()) throw new ErroVozElevenlabs('TEXTO_INVALIDO');
  const caracteres = [...opts.texto].length;
  if (caracteres > LIMITE_TEXTO_VOZ) throw new ErroVozElevenlabs('TEXTO_LONGO');
  if (typeof opts.chaveApi !== 'string' || !opts.chaveApi.trim()) throw new ErroVozElevenlabs('CHAVE_AUSENTE');
  const cfg = configuracao(opts);
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_PADRAO_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) throw new ErroVozElevenlabs('CONFIGURACAO_INVALIDA');
  const controle = new AbortController();
  let cancelado = opts.signal?.aborted === true;
  const cancelar = () => { cancelado = true; controle.abort(); };
  opts.signal?.addEventListener('abort', cancelar, { once: true });
  if (cancelado) controle.abort();
  const timer = setTimeout(() => controle.abort(), timeoutMs);
  let rejeitarAbort: () => void = () => {};
  const prazo = new Promise<never>((_, reject) => {
    rejeitarAbort = () => reject(new ErroVozElevenlabs(cancelado ? 'CANCELADO' : 'TEMPO_ESGOTADO'));
    controle.signal.addEventListener('abort', rejeitarAbort, { once: true });
    if (controle.signal.aborted) rejeitarAbort();
  });
  let etapa: CodigoErroVoz = 'CACHE_LEITURA_FALHOU';
  const trabalho = async (): Promise<VozElevenlabsPreparada> => {
    const sinal = controle.signal;
    sinal.throwIfAborted();
    const caminho = await caminhoCacheVozElevenlabs(opts.texto, opts);
    sinal.throwIfAborted();
    const bucket = opts.storage.from(BUCKET);
    const lerCache = async (): Promise<boolean> => {
      const cache = await bucket.download(caminho);
      sinal.throwIfAborted();
      if (cache.error) {
        if (await cacheAusente(cache.error)) return false;
        throw new ErroVozElevenlabs('CACHE_LEITURA_FALHOU');
      }
      if (!cache.data) throw new ErroVozElevenlabs('CACHE_LEITURA_FALHOU');
      if (cache.data.size > LIMITE_AUDIO_VOZ_BYTES) throw new ErroVozElevenlabs('AUDIO_GRANDE');
      const bytes = new Uint8Array(await cache.data.arrayBuffer());
      sinal.throwIfAborted();
      validarOggOpus(bytes);
      return true;
    };
    const concluir = (cacheHit: boolean): VozElevenlabsPreparada => {
      sinal.throwIfAborted();
      etapa = 'CACHE_URL_INVALIDA';
      const url = bucket.getPublicUrl(caminho).data.publicUrl;
      if (!/^https?:\/\//.test(url)) throw new ErroVozElevenlabs('CACHE_URL_INVALIDA');
      return { url, mimeType: 'audio/ogg', filename: 'audio.ogg', cacheHit, caracteres };
    };
    if (await lerCache()) return concluir(true);
    etapa = 'ELEVENLABS_REDE';
    sinal.throwIfAborted();
    const resposta = await (opts.fetchImpl ?? fetch)(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(cfg.voiceId)}?output_format=${cfg.formato}`,
      {
        method: 'POST', signal: sinal, redirect: 'error',
        headers: { 'xi-api-key': opts.chaveApi, 'Content-Type': 'application/json', Accept: 'audio/ogg' },
        // Texto aprovado segue intacto, sem tags acrescentadas. Não forçamos
        // language_code: o perfil V2 também pode ser escolhido e não o suporta.
        body: JSON.stringify({ text: opts.texto, model_id: cfg.modelo, voice_settings: cfg.settings }),
      },
    );
    sinal.throwIfAborted();
    if (!resposta.ok) {
      void resposta.body?.cancel().catch(() => {});
      throw new ErroVozElevenlabs(`ELEVENLABS_HTTP_${resposta.status}`);
    }
    const bytes = await lerAudio(resposta, sinal);
    validarOggOpus(bytes);
    sinal.throwIfAborted();
    etapa = 'CACHE_GRAVACAO_FALHOU';
    const upload = await bucket.upload(caminho, bytes.buffer as ArrayBuffer,
      { contentType: 'audio/ogg', upsert: false, cacheControl: '31536000' });
    sinal.throwIfAborted();
    if (upload.error) {
      if (Number(upload.error.statusCode ?? upload.error.status) === 409 || upload.error.code === 'Duplicate') {
        // Outra rodada gerou o MESMO texto/configuração. Só reusa após validar o
        // arquivo vencedor; nunca sobrescreve um objeto que a Meta já pode usar.
        if (await lerCache()) return concluir(true);
      }
      throw new ErroVozElevenlabs('CACHE_GRAVACAO_FALHOU');
    }
    if (!upload.data) throw new ErroVozElevenlabs('CACHE_GRAVACAO_FALHOU');
    return concluir(false);
  };
  try {
    // O prazo cobre cabeçalhos, bytes e Storage. Versões antigas do cliente Storage
    // não aceitam signal: o race limita a espera e cada continuação checa o abort
    // antes de iniciar outra operação. Upload já iniciado pode terminar como cache.
    return await Promise.race([trabalho(), prazo]);
  } catch (erro) {
    if (controle.signal.aborted) throw new ErroVozElevenlabs(cancelado ? 'CANCELADO' : 'TEMPO_ESGOTADO');
    if (erro instanceof ErroVozElevenlabs) throw erro;
    throw new ErroVozElevenlabs(etapa);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', cancelar);
    controle.signal.removeEventListener('abort', rejeitarAbort);
  }
}
