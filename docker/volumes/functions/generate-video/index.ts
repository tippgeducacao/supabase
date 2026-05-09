import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const { user_id, prompt, brand_profile_id, source_type, source_post_id, aspect_ratio, operator_name } = await req.json();
    if (!user_id || !prompt) {
      return new Response(JSON.stringify({ error: "user_id and prompt are required" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Fetch user's Google API key (same key for all Google services)
    const { data: keyRow } = await supabase
      .from("ai_api_keys").select("api_key")
      .eq("provider", "google").eq("is_active", true).limit(1).maybeSingle();

    if (!keyRow) {
      return new Response(JSON.stringify({ error: "Google API Key não configurada. Vá em Configurações > Chaves de API IA." }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Enrich prompt
    let enrichedPrompt = prompt;
    if (brand_profile_id) {
      const { data: bp } = await supabase.from("brand_profiles").select("*").eq("id", brand_profile_id).maybeSingle();
      if (bp) {
        const extras: string[] = [];
        if (bp.tom_de_voz) extras.push(`Style/tone: ${bp.tom_de_voz}`);
        if (bp.estrutura_visual) extras.push(`Visual guidelines: ${bp.estrutura_visual}`);
        if (bp.alertas_nao_usar) extras.push(`Avoid: ${bp.alertas_nao_usar}`);
        if (extras.length) enrichedPrompt = `${prompt}\n\n${extras.join("\n")}`;
      }
    }

    // Create generation record
    const startTime = Date.now();
    const { data: gen, error: genErr } = await supabase.from("ai_generations").insert({
      user_id,
      brand_profile_id: brand_profile_id || null,
      generation_type: "video",
      source_type: source_type || "manual",
      source_post_id: source_post_id || null,
      prompt_used: enrichedPrompt,
      model_used: "veo-3.1-generate-preview",
      provider: "google",
      input_params: { aspect_ratio: aspect_ratio || "9:16" },
      status: "processing",
      operator_name: operator_name || null,
    }).select("id").single();

    if (genErr || !gen) {
      return new Response(JSON.stringify({ error: "Failed to create generation record" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const generationId = gen.id;

    try {
      // Call Veo predictLongRunning (async API)
      const veoRes = await fetch(
        `${BASE_URL}/models/veo-3.1-generate-preview:predictLongRunning`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": keyRow.api_key,
          },
          body: JSON.stringify({
            instances: [{ prompt: enrichedPrompt }],
            parameters: {
              aspectRatio: aspect_ratio || "9:16",
            },
          }),
        }
      );

      if (!veoRes.ok) {
        const errText = await veoRes.text();
        if (veoRes.status === 429) throw new Error("Rate limit exceeded. Tente novamente em alguns segundos.");
        if (veoRes.status === 403) throw new Error("API key sem permissão. Verifique se a Generative Language API está ativada no Google Cloud Console.");
        throw new Error(`Veo API error ${veoRes.status}: ${errText}`);
      }

      const operation = await veoRes.json();
      const operationName = operation.name;

      if (!operationName) {
        throw new Error("Veo API did not return an operation name");
      }

      // Poll for completion (max ~4 minutes to stay within edge function limits)
      let videoUrl: string | null = null;
      const maxPolls = 48; // 48 * 5s = 240s = 4min
      for (let i = 0; i < maxPolls; i++) {
        await new Promise((r) => setTimeout(r, 5000));

        const pollRes = await fetch(`${BASE_URL}/${operationName}`, {
          headers: { "x-goog-api-key": keyRow.api_key },
        });

        if (!pollRes.ok) {
          const pollErr = await pollRes.text();
          throw new Error(`Poll error ${pollRes.status}: ${pollErr}`);
        }

        const pollData = await pollRes.json();

        if (pollData.done) {
          // Extract video URI
          const samples = pollData.response?.generateVideoResponse?.generatedSamples;
          if (samples && samples.length > 0 && samples[0].video?.uri) {
            videoUrl = samples[0].video.uri;
          }
          break;
        }
      }

      if (!videoUrl) {
        throw new Error("Tempo limite excedido ou vídeo não gerado. Tente novamente.");
      }

      // Download video from Google (requires API key) and upload to Supabase Storage
      let publicUrl = videoUrl;
      try {
        const videoRes = await fetch(videoUrl, {
          headers: { "x-goog-api-key": keyRow.api_key },
        });
        if (videoRes.ok) {
          const videoBlob = await videoRes.blob();
          const fileName = `generated-videos/${user_id}/${generationId}.mp4`;
          const { error: uploadErr } = await supabase.storage
            .from("ig-media")
            .upload(fileName, videoBlob, { contentType: "video/mp4", upsert: true });
          if (!uploadErr) {
            const { data: urlData } = supabase.storage.from("ig-media").getPublicUrl(fileName);
            if (urlData?.publicUrl) publicUrl = urlData.publicUrl;
          }
        }
      } catch (dlErr) {
        console.error("Failed to download/upload video to storage:", dlErr);
      }

      const elapsedSec = Math.round((Date.now() - startTime) / 1000);
      const costUsd = 0.10;

      await supabase.from("ai_generations").update({
        output_url: publicUrl,
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
          videos_generated: (existing.videos_generated || 0) + 1,
          total_cost_usd: (existing.total_cost_usd || 0) + costUsd,
          total_cost_brl: (existing.total_cost_brl || 0) + costUsd * 5.5,
        }).eq("id", existing.id);
      } else {
        await supabase.from("ai_cost_tracking").insert({
          user_id, month: monthStr, provider: "google",
          model: "veo-3.1-generate-preview", total_generations: 1, videos_generated: 1,
          total_cost_usd: costUsd, total_cost_brl: costUsd * 5.5,
        });
      }

      return new Response(JSON.stringify({ success: true, generation_id: generationId, video_url: publicUrl }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (apiError) {
      const msg = apiError instanceof Error ? apiError.message : "Unknown API error";
      await supabase.from("ai_generations").update({ status: "failed", error_message: msg }).eq("id", generationId);
      return new Response(JSON.stringify({ error: msg }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
  } catch (e) {
    console.error("generate-video error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
