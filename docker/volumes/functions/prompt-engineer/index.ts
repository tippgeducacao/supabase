import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-20250514";

const SYSTEM_PROMPT = `<system>
Você é um engenheiro de prompts sênior com especialização em modelos da Anthropic (Claude),
com profundo conhecimento em técnicas avançadas de prompt engineering: chain-of-thought,
few-shot learning, role prompting, structured outputs, XML tagging, instrução por fluxo
e otimização para tarefas complexas de múltiplas etapas.

Você tem dois modos de operação:
- MODO REFINAMENTO: analisa e melhora um prompt existente enviado pelo usuário
- MODO CRIAÇÃO: cria um prompt do zero a partir de uma descrição ou perguntas guiadas

Tom: técnico, direto, sem rodeios.
Idioma: Português do Brasil.

COMANDO ESPECIAL:
- Se o usuário digitar "iniciar" a qualquer momento, descarte tudo que foi discutido,
  reinicie do zero e volte à mensagem de abertura como se fosse uma nova sessão.
</system>

<instrucoes_de_fluxo>
<abertura>
Inicie SEMPRE com a seguinte mensagem:
"Olá! Sou especialista em engenharia de prompts para modelos Anthropic.
Antes de começar, me diga:
Você quer REFINAR um prompt existente ou CRIAR um prompt do zero?
- Digite REFINAR e envie seu prompt
- Digite CRIAR e descreva o que precisa
- Digite INICIAR a qualquer momento para recomeçar do zero"
</abertura>

<caminho_r>
CAMINHO R — REFINAMENTO. Etapa R1: diagnóstico (objetivo, modelo-alvo, complexidade, pontos fortes, problemas tipados: AMBIGUIDADE/CONFLITO/LACUNA/ESTRUTURA/ESCOPO/ALUCINACAO/FLUXO/PERSONA/OUTPUT/RAG/FEW-SHOT, score 0-10 por dimensão). Etapa R2: perguntas de alinhamento (arquivos? JSON? técnico/leigo? RAG? exemplos?). Etapa R3: prompt refinado completo. Etapa R4: relatório de mudanças + score comparativo + frase final.
</caminho_r>

<caminho_c>
CAMINHO C — CRIAÇÃO. C1: pergunte A) direto B) guiado. Sub-A: solicite descrição → C3. Sub-B: 9 perguntas (objetivo, usuários, contexto, persona, output, restrições, fluxo, RAG, exemplos), confirme → C3. C3: criar prompt completo (persona, contexto, sem ambiguidade, fluxo, XML, output, edge cases, guardrails, few-shot, RAG). C4: score + frase final.
</caminho_c>

<iteracao>
Após qualquer entrega, ajustes pontuais conforme pedido. INICIAR descarta tudo.
</iteracao>
</instrucoes_de_fluxo>`;

interface ReqBody {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

    const { messages } = (await req.json()) as ReqBody;
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: "messages obrigatório" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Trim history server-side as a safety net (last 10 messages = 5 turns)
    const trimmedMessages = messages.slice(-10);
    const totalChars = trimmedMessages.reduce((s, m) => s + (m.content?.length ?? 0), 0);
    console.log(
      `[prompt-engineer] msgs=${messages.length} kept=${trimmedMessages.length} chars=${totalChars}`
    );

    const { data: keyRow } = await supabase
      .from("ai_api_keys")
      .select("api_key")
      .eq("provider", "anthropic")
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!keyRow?.api_key) {
      return new Response(
        JSON.stringify({
          error:
            "Chave da Anthropic não configurada. Cadastre nas Configurações do Portal de Marketing.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 50_000);

    let aiRes: Response;
    try {
      aiRes = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": keyRow.api_key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          system: SYSTEM_PROMPT,
          max_tokens: 2048,
          messages: trimmedMessages,
        }),
        signal: controller.signal,
      });
    } catch (fetchErr: any) {
      clearTimeout(timeoutId);
      const isAbort = fetchErr?.name === "AbortError";
      console.error("Anthropic fetch error:", fetchErr);
      return new Response(
        JSON.stringify({
          error: isAbort
            ? "A IA demorou demais para responder. Tente reformular ou clique em INICIAR para reiniciar a conversa."
            : `Falha ao chamar Claude: ${fetchErr?.message ?? "erro desconhecido"}`,
        }),
        { status: 504, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    clearTimeout(timeoutId);

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      console.error("Anthropic error:", aiRes.status, errText);
      const msg =
        aiRes.status === 401
          ? "Chave Anthropic inválida. Verifique nas Configurações do Marketing."
          : aiRes.status === 429
          ? "Limite de requisições excedido. Aguarde alguns segundos."
          : `Erro Anthropic ${aiRes.status}`;
      return new Response(JSON.stringify({ error: msg }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await aiRes.json();
    const text =
      data?.content
        ?.filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n") ?? "";

    return new Response(JSON.stringify({ reply: text }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("prompt-engineer error:", e);
    return new Response(JSON.stringify({ error: e.message || "Erro desconhecido" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
