import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-sonnet-4-20250514";

interface CampoSchema {
  key: string;
  label: string;
  tipo: string;
  obrigatorio?: boolean;
}

function buildBrandContext(bp: any, opts?: { includeManifesto?: boolean }): string {
  if (!bp) return "";
  const includeManifesto = opts?.includeManifesto === true;
  const lines: string[] = [];
  lines.push(`MARCA: ${bp.brand_name || bp.account_name || ""}`);
  if (bp.segmento) lines.push(`SEGMENTO: ${bp.segmento}`);
  if (bp.tom_de_voz) lines.push(`TOM DE VOZ: ${bp.tom_de_voz}`);
  if (bp.tom_descricao) lines.push(`DESCRIÇÃO DO TOM: ${bp.tom_descricao}`);
  if (bp.publico_alvo) lines.push(`PÚBLICO-ALVO: ${bp.publico_alvo}`);
  if (bp.persona_perfil_demografico)
    lines.push(`PERFIL DEMOGRÁFICO: ${bp.persona_perfil_demografico}`);

  // Campos topicais — só entram quando o tipo é promocional
  if (includeManifesto) {
    if (bp.persona_dores) lines.push(`DORES DA PERSONA: ${bp.persona_dores}`);
    if (bp.persona_desejos) lines.push(`DESEJOS DA PERSONA: ${bp.persona_desejos}`);
    if (bp.persona_objecoes) lines.push(`OBJEÇÕES DA PERSONA: ${bp.persona_objecoes}`);
    if (bp.vocabulario_chave) lines.push(`VOCABULÁRIO-CHAVE: ${bp.vocabulario_chave}`);
    if (bp.metaforas_estrategicas) lines.push(`METÁFORAS ESTRATÉGICAS: ${bp.metaforas_estrategicas}`);
    if (bp.frases_exemplo) lines.push(`FRASES EXEMPLO: ${bp.frases_exemplo}`);
  }

  if (bp.alertas_nao_usar) lines.push(`ALERTAS - NÃO USAR: ${bp.alertas_nao_usar}`);
  if (Array.isArray(bp.termos_proibidos) && bp.termos_proibidos.length)
    lines.push(`TERMOS PROIBIDOS: ${bp.termos_proibidos.join(", ")}`);
  if (Array.isArray(bp.termos_obrigatorios) && bp.termos_obrigatorios.length)
    lines.push(`TERMOS OBRIGATÓRIOS: ${bp.termos_obrigatorios.join(", ")}`);
  if (Array.isArray(bp.regras_estilo) && bp.regras_estilo.length)
    lines.push(`REGRAS DE ESTILO:\n- ${bp.regras_estilo.join("\n- ")}`);
  return lines.join("\n");
}

