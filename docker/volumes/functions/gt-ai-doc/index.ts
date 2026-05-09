// Edge function: gt-ai-doc
// Multi-action AI helper for the document editor (Notion-like)
// Actions: improve | summarize | expand | shorten | translate | continue | generate
// Uses Google Gemini (GEMINI_API_KEY) — global key configured in Lovable secrets.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

type Action =
  | "improve"
  | "summarize"
  | "expand"
  | "shorten"
  | "translate"
  | "continue"
  | "generate";

interface ReqBody {
  action: Action;
  text?: string;
  instruction?: string;
  language?: "pt" | "en" | "es";
}

function systemPromptFor(action: Action, opts: { instruction?: string; language?: string }): string {
  const base =
    "Você é um assistente de escrita profissional para um editor de documentos em Português do Brasil. " +
    "Retorne APENAS o resultado final, sem comentários, sem markdown extra, sem aspas envolventes. " +
    "Preserve o formato HTML simples (parágrafos, listas) quando o texto vier em HTML.";

  switch (action) {
    case "improve":
      return `${base}\nTarefa: melhorar gramática, clareza, fluidez e estilo, mantendo idioma e sentido.`;
    case "summarize":
      return `${base}\nTarefa: resumir o texto em poucos parágrafos mantendo as ideias principais.`;
    case "expand":
      return `${base}\nTarefa: expandir o texto adicionando detalhes, exemplos e contexto, mantendo o tom.`;
    case "shorten":
      return `${base}\nTarefa: encurtar o texto preservando as informações essenciais.`;
    case "translate": {
      const langName = opts.language === "en" ? "Inglês" : opts.language === "es" ? "Espanhol" : "Português do Brasil";
      return `${base}\nTarefa: traduzir o texto para ${langName}, mantendo formatação.`;
    }
    case "continue":
      return `${base}\nTarefa: continuar escrevendo a partir do texto fornecido, mantendo coerência, tom e estilo. Retorne SOMENTE a continuação (não repita o texto enviado).`;
    case "generate":
      return `${base}\nTarefa: gerar um texto novo a partir da instrução do usuário: "${opts.instruction || ""}". Use HTML simples (parágrafos <p>, listas <ul>/<ol>, títulos <h2>/<h3>) quando fizer sentido.`;
    default:
      return base;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
    if (!GEMINI_API_KEY) {
      return new Response(
        JSON.stringify({ error: "GEMINI_API_KEY não configurada no projeto." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body = (await req.json()) as ReqBody;
    const { action, text, instruction, language } = body;

    if (!action) {
      return new Response(JSON.stringify({ error: "action é obrigatório" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action !== "generate" && (!text || !text.trim())) {
      return new Response(JSON.stringify({ error: "text é obrigatório para essa ação" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sys = systemPromptFor(action, { instruction, language });
    const userContent =
      action === "generate"
        ? instruction || ""
        : action === "translate" || action === "continue" || action === "improve" || action === "summarize" || action === "expand" || action === "shorten"
        ? text!
        : text!;

    const aiRes = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sys }] },
        contents: [{ role: "user", parts: [{ text: userContent }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      console.error("Gemini error:", aiRes.status, errText);
      const msg =
        aiRes.status === 401 || aiRes.status === 403
          ? "Chave Gemini inválida ou sem permissão."
          : aiRes.status === 429
          ? "Limite de requisições do Gemini excedido."
          : `Erro Gemini ${aiRes.status}`;
      return new Response(JSON.stringify({ error: msg }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await aiRes.json();
    const result =
      data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("").trim() ?? "";

    return new Response(JSON.stringify({ result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("gt-ai-doc error:", e);
    return new Response(JSON.stringify({ error: e.message || "Erro desconhecido" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
