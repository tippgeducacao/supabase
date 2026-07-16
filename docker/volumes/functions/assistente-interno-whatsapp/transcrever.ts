// Transcrição de áudio CURTO (comando/recado do dono) via OpenAI Whisper.
// Reunião LONGA (áudio grande) NÃO passa aqui — vai pro pipeline Gemini em background
// (transcricao.ts). Whisper tem teto ~25MB.

const MAX_BYTES = 24 * 1024 * 1024;

/** Extensão a partir do mime (o Whisper detecta o formato pelo nome do arquivo). */
export function extDeMime(mime: string): string {
  const m = (mime || "").toLowerCase();
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("wav")) return "wav";
  if (m.includes("webm")) return "webm";
  return "ogg";
}

export async function transcreverBytes(bytes: Uint8Array, mime: string): Promise<string> {
  if (bytes.length > MAX_BYTES) throw new Error("áudio muito longo para transcrição rápida");
  const key = Deno.env.get("AGENTE_SDR_OPENAI_KEY") || Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new Error("sem chave OpenAI");

  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mime || "audio/ogg" }), `audio.${extDeMime(mime)}`);
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
