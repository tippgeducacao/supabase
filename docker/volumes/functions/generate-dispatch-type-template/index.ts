import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-sonnet-4-20250514";

function buildBrandContext(bp: any): string {
  if (!bp) return "Sem perfil de marca selecionado.";
  const lines: string[] = [];
  lines.push(`Marca: ${bp.brand_name || bp.account_name || "(sem nome)"}`);
  if (bp.segmento) lines.push(`Segmento: ${bp.segmento}`);
  if (bp.publico_alvo) lines.push(`Público-alvo: ${bp.publico_alvo}`);
  if (bp.tom_de_voz) lines.push(`Tom de voz: ${bp.tom_de_voz}`);
  if (bp.tom_descricao) lines.push(`Descrição do tom: ${bp.tom_descricao}`);
  if (bp.persona_dores) lines.push(`Dores da persona: ${bp.persona_dores}`);
  if (bp.persona_objecoes) lines.push(`Objeções: ${bp.persona_objecoes}`);
  if (bp.persona_desejos) lines.push(`Desejos: ${bp.persona_desejos}`);
  if (bp.persona_perfil_demografico) lines.push(`Perfil demográfico: ${bp.persona_perfil_demografico}`);
  if (bp.vocabulario_chave) lines.push(`Vocabulário-chave: ${bp.vocabulario_chave}`);
  if (Array.isArray(bp.termos_obrigatorios) && bp.termos_obrigatorios.length)
    lines.push(`Termos obrigatórios: ${bp.termos_obrigatorios.join(", ")}`);
  if (Array.isArray(bp.termos_proibidos) && bp.termos_proibidos.length)
    lines.push(`Termos proibidos: ${bp.termos_proibidos.join(", ")}`);
  if (bp.alertas_nao_usar) lines.push(`Alertas (não usar): ${bp.alertas_nao_usar}`);
  if (bp.frases_exemplo) lines.push(`Frases de exemplo: ${bp.frases_exemplo}`);
  return lines.join("\n");
}

function buildEventStructure(tipo: any, campos: any[]): string {
  const lines: string[] = [];
  lines.push(`Tipo: ${tipo.nome || ""}`);
  if (tipo.descricao) lines.push(`Descrição: ${tipo.descricao}`);
  if (tipo.objetivo) lines.push(`Objetivo: ${tipo.objetivo}`);
  if (Array.isArray(tipo.canais_habilitados) && tipo.canais_habilitados.length)
    lines.push(`Canais disponíveis: ${tipo.canais_habilitados.join(", ")}`);
  if (campos?.length) {
    lines.push("Campos do evento:");
    campos.forEach((c) => {
      lines.push(`  - {${c.key}} (${c.tipo})${c.obrigatorio ? " [obrigatório]" : ""}: ${c.label}${c.ajuda ? " — " + c.ajuda : ""}`);
    });
  }
  return lines.join("\n");
}

