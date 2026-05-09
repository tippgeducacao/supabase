import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { tipo, nome, trimestre, scores, pontos_fortes, pontos_desenvolver, sugestoes, nota_geral, media_geral, equipe_ranking } = await req.json();

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    let prompt = "";

    if (tipo === "colaborador") {
      prompt = `Você é um consultor sênior de desenvolvimento humano e organizacional com 20 anos de experiência. Gere um relatório COMPLETO e APROFUNDADO de feedback para o colaborador "${nome}" com base nos dados da avaliação de clima trimestral ${trimestre}.

DADOS DO COLABORADOR:
- Média geral: ${media_geral}/5
- Nota geral atribuída pelo líder: ${nota_geral}/10
- Scores por bloco: ${JSON.stringify(scores)}
- Pontos fortes citados pelo líder: ${JSON.stringify(pontos_fortes)}
- Pontos a desenvolver citados pelo líder: ${JSON.stringify(pontos_desenvolver)}

INSTRUÇÕES IMPORTANTES:
- Seja ESPECÍFICO e PRÁTICO, nada genérico
- Use os dados reais para fundamentar cada ponto
- Considere que notas abaixo de 3.5/5 são áreas críticas
- Notas entre 3.5 e 4.0 são áreas de atenção
- Notas acima de 4.0 são pontos fortes
- O plano de desenvolvimento deve ser CONCRETO com ações semanais/mensais

Gere um JSON com esta estrutura EXATA (sem markdown, apenas JSON válido):
{
  "resumo_executivo": "Parágrafo de 5-6 frases com análise profunda do perfil profissional do colaborador, correlacionando os scores dos blocos com os feedbacks qualitativos. Identifique padrões, tendências e o nível de maturidade profissional demonstrado.",
  
  "pontos_destaque": [
    "4-5 pontos positivos ESPECÍFICOS baseados nos dados, explicando POR QUE são relevantes e COMO impactam a equipe"
  ],
  
  "habilidades_a_lapidar": [
    {
      "habilidade": "Nome da habilidade (ex: Comunicação Assertiva)",
      "situacao_atual": "Descrição objetiva de como está hoje baseado nos dados",
      "nivel_urgencia": "alto/medio/baixo",
      "como_desenvolver": "2-3 ações práticas e específicas para desenvolver esta habilidade"
    }
  ],
  
  "comportamentos_a_moldar": [
    {
      "comportamento": "Comportamento específico observado ou inferido dos dados",
      "impacto_negativo": "Como esse comportamento afeta resultados e relacionamentos",
      "comportamento_desejado": "O que se espera ver no lugar",
      "estrategia_mudanca": "Passos concretos para a mudança comportamental"
    }
  ],
  
  "plano_desenvolvimento_90_dias": {
    "mes_1": {
      "foco": "Tema principal do mês",
      "acoes": ["3-4 ações concretas e mensuráveis para o primeiro mês"],
      "meta": "Resultado esperado ao final do mês 1"
    },
    "mes_2": {
      "foco": "Tema principal do mês",
      "acoes": ["3-4 ações concretas e mensuráveis para o segundo mês"],
      "meta": "Resultado esperado ao final do mês 2"
    },
    "mes_3": {
      "foco": "Tema principal do mês",
      "acoes": ["3-4 ações concretas e mensuráveis para o terceiro mês"],
      "meta": "Resultado esperado ao final do mês 3"
    }
  },
  
  "sugestoes_estudo": [
    {
      "tema": "Tema de estudo recomendado",
      "por_que": "Razão baseada nos dados do colaborador",
      "recursos": "Livros, cursos online, vídeos ou práticas recomendadas"
    }
  ],
  
  "indicadores_acompanhamento": [
    "3-4 indicadores objetivos que o líder pode usar para medir a evolução nos próximos 3 meses"
  ],
  
  "mensagem_motivacional": "Uma mensagem personalizada de 2-3 frases que reconheça os pontos fortes e motive o desenvolvimento, mencionando o nome do colaborador"
}`;
    } else if (tipo === "lider") {
      prompt = `Você é um consultor sênior de liderança e cultura organizacional com 20 anos de experiência. Gere um diagnóstico COMPLETO e ESTRATÉGICO para o líder "${nome}" com base na avaliação de clima do trimestre ${trimestre}.

DADOS DO LÍDER:
- Média de avaliação como líder: ${media_geral}/5
- Scores por bloco: ${JSON.stringify(scores)}
- Pontos fortes citados pela equipe: ${JSON.stringify(pontos_fortes)}
- Pontos a desenvolver citados: ${JSON.stringify(pontos_desenvolver)}
- Sugestões da equipe: ${JSON.stringify(sugestoes)}
- Ranking da equipe (nome, média, nota): ${JSON.stringify(equipe_ranking)}

INSTRUÇÕES IMPORTANTES:
- Seja ESPECÍFICO e ESTRATÉGICO, nada genérico
- Analise gaps entre blocos para identificar inconsistências
- Identifique padrões na equipe (colaboradores desalinhados, padrões de performance)
- O plano deve ser CONCRETO com ações de gestão semanais/mensais

Gere um JSON com esta estrutura EXATA (sem markdown, apenas JSON válido):
{
  "resumo_lideranca": "Parágrafo de 5-7 frases analisando profundamente o estilo de liderança, correlacionando scores dos blocos com feedbacks qualitativos. Identifique o perfil de liderança predominante e gaps críticos.",
  
  "analise_equipe": "Parágrafo de 4-5 frases analisando a dinâmica da equipe, distribuição de performance, possíveis subgrupos e padrões identificados no ranking.",
  
  "pontos_fortes_lider": [
    "4-5 competências de liderança que se destacam, com explicação de COMO impactam positivamente a equipe"
  ],
  
  "habilidades_gestao_a_desenvolver": [
    {
      "habilidade": "Nome da competência de gestão",
      "gap_identificado": "O que os dados revelam sobre esta lacuna",
      "nivel_urgencia": "alto/medio/baixo",
      "como_desenvolver": "2-3 ações práticas específicas para o líder"
    }
  ],
  
  "comportamentos_lideranca_a_moldar": [
    {
      "comportamento": "Comportamento de liderança observado ou inferido",
      "impacto_na_equipe": "Como afeta clima, produtividade e retenção",
      "comportamento_desejado": "O padrão de liderança esperado",
      "estrategia_mudanca": "Passos concretos para transformar o comportamento"
    }
  ],
  
  "plano_gestao_90_dias": {
    "mes_1": {
      "foco": "Tema de gestão principal",
      "acoes": ["3-4 ações de gestão concretas"],
      "meta": "Resultado esperado"
    },
    "mes_2": {
      "foco": "Tema de gestão principal",
      "acoes": ["3-4 ações de gestão concretas"],
      "meta": "Resultado esperado"
    },
    "mes_3": {
      "foco": "Tema de gestão principal",
      "acoes": ["3-4 ações de gestão concretas"],
      "meta": "Resultado esperado"
    }
  },
  
  "recomendacoes_por_colaborador": [
    {
      "colaborador": "Nome (do ranking)",
      "situacao": "Breve análise da situação",
      "acao_recomendada": "O que o líder deve fazer com este colaborador"
    }
  ],
  
  "alertas": ["1-3 pontos de atenção urgentes baseados nos dados, pode ser vazio"],
  
  "indicadores_acompanhamento": [
    "3-4 KPIs que o líder deve monitorar nos próximos 3 meses"
  ],
  
  "mensagem_final": "Mensagem de 2-3 frases com visão construtiva e estratégica, mencionando o nome do líder"
}`;
    } else {
      throw new Error("tipo must be 'colaborador' or 'lider'");
    }

    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: "Você é um consultor sênior de RH e desenvolvimento organizacional. Responda APENAS com JSON válido, sem markdown, sem blocos de código. Seja extremamente específico, prático e profundo nas análises. Use os dados fornecidos para fundamentar cada ponto." },
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
      parsed = { resumo_executivo: content.slice(0, 500), error: "Could not parse AI response as JSON" };
    }

    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("clima-feedback-individual error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
