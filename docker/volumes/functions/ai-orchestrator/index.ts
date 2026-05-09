import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
const MAX_TOOL_LOOPS = 5;
// Hard deadline (ms) to stay safely under Supabase Edge Runtime ~150s wall limit
const SOFT_DEADLINE_MS = 110_000;
// Per-tool timeout to prevent any single tool from stalling the loop
const TOOL_TIMEOUT_MS = 25_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }).catch(e => { clearTimeout(t); reject(e); });
  });
}

// ─── Tool definitions (Anthropic native format) ───
const TOOL_DEFINITIONS: Record<string, any> = {
  generate_image: {
    name: "generate_image",
    description: "Gera uma imagem usando IA via Nano Banana Pro. Use quando precisar criar um visual, foto, ilustração ou arte.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Prompt detalhado em inglês para geração da imagem." },
        aspect_ratio: { type: "string", enum: ["1:1", "16:9", "9:16", "4:5"], description: "Proporção da imagem" },
        style: { type: "string", enum: ["photorealistic", "3d-premium", "illustration", "flat-design", "cinematic", "editorial"], description: "Estilo visual" }
      },
      required: ["prompt", "aspect_ratio"]
    }
  },
  generate_video: {
    name: "generate_video",
    description: "Gera um vídeo curto usando Veo 3. Use quando precisar de vídeo, motion, reels ou conteúdo audiovisual.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Prompt cinematográfico detalhado em inglês." },
        duration_seconds: { type: "number", enum: [4, 6, 8], description: "Duração do vídeo" },
        aspect_ratio: { type: "string", enum: ["16:9", "9:16", "1:1"], description: "Proporção" }
      },
      required: ["prompt", "duration_seconds", "aspect_ratio"]
    }
  },
  web_search: {
    name: "web_search",
    description: "Pesquisa na web por informações atuais usando Google Gemini com grounding.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Termo de busca" },
        num_results: { type: "number", description: "Número de resultados (1-10)" }
      },
      required: ["query"]
    }
  },
  query_instagram: {
    name: "query_instagram",
    description: "Consulta métricas do Instagram dos perfis conectados no banco de dados.",
    input_schema: {
      type: "object",
      properties: {
        profiles: { type: "array", items: { type: "string" }, description: "Usernames para consultar. Se vazio, consulta todos." },
        period: { type: "string", enum: ["last_7_days", "last_14_days", "last_30_days", "last_90_days"], description: "Período" },
        content_type: { type: "string", enum: ["posts", "stories", "all"], description: "Tipo de conteúdo" },
        order_by: { type: "string", enum: ["engagement", "reach", "likes", "comments", "saves", "shares"], description: "Ordenar por" },
        limit: { type: "number", description: "Número de itens" }
      },
      required: ["period"]
    }
  },
  query_ads: {
    name: "query_ads",
    description: "Consulta métricas de anúncios do Meta Ads no banco de dados.",
    input_schema: {
      type: "object",
      properties: {
        period: { type: "string", enum: ["last_7_days", "last_14_days", "last_30_days", "last_90_days"] },
        campaign_ids: { type: "array", items: { type: "string" }, description: "IDs de campanhas" },
        order_by: { type: "string", enum: ["spend", "conversions", "ctr", "cpc", "roas"] },
        limit: { type: "number" }
      },
      required: ["period"]
    }
  },
  query_whatsapp: {
    name: "query_whatsapp",
    description: "Consulta métricas do WhatsApp Business no banco de dados.",
    input_schema: {
      type: "object",
      properties: {
        period: { type: "string", enum: ["last_7_days", "last_14_days", "last_30_days"] },
        template_name: { type: "string", description: "Template específico" }
      },
      required: ["period"]
    }
  },
  generate_report: {
    name: "generate_report",
    description: "Gera um relatório profissional em HTML. IMPORTANTE: Use markdown rico no 'content' de cada seção. Para 'summary': inclua KPIs como '**Alcance Total:** 45.230' em linhas separadas. Para 'table': use tabelas markdown com | Header | Header |. Para 'insights' e 'recommendations': use listas com '- ' e negritos para destaques. Sempre inclua dados numéricos concretos e comparações percentuais quando possível.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        report_type: { type: "string", enum: ["weekly_instagram", "weekly_ads", "weekly_whatsapp", "monthly_consolidated", "campaign_analysis", "custom"] },
        period_start: { type: "string" },
        period_end: { type: "string" },
        sections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              type: { type: "string", enum: ["summary", "table", "chart", "top_content", "insights", "recommendations"] },
              content: { type: "string", description: "Conteúdo em markdown rico. Use **negrito**, listas com -, tabelas markdown, e métricas numéricas destacadas." }
            }
          }
        }
      },
      required: ["title", "report_type", "sections"]
    }
  },
  save_content: {
    name: "save_content",
    description: "Salva conteúdo aprovado no banco de dados.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        content_type: { type: "string", enum: ["social_post", "whatsapp_message", "ad_copy", "blog_article", "email", "educational_material", "campaign_package"] },
        platform: { type: "string", enum: ["instagram", "facebook", "whatsapp", "linkedin", "youtube", "tiktok", "blog", "email"] },
        media_urls: { type: "array", items: { type: "string" } }
      },
      required: ["title", "body", "content_type"]
    }
  },
  call_agent: {
    name: "call_agent",
    description: "Chama outro agente especialista para executar uma tarefa específica dentro da produção. Use quando precisar de uma peça que outro agente produz melhor (copy, imagem, vídeo, pesquisa, análise). Útil para orquestração de campanhas.",
    input_schema: {
      type: "object",
      properties: {
        agent_slug: {
          type: "string",
          enum: ["researcher", "copywriter", "art-director", "video-director", "educator", "analyst", "sales-assistant"],
          description: "Slug do agente a ser chamado"
        },
        task: {
          type: "string",
          description: "Tarefa específica que o agente deve executar. Seja claro e objetivo."
        },
        context: {
          type: "object",
          description: "Contexto relevante: briefing aprovado, posicionamento, tom de voz, peças já produzidas",
          properties: {
            briefing: { type: "object", description: "Briefing completo da campanha" },
            main_hook: { type: "string", description: "Gancho central da campanha" },
            positioning: { type: "string", description: "Posicionamento diferencial aprovado" },
            previous_pieces: { type: "object", description: "Peças já produzidas para manter consistência" },
            called_by: { type: "string", description: "Slug do agente que está chamando" }
          }
        }
      },
      required: ["agent_slug", "task"]
    }
  }
};

