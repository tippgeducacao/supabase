import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { encode as base64Encode } from "https://deno.land/std@0.168.0/encoding/base64.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Status transitórios das APIs de IA — vale a pena tentar de novo.
// 529 = Anthropic "Overloaded"; 429 = rate limit; 5xx = instabilidade momentânea.
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Host INTERNO do storage (kong) visto de dentro do container. O navegador manda a
// URL PÚBLICA (api.ppgeducacao.site); baixar do host interno evita o hairpin do
// Cloudflare (443 travada nos IPs do CF) e é o caminho confiável para o edge.
const INTERNAL_SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
function internalizeStorageUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.pathname.startsWith("/storage/v1/") && INTERNAL_SUPABASE_URL) {
      const base = new URL(INTERNAL_SUPABASE_URL);
      u.protocol = base.protocol;
      u.host = base.host;
      return u.toString();
    }
  } catch { /* URL inválida → devolve como veio */ }
  return url;
}

// media_type aceito pela Claude Vision (jpeg/png/gif/webp). Deriva do content-type e,
// na falta, da extensão da URL. HEIC/AVIF/BMP não são suportados pela Claude.
const IMG_MIME_OK = /^image\/(jpeg|png|gif|webp)$/;
function guessImageMime(url: string, contentType?: string | null): string {
  const ct = (contentType || "").split(";")[0].trim().toLowerCase();
  if (IMG_MIME_OK.test(ct)) return ct;
  if (ct === "image/jpg") return "image/jpeg";
  const u = url.toLowerCase();
  if (/\.jpe?g(\?|$)/.test(u)) return "image/jpeg";
  if (/\.png(\?|$)/.test(u)) return "image/png";
  if (/\.gif(\?|$)/.test(u)) return "image/gif";
  if (/\.webp(\?|$)/.test(u)) return "image/webp";
  return "image/jpeg";
}

// Baixa uma imagem (por URL) SERVER-SIDE e devolve o bloco de imagem base64 da Claude.
// Tenta o host interno primeiro e cai na URL pública; 2 tentativas cada, com backoff.
// Assim a legenda não depende do fetch/FileReader do navegador (onde vinha falhando).
async function fetchImageBlock(url: string): Promise<any> {
  const candidates = [internalizeStorageUrl(url), url].filter((v, i, a) => a.indexOf(v) === i);
  let lastErr: unknown = null;
  for (const cand of candidates) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await fetch(cand);
        if (!r.ok) {
          lastErr = new Error(`HTTP ${r.status}`);
          if (attempt < 2) { await sleep(300 * attempt); continue; }
          break;
        }
        const buf = new Uint8Array(await r.arrayBuffer());
        if (buf.byteLength > 4.5 * 1024 * 1024) {
          throw new Error("imagem muito grande para análise (máx. ~4,5 MB).");
        }
        return {
          type: "image",
          source: { type: "base64", media_type: guessImageMime(url, r.headers.get("content-type")), data: base64Encode(buf) },
        };
      } catch (e) {
        lastErr = e;
        if (attempt < 2) { await sleep(300 * attempt); continue; }
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("falha ao baixar a imagem.");
}

/**
 * fetch com retry + backoff exponencial para chamadas de IA. Em sucesso retorna a
 * Response SEM consumir o corpo (o chamador lê o JSON). Em erro transitório (ou
 * "overloaded"/"rate limit" no corpo) espera e tenta de novo; esgotando as
 * tentativas, lança o erro com o corpo. Conserta o toast "Claude API error 529".
 */
