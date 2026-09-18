// Transcrição de áudio CURTO (comando/recado do dono): SÓ Gemini inline, com a chave Google
// do banco (ai_api_keys). Nenhum áudio vai para a OpenAI e não há provedor de reserva
// (18/09/2026) — a OpenAI já recusava a chave do container com 429 desde 11/09 e o Whisper
// saiu de vez. Reunião LONGA (áudio grande) NÃO passa aqui — vai pro pipeline Gemini em
// background (transcricao.ts).

// Inline no generateContent: o request inteiro tem teto de ~20MB e o base64 infla 33%.
// É também a fronteira curto × reunião do index.ts: acima disto o áudio vai para a fila.
export const MAX_BYTES_AUDIO_CURTO = 14 * 1024 * 1024;
const GEMINI_MODEL = Deno.env.get("ASSIST_GEMINI_MODEL") || "gemini-2.5-flash";

/** Extensão a partir do mime (nome do arquivo no Storage da fila de reunião). */
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

function base64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000; // fatia p/ não estourar o limite de argumentos do fromCharCode
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

async function viaGemini(admin: any, bytes: Uint8Array, mime: string): Promise<string> {
  if (bytes.length > MAX_BYTES_AUDIO_CURTO) throw new Error("áudio grande demais p/ envio inline");
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
  try {
    return await viaGemini(admin, bytes, mime);
  } catch (e) {
    // O prefixo vai para o "Motivo técnico" do chat: diz qual provedor falhou.
    throw new Error(`gemini ${(e as Error).message}`);
  }
}
