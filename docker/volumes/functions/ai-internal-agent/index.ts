import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { AcessoNegado, exigirAcesso, respostaAcessoNegado } from "../_shared/acesso.ts";

import { contextoAutorizado, listasAutorizadas, metricasAutorizadas, type ContextoIa } from "./acesso.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");

const SYSTEM_PROMPT = `Você é o assistente IA interno da PPGVET Educação. Você atua dentro do chat de cada setor.

REGRAS:
- Seja direto e objetivo — estamos no chat de trabalho
- Use formatação visual: **negrito** em dados importantes
- Quando mostrar tarefas, inclua: título, responsável, prazo, status
- Quando mostrar métricas, use números com comparativo
- Quando identificar problemas, alerte proativamente
- Responda sempre em português brasileiro

CAPACIDADES:
- Consultar tarefas do setor (filtrar por status, responsável, projeto, prazo)
- Consultar atividades realizadas (quem fez o quê, quando)
- Consultar métricas de produtividade
- Criar novas tarefas por linguagem natural
- Atualizar status e responsável de tarefas
- Gerar resumos e relatórios`;

const TOOLS = [
  {
    name: "query_tasks",
    description: "Consulta tarefas do setor com filtros",
    input_schema: {
      type: "object",
      properties: {
        department_id: { type: "string" },
        status: { type: "string", enum: ["a_fazer", "em_andamento", "em_revisao", "concluido", "all"] },
        assignee_name: { type: "string" },
        is_overdue: { type: "boolean" },
        due_date_range: { type: "string", enum: ["today", "this_week", "overdue"] },
        limit: { type: "number" },
      },
      required: ["department_id"],
    },
  },
  {
    name: "query_activity",
    description: "Consulta atividades realizadas no setor",
    input_schema: {
      type: "object",
      properties: {
        department_id: { type: "string" },
        user_name: { type: "string" },
        period: { type: "string", enum: ["today", "yesterday", "this_week"] },
      },
      required: ["department_id", "period"],
    },
  },
  {
    name: "query_metrics",
    description: "Consulta métricas de produtividade",
    input_schema: {
      type: "object",
      properties: {
        department_id: { type: "string" },
        user_name: { type: "string" },
      },
      required: ["department_id"],
    },
  },
  {
    name: "create_task",
    description: "Cria uma nova tarefa",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        list_id: { type: "string" },
        assignee_name: { type: "string" },
        due_date: { type: "string" },
        priority: { type: "string", enum: ["urgent", "high", "normal", "low"] },
      },
      required: ["title"],
    },
  },
];

