import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      return new Response(JSON.stringify({ error: "LOVABLE_API_KEY não configurada." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json().catch(() => ({}));
    const performers = (body?.performers || []) as {
      user_id: string; name: string; department_name?: string; completed_this_month: number;
    }[];

    if (!performers.length) {
      return new Response(JSON.stringify({ error: "performers obrigatório" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const now = new Date();
    const since60 = new Date(now); since60.setDate(since60.getDate() - 60);
    const since30 = new Date(now); since30.setDate(since30.getDate() - 30);
    const since7 = new Date(now); since7.setDate(since7.getDate() - 7);
    // Início do mês atual em SP (UTC-3 simplificado)
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 3, 0, 0));

    const userSummaries: any[] = [];
    for (const p of performers) {
      if (!p.user_id) continue;
      let multiIds: string[] = [];
      try {
        const { data: multiRows } = await supabase
          .from("gt_task_assignees")
          .select("task_id")
          .eq("user_id", p.user_id);
        multiIds = [...new Set((multiRows || []).map((r: any) => r.task_id))];
      } catch (_) { /* ignore */ }

      let tasksQuery = supabase
        .from("gt_tasks")
        .select("id,title,description,priority,estimated_hours,time_spent_seconds,created_at,completed_at")
        .gte("completed_at", since60.toISOString())
        .not("completed_at", "is", null)
        .limit(500);

      if (multiIds.length > 0) {
        tasksQuery = tasksQuery.or(`assignee_id.eq.${p.user_id},id.in.(${multiIds.join(",")})`);
      } else {
        tasksQuery = tasksQuery.eq("assignee_id", p.user_id);
      }

      const { data: tasks, error: tErr } = await tasksQuery;
      if (tErr) console.error("tasks error for", p.name, tErr.message);

      const t = tasks || [];
      const sample = t.slice(0, 50).map((x: any) => ({
        title: x.title,
        desc_len: (x.description || "").length,
        priority: x.priority,
        estimated_hours: x.estimated_hours,
        time_spent_min: x.time_spent_seconds ? Math.round(x.time_spent_seconds / 60) : null,
        days_open: x.created_at && x.completed_at
          ? Math.max(0, Math.round((new Date(x.completed_at).getTime() - new Date(x.created_at).getTime()) / 86400000))
          : null,
        completed_at: x.completed_at,
      }));

      const withDays = sample.filter(s => s.days_open !== null);
      const avgDays = withDays.length ? withDays.reduce((a, s) => a + (s.days_open || 0), 0) / withDays.length : 0;
      const avgDescLen = sample.length ? sample.reduce((a, s) => a + s.desc_len, 0) / sample.length : 0;
      const sameDay = sample.filter(s => s.days_open === 0).length;

      // Fechamentos no mês atual + últimos 7 dias
      const monthMs = monthStart.getTime();
      const week7Ms = since7.getTime();
      const completedMonth = t.filter((x: any) => x.completed_at && new Date(x.completed_at).getTime() >= monthMs).length;
      const completedWeek = t.filter((x: any) => x.completed_at && new Date(x.completed_at).getTime() >= week7Ms).length;
      // Média de tarefas/dia nos últimos 30 dias
      const completed30d = t.filter((x: any) => x.completed_at && new Date(x.completed_at).getTime() >= since30.getTime()).length;
      const avgPerDay30 = +(completed30d / 30).toFixed(2);
      // Média semanal (últimos 60 dias / ~8.57 semanas)
      const avgPerWeek = +(t.length / (60 / 7)).toFixed(2);

      // Interações em canais (gt_chat_messages) últimos 30 dias
      let chatCount30 = 0, mentionsReceived30 = 0, taskCommentCount30 = 0;
      try {
        const { count: cc } = await supabase
          .from("gt_chat_messages")
          .select("id", { count: "exact", head: true })
          .eq("user_id", p.user_id)
          .is("deleted_at", null)
          .gte("created_at", since30.toISOString());
        chatCount30 = cc || 0;
      } catch (_) { /* ignore */ }

      try {
        const { count: tc } = await supabase
          .from("gt_task_comments")
          .select("id", { count: "exact", head: true })
          .eq("user_id", p.user_id)
          .gte("created_at", since30.toISOString());
        taskCommentCount30 = tc || 0;
      } catch (_) { /* ignore */ }

      // Menções recebidas (no chat e comentários) últimos 30 dias
      try {
        const { count: mc } = await supabase
          .from("gt_chat_messages")
          .select("id", { count: "exact", head: true })
          .contains("mentions", [p.user_id])
          .is("deleted_at", null)
          .gte("created_at", since30.toISOString());
        mentionsReceived30 = mc || 0;
      } catch (_) { /* ignore */ }

      userSummaries.push({
        name: p.name,
        department: p.department_name,
        completed_this_month: completedMonth,
        completed_last_7d: completedWeek,
        completed_last_30d: completed30d,
        total_completed_60d: t.length,
        avg_tasks_per_day_30d: avgPerDay30,
        avg_tasks_per_week_60d: avgPerWeek,
        avg_days_to_complete: Number(avgDays.toFixed(1)),
        avg_description_length: Math.round(avgDescLen),
        same_day_completions: sameDay,
        chat_messages_30d: chatCount30,
        task_comments_30d: taskCommentCount30,
        mentions_received_30d: mentionsReceived30,
        engagement_score: chatCount30 + taskCommentCount30,
        sample_tasks: sample.slice(0, 15),
      });
    }

    const system = `Você é um analista de produtividade. Avalie os "Top Performers" de um sistema de gestão de tarefas e identifique se a alta contagem de tarefas representa produtividade real ou tarefas pequenas/triviais (títulos vagos, descrições curtas, conclusão no mesmo dia, sem horas estimadas).

Considere também o ENGAJAMENTO da pessoa em canais e comentários de tarefas (chat_messages_30d, task_comments_30d, mentions_received_30d). Baixa colaboração + muitas tarefas curtas = produtividade inflada. Alto volume de tarefas + alto engajamento + tarefas com horas estimadas/tempo gasto = produtividade real.

Para cada usuário retorne:
- Avaliação resumida (2-3 frases)
- Indicador "Produtividade Real" (Alta / Média / Baixa / Inflada)
- Volume: fechamentos do mês atual, média de tarefas/dia (30d) e média semanal
- Engajamento: mensagens em canais + comentários em tarefas (30d)
- Justificativa baseada nos dados
- Recomendação curta para o gestor

Responda em Markdown bem formatado e em português.`;

    const userMsg = `Analise estes top performers (últimos 60 dias):\n\n${JSON.stringify(userSummaries, null, 2)}`;

    const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Lovable-API-Key": LOVABLE_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: system },
          { role: "user", content: userMsg },
        ],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("Lovable AI error:", resp.status, errText);
      const status = resp.status === 429 ? 429 : resp.status === 402 ? 402 : 500;
      const msg = resp.status === 429
        ? "Limite de uso atingido. Tente novamente em instantes."
        : resp.status === 402
        ? "Créditos de IA esgotados. Adicione créditos em Settings → Workspace → Usage."
        : `Erro IA (${resp.status})`;
      return new Response(JSON.stringify({ error: msg }), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || "";

    return new Response(JSON.stringify({ analysis: text, summaries: userSummaries }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("gt-analyze-top-performers error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Erro desconhecido" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
