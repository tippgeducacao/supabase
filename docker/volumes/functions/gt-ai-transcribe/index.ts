// Edge function: gt-ai-transcribe
// Receives audio (base64) and returns transcription (PT-BR) using Gemini 2.5 Flash multimodal.
// Supports incremental transcription via optional `context` (previous transcript) for chunked recording.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Hard limits to avoid edge timeouts and oversized payloads
const MAX_BASE64_BYTES = 8 * 1024 * 1024; // ~8MB base64 (~6MB raw audio)
const GEMINI_TIMEOUT_MS = 45_000;

interface ReqBody {
  audio: string; // base64
  mimeType?: string;
  language?: string;
  context?: string; // previous transcript fragment, for continuity in chunked mode
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout (${label}) após ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
    if (!GEMINI_API_KEY) {
      return new Response(
        JSON.stringify({ error: "GEMINI_API_KEY não configurada." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body = (await req.json()) as ReqBody;
    const { audio, mimeType = "audio/webm", language = "pt-BR", context } = body;

    if (!audio || typeof audio !== "string") {
      return new Response(JSON.stringify({ error: "audio (base64) é obrigatório" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (audio.length > MAX_BASE64_BYTES) {
      return new Response(
        JSON.stringify({ error: `Áudio muito grande (${Math.round(audio.length / 1024 / 1024)}MB). Use chunks menores.` }),
        { status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const hasContext = typeof context === "string" && context.trim().length > 0;
    const sys = hasContext
      ? `Você é um transcritor de áudio em ${language}. Este áudio é a CONTINUAÇÃO de uma transcrição anterior. ` +
        `Transcreva APENAS o novo trecho (não repita o anterior), mantendo pontuação e estilo coerentes. ` +
        `Retorne APENAS o texto transcrito, sem aspas ou prefixos.`
      : `Você é um transcritor de áudio. Transcreva o áudio para texto em ${language}, ` +
        `preservando a pontuação natural. Retorne APENAS o texto transcrito, sem comentários, sem aspas, sem prefixos.`;

    const userParts: any[] = [];
    if (hasContext) {
      const tail = context!.slice(-600);
      userParts.push({ text: `Trecho anterior (apenas para contexto, não repita):\n"""${tail}"""\n\nNovo áudio:` });
    } else {
      userParts.push({ text: "Transcreva este áudio:" });
    }
    userParts.push({ inlineData: { mimeType, data: audio } });

    const aiRes = await withTimeout(
      fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: sys }] },
          contents: [{ role: "user", parts: userParts }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
        }),
      }),
      GEMINI_TIMEOUT_MS,
      "gemini",
    );

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      console.error("Gemini transcribe error:", aiRes.status, errText);
      return new Response(
        JSON.stringify({ error: `Erro Gemini ${aiRes.status}: ${errText.slice(0, 200)}` }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const data = await aiRes.json();
    const text =
      data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("").trim() ?? "";

    return new Response(JSON.stringify({ text }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("gt-ai-transcribe error:", e);
    const msg = e?.message || "Erro desconhecido";
    const isTimeout = /Timeout/i.test(msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: isTimeout ? 504 : 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