export async function executeTool(toolName: string, input: any, cliente: any, contexto: ContextoIa): Promise<string> {
  try {
    const listas = await listasAutorizadas(cliente, contexto);
    if (!listas.size) return "Este canal não tem listas autorizadas para esta consulta.";
    const idsListas = [...listas.keys()];
    input = { ...input, department_id: contexto.departamentoId };
    switch (toolName) {
      case "query_tasks": {
        let query = cliente
          .from("gt_tasks")
          .select("id, title, priority, due_date, completed_at, assignee_id, status_id, is_archived, gt_task_lists!inner(id, gt_projects!inner(department_id))")
          .eq("is_archived", false)
          .in("list_id", idsListas)
          .eq("gt_task_lists.gt_projects.department_id", input.department_id)
          .order("created_at", { ascending: false })
          .limit(Math.max(1, Math.min(100, Number(input.limit) || 20)));

        if (input.is_overdue) {
          query = query.lt("due_date", new Date().toISOString().slice(0, 10)).is("completed_at", null);
        }
        if (input.due_date_range === "today") {
          const today = new Date().toISOString().slice(0, 10);
          query = query.eq("due_date", today);
        }
        if (input.due_date_range === "overdue") {
          query = query.lt("due_date", new Date().toISOString().slice(0, 10)).is("completed_at", null);
        }

        const { data, error } = await query;
        if (error) return `Erro: ${error.message}`;

        // Get assignee names
        const assigneeIds = [...new Set((data || []).map((t: any) => t.assignee_id).filter(Boolean))];
        let nameMap: Record<string, string> = {};
        if (assigneeIds.length) {
          const { data: profiles } = await cliente.from("profiles").select("id, name").in("id", assigneeIds);
          if (profiles) nameMap = Object.fromEntries(profiles.map((p: any) => [p.id, p.name]));
        }

        const tasks = (data || []).map((t: any) => ({
          titulo: t.title,
          prioridade: t.priority,
          prazo: t.due_date,
          responsavel: t.assignee_id ? nameMap[t.assignee_id] || "N/A" : "Sem responsável",
          status: t.completed_at ? "Concluída" : t.due_date && t.due_date < new Date().toISOString().slice(0, 10) ? "Atrasada" : "Em andamento",
        }));

        return JSON.stringify({ total: tasks.length, tarefas: tasks });
      }

      case "query_activity": {
        let since: Date;
        if (input.period === "today") {
          since = new Date();
          since.setHours(0, 0, 0, 0);
        } else if (input.period === "yesterday") {
          since = new Date();
          since.setDate(since.getDate() - 1);
          since.setHours(0, 0, 0, 0);
        } else {
          since = new Date();
          since.setDate(since.getDate() - 7);
        }

        const { data, error } = await cliente
          .from("gt_activity_log")
          .select("action, field_changed, old_value, new_value, created_at, user_id, task_id, gt_tasks!inner(list_id)")
          .in("gt_tasks.list_id", idsListas)
          .gte("created_at", since.toISOString())
          .order("created_at", { ascending: false })
          .limit(30);
        if (error) return `Erro: ${error.message}`;

        const userIds = [...new Set((data || []).map((a: any) => a.user_id).filter(Boolean))];
        let nameMap: Record<string, string> = {};
        if (userIds.length) {
          const { data: profiles } = await cliente.from("profiles").select("id, name").in("id", userIds);
          if (profiles) nameMap = Object.fromEntries(profiles.map((p: any) => [p.id, p.name]));
        }

        const activities = (data || []).map((a: any) => ({
          usuario: a.user_id ? nameMap[a.user_id] || "N/A" : "Sistema",
          acao: a.action,
          campo: a.field_changed,
          de: a.old_value,
          para: a.new_value,
          quando: a.created_at,
        }));

        return JSON.stringify({ total: activities.length, atividades: activities });
      }

      case "query_metrics": {
        return JSON.stringify(await metricasAutorizadas(cliente, idsListas, input.user_name));
      }

      case "create_task": {
        // A IA não escolhe uma lista fora do contexto nem cria em lista só de leitura.
        const listId = input.list_id || [...listas].find(([, p]) => p === "edit" || p === "full_edit")?.[0];
        if (!listId || !["edit", "full_edit"].includes(listas.get(listId) ?? "")) {
          return "Sem permissão para criar tarefa nesta lista.";
        }

        // Find assignee by name
        let assigneeId = null;
        if (input.assignee_name) {
          const { data: profiles } = await cliente
            .from("profiles")
            .select("id, name")
            .ilike("name", `%${input.assignee_name}%`)
            .limit(1);
          if (profiles && profiles.length > 0) assigneeId = profiles[0].id;
        }

        const { data, error } = await cliente.from("gt_tasks").insert({
          list_id: listId,
          created_by: contexto.usuarioId,
          title: input.title,
          assignee_id: assigneeId,
          priority: input.priority || "normal",
          due_date: input.due_date || null,
        }).select().single();

        if (error) return `Erro ao criar tarefa: ${error.message}`;
        return JSON.stringify({ sucesso: true, tarefa: { id: data.id, titulo: data.title } });
      }

      default:
        return `Tool desconhecida: ${toolName}`;
    }
  } catch (e: any) {
    return `Erro na execução: ${e.message}`;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  let quem: Awaited<ReturnType<typeof exigirAcesso>>;
  try { quem = await exigirAcesso(req, { usuario: true }); }
  catch (e) { return respostaAcessoNegado(e, corsHeaders); }

  try {
    if (quem.tipo !== "usuario") throw new AcessoNegado(403, "Login necessário.");
    const { message, channel_id } = await req.json();
    if (!message) return new Response(JSON.stringify({ error: "Missing message" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    if (typeof channel_id !== "string" || !channel_id) return new Response(JSON.stringify({ error: "Informe o canal." }), { status: 400, headers: corsHeaders });
    const comoUsuario = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: `Bearer ${quem.token}` } }, auth: { persistSession: false },
    });
    const contexto = await contextoAutorizado(comoUsuario, quem.usuarioId, channel_id);

    // Use Anthropic if key available, otherwise Lovable AI Gateway
    let aiResponse: string;

    if (ANTHROPIC_API_KEY) {
      aiResponse = await callAnthropic(message, contexto, comoUsuario);
    } else if (LOVABLE_API_KEY) {
      aiResponse = await callLovableAI(message, contexto, comoUsuario);
    } else {
      aiResponse = "⚠️ O agente IA não está configurado. Configure a chave ANTHROPIC_API_KEY ou LOVABLE_API_KEY.";
    }

    // A service role só registra a resposta, via RPC que revalida o canal na transação.
    // Nenhuma ferramenta da IA recebe este cliente privilegiado.
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { error: erroResposta } = await admin.rpc("gt_ia_registrar_resposta", {
      p_canal: contexto.canalId, p_usuario: contexto.usuarioId, p_conteudo: aiResponse,
    });
    if (erroResposta) throw new AcessoNegado(erroResposta.code === "42501" ? 403 : 503, "Não foi possível registrar a resposta neste canal.");

    return new Response(JSON.stringify({ response: aiResponse }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    if (e instanceof AcessoNegado) return respostaAcessoNegado(e, corsHeaders);
    console.error("ai-internal-agent error:", e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function callAnthropic(message: string, contexto: ContextoIa, cliente: any): Promise<string> {
  const messages: any[] = [{ role: "user", content: message }];
  let maxIterations = 5;

  while (maxIterations-- > 0) {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        // claude-sonnet-4-20250514 (Sonnet 4.0) foi descontinuado em 15/06/2026 → 404.
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages,
        tools: TOOLS,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("Anthropic error:", response.status, text);
      return "Erro ao processar sua solicitação. Tente novamente.";
    }

    const data = await response.json();

    if (data.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: data.content });
      const toolResults: any[] = [];
      for (const block of data.content) {
        if (block.type === "tool_use") {
          const input = { ...block.input, department_id: contexto.departamentoId };
          const result = await executeTool(block.name, input, cliente, contexto);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
        }
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // Extract text response
    const textBlock = data.content?.find((b: any) => b.type === "text");
    return textBlock?.text || "Sem resposta.";
  }

  return "Processamento interrompido após muitas iterações.";
}

async function callLovableAI(message: string, contexto: ContextoIa, cliente: any): Promise<string> {
  const toolsDef = TOOLS.map(t => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  const messages: any[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: message },
  ];
  let maxIterations = 5;

  while (maxIterations-- > 0) {
    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages,
        tools: toolsDef,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("AI Gateway error:", response.status, text);
      return "Erro ao processar sua solicitação. Tente novamente.";
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    if (!choice) return "Sem resposta.";

    const msg = choice.message;
    messages.push(msg);

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        const input = { ...JSON.parse(tc.function.arguments), department_id: contexto.departamentoId };
        const result = await executeTool(tc.function.name, input, cliente, contexto);
        messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      }
      continue;
    }

    return msg.content || "Sem resposta.";
  }

  return "Processamento interrompido após muitas iterações.";
}