// ─── Helpers ───
function getPeriodDates(period: string): { start: string; end: string } {
  const now = new Date();
  const end = now.toISOString().split("T")[0];
  const days = period === "last_7_days" ? 7 : period === "last_14_days" ? 14 : period === "last_30_days" ? 30 : 90;
  const s = new Date(now);
  s.setDate(s.getDate() - days);
  return { start: s.toISOString().split("T")[0], end };
}

// ─── Tool Executors ───
async function executeTool(
  toolName: string,
  toolInput: any,
  supabase: any,
  userId: string,
  brandId: string | null,
  sessionId: string | null
): Promise<string> {
  switch (toolName) {
    case "generate_image": {
      const { data: keyRow } = await supabase
        .from("ai_api_keys").select("api_key")
        .eq("provider", "google").eq("is_active", true).limit(1).maybeSingle();

      if (!keyRow) return JSON.stringify({ error: "Google API Key não configurada" });

      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${keyRow.api_key}`;
      const aiRes = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: toolInput.prompt }] }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
        }),
      });

      if (!aiRes.ok) {
        const errText = await aiRes.text();
        return JSON.stringify({ error: `Image generation failed: ${aiRes.status} - ${errText}` });
      }

      const result = await aiRes.json();
      let imageUrl: string | null = null;
      const candidates = result?.candidates;
      if (candidates?.[0]?.content?.parts) {
        for (const part of candidates[0].content.parts) {
          const inlineData = part.inlineData || part.inline_data;
          if (inlineData) {
            const base64 = inlineData.data;
            const mimeType = inlineData.mimeType || inlineData.mime_type || "image/png";
            const ext = mimeType.includes("jpeg") ? "jpg" : "png";
            const fileName = `generated-images/${userId}/${crypto.randomUUID()}.${ext}`;
            const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

            const { error: uploadErr } = await supabase.storage
              .from("ig-media")
              .upload(fileName, bytes, { contentType: mimeType, upsert: true });

            if (!uploadErr) {
              const { data: urlData } = supabase.storage.from("ig-media").getPublicUrl(fileName);
              imageUrl = urlData?.publicUrl || null;
            } else {
              imageUrl = `data:${mimeType};base64,${base64.substring(0, 100)}...`;
            }
            break;
          }
        }
      }

      await supabase.from("ai_generations").insert({
        user_id: userId,
        brand_profile_id: brandId,
        generation_type: "image",
        source_type: "agent",
        prompt_used: toolInput.prompt,
        model_used: "gemini-2.5-flash-image",
        provider: "google",
        status: imageUrl ? "completed" : "failed",
        output_url: imageUrl,
        completed_at: new Date().toISOString(),
      });

      return JSON.stringify({ success: !!imageUrl, image_url: imageUrl });
    }

    case "generate_video": {
      const { data: keyRow } = await supabase
        .from("ai_api_keys").select("api_key")
        .eq("provider", "google").eq("is_active", true).limit(1).maybeSingle();

      if (!keyRow) return JSON.stringify({ error: "Google API Key não configurada" });

      const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
      const veoRes = await fetch(`${BASE_URL}/models/veo-3.1-generate-preview:predictLongRunning`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": keyRow.api_key },
        body: JSON.stringify({
          instances: [{ prompt: toolInput.prompt }],
          parameters: { aspectRatio: toolInput.aspect_ratio || "9:16" },
        }),
      });

      if (!veoRes.ok) {
        const errText = await veoRes.text();
        return JSON.stringify({ error: `Video generation started but failed: ${errText}` });
      }

      const operation = await veoRes.json();
      const operationName = operation.name;
      if (!operationName) return JSON.stringify({ error: "Veo did not return operation name" });

      let videoUrl: string | null = null;
      for (let i = 0; i < 48; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const pollRes = await fetch(`${BASE_URL}/${operationName}`, {
          headers: { "x-goog-api-key": keyRow.api_key },
        });
        if (!pollRes.ok) continue;
        const pollData = await pollRes.json();
        if (pollData.done) {
          const samples = pollData.response?.generateVideoResponse?.generatedSamples;
          if (samples?.[0]?.video?.uri) {
            const generatedVideoUrl = samples[0].video.uri as string;
            videoUrl = generatedVideoUrl;
            try {
              const vidRes = await fetch(generatedVideoUrl, { headers: { "x-goog-api-key": keyRow.api_key } });
              if (vidRes.ok) {
                const blob = await vidRes.blob();
                const fileName = `generated-videos/${userId}/${crypto.randomUUID()}.mp4`;
                const { error: uploadErr } = await supabase.storage
                  .from("ig-media").upload(fileName, blob, { contentType: "video/mp4", upsert: true });
                if (!uploadErr) {
                  const { data: urlData } = supabase.storage.from("ig-media").getPublicUrl(fileName);
                  if (urlData?.publicUrl) videoUrl = urlData.publicUrl;
                }
              }
            } catch (_) { }
          }
          break;
        }
      }

      await supabase.from("ai_generations").insert({
        user_id: userId, brand_profile_id: brandId, generation_type: "video",
        source_type: "agent", prompt_used: toolInput.prompt,
        model_used: "veo-3.1-generate-preview", provider: "google",
        status: videoUrl ? "completed" : "failed", output_url: videoUrl,
        completed_at: new Date().toISOString(),
      });

      return JSON.stringify({ success: !!videoUrl, video_url: videoUrl });
    }

    case "web_search": {
      const { data: keyRow } = await supabase
        .from("ai_api_keys").select("api_key")
        .eq("provider", "google").eq("is_active", true).limit(1).maybeSingle();

      if (!keyRow) return JSON.stringify({ error: "Google API Key não configurada" });

      const searchRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${keyRow.api_key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: toolInput.query }] }],
            tools: [{ google_search: {} }],
          }),
        }
      );

      if (!searchRes.ok) {
        return JSON.stringify({ error: `Search failed: ${searchRes.status}` });
      }

      const searchResult = await searchRes.json();
      const text = searchResult?.candidates?.[0]?.content?.parts?.[0]?.text || "Nenhum resultado encontrado.";
      const groundingMeta = searchResult?.candidates?.[0]?.groundingMetadata;

      return JSON.stringify({
        results: text,
        sources: groundingMeta?.groundingChunks?.map((c: any) => ({
          title: c.web?.title,
          url: c.web?.uri,
        })) || [],
      });
    }

    case "query_instagram": {
      const { start, end } = getPeriodDates(toolInput.period);

      let accountQuery = supabase.from("ig_accounts").select("id, username, followers_count, reach, impressions, profile_views, total_likes, total_comments, total_shares, total_saves").eq("is_active", true);
      if (toolInput.profiles?.length) {
        accountQuery = accountQuery.in("username", toolInput.profiles);
      }
      const { data: accounts } = await accountQuery;

      if (!accounts?.length) return JSON.stringify({ accounts: [], posts: [], stories: [] });

      const accountIds = accounts.map((a: any) => a.id);
      const result: any = { accounts };

      if (!toolInput.content_type || toolInput.content_type === "posts" || toolInput.content_type === "all") {
        let postQuery = supabase.from("ig_post_metrics")
          .select("*")
          .in("account_id", accountIds)
          .gte("timestamp", start)
          .lte("timestamp", end);

        const orderMap: Record<string, string> = {
          engagement: "engagement_rate", reach: "reach", likes: "likes",
          comments: "comments", saves: "saves", shares: "shares"
        };
        const orderCol = orderMap[toolInput.order_by || "engagement"] || "engagement_rate";
        postQuery = postQuery.order(orderCol, { ascending: false }).limit(toolInput.limit || 20);
        const { data: posts } = await postQuery;
        result.posts = posts || [];
      }

      if (!toolInput.content_type || toolInput.content_type === "stories" || toolInput.content_type === "all") {
        const { data: stories } = await supabase.from("ig_story_metrics")
          .select("*")
          .in("account_id", accountIds)
          .gte("timestamp", start)
          .lte("timestamp", end)
          .order("reach", { ascending: false })
          .limit(toolInput.limit || 20);
        result.stories = stories || [];
      }

      return JSON.stringify(result);
    }

    case "query_ads": {
      const { start, end } = getPeriodDates(toolInput.period);

      let query = supabase.from("meta_insights")
        .select("*, meta_campaigns!inner(name, status, objective)")
        .gte("date_start", start)
        .lte("date_stop", end);

      if (toolInput.campaign_ids?.length) {
        query = query.in("campaign_id", toolInput.campaign_ids);
      }

      const orderMap: Record<string, string> = {
        spend: "spend", conversions: "conversions", ctr: "ctr", cpc: "cpc", roas: "roas"
      };
      const orderCol = orderMap[toolInput.order_by || "spend"] || "spend";
      query = query.order(orderCol, { ascending: false }).limit(toolInput.limit || 50);

      const { data } = await query;

      const totals = (data || []).reduce((acc: any, row: any) => ({
        total_spend: acc.total_spend + (row.spend || 0),
        total_impressions: acc.total_impressions + (row.impressions || 0),
        total_clicks: acc.total_clicks + (row.clicks || 0),
        total_conversions: acc.total_conversions + (row.conversions || 0),
        total_conversion_value: acc.total_conversion_value + (row.conversion_value || 0),
      }), { total_spend: 0, total_impressions: 0, total_clicks: 0, total_conversions: 0, total_conversion_value: 0 });

      if (totals.total_spend > 0) {
        totals.avg_cpc = totals.total_clicks > 0 ? totals.total_spend / totals.total_clicks : 0;
        totals.avg_ctr = totals.total_impressions > 0 ? (totals.total_clicks / totals.total_impressions) * 100 : 0;
        totals.roas = totals.total_spend > 0 ? totals.total_conversion_value / totals.total_spend : 0;
      }

      return JSON.stringify({ insights: data || [], totals });
    }

    case "query_whatsapp": {
      const { start, end } = getPeriodDates(toolInput.period);

      let query = supabase.from("wa_analytics")
        .select("*")
        .gte("date", start)
        .lte("date", end);

      if (toolInput.template_name) {
        query = query.eq("template_name", toolInput.template_name);
      }

      query = query.order("date", { ascending: false }).limit(100);
      const { data } = await query;

      const totals = (data || []).reduce((acc: any, row: any) => ({
        total_sent: acc.total_sent + (row.sent || 0),
        total_delivered: acc.total_delivered + (row.delivered || 0),
        total_read: acc.total_read + (row.read || 0),
      }), { total_sent: 0, total_delivered: 0, total_read: 0 });

      if (totals.total_sent > 0) {
        totals.delivery_rate = ((totals.total_delivered / totals.total_sent) * 100).toFixed(1);
        totals.read_rate = ((totals.total_read / totals.total_sent) * 100).toFixed(1);
      }

      return JSON.stringify({ analytics: data || [], totals });
    }

    case "generate_report": {
      // Simple markdown to HTML converter
      const md2html = (text: string): string => {
        if (!text) return "";
        let html = text;
        // Tables
        const tableRegex = /(\|.+\|[\r\n]+\|[-| :]+\|[\r\n]+((\|.+\|[\r\n]*)+))/gm;
        html = html.replace(tableRegex, (match: string) => {
          const rows = match.trim().split("\n").filter((r: string) => r.trim());
          if (rows.length < 2) return match;
          const headers = rows[0].split("|").filter((c: string) => c.trim()).map((c: string) => c.trim());
          const dataRows = rows.slice(2);
          let table = '<table><thead><tr>';
          headers.forEach((h: string) => { table += `<th>${h}</th>`; });
          table += '</tr></thead><tbody>';
          dataRows.forEach((row: string) => {
            const cells = row.split("|").filter((c: string) => c.trim()).map((c: string) => c.trim());
            table += '<tr>';
            cells.forEach((c: string) => {
              const cls = c.startsWith("+") ? ' class="up"' : c.startsWith("-") ? ' class="down"' : '';
              table += `<td${cls}>${c}</td>`;
            });
            table += '</tr>';
          });
          table += '</tbody></table>';
          return table;
        });
        // Bold
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        // Unordered lists
        html = html.replace(/^[\s]*[-•]\s+(.+)$/gm, '<li>$1</li>');
        html = html.replace(/((?:<li>.*<\/li>\s*)+)/g, '<ul>$1</ul>');
        // Line breaks
        html = html.replace(/\n/g, '<br>');
        // Clean up brs inside lists/tables
        html = html.replace(/<br>\s*<ul>/g, '<ul>');
        html = html.replace(/<\/ul>\s*<br>/g, '</ul>');
        html = html.replace(/<br>\s*<table>/g, '<table>');
        html = html.replace(/<\/table>\s*<br>/g, '</table>');
        return html;
      };

      const typeConfig: Record<string, { icon: string; color: string; gradient: string }> = {
        summary: { icon: "📊", color: "#3B82F6", gradient: "linear-gradient(135deg, #3B82F6, #1D4ED8)" },
        table: { icon: "📋", color: "#8B5CF6", gradient: "linear-gradient(135deg, #8B5CF6, #7C3AED)" },
        chart: { icon: "📈", color: "#10B981", gradient: "linear-gradient(135deg, #10B981, #059669)" },
        top_content: { icon: "🏆", color: "#F59E0B", gradient: "linear-gradient(135deg, #F59E0B, #D97706)" },
        insights: { icon: "💡", color: "#F59E0B", gradient: "linear-gradient(135deg, #FBBF24, #F59E0B)" },
        recommendations: { icon: "🎯", color: "#EF4444", gradient: "linear-gradient(135deg, #EF4444, #DC2626)" },
      };

      const reportTypeLabels: Record<string, string> = {
        weekly_instagram: "📱 Instagram Semanal",
        weekly_ads: "📢 Ads Semanal",
        weekly_whatsapp: "💬 WhatsApp Semanal",
        monthly_consolidated: "📅 Consolidado Mensal",
        campaign_analysis: "🎯 Análise de Campanha",
        custom: "📝 Relatório Personalizado",
      };

      // Limit sections and per-section content size to keep generation fast and payload small
      const MAX_SECTIONS = 8;
      const MAX_SECTION_CHARS = 6000;
      const rawSections = Array.isArray(toolInput.sections) ? toolInput.sections.slice(0, MAX_SECTIONS) : [];
      const sectionsHtml = rawSections.map((s: any) => {
        const cfg = typeConfig[s.type] || { icon: "📌", color: "#6B7280", gradient: "linear-gradient(135deg, #6B7280, #4B5563)" };
        const trimmedContent = (s.content || "").slice(0, MAX_SECTION_CHARS);
        const contentHtml = md2html(trimmedContent);

        return `<div class="section-card">
          <div class="section-header" style="border-left: 4px solid ${cfg.color}">
            <span class="section-icon" style="background: ${cfg.gradient}">${cfg.icon}</span>
            <h2>${s.title}</h2>
          </div>
          <div class="section-body">${contentHtml}</div>
        </div>`;
      }).join("\n");

      const reportLabel = reportTypeLabels[toolInput.report_type] || "📝 Relatório";

      const html = `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${toolInput.title}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Inter',system-ui,-apple-system,sans-serif;max-width:960px;margin:0 auto;padding:0;color:#1e293b;background:#f8fafc;line-height:1.6}

  /* Header */
  .report-header{background:linear-gradient(135deg,#4F46E5 0%,#7C3AED 50%,#9333EA 100%);color:white;padding:40px 36px;position:relative;overflow:hidden}
  .report-header::before{content:'';position:absolute;top:-50%;right:-20%;width:400px;height:400px;background:radial-gradient(circle,rgba(255,255,255,0.08) 0%,transparent 70%);border-radius:50%}
  .report-header::after{content:'';position:absolute;bottom:-30%;left:-10%;width:300px;height:300px;background:radial-gradient(circle,rgba(255,255,255,0.05) 0%,transparent 70%);border-radius:50%}
  .header-badge{display:inline-block;background:rgba(255,255,255,0.2);backdrop-filter:blur(10px);padding:6px 16px;border-radius:20px;font-size:12px;font-weight:600;letter-spacing:0.5px;margin-bottom:16px;text-transform:uppercase}
  .header-title{font-size:28px;font-weight:800;margin-bottom:8px;letter-spacing:-0.5px;position:relative;z-index:1}
  .header-meta{display:flex;gap:24px;font-size:13px;opacity:0.9;position:relative;z-index:1;flex-wrap:wrap}
  .header-meta span{display:flex;align-items:center;gap:6px}

  /* Content area */
  .report-body{padding:28px 36px 40px}

  /* Section cards */
  .section-card{background:white;border-radius:12px;margin-bottom:20px;box-shadow:0 1px 3px rgba(0,0,0,0.06),0 1px 2px rgba(0,0,0,0.04);border:1px solid #e2e8f0;overflow:hidden;transition:box-shadow 0.2s}
  .section-card:hover{box-shadow:0 4px 12px rgba(0,0,0,0.08)}
  .section-header{display:flex;align-items:center;gap:12px;padding:18px 20px 14px;border-bottom:1px solid #f1f5f9}
  .section-icon{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;color:white;text-shadow:0 1px 2px rgba(0,0,0,0.1)}
  .section-header h2{font-size:16px;font-weight:700;color:#1e293b;letter-spacing:-0.3px}
  .section-body{padding:20px;font-size:14px;color:#475569}

  /* Typography inside sections */
  .section-body strong{color:#1e293b;font-weight:600}
  .section-body br{display:block;content:'';margin-top:4px}

  /* Lists */
  .section-body ul{list-style:none;padding:0;margin:8px 0}
  .section-body ul li{padding:8px 12px 8px 32px;position:relative;border-radius:8px;margin-bottom:4px;background:#f8fafc;border:1px solid #f1f5f9}
  .section-body ul li::before{content:'▸';position:absolute;left:12px;color:#7C3AED;font-weight:700;font-size:14px}

  /* Tables */
  table{width:100%;border-collapse:separate;border-spacing:0;margin:12px 0;border-radius:10px;overflow:hidden;border:1px solid #e2e8f0}
  thead{background:linear-gradient(135deg,#4F46E5,#7C3AED)}
  th{padding:12px 16px;text-align:left;font-weight:600;font-size:12px;color:white;text-transform:uppercase;letter-spacing:0.5px}
  td{padding:11px 16px;font-size:13px;border-bottom:1px solid #f1f5f9;color:#334155}
  tbody tr{transition:background 0.15s}
  tbody tr:hover{background:#f8fafc}
  tbody tr:last-child td{border-bottom:none}
  .up{color:#16a34a;font-weight:600}
  .down{color:#dc2626;font-weight:600}

  /* Footer */
  .report-footer{text-align:center;padding:24px 36px;border-top:2px solid #e2e8f0;background:white;margin-top:8px}
  .report-footer .footer-brand{font-size:14px;font-weight:700;color:#4F46E5;margin-bottom:4px;letter-spacing:0.3px}
  .report-footer .footer-sub{font-size:11px;color:#94a3b8}

  /* Responsive */
  @media(max-width:640px){
    .report-header{padding:28px 20px}
    .report-body{padding:16px}
    .header-title{font-size:22px}
    .header-meta{flex-direction:column;gap:8px}
    .section-header{padding:14px 16px 10px}
    .section-body{padding:16px}
    th,td{padding:8px 10px;font-size:11px}
  }
</style></head><body>
<div class="report-header">
  <div class="header-badge">${reportLabel}</div>
  <h1 class="header-title">${toolInput.title}</h1>
  <div class="header-meta">
    <span>📅 Período: ${toolInput.period_start || "N/A"} a ${toolInput.period_end || "N/A"}</span>
    <span>🕐 Gerado em: ${new Date().toLocaleDateString("pt-BR")} às ${new Date().toLocaleTimeString("pt-BR")}</span>
  </div>
</div>
<div class="report-body">
${sectionsHtml}
</div>
<div class="report-footer">
  <div class="footer-brand">PPGVET Educação</div>
  <div class="footer-sub">Relatório gerado por Inteligência Artificial • ${new Date().toLocaleDateString("pt-BR")}</div>
</div>
</body></html>`;

      const { data: report } = await supabase.from("generated_reports").insert({
        user_id: userId,
        report_type: toolInput.report_type,
        title: toolInput.title,
        period_start: toolInput.period_start || null,
        period_end: toolInput.period_end || null,
        html_content: html,
        data: { sections: toolInput.sections },
        insights: {},
      }).select("id").single();

      return JSON.stringify({
        success: true,
        report_id: report?.id,
        html_content: html,
        message: "Relatório gerado com sucesso! O usuário pode visualizar e baixar o PDF."
      });
    }

    case "save_content": {
      const { data: saved } = await supabase.from("generated_content").insert({
        user_id: userId,
        session_id: sessionId,
        brand_id: brandId,
        title: toolInput.title,
        body: toolInput.body,
        content_type: toolInput.content_type,
        platform: toolInput.platform || null,
        media_urls: toolInput.media_urls || [],
        status: "draft",
      }).select("id").single();

      return JSON.stringify({ success: true, content_id: saved?.id });
    }

    case "call_agent": {
      const { agent_slug, task, context: callContext = {} } = toolInput;
      const startTime = Date.now();

      // Build structured message for the called agent
      const structuredMessage = JSON.stringify({
        task,
        context: {
          ...callContext,
          called_by: "campaign-director",
          source_session_id: sessionId,
        },
      });

      try {
        const response = await fetch(
          `${Deno.env.get("SUPABASE_URL")}/functions/v1/ai-orchestrator`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              userMessage: structuredMessage,
              agentSlug: agent_slug,
              brandId,
              userId,
              sessionId: null, // new session to avoid context contamination
            }),
          }
        );

        const durationMs = Date.now() - startTime;

        if (!response.ok) {
          const errText = await response.text();
          // Log failure
          await supabase.from("agent_orchestration_logs").insert({
            caller_agent_slug: "campaign-director",
            called_agent_slug: agent_slug,
            task,
            context: callContext,
            status: "failed",
            error_message: errText,
            duration_ms: durationMs,
            parent_session_id: sessionId,
          });
          return JSON.stringify({ success: false, error: `Falha ao chamar agente ${agent_slug}` });
        }

        const result = await response.json();
        const output = result.response || "";

        // Log success
        await supabase.from("agent_orchestration_logs").insert({
          caller_agent_slug: "campaign-director",
          called_agent_slug: agent_slug,
          task,
          context: callContext,
          output_summary: output.substring(0, 500),
          status: "success",
          duration_ms: durationMs,
          parent_session_id: sessionId,
        });

        return JSON.stringify({
          success: true,
          agent: agent_slug,
          output,
        });
      } catch (err) {
        const durationMs = Date.now() - startTime;
        await supabase.from("agent_orchestration_logs").insert({
          caller_agent_slug: "campaign-director",
          called_agent_slug: agent_slug,
          task,
          context: callContext,
          status: "failed",
          error_message: err instanceof Error ? err.message : "Unknown error",
          duration_ms: durationMs,
          parent_session_id: sessionId,
        });
        return JSON.stringify({ success: false, error: `Erro ao chamar agente ${agent_slug}: ${err}` });
      }
    }

    default:
      return JSON.stringify({ error: `Ferramenta '${toolName}' não reconhecida` });
  }
}

// ─── Main Handler ───
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const { userMessage, sessionId, agentSlug, brandId, userId, attachments } = await req.json();

    if (!userId || !userMessage || !agentSlug) {
      return new Response(JSON.stringify({ error: "userId, userMessage, and agentSlug are required" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: agent, error: agentErr } = await supabase
      .from("ai_agents").select("*").eq("slug", agentSlug).eq("active", true).single();

    if (agentErr || !agent) {
      return new Response(JSON.stringify({ error: `Agente '${agentSlug}' não encontrado ou inativo.` }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch Anthropic API key from ai_api_keys (per user)
    const { data: anthropicKey } = await supabase
      .from("ai_api_keys").select("api_key")
      .eq("provider", "anthropic").eq("is_active", true).limit(1).maybeSingle();

    if (!anthropicKey) {
      return new Response(JSON.stringify({ error: "Chave API da Anthropic não configurada. Cadastre sua chave nas configurações do Marketing." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let systemPrompt = agent.system_prompt;
    if (brandId) {
      const { data: bp } = await supabase.from("brand_profiles").select("*").eq("id", brandId).maybeSingle();
      if (bp) {
        const brandContext = [
          `\n\n=== PERFIL DA MARCA: ${bp.account_name || bp.brand_name} ===`,
          bp.tom_de_voz ? `Tom de Voz: ${bp.tom_de_voz}` : "",
          bp.tom_descricao ? `Descrição do Tom: ${bp.tom_descricao}` : "",
          bp.vocabulario_chave ? `Vocabulário-Chave: ${bp.vocabulario_chave}` : "",
          bp.metaforas_estrategicas ? `Metáforas Estratégicas: ${bp.metaforas_estrategicas}` : "",
          bp.estrutura_visual ? `Estrutura Visual: ${bp.estrutura_visual}` : "",
          bp.alertas_nao_usar ? `NÃO USAR: ${bp.alertas_nao_usar}` : "",
          bp.frases_exemplo ? `Frases Exemplo: ${bp.frases_exemplo}` : "",
          bp.publico_alvo ? `Público-Alvo: ${bp.publico_alvo}` : "",
          bp.segmento ? `Segmento: ${bp.segmento}` : "",
          bp.persona_dores ? `Dores do Público: ${bp.persona_dores}` : "",
          bp.persona_desejos ? `Desejos do Público: ${bp.persona_desejos}` : "",
          bp.persona_objecoes ? `Objeções: ${bp.persona_objecoes}` : "",
        ].filter(Boolean).join("\n");
        systemPrompt += brandContext;
      }
    }

    // Detect structured message from orchestration (call_agent)
    let processedMessage = userMessage;
    try {
      const parsed = JSON.parse(userMessage);
      if (parsed.task && parsed.context && parsed.context.called_by) {
        processedMessage = parsed.task;
        const sc = parsed.context;

        systemPrompt += `\n\n# CONTEXTO DA CHAMADA ORQUESTRADA\n\n`;
        systemPrompt += `Você está sendo chamado pelo agente: ${sc.called_by}\n\n`;

        if (sc.briefing) {
          systemPrompt += `## Briefing da campanha:\n${JSON.stringify(sc.briefing, null, 2)}\n\n`;
        }
        if (sc.main_hook) {
          systemPrompt += `## Gancho central (usar em todas as peças):\n${sc.main_hook}\n\n`;
        }
        if (sc.positioning) {
          systemPrompt += `## Posicionamento aprovado:\n${sc.positioning}\n\n`;
        }
        if (sc.previous_pieces) {
          systemPrompt += `## Peças já produzidas (para manter consistência):\n${JSON.stringify(sc.previous_pieces, null, 2)}\n\n`;
        }
      }
    } catch (_) {
      // Normal text message, no parsing needed
    }

    let session: any = null;
    let messages: any[] = [];

    if (sessionId) {
      const { data } = await supabase.from("ai_sessions").select("*").eq("id", sessionId).eq("user_id", userId).single();
      if (data) {
        session = data;
        messages = Array.isArray(data.messages) ? data.messages : [];
      }
    }

    if (!session) {
      const title = userMessage.substring(0, 60) + (userMessage.length > 60 ? "..." : "");
      const { data: newSession, error: sessionErr } = await supabase.from("ai_sessions").insert({
        user_id: userId,
        agent_id: agent.id,
        brand_id: brandId || null,
        title,
        messages: [],
        status: "active",
      }).select("id").single();

      if (sessionErr) {
        console.error("ai-orchestrator: Failed to create session:", sessionErr.message, sessionErr.details);
        return new Response(JSON.stringify({ error: `Falha ao criar sessão: ${sessionErr.message}` }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      session = newSession;
      if (!session) {
        console.error("ai-orchestrator: Session insert returned null without error");
        return new Response(JSON.stringify({ error: "Falha ao criar sessão de chat." }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Build user content blocks (Anthropic native format)
    const contentBlocks: any[] = [];
    if (attachments?.length) {
      for (const att of attachments) {
        if (typeof att === "string" && att.startsWith("data:image")) {
          const match = att.match(/^data:(image\/\w+);base64,(.+)$/);
          if (match) {
            contentBlocks.push({
              type: "image",
              source: { type: "base64", media_type: match[1], data: match[2] },
            });
          }
        }
      }
    }
    contentBlocks.push({ type: "text", text: processedMessage });

    messages.push({ role: "user", content: contentBlocks });

    const contextMessages = messages.slice(-30);

    const agentToolNames: string[] = Array.isArray(agent.tools) ? agent.tools : JSON.parse(agent.tools || "[]");
    const tools = agentToolNames
      .map((name: string) => TOOL_DEFINITIONS[name])
      .filter(Boolean);

    // Build Anthropic messages (filter out system, keep user/assistant)
    const anthropicMessages: any[] = contextMessages.map((m: any) => {
      // Pass through as-is for Anthropic format (content blocks)
      return { role: m.role, content: m.content };
    });

    let currentMessages = [...anthropicMessages];
    let finalResponse = "";
    let mediaUrls: string[] = [];
    let reportHtml: string | null = null;
    let reportId: string | null = null;
    const startedAt = Date.now();
    let hitDeadline = false;

    for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
      // Soft deadline guard — leave time to persist session and respond
      if (Date.now() - startedAt > SOFT_DEADLINE_MS) {
        console.warn(`ai-orchestrator: soft deadline reached at loop ${loop}, breaking out.`);
        hitDeadline = true;
        break;
      }

      // Use smaller token budget on intermediate iterations to keep latency low
      const isLikelyFinal = loop === MAX_TOOL_LOOPS - 1;
      const body: any = {
        model: ANTHROPIC_MODEL,
        system: systemPrompt,
        messages: currentMessages,
        max_tokens: isLikelyFinal ? 4096 : 2048,
      };

      if (tools.length > 0) {
        body.tools = tools;
      }

      const aiRes = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicKey.api_key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });

      if (!aiRes.ok) {
        const errText = await aiRes.text();
        if (aiRes.status === 429) throw new Error("Rate limit excedido. Tente novamente em alguns segundos.");
        if (aiRes.status === 401) throw new Error("Chave API da Anthropic inválida. Verifique nas configurações.");
        throw new Error(`Anthropic API error ${aiRes.status}: ${errText}`);
      }

      const result = await aiRes.json();
      const stopReason = result.stop_reason;
      const contentArray = result.content || [];

      // Add assistant response to messages
      currentMessages.push({ role: "assistant", content: contentArray });

      if (stopReason === "tool_use") {
        // Process tool calls
        const toolResults: any[] = [];
        for (const block of contentArray) {
          if (block.type === "tool_use") {
            const toolName = block.name;
            const toolInput = block.input || {};

            console.log(`Executing tool: ${toolName}`, JSON.stringify(toolInput).substring(0, 200));

            let toolResult: string;
            try {
              toolResult = await withTimeout(
                executeTool(toolName, toolInput, supabase, userId, brandId, session?.id),
                TOOL_TIMEOUT_MS,
                `tool ${toolName}`
              );
            } catch (toolErr: any) {
              console.error(`Tool ${toolName} failed:`, toolErr?.message || toolErr);
              toolResult = JSON.stringify({
                success: false,
                error: toolErr?.message || "Tool execution failed",
                tool: toolName,
              });
            }

            // Strip large payloads (HTML) from what is sent BACK to the model:
            // they explode token usage and latency. Keep them only on our side.
            let toolResultForModel = toolResult;
            try {
              const parsed = JSON.parse(toolResult);
              if (parsed.image_url) mediaUrls.push(parsed.image_url);
              if (parsed.video_url) mediaUrls.push(parsed.video_url);
              if (parsed.html_content) reportHtml = parsed.html_content;
              if (parsed.report_id) reportId = parsed.report_id;

              if (parsed.html_content) {
                const stripped = { ...parsed };
                delete stripped.html_content;
                stripped.message = stripped.message || "Relatório gerado com sucesso. HTML omitido aqui para economizar tokens.";
                toolResultForModel = JSON.stringify(stripped);
              }
            } catch (_) { }

            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: toolResultForModel,
            });
          }
        }

        // Add tool results as a user message
        currentMessages.push({ role: "user", content: toolResults });
      } else {
        // Extract text from content blocks
        finalResponse = contentArray
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n");
        break;
      }
    }

    if (hitDeadline && !finalResponse) {
      finalResponse =
        "Cheguei perto do limite de tempo de processamento antes de concluir a resposta. " +
        "Tente reformular a pergunta de forma mais específica (por exemplo, foque em um único canal, período curto ou uma seção do relatório).";
    }

    messages.push({ role: "assistant", content: finalResponse });

    await supabase.from("ai_sessions").update({
      messages: messages.slice(-60),
      updated_at: new Date().toISOString(),
    }).eq("id", session.id);

    // Cost tracking
    const costUsd = 0.005;
    const monthStr = new Date().toISOString().slice(0, 7) + "-01";
    const { data: existing } = await supabase.from("ai_cost_tracking")
      .select("*").eq("user_id", userId).eq("month", monthStr).eq("provider", "anthropic").maybeSingle();

    if (existing) {
      await supabase.from("ai_cost_tracking").update({
        total_generations: (existing.total_generations || 0) + 1,
        total_cost_usd: (existing.total_cost_usd || 0) + costUsd,
        total_cost_brl: (existing.total_cost_brl || 0) + costUsd * 5.5,
      }).eq("id", existing.id);
    } else {
      await supabase.from("ai_cost_tracking").insert({
        user_id: userId, month: monthStr, provider: "anthropic",
        model: ANTHROPIC_MODEL, total_generations: 1,
        total_cost_usd: costUsd, total_cost_brl: costUsd * 5.5,
      });
    }

    return new Response(JSON.stringify({
      success: true,
      sessionId: session.id,
      agentName: agent.name,
      agentIcon: agent.icon,
      response: finalResponse,
      mediaUrls,
      reportHtml,
      reportId,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e) {
    console.error("ai-orchestrator error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
