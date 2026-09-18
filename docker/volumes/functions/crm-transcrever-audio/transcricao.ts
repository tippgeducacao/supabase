// Compartilhado pelo botão do SAC e pela fila da memória SDR. Sem Deno.env aqui:
// configuração e fetch entram por parâmetro para testar sem mídia nem provedor reais.
export const LIMITE_AUDIO_BYTES = 25_000_000;
export const TEMPO_MAXIMO_AUDIO_MS = 45_000;
import { codigoErroSeguro, ErroTranscricao } from './erros.ts';
import { type ConfigGemini, transcreverGemini } from './gemini.ts';
export { codigoErroSeguro, ErroTranscricao } from './erros.ts';

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
  gemini: ConfigGemini | null;
  fetchImpl?: typeof fetch;
  tempoMaximoMs?: number;
  registrar?: (evento: { fase: 'concluida' | 'falhou'; provedor: 'gemini';
    codigo?: string; modelo?: string; tokensEntrada?: number; tokensSaida?: number }) => void;
};

// Gemini é o ÚNICO provedor (18/09/2026): nenhum áudio vai para a OpenAI e não existe
// reserva. Falhou aqui, falhou a transcrição; quem tenta de novo é a fila (até cinco
// vezes) ou o atendente no botão. `semOpenai.test.ts` quebra o build se o Whisper voltar.
export async function transcreverAudio(
  audioUrl: string,
  mimeAnexo: string | null | undefined,
  config: ConfigTranscricao,
): Promise<string> {
  const url = validarUrl(audioUrl);
  if (!config.gemini?.chave) throw new ErroTranscricao("CHAVE_NAO_CONFIGURADA");
  const fetchImpl = config.fetchImpl ?? fetch;
  const informado = config.tempoMaximoMs ?? TEMPO_MAXIMO_AUDIO_MS;
  const prazo = Number.isFinite(informado) ? Math.max(1, Math.min(informado, TEMPO_MAXIMO_AUDIO_MS)) : TEMPO_MAXIMO_AUDIO_MS;
  const controlador = new AbortController();
  const registrar: NonNullable<ConfigTranscricao['registrar']> = evento => {
    try { config.registrar?.(evento); } catch { /* telemetria não muda o resultado */ }
  };
  // O prazo cobre o download e a transcrição.
  const timeout = setTimeout(() => controlador.abort(), prazo);
  try {
    const audio = await fetchImpl(url, { signal: controlador.signal });
    if (!audio.ok) throw new ErroTranscricao(`DOWNLOAD_HTTP_${audio.status}`);
    const mime = mimeDoAudio(audio.headers.get("content-type"), mimeAnexo);
    const bytes = await lerAudio(audio, controlador.signal);
    try {
      const { texto, modelo, tokensEntrada, tokensSaida } = await transcreverGemini(bytes, mime, config.gemini, controlador.signal, fetchImpl);
      registrar({ fase: 'concluida', provedor: 'gemini', modelo, tokensEntrada, tokensSaida });
      return texto;
    } catch (erro) {
      registrar({ fase: 'falhou', provedor: 'gemini', codigo: controlador.signal.aborted ? 'TEMPO_ESGOTADO' : codigoErroSeguro(erro) });
      throw erro;
    }
  } catch (erro) {
    if (controlador.signal.aborted) throw new ErroTranscricao("TEMPO_ESGOTADO");
    if (erro instanceof ErroTranscricao) throw erro;
    throw new ErroTranscricao("TRANSCRICAO_FALHOU");
  } finally {
    clearTimeout(timeout);
  }
}
