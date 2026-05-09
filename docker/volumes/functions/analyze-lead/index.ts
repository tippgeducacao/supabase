import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { leadDescription, mode, programId, programData, scriptData } = await req.json();
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY ausente");

    const isPre = mode === "pre-meeting";
    const systemPrompt = isPre
      ? `Você é um especialista em vendas consultivas da PPGVet Educação (pós-graduações veterinárias). Analise o perfil do lead e produza, em português, um material PRÉ-REUNIÃO contendo:
1. Resumo do ICP e fit com o programa selecionado
2. Possíveis dores e motivadores de carreira
3. Roteiro SPIN (Situação, Problema, Implicação, Necessidade) adaptado
4. 3-5 argumentos diferenciais do programa para esse perfil
5. Possíveis objeções e como contornar
Use markdown com títulos (##), negrito e listas. Seja específico e prático.`
      : `Você é um especialista em vendas consultivas da PPGVet Educação. A partir da descrição da reunião com o lead, produza, em português:
1. Diagnóstico do lead (perfil, momento de carreira, sinais de compra)
2. Plano de follow-up em 7 dias (D+1, D+2, D+4, D+7) com mensagens prontas
3. Proposta formalizada com plano de evolução de carreira
4. Próximos passos recomendados ao vendedor
Use markdown com títulos (##), negrito e listas.`;

    const userPrompt = `${programData}\n\n${scriptData ? `Material de apoio:\n${scriptData}\n\n` : ""}Descrição do lead:\n${leadDescription}`;

    const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        stream: true,
      }),
    });

    if (!resp.ok) {
      if (resp.status === 429)
        return new Response(JSON.stringify({ error: "Limite de requisições atingido. Tente novamente em alguns minutos." }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      if (resp.status === 402)
        return new Response(JSON.stringify({ error: "Créditos da IA esgotados. Adicione créditos no workspace Lovable." }), { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      const t = await resp.text();
      console.error("AI gateway error:", resp.status, t);
      return new Response(JSON.stringify({ error: "Erro no gateway de IA" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(resp.body, { headers: { ...corsHeaders, "Content-Type": "text/event-stream" } });
  } catch (e) {
    console.error("analyze-lead error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Erro desconhecido" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
