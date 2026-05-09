import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { channel, description, answers, textForSpace, textPosition } = await req.json();

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      return new Response(JSON.stringify({ error: "LOVABLE_API_KEY not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let systemPrompt = "";

    if (channel === "image") {
      systemPrompt = `You are an expert prompt engineer for AI image generation (Google Gemini / Nano Banana Pro / Flux).
Your goal is to create a highly detailed, efficient prompt in English.

CRITICAL RULES:
- Write ALWAYS in English
- Use this exact formula structure: [Style] of [Subject], [action/pose], in [setting/background], [lighting], [color palette/mood], [composition/angle], [technical specs]
- The model does NOT support negative prompts. If the user mentions things to avoid, CONVERT them into positive language in the main prompt. Example: "avoid text" → "clean image without any overlapping text or typography"
- Be specific, no ambiguity
- 50-150 words
- Return ONLY the final prompt, no explanations
- Include camera angle, depth of field, resolution details
${textForSpace ? `- Include clear empty space on the ${textPosition === "esquerda" ? "left" : textPosition === "direita" ? "right" : textPosition === "topo" ? "top" : "bottom"} side for text overlay placement` : ""}`;
    } else if (channel === "video") {
      systemPrompt = `You are an expert prompt engineer for AI video generation (Google Veo 3.1).
Your goal is to create a highly detailed, efficient prompt in English for short video generation.

CRITICAL RULES:
- Write ALWAYS in English
- Describe scene with clear movement and action
- Specify camera movements (pan, zoom, tracking shot, etc.)
- Include lighting, atmosphere, and visual style
- The video will be 8 seconds long, so keep the action scope concise
- If the user mentions things to avoid, CONVERT them into positive language
- 50-150 words
- Return ONLY the final prompt, no explanations`;
    } else if (channel === "caption") {
      systemPrompt = `You are an expert prompt engineer for AI caption/copywriting generation (Claude).
Your goal is to create a structured briefing in Portuguese for generating the perfect Instagram caption.

CRITICAL RULES:
- Write in Portuguese (Brazilian)
- Include: objective, tone of voice, target audience, CTA type, hashtag count suggestion
- Describe the product/service/context clearly
- Make it a clear, structured briefing
- Return ONLY the final briefing/prompt, no explanations`;
    }

    // Build user message from description + structured answers
    let userMessage = `Content type: ${channel === "image" ? "IMAGE" : channel === "video" ? "VIDEO" : "CAPTION"}\n\n`;
    userMessage += `User description: ${description}\n\n`;

    if (answers && Object.keys(answers).length > 0) {
      userMessage += "Visual direction answers:\n";
      
      const labelMap: Record<string, string> = {
        style: "Visual style",
        lighting: "Lighting",
        angle: "Camera angle",
        colors: "Color palette",
        colorPicker: "Selected color (hex)",
        mood: "Mood/atmosphere",
        elements: "Required elements",
        avoid: "Things to avoid (convert to positive language)",
        scene_type: "Scene type",
        movement: "Camera movement",
        scene: "Scene description",
        format: "Format",
        objective: "Post objective",
        product: "Product/service",
        audience: "Target audience",
        tone: "Tone of voice",
        cta: "Call to action",
        context: "Additional context",
      };

      for (const [key, value] of Object.entries(answers)) {
        if (value && key !== "colorPicker") {
          const label = labelMap[key] || key;
          userMessage += `- ${label}: ${value}\n`;
        }
      }

      if (answers.colorPicker && answers.colorPicker !== "#6366f1") {
        userMessage += `- Accent color reference: ${answers.colorPicker}\n`;
      }
    }

    if (channel === "image" && textForSpace) {
      userMessage += `\nIMPORTANT: Leave clear empty space on the ${textPosition} side of the image for text overlay.\n`;
    }

    userMessage += "\n\nNow generate the optimized prompt ready to use. Return ONLY the prompt, no additional explanations.";

    const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
      }),
    });

    if (!aiRes.ok) {
      if (aiRes.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit excedido. Tente novamente em alguns segundos." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiRes.status === 402) {
        return new Response(JSON.stringify({ error: "Créditos esgotados. Adicione créditos no workspace." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const errText = await aiRes.text();
      throw new Error(`AI error ${aiRes.status}: ${errText}`);
    }

    const result = await aiRes.json();
    const generatedPrompt = result.choices?.[0]?.message?.content || "";

    return new Response(JSON.stringify({ prompt: generatedPrompt.trim() }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("generate-prompt error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
