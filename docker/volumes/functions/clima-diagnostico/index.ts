import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { trimestre, setor_id } = await req.json();
    if (!trimestre) throw new Error("trimestre is required");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Fetch questions
    const { data: perguntas } = await supabase
      .from("fin_clima_perguntas")
      .select("*")
      .eq("ativo", true)
      .order("ordem");

    // Fetch responses
    let liderQuery = supabase.from("fin_clima_respostas_lider").select("*").eq("trimestre", trimestre);
    let colabQuery = supabase.from("fin_clima_respostas_colaborador").select("*").eq("trimestre", trimestre);
    if (setor_id) {
      liderQuery = liderQuery.eq("setor_id", setor_id);
      colabQuery = colabQuery.eq("setor_id", setor_id);
    }

    const [{ data: respostasLider }, { data: respostasColab }] = await Promise.all([liderQuery, colabQuery]);

    // Fetch setores
    const { data: setores } = await supabase.from("fin_setores").select("*").eq("ativo", true);

    // Build context
    const tipo = setor_id ? "setor" : "geral";
    const setorNome = setor_id ? setores?.find((s: any) => s.id === setor_id)?.nome : "Todos";

    const perguntasLider = perguntas?.filter((p: any) => p.tipo_avaliacao === "lider") || [];
    const perguntasColab = perguntas?.filter((p: any) => p.tipo_avaliacao === "colaborador") || [];

    // Score calculation
    const FREQ_OPTIONS = ["Sempre", "Quase sempre", "Às vezes", "Raramente", "Nunca"];
    const CONC_OPTIONS = ["Concordo totalmente", "Concordo", "Neutro", "Discordo", "Discordo totalmente"];

    function scoreFromScale(answer: string, type: string): number {
      const opts = type === "scale-freq" ? FREQ_OPTIONS : CONC_OPTIONS;
      const idx = opts.indexOf(answer);
      if (idx === -1) return 0;
      return 5 - idx;
    }

    // Calculate pilar scores
    const pilarScores: Record<string, { total: number; count: number }> = {
      cultura: { total: 0, count: 0 },
      clareza: { total: 0, count: 0 },
      processos: { total: 0, count: 0 },
    };

    const allPerguntas = [...perguntasLider, ...perguntasColab];
    const allRespostas = [...(respostasLider || []), ...(respostasColab || [])];

    allRespostas.forEach((r: any) => {
      allPerguntas.forEach((p: any) => {
        const val = r.respostas?.[p.id];
        if (val && (p.tipo_resposta === "scale-freq" || p.tipo_resposta === "scale-conc")) {
          const score = scoreFromScale(val, p.tipo_resposta);
          if (score > 0 && pilarScores[p.pilar]) {
            pilarScores[p.pilar].total += score;
            pilarScores[p.pilar].count++;
          }
        }
      });
    });

    // Also score by the old hardcoded IDs for backward compatibility
    const oldPilarMap: Record<string, string> = {
      l1: "clareza", l2: "clareza", l3: "clareza", l4: "clareza",
      l5: "cultura", l6: "cultura", l7: "cultura",
      l8: "processos", l9: "processos", l10: "processos",
      l11: "cultura", l12: "cultura",
      e1: "cultura", e2: "cultura", e3: "cultura",
      e4: "processos", e5: "processos", e6: "processos", e7: "processos",
      e8: "clareza", e9: "clareza", e10: "clareza",
      e11: "cultura", e12: "cultura",
    };

    const oldScaleTypes: Record<string, string> = {
      l1: "scale-freq", l2: "scale-conc", l3: "scale-conc", l4: "scale-freq",
      l5: "scale-freq", l6: "scale-conc", l7: "scale-freq",
      l8: "scale-freq", l9: "scale-freq", l10: "scale-conc",
      l11: "scale-conc", l12: "scale-conc",
      e1: "scale-conc", e2: "scale-conc", e3: "scale-freq",
      e4: "scale-freq", e5: "scale-conc", e6: "scale-freq", e7: "scale-freq",
      e8: "scale-conc", e9: "scale-conc", e10: "scale-freq",
      e11: "scale-conc", e12: "scale-freq",
    };

    allRespostas.forEach((r: any) => {
      Object.entries(oldPilarMap).forEach(([qId, pilar]) => {
        const val = r.respostas?.[qId];
        if (val && oldScaleTypes[qId]) {
          const score = scoreFromScale(val, oldScaleTypes[qId]);
          if (score > 0 && pilarScores[pilar]) {
            pilarScores[pilar].total += score;
            pilarScores[pilar].count++;
          }
        }
      });
    });

    const pilarCultura = pilarScores.cultura.count > 0 ? +(pilarScores.cultura.total / pilarScores.cultura.count).toFixed(2) : 0;
    const pilarClareza = pilarScores.clareza.count > 0 ? +(pilarScores.clareza.total / pilarScores.clareza.count).toFixed(2) : 0;
    const pilarProcessos = pilarScores.processos.count > 0 ? +(pilarScores.processos.total / pilarScores.processos.count).toFixed(2) : 0;

    // Collect open answers
    const openAnswers: string[] = [];
    allRespostas.forEach((r: any) => {
      Object.entries(r.respostas || {}).forEach(([key, val]) => {
        if (typeof val === "string" && val.length > 5) {
          openAnswers.push(val);
        }
      });
    });

    // Build prompt
    const prompt = `Você é um especialista em Cultura e Clima Organizacional. Analise os dados da avaliação trimestral ${trimestre} ${setor_id ? `do setor ${setorNome}` : "da organização inteira"} e gere um diagnóstico estruturado.

DADOS:
- Total de respostas de líderes: ${respostasLider?.length || 0}
- Total de respostas de colaboradores: ${respostasColab?.length || 0}
- Pilar Alinhamento Cultural: ${pilarCultura}/5 (${pilarScores.cultura.count} avaliações)
- Pilar Clareza para Execução: ${pilarClareza}/5 (${pilarScores.clareza.count} avaliações)
- Pilar Alinhamento com Processos e Indicadores: ${pilarProcessos}/5 (${pilarScores.processos.count} avaliações)

RESPOSTAS ABERTAS (amostra):
${openAnswers.slice(0, 20).map((a, i) => `${i + 1}. "${a}"`).join("\n")}

Retorne um JSON com exatamente esta estrutura (sem markdown, apenas JSON puro):
{
  "pilar_cultura": {
    "nota": ${pilarCultura},
    "classificacao": "Excelente|Bom|Regular|Crítico",
    "pontos_fortes": ["...", "..."],
    "pontos_atencao": ["...", "..."],
    "analise": "Texto de 2-3 frases analisando o alinhamento cultural"
  },
  "pilar_clareza": {
    "nota": ${pilarClareza},
    "classificacao": "Excelente|Bom|Regular|Crítico",
    "pontos_fortes": ["...", "..."],
    "pontos_atencao": ["...", "..."],
    "analise": "Texto de 2-3 frases analisando a clareza para execução"
  },
  "pilar_processos": {
    "nota": ${pilarProcessos},
    "classificacao": "Excelente|Bom|Regular|Crítico",
    "pontos_fortes": ["...", "..."],
    "pontos_atencao": ["...", "..."],
    "analise": "Texto de 2-3 frases analisando o alinhamento com processos"
  },
  "resumo_geral": "Parágrafo de 3-5 frases com a visão geral do diagnóstico",
  "recomendacoes": "3-5 recomendações práticas e específicas separadas por \\n"
}`;

    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: "Você é um consultor de RH especialista em clima organizacional. Responda APENAS com JSON válido, sem markdown." },
          { role: "user", content: prompt },
        ],
      }),
    });

    if (!aiResponse.ok) {
      if (aiResponse.status === 429) {
        return new Response(JSON.stringify({ error: "Limite de requisições excedido. Tente novamente em alguns segundos." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiResponse.status === 402) {
        return new Response(JSON.stringify({ error: "Créditos de IA esgotados. Adicione créditos no workspace." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      throw new Error(`AI gateway error: ${aiResponse.status}`);
    }

    const aiData = await aiResponse.json();
    let content = aiData.choices?.[0]?.message?.content || "";
    
    // Clean markdown wrappers if present
    content = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = {
        pilar_cultura: { nota: pilarCultura, classificacao: pilarCultura >= 4 ? "Bom" : pilarCultura >= 3 ? "Regular" : "Crítico", pontos_fortes: [], pontos_atencao: [], analise: content.slice(0, 200) },
        pilar_clareza: { nota: pilarClareza, classificacao: pilarClareza >= 4 ? "Bom" : pilarClareza >= 3 ? "Regular" : "Crítico", pontos_fortes: [], pontos_atencao: [], analise: "" },
        pilar_processos: { nota: pilarProcessos, classificacao: pilarProcessos >= 4 ? "Bom" : pilarProcessos >= 3 ? "Regular" : "Crítico", pontos_fortes: [], pontos_atencao: [], analise: "" },
        resumo_geral: content.slice(0, 500),
        recomendacoes: "",
      };
    }

    // Save to DB
    const { data: saved, error: saveError } = await supabase.from("fin_clima_diagnosticos").insert({
      trimestre,
      setor_id: setor_id || null,
      tipo,
      pilar_cultura: parsed.pilar_cultura,
      pilar_clareza: parsed.pilar_clareza,
      pilar_processos: parsed.pilar_processos,
      resumo_geral: parsed.resumo_geral,
      recomendacoes: parsed.recomendacoes,
      dados_brutos: { pilarScores: { cultura: pilarCultura, clareza: pilarClareza, processos: pilarProcessos }, totalLider: respostasLider?.length, totalColab: respostasColab?.length },
    }).select().single();

    if (saveError) throw saveError;

    return new Response(JSON.stringify(saved), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("clima-diagnostico error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
