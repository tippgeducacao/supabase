import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-20250514";

const FORMAT_RULES = `REGRAS DE FORMATAÇÃO OBRIGATÓRIAS:
- Responda em TEXTO PURO. NUNCA use markdown: nada de **negrito**, *itálico*, _sublinhado_, # títulos, > citações, \`código\`.
- Separe parágrafos com UMA linha em branco (\\n\\n). Não junte tudo em um bloco só.
- Use listas com "- " no início da linha quando fizer sentido (sem usar •, ★ ou outros bullets).
- Não inclua aspas envolvendo a resposta, comentários sobre o que mudou, ou prefixos tipo "Aqui está:".
- Mantenha QUALQUER título/seção do texto original em uma linha própria seguida do conteúdo.
- Devolva o TEXTO COMPLETO. Nunca corte no meio de uma frase. Nunca finalize com reticências indicando continuação.`;

const DEFAULT_SYSTEM_PROMPT = `Você é um assistente de escrita profissional para um app de gestão de tarefas em Português do Brasil.
Sua tarefa é MELHORAR o texto enviado: corrigir gramática, ortografia, pontuação, clareza e fluidez,
mantendo o sentido original, o tom e o idioma. NÃO adicione conteúdo novo, NÃO faça comentários.

${FORMAT_RULES}`;

function buildSystemPrompt(instruction?: string): string {
  if (!instruction || !instruction.trim()) return DEFAULT_SYSTEM_PROMPT;
  return `Você é um assistente de escrita profissional para um app de gestão de tarefas em Português do Brasil.
O usuário selecionou um trecho de texto e pediu a seguinte ação: "${instruction.trim()}".
Aplique essa instrução ao texto enviado, mantendo o idioma (PT-BR) e um tom profissional.
NÃO faça comentários sobre o que mudou.

${FORMAT_RULES}`;
}

interface ReqBody {
  text: string;
  instruction?: string;
  action?: "improve";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

    const { text, instruction } = (await req.json()) as ReqBody;
    if (!text || typeof text !== "string" || !text.trim()) {
      return new Response(JSON.stringify({ error: "text é obrigatório" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const systemPrompt = buildSystemPrompt(instruction);

    // Helper: chama Lovable AI Gateway (Gemini) como fallback
    const callLovableGateway = async (): Promise<{ improved?: string; error?: string; status?: number }> => {
      const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
      if (!LOVABLE_API_KEY) {
        return { error: "LOVABLE_API_KEY não configurada (fallback indisponível)", status: 500 };
      }
      const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: text },
          ],
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        console.error("Lovable AI Gateway error:", res.status, errText);
        if (res.status === 429) return { error: "Limite de requisições da IA excedido. Aguarde alguns segundos.", status: 429 };
        if (res.status === 402) return { error: "Créditos da IA esgotados. Adicione créditos em Settings → Workspace → Usage.", status: 402 };
        return { error: `Erro do gateway de IA (${res.status})`, status: 500 };
      }
      const data = await res.json();
      const improved = (data?.choices?.[0]?.message?.content as string | undefined)?.trim() ?? "";
      return { improved };
    };

    // 1) Tenta Anthropic primeiro (se houver chave)
    const { data: keyRow } = await supabase
      .from("ai_api_keys")
      .select("api_key")
      .eq("provider", "anthropic")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (keyRow?.api_key) {
      const aiRes = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": keyRow.api_key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          system: systemPrompt,
          max_tokens: 4096,
          messages: [{ role: "user", content: text }],
        }),
      });

      if (aiRes.ok) {
        const data = await aiRes.json();
        const improved =
          data?.content
            ?.filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("\n")
            .trim() ?? "";
        return new Response(JSON.stringify({ improved }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Anthropic falhou — log e decide se faz fallback
      const errText = await aiRes.text();
      console.error("Anthropic error:", aiRes.status, errText);
      const shouldFallback =
        aiRes.status === 401 ||
        aiRes.status === 402 ||
        aiRes.status === 429 ||
        /credit|balance|billing|quota/i.test(errText);

      if (!shouldFallback) {
        return new Response(JSON.stringify({ error: `Erro Anthropic ${aiRes.status}` }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      console.warn("Anthropic indisponível, usando fallback Lovable AI Gateway…");
    } else {
      console.log("Sem chave Anthropic ativa, usando Lovable AI Gateway diretamente.");
    }

    // 2) Fallback / padrão: Lovable AI Gateway
    const result = await callLovableGateway();
    if (result.error) {
      return new Response(JSON.stringify({ error: result.error }), {
        status: result.status ?? 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ improved: result.improved ?? "" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("gt-ai-improve error:", e);
    return new Response(JSON.stringify({ error: e.message || "Erro desconhecido" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
