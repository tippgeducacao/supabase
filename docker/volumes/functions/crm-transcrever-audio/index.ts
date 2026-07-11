// crm-transcrever-audio
// Transcreve um áudio do chat comercial sob demanda (botão do atendente) via OpenAI.
// PROPOSITALMENTE OpenAI (não Gemini): a transcrição do agente João usa Gemini, e
// transcrever no chat com Gemini disputaria o MESMO rate limit do agente — então aqui
// usamos OpenAI pra isolar a carga. Resultado é cacheado em sac_mensagens.transcricao.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_KEY = Deno.env.get("AGENTE_SDR_OPENAI_KEY") ?? Deno.env.get("OPENAI_API_KEY") ?? "";
const MODELO = Deno.env.get("OPENAI_TRANSCRIBE_MODEL") ?? "whisper-1";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Extensão de arquivo a partir do mime (whisper exige nome com extensão reconhecível). */
function extDoMime(mime: string): string {
  const m = (mime || "").toLowerCase();
  if (m.includes("ogg") || m.includes("opus")) return "ogg";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("wav")) return "wav";
  if (m.includes("webm")) return "webm";
  return "ogg";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!OPENAI_KEY) return json({ error: "OPENAI key não configurada" }, 500);

    const body = await req.json().catch(() => ({}));
    const mensagemId = String(body?.mensagem_id ?? "").trim();
    if (!mensagemId) return json({ error: "mensagem_id obrigatório" }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    // Só atendente logado transcreve (não anon). O front chama via invoke (manda o JWT).
    const authToken = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!authToken || authToken === SERVICE_ROLE) return json({ error: "não autorizado" }, 401);
    const { data: u } = await admin.auth.getUser(authToken);
    if (!u?.user?.id) return json({ error: "não autorizado" }, 401);

    const { data: msg, error: msgErr } = await admin
      .from("sac_mensagens")
      .select("id, anexos, transcricao")
      .eq("id", mensagemId)
      .maybeSingle();
    if (msgErr) return json({ error: msgErr.message }, 500);
    if (!msg) return json({ error: "mensagem não encontrada" }, 404);

    // Cache: já transcrito → devolve.
    if (msg.transcricao && String(msg.transcricao).trim()) {
      return json({ transcricao: msg.transcricao, cached: true });
    }

    const anexos = Array.isArray(msg.anexos) ? msg.anexos : [];
    const audio = anexos.find((a: any) =>
      (a?.mime_type ?? "").startsWith("audio/") || a?.tipo === "audio"
    ) ?? anexos[0];
    const audioUrl = audio?.url ?? audio?.url_storage;
    if (!audioUrl) return json({ error: "mensagem sem áudio" }, 400);

    // Baixa o áudio e manda pro OpenAI (multipart).
    const audioRes = await fetch(audioUrl);
    // 422 (nunca 502/504): o Cloudflare na frente da api. troca 502/504 da origem
    // pela página dele sem headers CORS → o navegador vê "Failed to send a request".
    if (!audioRes.ok) return json({ error: `download do áudio falhou (HTTP ${audioRes.status})` }, 422);
    const mime = audio?.mime_type ?? audioRes.headers.get("content-type") ?? "audio/ogg";
    const blob = await audioRes.blob();

    const form = new FormData();
    form.append("file", blob, `audio.${extDoMime(mime)}`);
    form.append("model", MODELO);
    form.append("language", "pt");

    const oa = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_KEY}` },
      body: form,
    });
    const oaJson = await oa.json().catch(() => ({}));
    if (!oa.ok) {
      return json({ error: `OpenAI HTTP ${oa.status}: ${oaJson?.error?.message ?? "falha"}` }, 422);
    }
    const transcricao = String(oaJson?.text ?? "").trim();
    if (!transcricao) return json({ error: "transcrição vazia" }, 422);

    // Cacheia.
    await admin.from("sac_mensagens").update({ transcricao }).eq("id", mensagemId);

    return json({ transcricao, cached: false });
  } catch (e) {
    return json({ error: (e as Error).message ?? "erro" }, 500);
  }
});
