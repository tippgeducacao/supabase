import { afterEach, describe, expect, it, vi } from "vitest";
import { codigoErroSeguro, ErroTranscricao, LIMITE_AUDIO_BYTES, transcreverAudio } from "./transcricao";

const URL_AUDIO = "https://storage.exemplo.test/voz.ogg";
const config = (fetchImpl: typeof fetch) => ({ chave: "chave-ficticia", modelo: "whisper-1", fetchImpl });
const audio = (mime = "audio/ogg") => new Response(new Uint8Array([1, 2, 3]), {
  headers: { "content-type": mime },
});

afterEach(() => vi.useRealTimers());

describe("transcrição de áudio sem mídia real", () => {
  it("transcreve multipart e compartilha o sinal entre download e Whisper", async () => {
    const chamada = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(audio())
      .mockResolvedValueOnce(Response.json({ text: "  Combinamos amanhã.  " }));
    expect(await transcreverAudio(URL_AUDIO, "audio/ogg", config(chamada))).toBe("Combinamos amanhã.");
    expect(chamada).toHaveBeenCalledTimes(2);
    const [, envio] = chamada.mock.calls[1];
    expect(chamada.mock.calls[1][0]).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(envio?.signal).toBe(chamada.mock.calls[0][1]?.signal);
    const formulario = envio?.body as FormData;
    expect(formulario.get("model")).toBe("whisper-1");
    expect(formulario.get("language")).toBe("pt");
    expect((formulario.get("file") as File).name).toBe("audio.ogg");
  });

  it("aceita octet-stream somente com MIME de áudio registrado no anexo", async () => {
    const chamada = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(audio("application/octet-stream"))
      .mockResolvedValueOnce(Response.json({ text: "Proposta apresentada." }));
    await expect(transcreverAudio(URL_AUDIO, "audio/mpeg", config(chamada))).resolves.toBe("Proposta apresentada.");
    const formulario = chamada.mock.calls[1][1]?.body as FormData;
    expect((formulario.get("file") as File).name).toBe("audio.mp3");

    const semMime = vi.fn<typeof fetch>().mockResolvedValue(audio("application/octet-stream"));
    await expect(transcreverAudio(URL_AUDIO, null, config(semMime))).rejects.toMatchObject({ codigo: "MIME_AUDIO_INVALIDO" });
    expect(semMime).toHaveBeenCalledTimes(1);
  });

  it("rejeita página HTML mesmo se o anexo estiver marcado como áudio", async () => {
    const chamada = vi.fn<typeof fetch>().mockResolvedValue(audio("text/html"));
    await expect(transcreverAudio(URL_AUDIO, "audio/ogg", config(chamada))).rejects.toMatchObject({ codigo: "MIME_AUDIO_INVALIDO" });
    expect(chamada).toHaveBeenCalledTimes(1);
  });

  it.each(["file:///tmp/voz.ogg", "data:audio/ogg;base64,AA==", "não-é-url", "https://usuario:segredo@storage.test/a.ogg"])(
    "recusa URL inválida antes de acessar a rede: %s", async (url) => {
      const chamada = vi.fn<typeof fetch>();
      await expect(transcreverAudio(url, "audio/ogg", config(chamada))).rejects.toMatchObject({ codigo: "URL_AUDIO_INVALIDA" });
      expect(chamada).not.toHaveBeenCalled();
    },
  );

  it("recusa tamanho declarado acima de 25 MB sem chamar Whisper", async () => {
    const chamada = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1]), {
      headers: { "content-type": "audio/ogg", "content-length": String(LIMITE_AUDIO_BYTES + 1) },
    }));
    await expect(transcreverAudio(URL_AUDIO, "audio/ogg", config(chamada))).rejects.toMatchObject({ codigo: "AUDIO_MUITO_GRANDE" });
    expect(chamada).toHaveBeenCalledTimes(1);
  });

  it("limita também stream sem Content-Length e cancela leitura excedente", async () => {
    const cancelar = vi.fn();
    const corpo = new ReadableStream<Uint8Array>({
      start(controlador) { controlador.enqueue(new Uint8Array(LIMITE_AUDIO_BYTES + 1)); },
      cancel: cancelar,
    });
    const chamada = vi.fn<typeof fetch>().mockResolvedValue(new Response(corpo, { headers: { "content-type": "audio/ogg" } }));
    await expect(transcreverAudio(URL_AUDIO, "audio/ogg", config(chamada))).rejects.toMatchObject({ codigo: "AUDIO_MUITO_GRANDE" });
    expect(cancelar).toHaveBeenCalledTimes(1);
    expect(chamada).toHaveBeenCalledTimes(1);
  });

  it("o prazo global cancela Whisper com o tempo já consumido no download", async () => {
    vi.useFakeTimers();
    let sinalWhisper: AbortSignal | undefined;
    const chamada = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve(audio()), 30_000)))
      .mockImplementationOnce((_url, opcoes) => new Promise((_resolve, reject) => {
        sinalWhisper = opcoes?.signal as AbortSignal;
        sinalWhisper.addEventListener("abort", () => reject(new DOMException("Abortado", "AbortError")), { once: true });
      }));
    // Pedir mais tempo nunca amplia o teto do worker.
    const resultado = transcreverAudio(URL_AUDIO, "audio/ogg", { ...config(chamada), tempoMaximoMs: 90_000 });
    const rejeicao = expect(resultado).rejects.toMatchObject({ codigo: "TEMPO_ESGOTADO" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(chamada).toHaveBeenCalledTimes(2);
    expect(sinalWhisper?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    await rejeicao;
    expect(sinalWhisper?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancela download travado sem iniciar transcrição", async () => {
    vi.useFakeTimers();
    let sinal: AbortSignal | undefined;
    const chamada = vi.fn<typeof fetch>().mockImplementation((_url, opcoes) => new Promise((_resolve, reject) => {
      sinal = opcoes?.signal as AbortSignal;
      sinal.addEventListener("abort", () => reject(new DOMException("Abortado", "AbortError")), { once: true });
    }));
    const rejeicao = expect(transcreverAudio(URL_AUDIO, "audio/ogg", config(chamada))).rejects.toMatchObject({ codigo: "TEMPO_ESGOTADO" });
    await vi.advanceTimersByTimeAsync(45_000);
    await rejeicao;
    expect(sinal?.aborted).toBe(true);
    expect(chamada).toHaveBeenCalledTimes(1);
  });

  it("retorna códigos sem corpo, URL ou chave do erro do provedor", async () => {
    const chamada = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(audio())
      .mockResolvedValueOnce(Response.json({ error: { message: "segredo e conversa privada" } }, { status: 429 }));
    await expect(transcreverAudio(URL_AUDIO, "audio/ogg", config(chamada))).rejects.toMatchObject({ codigo: "WHISPER_HTTP_429" });
    expect(codigoErroSeguro(new Error("https://privado.test/token"))).toBe("TRANSCRICAO_FALHOU");
    expect(codigoErroSeguro(new ErroTranscricao("DOWNLOAD_HTTP_500 token=segredo"))).toBe("TRANSCRICAO_FALHOU");
  });

  it("preserva ausência de fala como erro distinguível", async () => {
    const chamada = vi.fn<typeof fetch>().mockResolvedValueOnce(audio()).mockResolvedValueOnce(Response.json({ text: "  " }));
    await expect(transcreverAudio(URL_AUDIO, "audio/ogg", config(chamada))).rejects.toMatchObject({ codigo: "TRANSCRICAO_VAZIA" });
  });
});
