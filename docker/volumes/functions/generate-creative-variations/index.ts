import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const VARIATION_PROMPTS = [
  "Create a variation of this ad creative with a different color palette. Keep the same composition, elements, and text layout, but change the primary and accent colors to create a fresh look. Maintain brand professionalism.",
  "Create a variation of this ad creative with a reorganized layout. Move key visual elements to different positions, try a different text placement, but keep the same overall message and visual style.",
  "Create a variation of this ad creative using a warm color palette (golds, oranges, deep reds). Replace the primary and accent colors with these warm tones while keeping the exact same layout, text, images, and composition. Do not change any visual elements or style — only swap the colors.",
];

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { user_id, creative_id, brand_profile_id } = await req.json();

    if (!user_id || !creative_id) {
      return new Response(JSON.stringify({ error: "user_id and creative_id are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      return new Response(JSON.stringify({ error: "LOVABLE_API_KEY not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseKey);

    // Fetch creative data
    const { data: creative, error: crErr } = await sb
      .from("meta_creatives")
      .select("*")
      .eq("id", creative_id)
      .single();

    if (crErr || !creative) {
      return new Response(JSON.stringify({ error: "Creative not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!creative.thumbnail_url) {
      return new Response(JSON.stringify({ error: "Creative has no thumbnail image" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`Generating 3 variations for creative: ${creative.ad_name}`);

    const variations: any[] = [];

    for (let i = 0; i < 3; i++) {
      try {
        console.log(`Generating variation ${i + 1}...`);

        const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${LOVABLE_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash-image",
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: VARIATION_PROMPTS[i] },
                  {
                    type: "image_url",
                    image_url: { url: creative.thumbnail_url },
                  },
                ],
              },
            ],
            modalities: ["image", "text"],
          }),
        });

        if (!response.ok) {
          const errText = await response.text();
          console.error(`AI gateway error for variation ${i + 1}:`, response.status, errText);

          if (response.status === 429) {
            return new Response(JSON.stringify({ error: "Rate limit exceeded. Try again in a few minutes." }), {
              status: 429,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
          if (response.status === 402) {
            return new Response(JSON.stringify({ error: "AI credits exhausted. Add funds in Settings > Workspace > Usage." }), {
              status: 402,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
          continue;
        }

        const data = await response.json();
        const imageUrl = data.choices?.[0]?.message?.images?.[0]?.image_url?.url;

        if (imageUrl) {
          variations.push({
            user_id,
            brand_profile_id: brand_profile_id || null,
            original_creative_id: creative_id,
            original_image_url: creative.thumbnail_url,
            original_caption: creative.body || creative.title || null,
            original_post_type: "paid",
            original_metrics: {
              ad_name: creative.ad_name,
              spend: creative.spend,
              impressions: creative.impressions,
              ctr: creative.ctr,
              cpc: creative.cpc,
              conversions: creative.conversions,
            },
            generated_image_url: imageUrl,
            generated_caption: creative.body || null,
            variation_number: i + 1,
            status: "draft",
          });
        }
      } catch (err) {
        console.error(`Error generating variation ${i + 1}:`, err);
      }
    }

    if (variations.length === 0) {
      return new Response(JSON.stringify({ error: "Failed to generate any variations" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Insert variations
    const { error: insertErr } = await sb.from("content_variations").insert(variations);
    if (insertErr) {
      console.error("Insert error:", insertErr);
      return new Response(JSON.stringify({ error: "Failed to save variations" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Track cost
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    await sb.from("ai_cost_tracking").upsert(
      {
        user_id,
        provider: "google",
        model: "gemini-2.5-flash-image",
        month,
        variations_generated: variations.length,
        total_generations: variations.length,
        images_generated: variations.length,
      },
      { onConflict: "user_id,provider,month" }
    ).then(() => console.log("Cost tracked"));

    console.log(`Successfully generated ${variations.length} variations`);

    return new Response(JSON.stringify({ success: true, count: variations.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("generate-creative-variations error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
