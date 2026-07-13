import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { resolverImagemCriativo, bytesParaDataUrl } from "../_shared/metaCreativeImage.ts";

// Gera (ou edita) UMA variação de um criativo do Meta Ads com a API do Google
// (Gemini 2.5 Flash Image — a MESMA chave do sistema em ai_api_keys provider=google,
// como o generate-image). 1 imagem por chamada de propósito: o front dispara N vezes
// (concorrência baixa) e vê o progresso ao vivo, sem morrer no wall-clock do worker.
// Fonte da imagem: resolvida FRESCA na Meta (gerar) ou a própria variação (editar).
// Persiste em content_variations + bucket público mkt-criativos-ia. NÃO pontua.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
const getErr = (e: unknown) => (e instanceof Error ? e.message : String(e));
const BUCKET = "mkt-criativos-ia";

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function extDe(ct: string): string {
  if (ct.includes("png")) return "png";
  if (ct.includes("webp")) return "webp";
  return "jpg";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Gate "logado": o user_id vem SEMPRE do JWT (nunca do body — senão IDOR:
    // um usuário poderia editar variação alheia / injetar linhas em outro user_id).
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const { data: userData } = jwt ? await sb.auth.getUser(jwt) : { data: { user: null } };
    const user_id = userData?.user?.id;
    if (!user_id) {
      return new Response(JSON.stringify({ error: "Não autenticado." }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const {
      creative_id, variation_number, prompt,
      brand_profile_id, edit_variation_id, edit_instruction,
      ad_name, original_caption, original_metrics,
    } = body || {};

    const editando = !!edit_variation_id;
    if (!editando && !creative_id) {
      return new Response(JSON.stringify({ error: "creative_id é obrigatório" }), {
        status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Chave Google do sistema (Configurações > Chaves de API IA)
    const { data: keyRow } = await sb.from("ai_api_keys")
      .select("api_key").eq("provider", "google").eq("is_active", true).limit(1).maybeSingle();
    if (!keyRow?.api_key) {
      return new Response(JSON.stringify({ error: "Chave da API do Google não configurada (Configurações > Chaves de API IA)." }), {
        status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---- Fonte da imagem ----
    let srcMime = "image/jpeg";
    let srcB64: string | null = null;
    let originalUrl: string | null = null;
    let cid: string | null = creative_id || null;

    if (editando) {
      const { data: v } = await sb.from("content_variations")
        .select("id, user_id, generated_image_url, original_creative_id, original_image_url, variation_number")
        .eq("id", edit_variation_id).maybeSingle();
      if (!v || v.user_id !== user_id) {
        return new Response(JSON.stringify({ error: "Variação não encontrada." }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      cid = v.original_creative_id;
      originalUrl = v.original_image_url;
      const r = await fetch(v.generated_image_url);
      if (!r.ok) throw new Error("Não consegui carregar a variação atual para editar.");
      srcMime = r.headers.get("content-type") || "image/png";
      srcB64 = bytesParaDataUrl({ bytes: new Uint8Array(await r.arrayBuffer()), contentType: srcMime, urlUsada: "" }).split(",")[1];
    } else {
      const img = await resolverImagemCriativo(sb, creative_id);
      if (!img) {
        return new Response(JSON.stringify({ error: "Sem imagem base para este criativo (não foi possível resolver na Meta)." }), {
          status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      srcMime = img.contentType;
      srcB64 = bytesParaDataUrl(img).split(",")[1];
      // sobe a imagem base uma vez (caminho estável, idempotente) p/ referência durável
      try {
        const ext = extDe(img.contentType);
        const path = `variacoes/${creative_id}/_original.${ext}`;
        await sb.storage.from(BUCKET).upload(path, img.bytes, { contentType: img.contentType, upsert: true });
        originalUrl = sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
      } catch { /* referência é best-effort */ }
    }

    // ---- Prompt ----
    let instrucao: string;
    if (editando) {
      instrucao =
        `You are editing an existing ad creative image. Apply ONLY the following change, keeping everything else ` +
        `(layout, other elements, text, brand style) intact and keeping it a polished, high-quality advertising creative:\n` +
        `${edit_instruction || "improve the visual quality"}`;
    } else {
      instrucao = prompt ||
        "Create a fresh variation of this ad creative keeping the brand style and message, with a new visual treatment.";
    }
    // enriquecimento por perfil de marca (opcional)
    if (brand_profile_id) {
      const { data: bp } = await sb.from("brand_profiles").select("*").eq("id", brand_profile_id).maybeSingle();
      if (bp) {
        const extras: string[] = [];
        if (bp.tom_de_voz) extras.push(`Tone: ${bp.tom_de_voz}`);
        if (bp.estrutura_visual) extras.push(`Visual guidelines: ${bp.estrutura_visual}`);
        if (bp.alertas_nao_usar) extras.push(`Avoid: ${bp.alertas_nao_usar}`);
        if (extras.length) instrucao += `\n\n${extras.join("\n")}`;
      }
    }
    instrucao += "\n\nKeep any text legible and correctly spelled in Brazilian Portuguese. Output a single high-resolution image.";

    // ---- Google Gemini (imagem) ----
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${keyRow.api_key}`;
    const aiRes = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: instrucao }, { inline_data: { mime_type: srcMime, data: srcB64 } }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      }),
    });
    if (!aiRes.ok) {
      const t = await aiRes.text();
      if (aiRes.status === 429) throw new Error("Limite de uso da API do Google atingido. Tente em alguns segundos.");
      if (aiRes.status === 403) throw new Error("Chave do Google sem permissão. Ative a Generative Language API no Google Cloud.");
      throw new Error(`Google API ${aiRes.status}: ${t.slice(0, 300)}`);
    }
    const result = await aiRes.json();
    let outMime = "image/png";
    let outB64: string | null = null;
    for (const part of result?.candidates?.[0]?.content?.parts || []) {
      const inl = part.inlineData || part.inline_data;
      if (inl?.data) { outMime = inl.mimeType || inl.mime_type || "image/png"; outB64 = inl.data; break; }
    }
    if (!outB64) throw new Error("A IA não devolveu imagem. Tente novamente.");

    // ---- Upload da variação ----
    const ext = extDe(outMime);
    const path = `variacoes/${cid || "avulso"}/${crypto.randomUUID()}.${ext}`;
    const { error: upErr } = await sb.storage.from(BUCKET).upload(path, b64ToBytes(outB64), { contentType: outMime, upsert: true });
    if (upErr) throw new Error(`Falha ao salvar a imagem: ${upErr.message}`);
    const publicUrl = sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;

    // ---- Persiste em content_variations ----
    let row;
    if (editando) {
      const { data, error } = await sb.from("content_variations")
        .update({ generated_image_url: publicUrl, variation_prompt: edit_instruction || null, status: "draft" })
        .eq("id", edit_variation_id).eq("user_id", user_id).select("*").single();
      if (error) throw new Error(`Falha ao atualizar variação: ${error.message}`);
      row = data;
    } else {
      const { data, error } = await sb.from("content_variations").insert({
        user_id,
        brand_profile_id: brand_profile_id || null,
        original_creative_id: creative_id,
        original_image_url: originalUrl,
        original_caption: original_caption || null,
        original_post_type: "paid",
        original_metrics: original_metrics || (ad_name ? { ad_name } : null),
        generated_image_url: publicUrl,
        generated_caption: original_caption || null,
        variation_number: variation_number || 1,
        variation_prompt: prompt || null,
        status: "draft",
      }).select("*").single();
      if (error) throw new Error(`Falha ao salvar variação: ${error.message}`);
      row = data;
    }

    // Custo (paridade com generate-image / generate-creative-variations)
    try {
      const month = new Date().toISOString().slice(0, 7);
      await sb.from("ai_cost_tracking").upsert(
        { user_id, provider: "google", model: "gemini-2.5-flash-image", month,
          total_generations: 1, images_generated: 1, variations_generated: 1 },
        { onConflict: "user_id,provider,month" },
      );
    } catch { /* custo é best-effort */ }

    return new Response(JSON.stringify({ success: true, variation: row }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: getErr(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