async function fetchAIWithRetry(
  url: string,
  init: RequestInit,
  label: string,
  maxAttempts = 4,
): Promise<Response> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      const text = await res.text();
      const transient = RETRYABLE_STATUS.has(res.status) || /overloaded|rate.?limit/i.test(text);
      if (transient && attempt < maxAttempts) {
        const backoff = Math.min(8000, 600 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400);
        console.warn(`${label}: ${res.status} (transitório), retry ${attempt}/${maxAttempts - 1} em ${backoff}ms`);
        await sleep(backoff);
        lastErr = new Error(`${label} ${res.status}: ${text.slice(0, 200)}`);
        continue;
      }
      throw new Error(`${label} ${res.status}: ${text.slice(0, 300)}`);
    } catch (e) {
      // Erro de rede (sem Response) também é transitório.
      const isNetwork = e instanceof TypeError;
      if (isNetwork && attempt < maxAttempts) {
        lastErr = e;
        await sleep(Math.min(8000, 600 * 2 ** (attempt - 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${label}: falhou após ${maxAttempts} tentativas`);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const { user_id, brand_profile_id, context, tom_de_voz, post_type, original_caption, image_description, reference_images, reference_image_urls, operator_name, video_url, video_data, video_mime, ig_handle } = await req.json();
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

    // 2. Resolver o BRAND PROFILE (inteligência de público-alvo) — SEMPRE carrega um.
    //    Prioridade: id explícito → casa pelo @ do perfil (ig_handle) → perfil-mestre
    //    PPGVET → 1º ativo. Assim a legenda nunca sai sem o público-alvo.
    let bp: any = null;
    if (brand_profile_id) {
      const { data } = await supabase.from("brand_profiles").select("*").eq("id", brand_profile_id).maybeSingle();
      bp = data;
    }
    if (!bp) {
      const { data: allBp } = await supabase.from("brand_profiles").select("*").eq("is_active", true);
      const norm = (s: any) => (s ?? "").toString().replace(/^@/, "").trim().toLowerCase();
      if (ig_handle) {
        const h = norm(ig_handle);
        const matches = (allBp || []).filter((b: any) => norm(b.instagram_handle) === h);
        // entre perfis do mesmo @ (ex.: ppgvet_oficial tem vários cursos), prefere o MESTRE da conta
        bp = matches.find((b: any) => norm(b.account_name) === norm(b.brand_name) && (b.brand_name || "").length <= 12)
          || matches[0] || null;
      }
      if (!bp) {
        bp = (allBp || []).find((b: any) => norm(b.brand_name) === "ppgvet")
          || (allBp || [])[0] || null;
      }
    }

    // 3. Build system prompt
    const tomFinal = tom_de_voz || bp?.tom_de_voz || "Direto e Forte";
    const systemPrompt = `Você é um copywriter especialista em redes sociais com foco em conteúdo TÉCNICO e APLICÁVEL. Gere uma legenda para Instagram seguindo RIGOROSAMENTE estas diretrizes:

${bp?.brand_name || bp?.account_name ? `MARCA/CONTA: ${bp.brand_name || bp.account_name}${bp?.instagram_handle ? ` (@${String(bp.instagram_handle).replace(/^@/, "")})` : ""}` : ""}
TOM DE VOZ: ${tomFinal}
${bp?.tom_descricao ? `DESCRIÇÃO DO TOM: ${bp.tom_descricao}` : ""}

${bp?.vocabulario_chave ? `VOCABULÁRIO E PALAVRAS-CHAVE: ${bp.vocabulario_chave}` : ""}
${bp?.metaforas_estrategicas ? `METÁFORAS ESTRATÉGICAS: ${bp.metaforas_estrategicas}` : ""}

${bp?.estrutura_visual ? `ESTRUTURA VISUAL:\n${bp.estrutura_visual}` : ""}

${bp?.alertas_nao_usar ? `ALERTAS - NÃO UTILIZAR DE FORMA ALGUMA:\n${bp.alertas_nao_usar}` : ""}

${bp?.frases_exemplo ? `EXEMPLOS DE FRASES QUE REPRESENTAM O TOM:\n${bp.frases_exemplo}` : ""}

=== PÚBLICO-ALVO (escreva FALANDO DIRETAMENTE para esta pessoa) ===
${bp?.publico_alvo ? `QUEM É: ${bp.publico_alvo}` : ""}
${bp?.persona_perfil_demografico ? `PERFIL DEMOGRÁFICO: ${bp.persona_perfil_demografico}` : ""}
${bp?.segmento ? `SEGMENTO/NICHO: ${bp.segmento}` : ""}
${bp ? `- Dores: ${bp.persona_dores || ""}
- Objeções: ${bp.persona_objecoes || ""}
- Desejos: ${bp.persona_desejos || ""}` : ""}

${bp?.termos_obrigatorios ? `TERMOS OBRIGATÓRIOS (use com naturalidade quando couber): ${bp.termos_obrigatorios}` : ""}
${bp?.termos_proibidos ? `TERMOS PROIBIDOS (NUNCA use): ${bp.termos_proibidos}` : ""}
${bp?.regras_estilo ? `REGRAS DE ESTILO:\n${bp.regras_estilo}` : ""}

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

    // ===== VÍDEO → análise NATIVA via Gemini (sem STT/Whisper) =====
    // Quando há vídeo (e nenhuma imagem), o Gemini analisa o vídeo diretamente,
    // usando o MESMO system prompt (modelos aprovados + persona/tom do brand_profile).
    const hasImages =
      (Array.isArray(reference_images) && reference_images.length > 0) ||
      (Array.isArray(reference_image_urls) && reference_image_urls.length > 0);
    if (!hasImages && (video_url || video_data)) {
      const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
      if (!GEMINI_API_KEY) {
        return new Response(JSON.stringify({ error: "GEMINI_API_KEY não configurada (necessária para analisar vídeo)." }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Obter bytes + mime do vídeo (de dataURL local ou baixando a URL).
      let b64 = "";
      let mime = video_mime || "video/mp4";
      try {
        if (video_data) {
          const m = String(video_data).match(/^data:(video\/[\w.+-]+);base64,(.+)$/);
          if (!m) throw new Error("video_data inválido (esperado dataURL base64 de vídeo).");
          mime = m[1];
          b64 = m[2];
        } else {
          const vr = await fetch(internalizeStorageUrl(String(video_url)));
          if (!vr.ok) throw new Error(`Não consegui baixar o vídeo (HTTP ${vr.status}).`);
          const ct = vr.headers.get("content-type");
          if (ct && ct.startsWith("video/")) mime = ct.split(";")[0];
          const buf = new Uint8Array(await vr.arrayBuffer());
          if (buf.byteLength > 18 * 1024 * 1024) throw new Error("Vídeo muito grande para análise inline (máx. ~18 MB). Reduza o vídeo ou gere a legenda a partir de uma imagem.");
          b64 = base64Encode(buf);
        }
      } catch (ve) {
        return new Response(JSON.stringify({ error: ve instanceof Error ? ve.message : "Falha ao ler o vídeo." }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const startTimeV = Date.now();
      const { data: genV } = await supabase.from("ai_generations").insert({
        user_id,
        brand_profile_id: brand_profile_id || null,
        generation_type: "caption",
        source_type: original_caption ? "organic" : "manual",
        prompt_used: userMessage,
        tom_de_voz_usado: tomFinal,
        model_used: "gemini-2.5-flash",
        provider: "google",
        status: "processing",
        operator_name: operator_name || null,
      }).select("id").single();
      const genVId = genV?.id;

      try {
        const gemRes = await fetchAIWithRetry(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: "user", parts: [
              { inlineData: { mimeType: mime, data: b64 } },
              { text: userMessage },
            ] }],
            generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
          }),
        }, "Gemini");
        const gj = await gemRes.json();
        const caption = (gj?.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || "").join("").trim();
        if (genVId) {
          await supabase.from("ai_generations").update({
            caption_generated: caption,
            status: "completed",
            generation_time_seconds: Math.round((Date.now() - startTimeV) / 1000),
            completed_at: new Date().toISOString(),
          }).eq("id", genVId);
        }
        return new Response(JSON.stringify({ success: true, generation_id: genVId, caption }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (gerr) {
        const msg = gerr instanceof Error ? gerr.message : "Erro Gemini";
        if (genVId) await supabase.from("ai_generations").update({ status: "failed", error_message: msg }).eq("id", genVId);
        return new Response(JSON.stringify({ error: msg }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

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
    // Imagens por URL (prefill do Agendar Post): o EDGE baixa server-side — evita o
    // fetch/FileReader do navegador, que é onde a geração vinha falhando.
    if (Array.isArray(reference_image_urls) && reference_image_urls.length > 0) {
      const antes = contentBlocks.length;
      let ultimoErro = "";
      for (const url of reference_image_urls.slice(0, 4)) {
        try {
          contentBlocks.push(await fetchImageBlock(String(url)));
        } catch (e) {
          ultimoErro = e instanceof Error ? e.message : String(e);
          console.warn(`generate-caption: falha ao baixar imagem ${url}: ${ultimoErro}`);
        }
      }
      // Só pediram URLs e NENHUMA baixou → erro claro (não gera legenda "no escuro").
      if (contentBlocks.length === antes && !(reference_images?.length)) {
        return new Response(
          JSON.stringify({ error: `Não consegui baixar a mídia para análise${ultimoErro ? ` (${ultimoErro})` : ""}. Tente novamente.` }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
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
      model_used: "claude-sonnet-4-6",
      provider: "anthropic",
      status: "processing",
      operator_name: operator_name || null,
    }).select("id").single();

    if (genErr || !gen) {
      return new Response(JSON.stringify({ error: "Failed to create generation record" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const generationId = gen.id;

    try {
      // 6. Call Claude API (com retry/backoff p/ 529 Overloaded e afins)
      const claudeRes = await fetchAIWithRetry("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": keyRow.api_key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: "user", content: contentBlocks }],
        }),
      }, "Claude API error");

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
          model: "claude-sonnet-4-6", total_generations: 1, captions_generated: 1,
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
