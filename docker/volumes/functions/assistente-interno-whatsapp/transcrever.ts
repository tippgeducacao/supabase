// Transcrição de áudio CURTO (comando de voz do dono) via OpenAI Whisper — chave
// própria/compartilhada, isolada da quota Gemini do João. Reunião LONGA (Plaud) = Fase 2
// (Gemini File API + job em background), não cabe aqui (Whisper tem teto ~25MB).
import { baixarAudio, type LinhaWa } from "./wa.ts";

const MAX_BYTES = 24 * 1024 * 1024;

export async function transcreverAudio(linha: LinhaWa, externalId: string): Promise<string> {
  const dl = await baixarAudio(linha, externalId);
  const key = Deno.env.get("AGENTE_SDR_OPENAI_KEY") || Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new Error("sem chave OpenAI");

  let bytes: Uint8Array;
  if (dl.url) {
    const r = await fetch(dl.url);
    if (!r.ok) throw new Error(`download áudio ${r.status}`);
    bytes = new Uint8Array(await r.arrayBuffer());
  } else if (dl.base64) {
    bytes = Uint8Array.from(atob(dl.base64), (ch) => ch.charCodeAt(0));
  } else {
    throw new Error("mídia de áudio indisponível");
  }
  if (bytes.length > MAX_BYTES) {
    throw new Error("áudio muito longo para transcrição de comando (reunião longa = Fase 2)");
  }

  const form = new FormData();
  form.append("file", new Blob([bytes], { type: dl.mime || "audio/ogg" }), "audio.ogg");
  form.append("model", Deno.env.get("OPENAI_TRANSCRIBE_MODEL") || "whisper-1");
  form.append("language", "pt");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`whisper ${res.status}: ${JSON.stringify(json).slice(0, 150)}`);
  return String(json.text || "").trim();
}
