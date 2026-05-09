import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { nome, perfil_d, perfil_i, perfil_s, perfil_c, perfil_dominante, setor } = await req.json();

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const prompt = `Você é um consultor sênior de desenvolvimento humano e comportamental com 20 anos de experiência em metodologia DISC. Gere um relatório COMPLETO e APROFUNDADO para o colaborador "${nome}" do setor "${setor}".

PERFIL DISC DO COLABORADOR:
- Dominância (D): ${perfil_d}%
- Influência (I): ${perfil_i}%
- Estabilidade (S): ${perfil_s}%
- Conformidade (C): ${perfil_c}%
- Perfil dominante: ${perfil_dominante}

CONTEXTO DOS PERFIS DISC:
- D (Dominância): Orientação a resultados, competitividade, assertividade, tomada de decisão rápida
- I (Influência): Comunicação, entusiasmo, persuasão, sociabilidade, otimismo
- S (Estabilidade): Paciência, lealdade, cooperação, consistência, harmonia
- C (Conformidade): Análise, precisão, qualidade, organização, pensamento crítico

INSTRUÇÕES:
- Analise os percentuais para entender o equilíbrio do perfil
- Perfis abaixo de 20% são áreas de desenvolvimento importante
- Perfis acima de 30% são traços dominantes
- Considere a combinação dos perfis (ex: alto D + baixo S = pode ser visto como impaciente)
- Seja ESPECÍFICO, PRÁTICO e PERSONALIZADO

Gere um JSON com esta estrutura EXATA (sem markdown, apenas JSON válido):
{
  "resumo_perfil": "Parágrafo de 5-6 frases com análise profunda do perfil comportamental, explicando como os percentuais se combinam e o que isso significa no dia a dia profissional",
  
  "pontos_fortes_naturais": [
    "4-5 pontos fortes NATURAIS baseados nos perfis dominantes, com explicação prática de como se manifestam no trabalho"
  ],
  
  "habilidades_a_desenvolver": [
    {
      "habilidade": "Nome da habilidade",
      "perfil_relacionado": "D/I/S/C",
      "situacao_atual": "Como o baixo percentual neste perfil se manifesta no dia a dia",
      "nivel_urgencia": "alto/medio/baixo",
      "como_desenvolver": "2-3 ações práticas e específicas"
    }
  ],
  
  "comportamentos_a_moldar": [
    {
      "comportamento_atual": "Comportamento típico do perfil dominante que pode ser excessivo",
      "impacto": "Como isso afeta colegas e resultados",
      "comportamento_ideal": "Equilíbrio desejado",
      "estrategia": "Como ajustar gradualmente"
    }
  ],
  
  "esportes_e_atividades": [
    {
      "atividade": "Nome do esporte ou atividade",
      "por_que": "Como essa atividade trabalha os perfis mais fracos e equilibra o comportamento",
      "frequencia": "Sugestão de frequência semanal"
    }
  ],
  
  "habitos_recomendados": [
    {
      "habito": "Hábito diário ou semanal",
      "objetivo": "Qual perfil DISC ele fortalece e por quê",
      "como_implementar": "Passo a passo prático"
    }
  ],
  
  "plano_desenvolvimento_90_dias": {
    "mes_1": {
      "foco": "Tema principal",
      "acoes": ["3-4 ações concretas"],
      "meta": "Resultado esperado"
    },
    "mes_2": {
      "foco": "Tema principal",
      "acoes": ["3-4 ações concretas"],
      "meta": "Resultado esperado"
    },
    "mes_3": {
      "foco": "Tema principal",
      "acoes": ["3-4 ações concretas"],
      "meta": "Resultado esperado"
    }
  },
  
  "sugestoes_estudo": [
    {
      "tema": "Tema de estudo",
      "por_que": "Conexão com o perfil DISC",
      "recursos": "Livros, cursos, podcasts recomendados"
    }
  ],
  
  "dicas_comunicacao": {
    "com_perfil_d": "Como o colaborador deve se comunicar com pessoas de perfil D",
    "com_perfil_i": "Como se comunicar com perfis I",
    "com_perfil_s": "Como se comunicar com perfis S",
    "com_perfil_c": "Como se comunicar com perfis C"
  },
  
  "mensagem_motivacional": "Mensagem personalizada de 2-3 frases mencionando o nome"
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
          { role: "system", content: "Você é um consultor sênior de comportamento organizacional especializado em DISC. Responda APENAS com JSON válido, sem markdown, sem blocos de código. Seja extremamente específico, prático e profundo." },
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
    content = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = { resumo_perfil: content.slice(0, 500), error: "Could not parse AI response as JSON" };
    }

    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("disc-feedback error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