async function callAnthropicTool(opts: {
  apiKey: string;
  systemPrompt: string;
  userMessage: string;
  toolName: string;
  toolDescription: string;
  inputSchema: Record<string, any>;
}): Promise<{ result: any; inputTokens: number; outputTokens: number }> {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": opts.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 4000,
      system: opts.systemPrompt,
      tools: [
        {
          name: opts.toolName,
          description: opts.toolDescription,
          input_schema: opts.inputSchema,
        },
      ],
      tool_choice: { type: "tool", name: opts.toolName },
      messages: [{ role: "user", content: opts.userMessage }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const toolUse = (data?.content || []).find((b: any) => b.type === "tool_use");
  if (!toolUse) {
    throw new Error("IA não retornou tool_use esperado.");
  }
  return {
    result: toolUse.input,
    inputTokens: data?.usage?.input_tokens || 0,
    outputTokens: data?.usage?.output_tokens || 0,
  };
}

async function trackCost(
  supabase: any,
  userId: string | null,
  inputTokens: number,
  outputTokens: number,
  generations: number,
) {
  if (!userId) return;
  const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;
  const monthStr = new Date().toISOString().slice(0, 7) + "-01";
  const { data: existing } = await supabase
    .from("ai_cost_tracking")
    .select("*")
    .eq("user_id", userId)
    .eq("month", monthStr)
    .eq("provider", "anthropic")
    .maybeSingle();
  if (existing) {
    await supabase
      .from("ai_cost_tracking")
      .update({
        total_generations: (existing.total_generations || 0) + generations,
        total_cost_usd: (existing.total_cost_usd || 0) + costUsd,
        total_cost_brl: (existing.total_cost_brl || 0) + costUsd * 5.5,
      })
      .eq("id", existing.id);
  } else {
    await supabase.from("ai_cost_tracking").insert({
      user_id: userId,
      month: monthStr,
      provider: "anthropic",
      model: ANTHROPIC_MODEL,
      total_generations: generations,
      total_cost_usd: costUsd,
      total_cost_brl: costUsd * 5.5,
    });
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { mode, dispatch_type, perfil_marca_id, mensagem } = await req.json();
    if (!mode || !["sequence", "content"].includes(mode)) {
      return new Response(JSON.stringify({ error: "mode inválido. Use 'sequence' ou 'content'." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Carrega chave Anthropic do banco (mesma usada pelo generate-dispatch)
    const { data: keyRow } = await sb
      .from("ai_api_keys")
      .select("api_key")
      .eq("provider", "anthropic")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (!keyRow?.api_key) {
      return new Response(
        JSON.stringify({
          error:
            "Chave API da Anthropic não configurada. Cadastre nas Configurações do Marketing.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Identifica o usuário autenticado para tracking de custo
    let userId: string | null = null;
    try {
      const authHeader = req.headers.get("Authorization");
      if (authHeader) {
        const token = authHeader.replace("Bearer ", "");
        const { data: userRes } = await sb.auth.getUser(token);
        userId = userRes?.user?.id || null;
      }
    } catch {
      // ignore
    }

    let perfil: any = null;
    if (perfil_marca_id) {
      const { data } = await sb
        .from("brand_profiles")
        .select("*")
        .eq("id", perfil_marca_id)
        .maybeSingle();
      perfil = data;
    }

    const brandCtx = buildBrandContext(perfil);
    const eventCtx = buildEventStructure(
      dispatch_type || {},
      dispatch_type?.campos_evento_schema || [],
    );

    if (mode === "sequence") {
      const systemPrompt = `Você é um estrategista de campanhas de marketing direto (WhatsApp + Email).
Sua tarefa: propor uma SEQUÊNCIA de mensagens (lista) para um tipo de disparo, levando em conta a estrutura do evento e o perfil da marca/público-alvo.
Cada item da lista é uma MENSAGEM que será enviada em um momento específico antes/durante/depois do evento.
Para cada mensagem, defina:
- timing_offset (string técnica curta: "-7d", "-1d", "0d 09h", "+30min", "+1d")
- timing_label (texto humano: "7 dias antes", "no dia às 9h", "30 min depois")
- canais (subset de: ${(dispatch_type?.canais_habilitados || []).join(", ") || "whatsapp_grupo, email, whatsapp_oficial"})
- intencao (briefing curto, 1-2 frases, do que essa mensagem deve comunicar e qual o sentimento/CTA — em português)
- campos_evento_usados (array com keys de campos do evento que essa mensagem deve referenciar)
Retorne SOMENTE via tool call.`;

      const userMsg = `ESTRUTURA DO EVENTO:\n${eventCtx}\n\nPERFIL DA MARCA / PÚBLICO:\n${brandCtx}\n\nGere uma sequência inteligente (4 a 8 mensagens) para esse tipo de disparo.`;

      const { result, inputTokens, outputTokens } = await callAnthropicTool({
        apiKey: keyRow.api_key,
        systemPrompt,
        userMessage: userMsg,
        toolName: "propor_sequencia",
        toolDescription: "Retorna a lista de mensagens da sequência",
        inputSchema: {
          type: "object",
          properties: {
            mensagens: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  timing_offset: { type: "string" },
                  timing_label: { type: "string" },
                  canais: { type: "array", items: { type: "string" } },
                  intencao: { type: "string" },
                  campos_evento_usados: { type: "array", items: { type: "string" } },
                },
                required: [
                  "timing_offset",
                  "timing_label",
                  "canais",
                  "intencao",
                  "campos_evento_usados",
                ],
              },
            },
          },
          required: ["mensagens"],
        },
      });

      await trackCost(sb, userId, inputTokens, outputTokens, 1);

      return new Response(JSON.stringify({ ok: true, data: result }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // mode === "content"
    if (!mensagem) {
      return new Response(JSON.stringify({ error: "mensagem é obrigatória no modo content." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const canais: string[] = mensagem.canais || [];
    const precisaWA = canais.some((c) => c === "whatsapp_grupo" || c === "whatsapp_oficial");
    const precisaEmail = canais.includes("email");

    const systemPrompt = `Você é um copywriter sênior de marketing direto.
Gere o CONTEÚDO MODELO (template) de UMA mensagem de uma sequência, em português brasileiro, fiel ao tom e ao público da marca.
Use placeholders entre chaves {} para os campos do evento (ex: {nome_aula}, {data_evento}, {link_inscricao}).
Não invente campos: use apenas os campos disponíveis listados.
Respeite termos obrigatórios e EVITE termos proibidos da marca.
${precisaWA ? "- Para WhatsApp: texto curto/objetivo, com quebras de linha naturais, podendo usar 1-2 emojis se combinar com o tom." : ""}
${precisaEmail ? "- Para Email: assunto chamativo (até 60 chars) + corpo bem formatado em parágrafos curtos." : ""}
Retorne SOMENTE via tool call.`;

    const userMsg = `ESTRUTURA DO EVENTO:\n${eventCtx}\n\nPERFIL DA MARCA:\n${brandCtx}\n\nMENSAGEM:
- Timing: ${mensagem.timing_label} (${mensagem.timing_offset})
- Canais: ${canais.join(", ")}
- Intenção/briefing: ${mensagem.intencao}
- Campos do evento que essa mensagem deve usar: ${(mensagem.campos_evento_usados || []).join(", ") || "(nenhum)"}
${mensagem.tem_botoes_interacao ? `- Possui botões interativos. Pergunta: "${mensagem.pergunta_botoes || ""}". Botões: ${(mensagem.botoes || []).map((b: any) => b.label).join(" | ")}` : ""}

Gere o conteúdo modelo agora.`;

    const props: any = {};
    const required: string[] = [];
    if (precisaWA) {
      props.whatsapp = { type: "string", description: "Texto da mensagem para WhatsApp" };
      required.push("whatsapp");
    }
    if (precisaEmail) {
      props.email_assunto = { type: "string", description: "Assunto do email (até 60 chars)" };
      props.email_corpo = { type: "string", description: "Corpo do email em texto/markdown leve" };
      required.push("email_assunto", "email_corpo");
    }

    const { result, inputTokens, outputTokens } = await callAnthropicTool({
      apiKey: keyRow.api_key,
      systemPrompt,
      userMessage: userMsg,
      toolName: "gerar_conteudo",
      toolDescription: "Retorna o conteúdo modelo da mensagem",
      inputSchema: {
        type: "object",
        properties: props,
        required,
      },
    });

    await trackCost(sb, userId, inputTokens, outputTokens, 1);

    return new Response(JSON.stringify({ ok: true, data: result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("generate-dispatch-type-template error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
