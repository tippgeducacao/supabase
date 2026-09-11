// Transcrição de áudio CURTO (comando/recado do dono): OpenAI Whisper e, se ele falhar,
// Gemini inline com a chave Google do banco (ai_api_keys) — mesmo desenho de 2 provedores
// do crm-agente-sdr/midia.ts. Antes o Whisper era o ÚNICO caminho: com a chave OpenAI do
// container morta, TODO áudio caía em "Tive um problema pra processar esse áudio" (11/09).
// Reunião LONGA (áudio grande) NÃO passa aqui — vai pro pipeline Gemini em background
// (transcricao.ts). Whisper tem teto ~25MB.

const MAX_BYTES = 24 * 1024 * 1024;
// Inline no generateContent: o request inteiro tem teto de ~20MB e o base64 infla 33%.
const MAX_BYTES_GEMINI_INLINE = 14 * 1024 * 1024;
const GEMINI_MODEL = Deno.env.get("ASSIST_GEMINI_MODEL") || "gemini-2.5-flash";

/** Extensão a partir do mime (o Whisper detecta o formato pelo nome do arquivo). */
export function extDeMime(mime: string): string {
  const m = (mime || "").toLowerCase();
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("wav")) return "wav";
  if (m.includes("webm")) return "webm";
  return "ogg";
}

/** Chave Gemini: env dedicada (opcional) → ai_api_keys provider google (a canônica, rotável na UI). */
export async function googleKey(admin: any): Promise<string | null> {
  const env = Deno.env.get("ASSIST_GEMINI_KEY") || Deno.env.get("GOOGLE_API_KEY");
  if (env) return env;
  const { data } = await admin.from("ai_api_keys").select("api_key")
    .eq("provider", "google").eq("is_active", true).limit(1).maybeSingle();
  return data?.api_key ?? null;
}

async function viaWhisper(bytes: Uint8Array, mime: string): Promise<string> {
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
  // Só o CÓDIGO do erro: a mensagem da OpenAI traz a chave mascarada e este texto vai pro chat.
  if (!res.ok) throw new Error(`${res.status} ${json?.error?.code || json?.error?.type || ""}`.trim());
  const texto = String(json.text || "").trim();
  if (!texto) throw new Error("transcrição vazia");
  return texto;
}

function base64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000; // fatia p/ não estourar o limite de argumentos do fromCharCode
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

async function viaGemini(admin: any, bytes: Uint8Array, mime: string): Promise<string> {
  if (bytes.length > MAX_BYTES_GEMINI_INLINE) throw new Error("áudio grande demais p/ envio inline");
  const key = await googleKey(admin);
  if (!key) throw new Error("sem chave Google");
  // "audio/ogg; codecs=opus" (nota de voz do WhatsApp) → "audio/ogg": o mime_type do Gemini não leva parâmetro.
  const mimeBase = (mime || "audio/ogg").split(";")[0].trim();

  let res: Response;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [
            { inline_data: { mime_type: mimeBase, data: base64(bytes) } },
            { text: "Transcreva este áudio em português, palavra por palavra. Devolva SÓ o texto falado, sem comentários, sem rótulos e sem aspas." },
          ] }],
          // thinkingBudget 0: sem isso o 2.5-flash gasta o maxOutputTokens "pensando" (lição da transcrição de reunião).
          generationConfig: { temperature: 0.1, maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
        }),
      },
    );
  } catch (e) {
    // Erro de rede do fetch no Deno traz a URL INTEIRA (com ?key=) na mensagem — e ela vai pro chat.
    throw new Error(`rede (${(e as Error)?.name ?? "erro"})`);
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${j?.error?.status || ""}`.trim());
  const cand = j?.candidates?.[0];
  const texto = (cand?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("").trim();
  if (!texto) throw new Error(`transcrição vazia (finish=${cand?.finishReason ?? "?"})`);
  return texto;
}

export async function transcreverBytes(admin: any, bytes: Uint8Array, mime: string): Promise<string> {
  if (bytes.length > MAX_BYTES) throw new Error("áudio muito longo para transcrição rápida");
  let erroWhisper = "";
  try {
    return await viaWhisper(bytes, mime);
  } catch (e) {
    erroWhisper = (e as Error).message;
  }
  try {
    const texto = await viaGemini(admin, bytes, mime);
    console.warn(`[assistente] whisper falhou (${erroWhisper}); transcrito pelo Gemini`);
    return texto;
  } catch (e) {
    throw new Error(`whisper ${erroWhisper} · gemini ${(e as Error).message}`);
  }
}
