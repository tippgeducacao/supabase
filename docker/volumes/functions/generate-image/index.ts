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
    const { user_id, prompt, negative_prompt, brand_profile_id, source_type, source_post_id, tom_de_voz, reference_images, operator_name } = await req.json();
    if (!user_id || !prompt) {
      return new Response(JSON.stringify({ error: "user_id and prompt are required" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Fetch user's Google API key
    const { data: keyRow, error: keyErr } = await supabase
      .from("ai_api_keys")
      .select("api_key")
      .eq("provider", "google")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (keyErr || !keyRow) {
      return new Response(JSON.stringify({ error: "Google API Key não configurada. Vá em Configurações > Chaves de API IA." }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Enrich prompt with brand profile
    let enrichedPrompt = prompt;
    if (brand_profile_id) {
      const { data: bp } = await supabase.from("brand_profiles").select("*").eq("id", brand_profile_id).maybeSingle();
      if (bp) {
        const extras: string[] = [];
        if (tom_de_voz || bp.tom_de_voz) extras.push(`Style/tone: ${tom_de_voz || bp.tom_de_voz}`);
        if (bp.estrutura_visual) extras.push(`Visual guidelines: ${bp.estrutura_visual}`);
        if (bp.alertas_nao_usar) extras.push(`Avoid: ${bp.alertas_nao_usar}`);
        if (extras.length) enrichedPrompt = `${prompt}\n\n${extras.join("\n")}`;
      }
    }

    if (negative_prompt) {
      enrichedPrompt += `\n\nDo NOT include: ${negative_prompt}`;
    }

    // Force high-resolution PNG output
    enrichedPrompt += `\n\nOutput requirements: ultra high resolution, sharp details, professional quality, 2048x2048 minimum, PNG format, lossless, no compression artifacts, crisp edges.`;

    // Create generation record
    const startTime = Date.now();
    const { data: gen, error: genErr } = await supabase.from("ai_generations").insert({
      user_id,
      brand_profile_id: brand_profile_id || null,
      generation_type: "image",
      source_type: source_type || "manual",
      source_post_id: source_post_id || null,
      prompt_used: enrichedPrompt,
      negative_prompt: negative_prompt || null,
      tom_de_voz_usado: tom_de_voz || null,
      model_used: "gemini-2.5-flash-image",
      provider: "google",
      status: "processing",
      operator_name: operator_name || null,
    }).select("id").single();

    if (genErr || !gen) {
      console.error("Insert generation error:", genErr);
      return new Response(JSON.stringify({ error: "Failed to create generation record" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const generationId = gen.id;

    try {
      // Build request parts for Gemini API
      const parts: any[] = [{ text: enrichedPrompt }];

      // Add reference images if provided
      if (reference_images && Array.isArray(reference_images)) {
        for (const imgDataUrl of reference_images) {
          if (imgDataUrl && typeof imgDataUrl === "string" && imgDataUrl.startsWith("data:")) {
            const match = imgDataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
            if (match) {
              parts.push({
                inline_data: {
                  mime_type: match[1],
                  data: match[2],
                },
              });
            }
          }
        }
      }

      // Call Google Gemini API directly
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${keyRow.api_key}`;

      const aiRes = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
          },
        }),
      });

      if (!aiRes.ok) {
        const errText = await aiRes.text();
        if (aiRes.status === 429) throw new Error("Rate limit exceeded. Tente novamente em alguns segundos.");
        if (aiRes.status === 403) throw new Error("API key sem permissão. Verifique se a Generative Language API está ativada no Google Cloud Console.");
        if (aiRes.status === 400) throw new Error(`Erro na requisição: ${errText}`);
        throw new Error(`Google API error ${aiRes.status}: ${errText}`);
      }

      const result = await aiRes.json();

      // Extract image from Gemini response
      let imageUrl: string | null = null;
      const candidates = result?.candidates;
      if (candidates && candidates[0]?.content?.parts) {
        for (const part of candidates[0].content.parts) {
          if (part.inlineData || part.inline_data) {
            const inlineData = part.inlineData || part.inline_data;
            imageUrl = `data:${inlineData.mimeType || inlineData.mime_type};base64,${inlineData.data}`;
            break;
          }
        }
      }

      const elapsedSec = Math.round((Date.now() - startTime) / 1000);
      const costUsd = 0.02;

      // Update generation
      await supabase.from("ai_generations").update({
        output_url: imageUrl,
        status: "completed",
        cost_usd: costUsd,
        cost_brl: costUsd * 5.5,
        generation_time_seconds: elapsedSec,
        completed_at: new Date().toISOString(),
      }).eq("id", generationId);

      // Upsert cost tracking
      const monthStr = new Date().toISOString().slice(0, 7) + "-01";
      const { data: existing } = await supabase.from("ai_cost_tracking")
        .select("*").eq("user_id", user_id).eq("month", monthStr).eq("provider", "google").maybeSingle();

      if (existing) {
        await supabase.from("ai_cost_tracking").update({
          total_generations: (existing.total_generations || 0) + 1,
          images_generated: (existing.images_generated || 0) + 1,
          total_cost_usd: (existing.total_cost_usd || 0) + costUsd,
          total_cost_brl: (existing.total_cost_brl || 0) + costUsd * 5.5,
        }).eq("id", existing.id);
      } else {
        await supabase.from("ai_cost_tracking").insert({
          user_id, month: monthStr, provider: "google",
          model: "gemini-2.5-flash-image", total_generations: 1, images_generated: 1,
          total_cost_usd: costUsd, total_cost_brl: costUsd * 5.5,
        });
      }

      return new Response(JSON.stringify({ success: true, generation_id: generationId, image_url: imageUrl }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (apiError) {
      const msg = apiError instanceof Error ? apiError.message : "Unknown API error";
      await supabase.from("ai_generations").update({ status: "failed", error_message: msg }).eq("id", generationId);
      return new Response(JSON.stringify({ error: msg }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
  } catch (e) {
    console.error("generate-image error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
