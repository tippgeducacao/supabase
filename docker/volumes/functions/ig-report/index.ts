import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const getErrorMessage = (err: unknown) => err instanceof Error ? err.message : String(err);

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { account_id, days } = await req.json();
    if (!account_id || !days) {
      return new Response(JSON.stringify({ error: "account_id and days required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Date ranges
    const now = new Date();
    const currentFrom = new Date(now);
    currentFrom.setDate(currentFrom.getDate() - days);
    const previousFrom = new Date(currentFrom);
    previousFrom.setDate(previousFrom.getDate() - days);

    const fmt = (d: Date) => d.toISOString();

    // Fetch account info
    const { data: account } = await supabase
      .from("ig_accounts")
      .select("*")
      .eq("id", account_id)
      .single();

    if (!account) {
      return new Response(JSON.stringify({ error: "Account not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch current period posts
    const { data: currentPosts } = await supabase
      .from("ig_post_metrics")
      .select("*")
      .eq("account_id", account_id)
      .gte("timestamp", fmt(currentFrom))
      .lte("timestamp", fmt(now))
      .order("timestamp", { ascending: false });

    // Fetch previous period posts
    const { data: previousPosts } = await supabase
      .from("ig_post_metrics")
      .select("*")
      .eq("account_id", account_id)
      .gte("timestamp", fmt(previousFrom))
      .lt("timestamp", fmt(currentFrom))
      .order("timestamp", { ascending: false });

    const cp = currentPosts || [];
    const pp = previousPosts || [];

    // Aggregate current period
    const currentMetrics = {
      reach: cp.reduce((s, p) => s + (p.reach || 0), 0),
      shares: cp.reduce((s, p) => s + (p.shares || 0), 0),
      likes: cp.reduce((s, p) => s + (p.likes || 0), 0),
      comments: cp.reduce((s, p) => s + (p.comments || 0), 0),
      saves: cp.reduce((s, p) => s + (p.saves || 0), 0),
      impressions: cp.reduce((s, p) => s + (p.impressions || 0), 0),
      postCount: cp.length,
    };

    // Aggregate previous period
    const previousMetrics = {
      reach: pp.reduce((s, p) => s + (p.reach || 0), 0),
      shares: pp.reduce((s, p) => s + (p.shares || 0), 0),
      likes: pp.reduce((s, p) => s + (p.likes || 0), 0),
      comments: pp.reduce((s, p) => s + (p.comments || 0), 0),
      saves: pp.reduce((s, p) => s + (p.saves || 0), 0),
      impressions: pp.reduce((s, p) => s + (p.impressions || 0), 0),
      postCount: pp.length,
    };

    // Top 5 by reach
    const top5Reach = [...cp].sort((a, b) => (b.reach || 0) - (a.reach || 0)).slice(0, 5);
    // Top 5 by likes
    const top5Likes = [...cp].sort((a, b) => (b.likes || 0) - (a.likes || 0)).slice(0, 5);

    // Fetch stories for the current period
    const { data: currentStories } = await supabase
      .from("ig_story_metrics")
      .select("*")
      .eq("account_id", account_id)
      .gte("timestamp", fmt(currentFrom))
      .lte("timestamp", fmt(now));

    const { data: previousStories } = await supabase
      .from("ig_story_metrics")
      .select("*")
      .eq("account_id", account_id)
      .gte("timestamp", fmt(previousFrom))
      .lt("timestamp", fmt(currentFrom));

    const cs = currentStories || [];
    const ps = previousStories || [];

    const currentStoryMetrics = {
      storyCount: cs.length,
      reach: cs.reduce((s, st) => s + (st.reach || 0), 0),
      views: cs.reduce((s, st) => s + (st.views || 0), 0),
      replies: cs.reduce((s, st) => s + (st.replies || 0), 0),
      profileVisits: cs.reduce((s, st) => s + (st.profile_visits || 0), 0),
      totalInteractions: cs.reduce((s, st) => s + (st.total_interactions || 0), 0),
    };

    const previousStoryMetrics = {
      storyCount: ps.length,
      reach: ps.reduce((s, st) => s + (st.reach || 0), 0),
      views: ps.reduce((s, st) => s + (st.views || 0), 0),
      replies: ps.reduce((s, st) => s + (st.replies || 0), 0),
      profileVisits: ps.reduce((s, st) => s + (st.profile_visits || 0), 0),
      totalInteractions: ps.reduce((s, st) => s + (st.total_interactions || 0), 0),
    };

    // Build AI prompt
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    let aiInsights = "";

    if (LOVABLE_API_KEY) {
      const prompt = `Você é um especialista em marketing digital e Instagram. Analise as métricas abaixo de um perfil do Instagram e forneça um relatório executivo em português brasileiro.

Perfil: @${account.username || account.account_name}
Período analisado: últimos ${days} dias
Seguidores: ${account.followers_count || 0}

MÉTRICAS DO PERÍODO ATUAL:
- Alcance total: ${currentMetrics.reach}
- Impressões: ${currentMetrics.impressions}
- Compartilhamentos: ${currentMetrics.shares}
- Curtidas: ${currentMetrics.likes}
- Comentários: ${currentMetrics.comments}
- Salvamentos: ${currentMetrics.saves}
- Número de posts: ${currentMetrics.postCount}

MÉTRICAS DE STORIES (PERÍODO ATUAL):
- Número de stories: ${currentStoryMetrics.storyCount}
- Alcance dos stories: ${currentStoryMetrics.reach}
- Visualizações dos stories: ${currentStoryMetrics.views}
- Respostas: ${currentStoryMetrics.replies}
- Visitas ao perfil (via stories): ${currentStoryMetrics.profileVisits}
- Interações totais: ${currentStoryMetrics.totalInteractions}

MÉTRICAS DO PERÍODO ANTERIOR (${days} dias antes):
- Alcance total: ${previousMetrics.reach}
- Impressões: ${previousMetrics.impressions}
- Compartilhamentos: ${previousMetrics.shares}
- Curtidas: ${previousMetrics.likes}
- Comentários: ${previousMetrics.comments}
- Salvamentos: ${previousMetrics.saves}
- Número de posts: ${previousMetrics.postCount}

MÉTRICAS DE STORIES (PERÍODO ANTERIOR):
- Número de stories: ${previousStoryMetrics.storyCount}
- Alcance dos stories: ${previousStoryMetrics.reach}
- Visualizações dos stories: ${previousStoryMetrics.views}
- Respostas: ${previousStoryMetrics.replies}
- Visitas ao perfil (via stories): ${previousStoryMetrics.profileVisits}
- Interações totais: ${previousStoryMetrics.totalInteractions}

TOP 5 CONTEÚDOS POR ALCANCE:
${top5Reach.map((p, i) => `${i + 1}. ${p.media_type || "POST"} - Alcance: ${p.reach || 0}, Curtidas: ${p.likes || 0}, Legenda: "${(p.caption || "").slice(0, 100)}"`).join("\n")}

TOP 5 CONTEÚDOS POR CURTIDAS:
${top5Likes.map((p, i) => `${i + 1}. ${p.media_type || "POST"} - Curtidas: ${p.likes || 0}, Alcance: ${p.reach || 0}, Legenda: "${(p.caption || "").slice(0, 100)}"`).join("\n")}

Forneça exatamente estas seções (use esses títulos):

## RESUMO EXECUTIVO
Um parágrafo resumindo o desempenho geral do período.

## COMPARATIVO COM PERÍODO ANTERIOR
Compare as métricas e indique se houve crescimento ou queda (com percentuais).

## ANÁLISE DOS MELHORES CONTEÚDOS
Analise os top 5 conteúdos e identifique padrões de sucesso.

## DESEMPENHO DOS STORIES
Analise as métricas dos stories (alcance, visualizações, interações, visitas ao perfil) e compare com o período anterior. Dê insights sobre frequência e engajamento.

## SUGESTÕES DE MELHORIA
Liste 3-5 sugestões práticas e específicas para melhorar os resultados.

## CONTEÚDOS PARA REPLICAR
Baseado nos melhores conteúdos, sugira tipos de conteúdo para criar novamente.

## O QUE O PÚBLICO MAIS GOSTA
Analise os dados e descreva o que o público mais engaja e compartilha.`;

      try {
        const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${LOVABLE_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "google/gemini-3-flash-preview",
            messages: [
              { role: "system", content: "Você é um consultor de marketing digital especializado em Instagram. Responda sempre em português brasileiro de forma profissional e objetiva." },
              { role: "user", content: prompt },
            ],
          }),
        });

        if (aiResponse.ok) {
          const aiData = await aiResponse.json();
          aiInsights = aiData.choices?.[0]?.message?.content || "";
        } else {
          console.error("AI gateway error:", aiResponse.status);
          aiInsights = "Não foi possível gerar análise de IA neste momento.";
        }
      } catch (e) {
        console.error("AI call failed:", e);
        aiInsights = "Não foi possível gerar análise de IA neste momento.";
      }
    }

    const result = {
      account: {
        username: account.username || account.account_name,
        followers_count: account.followers_count || 0,
        profile_picture_url: account.profile_picture_url,
      },
      days,
      periodLabel: `${currentFrom.toLocaleDateString("pt-BR")} a ${now.toLocaleDateString("pt-BR")}`,
      previousPeriodLabel: `${previousFrom.toLocaleDateString("pt-BR")} a ${currentFrom.toLocaleDateString("pt-BR")}`,
      currentMetrics,
      previousMetrics,
      top5Reach: top5Reach.map((p) => ({
        media_type: p.media_type,
        caption: (p.caption || "").slice(0, 80),
        reach: p.reach || 0,
        likes: p.likes || 0,
        comments: p.comments || 0,
        shares: p.shares || 0,
        saves: p.saves || 0,
        permalink: p.permalink,
      })),
      top5Likes: top5Likes.map((p) => ({
        media_type: p.media_type,
        caption: (p.caption || "").slice(0, 80),
        reach: p.reach || 0,
        likes: p.likes || 0,
        comments: p.comments || 0,
        shares: p.shares || 0,
        saves: p.saves || 0,
        permalink: p.permalink,
      })),
      aiInsights,
      currentStoryMetrics,
      previousStoryMetrics,
    };

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("ig-report error:", e);
    return new Response(JSON.stringify({ error: getErrorMessage(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
