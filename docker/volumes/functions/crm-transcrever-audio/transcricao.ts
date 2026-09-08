// Compartilhado pelo botão do SAC e pela fila da memória SDR. Sem Deno.env aqui:
// configuração e fetch entram por parâmetro para testar sem mídia nem provedor reais.
export const LIMITE_AUDIO_BYTES = 25_000_000;
export const TEMPO_MAXIMO_AUDIO_MS = 45_000;

export class ErroTranscricao extends Error {
  constructor(public readonly codigo: string) {
    super(codigo);
    this.name = "ErroTranscricao";
  }
}

const CODIGOS_SEGUROS = new Set([
  "URL_AUDIO_INVALIDA", "MIME_AUDIO_INVALIDO", "AUDIO_MUITO_GRANDE", "AUDIO_VAZIO",
  "TEMPO_ESGOTADO", "TRANSCRICAO_VAZIA", "TRANSCRICAO_FALHOU", "CHAVE_NAO_CONFIGURADA",
  "FALHA_REIVINDICAR", "LOTE_INVALIDO", "FALHA_CONCLUIR", "FALHA_REGISTRAR_ERRO",
]);

// O erro de fetch/SDK pode carregar URL assinada, corpo ou token. A fila só recebe
// códigos controlados por nós; nunca Error.message de uma dependência.
export function codigoErroSeguro(erro: unknown): string {
  if (erro instanceof ErroTranscricao && (
    CODIGOS_SEGUROS.has(erro.codigo) || /^(DOWNLOAD|WHISPER)_HTTP_[1-5]\d{2}$/.test(erro.codigo)
  )) return erro.codigo;
  return "TRANSCRICAO_FALHOU";
}

function extDoMime(mime: string): string {
  if (/ogg|opus/.test(mime)) return "ogg";
  if (/mpeg|mp3/.test(mime)) return "mp3";
  if (/mp4|m4a|aac/.test(mime)) return "m4a";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("webm")) return "webm";
  return "ogg";
}

function validarUrl(bruta: string): string {
  try {
    const url = new URL(bruta);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.toString();
  } catch {
    throw new ErroTranscricao("URL_AUDIO_INVALIDA");
  }
}

function mimeDoAudio(header: string | null, mimeAnexo?: string | null): string {
  const recebido = (header ?? "").split(";")[0].trim().toLowerCase();
  const declarado = (mimeAnexo ?? "").split(";")[0].trim().toLowerCase();
  // Storage legado pode servir octet-stream; nesse caso o MIME registrado no anexo
  // resolve. HTML/JSON de erro nunca vira áudio só porque o anexo dizia audio/ogg.
  const mime = !recebido || recebido === "application/octet-stream" ? declarado : recebido;
  if (!/^audio\/[a-z0-9.+-]+$/.test(mime)) throw new ErroTranscricao("MIME_AUDIO_INVALIDO");
  return mime;
}

async function lerAudio(resposta: Response, sinal: AbortSignal): Promise<ArrayBuffer> {
  const tamanho = Number(resposta.headers.get("content-length"));
  if (tamanho > LIMITE_AUDIO_BYTES) {
    await resposta.body?.cancel();
    throw new ErroTranscricao("AUDIO_MUITO_GRANDE");
  }
  if (!resposta.body) throw new ErroTranscricao("AUDIO_VAZIO");
  const leitor = resposta.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      sinal.throwIfAborted();
      const { done, value } = await leitor.read();
      if (done) break;
      total += value.byteLength;
      if (total > LIMITE_AUDIO_BYTES) {
        await leitor.cancel();
        throw new ErroTranscricao("AUDIO_MUITO_GRANDE");
      }
      partes.push(value);
    }
  } finally {
    leitor.releaseLock();
  }
  sinal.throwIfAborted();
  if (!total) throw new ErroTranscricao("AUDIO_VAZIO");
  const bytes = new Uint8Array(total);
  let posicao = 0;
  for (const parte of partes) { bytes.set(parte, posicao); posicao += parte.byteLength; }
  return bytes.buffer;
}

export type ConfigTranscricao = {
  chave: string;
  modelo: string;
  fetchImpl?: typeof fetch;
  tempoMaximoMs?: number;
};

export async function transcreverAudio(
  audioUrl: string,
  mimeAnexo: string | null | undefined,
  config: ConfigTranscricao,
): Promise<string> {
  const url = validarUrl(audioUrl);
  if (!config.chave) throw new ErroTranscricao("CHAVE_NAO_CONFIGURADA");
  const fetchImpl = config.fetchImpl ?? fetch;
  const informado = config.tempoMaximoMs ?? TEMPO_MAXIMO_AUDIO_MS;
  const prazo = Number.isFinite(informado) ? Math.max(1, Math.min(informado, TEMPO_MAXIMO_AUDIO_MS)) : TEMPO_MAXIMO_AUDIO_MS;
  const controlador = new AbortController();
  // Um único prazo cobre download, leitura do corpo e Whisper. Cancelar o fetch
  // de verdade evita que três jobs continuem consumindo rede após o cron desistir.
  const timeout = setTimeout(() => controlador.abort(), prazo);
  try {
    const audio = await fetchImpl(url, { signal: controlador.signal });
    if (!audio.ok) throw new ErroTranscricao(`DOWNLOAD_HTTP_${audio.status}`);
    const mime = mimeDoAudio(audio.headers.get("content-type"), mimeAnexo);
    const bytes = await lerAudio(audio, controlador.signal);
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mime }), `audio.${extDoMime(mime)}`);
    form.append("model", config.modelo);
    form.append("language", "pt");

    controlador.signal.throwIfAborted();
    const resposta = await fetchImpl("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.chave}` },
      body: form,
      signal: controlador.signal,
    });
    if (!resposta.ok) throw new ErroTranscricao(`WHISPER_HTTP_${resposta.status}`);
    const corpo = await resposta.json();
    controlador.signal.throwIfAborted();
    const texto = typeof corpo?.text === "string" ? corpo.text.trim() : "";
    if (!texto) throw new ErroTranscricao("TRANSCRICAO_VAZIA");
    return texto;
  } catch (erro) {
    if (controlador.signal.aborted) throw new ErroTranscricao("TEMPO_ESGOTADO");
    if (erro instanceof ErroTranscricao) throw erro;
    throw new ErroTranscricao("TRANSCRICAO_FALHOU");
  } finally {
    clearTimeout(timeout);
  }
}
