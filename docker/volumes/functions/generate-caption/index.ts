import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const { user_id, brand_profile_id, context, tom_de_voz, post_type, original_caption, image_description, reference_images, operator_name } = await req.json();
    if (!user_id) {
      return new Response(JSON.stringify({ error: "user_id is required" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 1. Fetch API key
    const { data: keyRow } = await supabase
      .from("ai_api_keys").select("api_key")
      .eq("provider", "anthropic").eq("is_active", true).limit(1).maybeSingle();

    if (!keyRow) {
      return new Response(JSON.stringify({ error: "Anthropic API key not configured" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 2. Fetch brand profile (optional)
    let bp: any = null;
    if (brand_profile_id) {
      const { data } = await supabase.from("brand_profiles").select("*").eq("id", brand_profile_id).maybeSingle();
      bp = data;
    }

    // 3. Build system prompt
    const tomFinal = tom_de_voz || bp?.tom_de_voz || "Direto e Forte";
    const systemPrompt = `Você é um copywriter especialista em redes sociais com foco em conteúdo TÉCNICO e APLICÁVEL. Gere uma legenda para Instagram seguindo RIGOROSAMENTE estas diretrizes:

TOM DE VOZ: ${tomFinal}
${bp?.tom_descricao ? `DESCRIÇÃO DO TOM: ${bp.tom_descricao}` : ""}

${bp?.vocabulario_chave ? `VOCABULÁRIO E PALAVRAS-CHAVE: ${bp.vocabulario_chave}` : ""}
${bp?.metaforas_estrategicas ? `METÁFORAS ESTRATÉGICAS: ${bp.metaforas_estrategicas}` : ""}

${bp?.estrutura_visual ? `ESTRUTURA VISUAL:\n${bp.estrutura_visual}` : ""}

${bp?.alertas_nao_usar ? `ALERTAS - NÃO UTILIZAR DE FORMA ALGUMA:\n${bp.alertas_nao_usar}` : ""}

${bp?.frases_exemplo ? `EXEMPLOS DE FRASES QUE REPRESENTAM O TOM:\n${bp.frases_exemplo}` : ""}

${bp ? `PERSONA DO PÚBLICO:
- Dores: ${bp.persona_dores || ""}
- Objeções: ${bp.persona_objecoes || ""}
- Desejos: ${bp.persona_desejos || ""}` : ""}

=== REGRAS OBRIGATÓRIAS DA LEGENDA ===

1. **CTA (Call to Action)**: A legenda DEVE terminar com um CTA claro e direto, convidando o leitor a agir (comentar, salvar, compartilhar, clicar no link, etc.).

2. **5 HASHTAGS PRINCIPAIS**: Ao final da legenda, inclua exatamente 5 hashtags altamente relevantes para o assunto abordado. Escolha hashtags que o público-alvo realmente pesquisa.

3. **TOM TÉCNICO E PRÁTICO**: A legenda deve ser técnica, com informações aplicáveis na prática. O leitor precisa conseguir implementar o que está sendo dito. Dê passos, dados concretos, exemplos reais ou instruções claras.

4. **CONEXÃO COM O PÚBLICO**: Crie identificação com quem lê. Use linguagem que mostra que você entende a realidade do público. Fale DE IGUAL PARA IGUAL.

5. **PROIBIDO**:
   - NÃO use tom de coach (frases motivacionais vazias, "acredite em você", "mindset", etc.)
   - NÃO use tom consultivo/corporativo distante ("nossa empresa oferece", "entre em contato para saber mais")
   - NÃO use clichês genéricos ou frases que poderiam servir para qualquer nicho
   - NÃO seja vago — toda frase deve agregar valor real

Gere APENAS a legenda, sem explicações adicionais. A legenda deve estar pronta para ser usada diretamente no Instagram.`;

    // 4. Build user message
    const userParts: string[] = [];
    if (context) userParts.push(`Contexto do post: ${context}`);
    if (post_type) userParts.push(`Tipo de post: ${post_type}`);
    if (image_description) userParts.push(`Descrição da imagem/vídeo: ${image_description}`);
    if (original_caption) userParts.push(`Legenda original para referência: ${original_caption}`);
    const userMessage = userParts.length ? userParts.join("\n\n") : "Gere uma legenda criativa para um post de Instagram.";

    // Build Claude messages with optional image references
    const contentBlocks: any[] = [];
    if (reference_images && Array.isArray(reference_images)) {
      for (const dataUrl of reference_images) {
        const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
        if (match) {
          contentBlocks.push({
            type: "image",
            source: { type: "base64", media_type: match[1], data: match[2] },
          });
        }
      }
    }
    contentBlocks.push({ type: "text", text: userMessage });

    // 5. Create generation record
    const startTime = Date.now();
    const { data: gen, error: genErr } = await supabase.from("ai_generations").insert({
      user_id,
      brand_profile_id: brand_profile_id || null,
      generation_type: "caption",
      source_type: original_caption ? "organic" : "manual",
      prompt_used: userMessage,
      tom_de_voz_usado: tomFinal,
      model_used: "claude-sonnet-4-20250514",
      provider: "anthropic",
      status: "processing",
      operator_name: operator_name || null,
    }).select("id").single();

    if (genErr || !gen) {
      return new Response(JSON.stringify({ error: "Failed to create generation record" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const generationId = gen.id;

    try {
      // 6. Call Claude API
      const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": keyRow.api_key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: "user", content: contentBlocks }],
        }),
      });

      if (!claudeRes.ok) {
        const errText = await claudeRes.text();
        throw new Error(`Claude API error ${claudeRes.status}: ${errText}`);
      }

      const result = await claudeRes.json();
      const caption = result?.content?.[0]?.text || "";
      const elapsedSec = Math.round((Date.now() - startTime) / 1000);

      const inputTokens = result?.usage?.input_tokens || 500;
      const outputTokens = result?.usage?.output_tokens || 200;
      const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

      // 7. Update generation
      await supabase.from("ai_generations").update({
        caption_generated: caption,
        status: "completed",
        cost_usd: costUsd,
        cost_brl: costUsd * 5.5,
        generation_time_seconds: elapsedSec,
        completed_at: new Date().toISOString(),
      }).eq("id", generationId);

      // 8. Upsert cost tracking
      const monthStr = new Date().toISOString().slice(0, 7) + "-01";
      const { data: existing } = await supabase.from("ai_cost_tracking")
        .select("*").eq("user_id", user_id).eq("month", monthStr).eq("provider", "anthropic").maybeSingle();

      if (existing) {
        await supabase.from("ai_cost_tracking").update({
          total_generations: (existing.total_generations || 0) + 1,
          captions_generated: (existing.captions_generated || 0) + 1,
          total_cost_usd: (existing.total_cost_usd || 0) + costUsd,
          total_cost_brl: (existing.total_cost_brl || 0) + costUsd * 5.5,
        }).eq("id", existing.id);
      } else {
        await supabase.from("ai_cost_tracking").insert({
          user_id, month: monthStr, provider: "anthropic",
          model: "claude-sonnet-4-20250514", total_generations: 1, captions_generated: 1,
          total_cost_usd: costUsd, total_cost_brl: costUsd * 5.5,
        });
      }

      return new Response(JSON.stringify({ success: true, generation_id: generationId, caption }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (apiError) {
      const msg = apiError instanceof Error ? apiError.message : "Unknown API error";
      await supabase.from("ai_generations").update({ status: "failed", error_message: msg }).eq("id", generationId);
      return new Response(JSON.stringify({ error: msg }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
  } catch (e) {
    console.error("generate-caption error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
