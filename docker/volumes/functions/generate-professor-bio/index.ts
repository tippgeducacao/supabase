// Edge function: gera mini-currículo do professor combinando dados cadastrais,
// cursos vinculados e (opcionalmente) scraping do Currículo Lattes.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY")!;

async function fetchLattesText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; PPGVetBot/1.0; +https://sistemappgvet.lovable.app)",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    // Strip tags + collapse whitespace, limit size
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text.slice(0, 12000);
  } catch (e) {
    console.error("Lattes fetch failed:", e);
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { professor_id } = await req.json();
    if (!professor_id) {
      return new Response(JSON.stringify({ error: "professor_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    const { data: prof, error: profErr } = await sb
      .from("ped_professores")
      .select("*")
      .eq("id", professor_id)
      .single();
    if (profErr || !prof) throw new Error(profErr?.message || "Professor not found");

    // Cursos vinculados (N:N) + curso_id legado
    const { data: vinculos } = await sb
      .from("ped_professor_cursos")
      .select("curso_id, cursos(nome, tipo, modalidade)")
      .eq("professor_id", professor_id);

    const cursosNomes = (vinculos || [])
      .map((v: any) => v.cursos?.nome)
      .filter(Boolean);

    // Aulas dadas (para inferir áreas práticas)
    const { data: aulas } = await sb
      .from("ped_aulas")
      .select("titulo, modulo")
      .eq("professor_id", professor_id)
      .limit(20);

    const aulasResumo = (aulas || [])
      .map((a: any) => a.titulo)
      .filter(Boolean)
      .slice(0, 10)
      .join("; ");

    let lattesText: string | null = null;
    if (prof.curriculo_lattes && /^https?:\/\//i.test(prof.curriculo_lattes)) {
      lattesText = await fetchLattesText(prof.curriculo_lattes);
    }

    const systemPrompt = `Você redige mini-biografias profissionais para professores de cursos de pós-graduação em medicina veterinária e áreas afins. Tom: respeitoso, técnico, fluido, em português do Brasil. 3 a 5 parágrafos curtos. Sem markdown, sem bullet points, sem emojis. Foque em formação acadêmica, atuação profissional, especialidades e relevância para os cursos vinculados. Não invente dados — se faltar informação, omita.`;

    const userPrompt = `Gere a mini-biografia do(a) professor(a) abaixo.

NOME: ${prof.nome}
TITULAÇÃO: ${prof.titulacao || "—"}
GRADUAÇÃO: ${prof.graduacao || "—"}
ÁREA DE EXPERTISE: ${prof.area_expertise || "—"}
ESPECIALIDADE/PÓS: ${prof.pos_graduacao_especialidade || "—"}
CURSOS QUE LECIONA: ${cursosNomes.join(", ") || "—"}
AULAS RECENTES: ${aulasResumo || "—"}

${lattesText ? `\nCONTEÚDO BRUTO DO CURRÍCULO LATTES (use para enriquecer com formação, instituições, linhas de pesquisa, atuação):\n"""${lattesText}"""` : "\nObs: Currículo Lattes não disponível."}`;

    const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!aiResp.ok) {
      const t = await aiResp.text();
      console.error("AI error", aiResp.status, t);
      if (aiResp.status === 429) {
        return new Response(JSON.stringify({ error: "Limite de uso da IA atingido. Tente novamente em alguns minutos." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiResp.status === 402) {
        return new Response(JSON.stringify({ error: "Créditos da IA esgotados. Adicione créditos no workspace." }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      throw new Error("AI gateway error");
    }

    const aiJson = await aiResp.json();
    const descricao: string = aiJson.choices?.[0]?.message?.content?.trim() || "";

    if (!descricao) throw new Error("Empty AI response");

    await sb
      .from("ped_professores")
      .update({
        descricao_ia: descricao,
        descricao_ia_atualizada_em: new Date().toISOString(),
      })
      .eq("id", professor_id);

    return new Response(JSON.stringify({ descricao, lattes_used: !!lattesText }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("generate-professor-bio error:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