function buildEventContext(
  schema: CampoSchema[],
  variaveis: Record<string, any>,
  evento_data?: string,
  evento_horario?: string,
  campos_usados?: string[],
): string {
  const lines: string[] = [];
  if (evento_data) lines.push(`DATA DO EVENTO: ${evento_data}`);
  if (evento_horario) lines.push(`HORÁRIO: ${evento_horario}`);
  const fields = Array.isArray(schema) ? schema : [];
  const filterSet =
    campos_usados && campos_usados.length ? new Set(campos_usados) : null;
  for (const c of fields) {
    if (filterSet && !filterSet.has(c.key)) continue;
    const v = variaveis?.[c.key];
    if (v === undefined || v === null || v === "") continue;
    lines.push(`${c.label.toUpperCase()}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  return lines.join("\n");
}

function buildChannelInstruction(canal: string): string {
  if (canal === "email") {
    return `Gere o conteúdo do EMAIL no formato:
ASSUNTO: <assunto curto e atrativo>
CORPO:
<corpo do email em HTML simples (use <p>, <strong>, <a>, <ul>, <li>). Sem <html>, <head> ou <body>>`;
  }
  if (canal === "whatsapp_oficial") {
    return `Gere o conteúdo da mensagem do WhatsApp Oficial API. Use texto plano (sem markdown nem emojis em excesso). Mensagem curta e direta, máximo ~600 caracteres. Não inclua o link no meio do texto se for usado em botão interativo.`;
  }
  // whatsapp_grupo (default)
  return `Gere a mensagem de WHATSAPP com formatação WhatsApp (*negrito*, _itálico_) e emojis pontuais. Mantenha legibilidade em mobile.`;
}

async function generateOneMessage(opts: {
  apiKey: string;
  systemPrompt: string;
  userMessage: string;
}): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": opts.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1500,
      system: opts.systemPrompt,
      messages: [{ role: "user", content: opts.userMessage }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  return {
    text: data?.content?.[0]?.text || "",
    inputTokens: data?.usage?.input_tokens || 0,
    outputTokens: data?.usage?.output_tokens || 0,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const body = await req.json();

    // Modo novo: dispatch_id já existente em "dispatches", regenera todas as mensagens.
    // Modo de criação: brand_profile_id + dispatch_type_id + variaveis_evento + evento_data, cria dispatch e mensagens.
    let {
      dispatch_id,
      user_id,
      brand_profile_id,
      dispatch_type_id,
      variaveis_evento,
      evento_data,
      evento_horario,
      formato_saida, // canais escolhidos para esse disparo (subset dos canais habilitados)
    } = body as {
      dispatch_id?: string;
      user_id?: string;
      brand_profile_id?: string;
      dispatch_type_id?: string;
      variaveis_evento?: Record<string, any>;
      evento_data?: string;
      evento_horario?: string;
      formato_saida?: string[];
    };

    // 1. Carrega chave Anthropic
    const { data: keyRow } = await supabase
      .from("ai_api_keys")
      .select("api_key")
      .eq("provider", "anthropic")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (!keyRow) {
      return new Response(
        JSON.stringify({
          error:
            "Chave API da Anthropic não configurada. Cadastre nas Configurações do Marketing.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 2. Resolve dispatch (cria se não existir)
    let dispatch: any = null;
    if (dispatch_id) {
      const { data, error } = await supabase
        .from("dispatches")
        .select("*")
        .eq("id", dispatch_id)
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error("Dispatch não encontrado");
      dispatch = data;
    } else {
      if (!user_id || !brand_profile_id || !dispatch_type_id || !evento_data) {
        return new Response(
          JSON.stringify({
            error:
              "user_id, brand_profile_id, dispatch_type_id e evento_data são obrigatórios para criar um dispatch.",
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const { data, error } = await supabase
        .from("dispatches")
        .insert({
          user_id,
          brand_profile_id,
          dispatch_type_id,
          evento_data,
          evento_horario: evento_horario || null,
          variaveis_evento: variaveis_evento || {},
          formato_saida: formato_saida || [],
          status: "rascunho",
        })
        .select("*")
        .single();
      if (error) throw error;
      dispatch = data;
    }

    // 3. Carrega tipo de disparo + sequência de mensagens
    const { data: tipo, error: tipoErr } = await supabase
      .from("dispatch_types")
      .select("*")
      .eq("id", dispatch.dispatch_type_id)
      .maybeSingle();
    if (tipoErr) throw tipoErr;
    if (!tipo) throw new Error("Tipo de disparo não encontrado");

    const { data: seq, error: seqErr } = await supabase
      .from("dispatch_type_messages")
      .select("*")
      .eq("dispatch_type_id", dispatch.dispatch_type_id)
      .order("ordem", { ascending: true });
    if (seqErr) throw seqErr;

    const { data: bp } = await supabase
      .from("brand_profiles")
      .select("*")
      .eq("id", dispatch.brand_profile_id)
      .maybeSingle();

    const schema = (tipo.campos_evento_schema as CampoSchema[]) || [];
    const brandContext = buildBrandContext(bp, {
      includeManifesto: (tipo as any).include_brand_manifesto === true,
    });
    const allowedChannels: string[] =
      Array.isArray(dispatch.formato_saida) && dispatch.formato_saida.length
        ? dispatch.formato_saida
        : (tipo.canais_habilitados as string[]) || [];

    // 4. Limpa mensagens antigas desse dispatch (regerar)
    await supabase.from("dispatch_messages").delete().eq("dispatch_id", dispatch.id);

    // 5. Para cada mensagem da sequência x cada canal aplicável, gera conteúdo
    const startTime = Date.now();
    let totalIn = 0;
    let totalOut = 0;
    const generated: any[] = [];

    for (const msg of seq || []) {
      const msgChannels = (msg.canais as string[]) || [];
      const channelsToGen = msgChannels.filter((c) => allowedChannels.includes(c));
      if (!channelsToGen.length) continue;

      const eventCtx = buildEventContext(
        schema,
        (dispatch.variaveis_evento as any) || {},
        dispatch.evento_data,
        dispatch.evento_horario,
        msg.campos_evento_usados as string[],
      );

      for (const canal of channelsToGen) {
        const channelInstr = buildChannelInstruction(canal);
        const buttonsHint =
          canal === "whatsapp_oficial" && msg.tem_botoes_interacao && msg.botoes
            ? `\n\nESTA MENSAGEM TERÁ BOTÕES INTERATIVOS (não inclua eles no texto, eles serão renderizados separadamente):\nPergunta: ${msg.pergunta_botoes || ""}\nBotões: ${(msg.botoes as any[]).map((b: any) => b.label).join(" | ")}`
            : "";

        const systemPrompt = `Você é um copywriter especialista em comunicação de eventos educacionais.

╔══════════════════════════════════════════════════════════════╗
║ REGRA INVIOLÁVEL — LEIA ANTES DE TUDO                          ║
╚══════════════════════════════════════════════════════════════╝
O TÓPICO desta mensagem é EXCLUSIVAMENTE o tema do evento descrito abaixo em "DADOS DO EVENTO".
NUNCA mencione assuntos, ferramentas, métodos, produtos ou tópicos que NÃO estejam explicitamente listados nos DADOS DO EVENTO.
Se o "VOZ E TOM DA MARCA" mencionar outros tópicos (ex: outros temas que a marca cobre), use-os APENAS como pista de COMO falar — NUNCA como o que falar.
Se faltar informação específica sobre o tema do evento, escreva de forma genérica sobre o tema, NUNCA invente conteúdo.

DADOS DO EVENTO (única fonte de tópico permitida):
${eventCtx || "(sem dados específicos preenchidos — use o tipo de disparo abaixo como guia)"}

TIPO DE DISPARO: ${tipo.nome}
${tipo.descricao ? `DESCRIÇÃO: ${tipo.descricao}` : ""}
${tipo.objetivo ? `OBJETIVO: ${tipo.objetivo}` : ""}

INTENÇÃO ESPECÍFICA DESTA MENSAGEM (${msg.timing_label} — ${msg.timing_offset}):
${msg.intencao}

─────────────────────────────────────────────────────────────
VOZ E TOM DA MARCA (use SOMENTE para definir COMO escrever — nunca como tópico):
${brandContext}

REGRAS GERAIS:
- Respeite o tom de voz e vocabulário da marca acima
- Nunca use TERMOS PROIBIDOS se houver
- Quando possível, incorpore TERMOS OBRIGATÓRIOS naturalmente
- Inclua os links e dados do evento listados acima
- Não invente fatos: se um campo do evento estiver vazio, NÃO mencione esse campo

${channelInstr}${buttonsHint}`;

        const userMessage = `Gere a mensagem agora seguindo TODAS as regras acima. Atenha-se RIGOROSAMENTE ao tema do evento — não traga outros tópicos.`;

        const out = await generateOneMessage({
          apiKey: keyRow.api_key,
          systemPrompt,
          userMessage,
        });
        totalIn += out.inputTokens;
        totalOut += out.outputTokens;

        const insertRow: any = {
          dispatch_id: dispatch.id,
          dispatch_type_message_id: msg.id,
          canal,
          conteudo_gerado: out.text,
          status: "rascunho",
        };
        if (canal === "whatsapp_oficial" && msg.tem_botoes_interacao && msg.botoes) {
          insertRow.botoes_payload = {
            pergunta: msg.pergunta_botoes || null,
            botoes: msg.botoes,
            acao_ao_clicar: msg.acao_ao_clicar || null,
          };
        }
        const { data: inserted, error: insErr } = await supabase
          .from("dispatch_messages")
          .insert(insertRow)
          .select("*")
          .single();
        if (insErr) throw insErr;
        generated.push(inserted);
      }
    }

    // 6. Tracking de custo
    const costUsd = (totalIn * 3 + totalOut * 15) / 1_000_000;
    const monthStr = new Date().toISOString().slice(0, 7) + "-01";
    const ownerId = dispatch.user_id;
    if (ownerId) {
      const { data: existing } = await supabase
        .from("ai_cost_tracking")
        .select("*")
        .eq("user_id", ownerId)
        .eq("month", monthStr)
        .eq("provider", "anthropic")
        .maybeSingle();
      if (existing) {
        await supabase
          .from("ai_cost_tracking")
          .update({
            total_generations: (existing.total_generations || 0) + generated.length,
            total_cost_usd: (existing.total_cost_usd || 0) + costUsd,
            total_cost_brl: (existing.total_cost_brl || 0) + costUsd * 5.5,
          })
          .eq("id", existing.id);
      } else {
        await supabase.from("ai_cost_tracking").insert({
          user_id: ownerId,
          month: monthStr,
          provider: "anthropic",
          model: ANTHROPIC_MODEL,
          total_generations: generated.length,
          total_cost_usd: costUsd,
          total_cost_brl: costUsd * 5.5,
        });
      }
    }

    const elapsedSec = Math.round((Date.now() - startTime) / 1000);
    return new Response(
      JSON.stringify({
        success: true,
        dispatch_id: dispatch.id,
        messages_generated: generated.length,
        generation_time_seconds: elapsedSec,
        cost_usd: costUsd,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("generate-dispatch error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
