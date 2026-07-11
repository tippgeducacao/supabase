// disc-feedback
// Gera relatório DISC personalizado para um colaborador via Anthropic.
// Saída em 3 blocos de 3 itens: hábitos, esportes e estudos.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-haiku-4-5-20251001";

async function getAnthropicKey(sb: any): Promise<string> {
  const { data, error } = await sb
    .from("ai_api_keys")
    .select("api_key")
    .eq("provider", "anthropic")
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("Erro ao ler chave Anthropic: " + error.message);
  if (!data?.api_key) {
    throw new Error("Chave Anthropic ativa não encontrada em ai_api_keys. Configure em /ia-config.");
  }
  return data.api_key as string;
}

// Robust JSON extractor: aceita resposta com fences markdown ou prefixos.
function extractJson(text: string): any | null {
  let s = (text || "").trim();
  s = s.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  // Pega da primeira { até a última } (Claude às vezes acrescenta intro).
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) s = s.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { nome, perfil_d, perfil_i, perfil_s, perfil_c, perfil_dominante, setor } = await req.json();

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    const ANTHROPIC_API_KEY = await getAnthropicKey(sb);

    const perfis = [
      { letra: "D", nome: "Dominância", pct: perfil_d },
      { letra: "I", nome: "Influência", pct: perfil_i },
      { letra: "S", nome: "Estabilidade", pct: perfil_s },
      { letra: "C", nome: "Conformidade", pct: perfil_c },
    ];
    const ordenados = [...perfis].sort((a, b) => a.pct - b.pct);
    const fracos = ordenados.slice(0, 2).map((p) => `${p.letra} (${p.nome}) = ${p.pct}%`).join(", ");
    const fortes = [...perfis].sort((a, b) => b.pct - a.pct).slice(0, 2)
      .map((p) => `${p.letra} (${p.nome}) = ${p.pct}%`).join(", ");

    const systemPrompt =
      "Você é um consultor sênior de desenvolvimento humano que trabalha com a metodologia DISC. " +
      "Sua resposta deve ser SOMENTE JSON válido, sem markdown, sem texto antes ou depois. " +
      "O JSON deve seguir EXATAMENTE o schema solicitado pelo usuário, sem chaves extras. " +
      "Escreva em português brasileiro acolhedor e prático, sem jargão corporativo importado.\n\n" +
      "CONTEXTO INTERNO (use somente como filtro para SUAS escolhas — NUNCA mencione no texto):\n" +
      "- O colaborador vive em uma cidade pequena de interior, sem acesso fácil a centros grandes.\n" +
      "- Toda recomendação precisa ser realista e acessível em qualquer cidade do interior.\n" +
      "- Prefira opções gratuitas ou de baixo custo; evite golfe, tênis privado, equitação, esqui, " +
      "mentorias premium pagas, eventos em capitais.\n\n" +
      "REGRAS DE ESCRITA DO RELATÓRIO (obrigatórias):\n" +
      "- NUNCA cite a cidade pelo nome (Ampere/PR ou qualquer outra). Trate o colaborador como uma pessoa qualquer.\n" +
      "- NUNCA mencione salário, faixa de renda, orçamento, valores em reais, custo mensal ou similares.\n" +
      "- NUNCA escreva frases tipo 'pensando em uma cidade pequena' ou 'considerando seu salário' — isso é constrangedor.\n" +
      "- Para 'onde_encontrar' e 'como_comecar' apenas indique onde acessar (ex: 'YouTube', 'biblioteca municipal', " +
      "'Sebrae online', 'app gratuito X') sem comentar custo nem localização do colaborador.";

    const userPrompt = `Gere um relatório DISC personalizado para "${nome}" do setor "${setor}".

PERFIL:
- D (Dominância): ${perfil_d}%
- I (Influência): ${perfil_i}%
- S (Estabilidade): ${perfil_s}%
- C (Conformidade): ${perfil_c}%
- Perfil dominante: ${perfil_dominante}
- Perfis mais fracos (foco das recomendações): ${fracos}
- Perfis mais fortes (já dominados): ${fortes}

REGRAS GERAIS:
- DISC mede PROBABILIDADE DE REAÇÃO IMEDIATA a um acontecimento, NÃO julga qualidade de pessoa.
- Não tratar perfis fracos como "ruins". Cada um pode escolher o que faz sentido desenvolver.
- 3 hábitos, 3 esportes, 3 estudos — cada um com motivação clara.
- Esportes válidos: caminhada, corrida de rua, futebol/futsal, ciclismo, vôlei, bocha, pesca esportiva,
  tênis de mesa, natação, academia (qualquer uma). Nenhum outro.
- Estudos: livro físico, e-book, podcast, canal do YouTube, curso (Sebrae, FGV, Coursera audit, etc.).
  Indicar onde encontrar (sem citar custo).
- Resumo do perfil em português natural (parágrafo de 4-6 frases).
- NUNCA escrever sobre cidade, salário, orçamento ou valores no relatório.

Responda EXATAMENTE com este JSON (sem markdown, sem texto fora):
{
  "resumo_perfil": "Parágrafo de 4-6 frases explicando o que esses % significam no dia a dia desta pessoa, sem julgar, terminando com uma frase que mostre quais pontos podem ser desenvolvidos se ela quiser.",
  "habitos": [
    {
      "nome": "Nome curto e direto do hábito (verbo no infinitivo)",
      "por_que": "1-2 frases explicando como esse hábito ajuda esta pessoa especificamente",
      "como_comecar": "Passo concreto e barato pra começar hoje (com gatilho, horário, ferramenta gratuita)"
    }
  ],
  "esportes": [
    {
      "esporte": "Nome do esporte (somente da lista válida)",
      "por_que": "1-2 frases ligando o esporte ao perfil",
      "como_comecar": "Como começar (sem citar cidade nem orçamento): rotina sugerida, frequência, dica prática"
    }
  ],
  "estudos": [
    {
      "tipo": "livro | curso | podcast | canal_youtube",
      "titulo": "Nome real do material (livros conhecidos, cursos reais)",
      "autor_canal": "Autor do livro, canal/instituição do curso ou podcast",
      "por_que": "1-2 frases conectando o material ao desenvolvimento do perfil",
      "onde_encontrar": "Onde acessar (preferir grátis: biblioteca municipal, YouTube, Coursera audit, Sebrae)"
    }
  ],
  "mensagem_final": "Mensagem curta (2-3 frases) fechando o relatório, mencionando ${nome} pelo nome. Tom acolhedor, sem clichê motivacional, lembrando que o teste mostra apenas tendência de reação imediata e que o desenvolvimento é uma escolha pessoal."
}

IMPORTANTE:
- Exatamente 3 itens em habitos, esportes e estudos.
- Foque nos perfis fracos (${fracos}) mas pode reforçar os fortes em 1 dos itens.
- Para "estudos", varie os tipos (não 3 livros — misture livro + canal/podcast + curso).`;

    const aiResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 3000,
        system: systemPrompt,
        messages: [
          { role: "user", content: userPrompt },
          // Prefill abre direto a chave do JSON — Claude continua de onde parou
          // e nunca devolve "Aqui está o JSON:" antes.
          { role: "assistant", content: "{" },
        ],
      }),
    });

    if (!aiResp.ok) {
      const t = await aiResp.text();
      console.error("Anthropic error", aiResp.status, t);
      const map: Record<number, [number, string]> = {
        401: [401, "Chave Anthropic inválida. Atualize em /ia-config."],
        429: [429, "Limite de uso da Anthropic atingido. Tente novamente em alguns segundos."],
      };
      // 422 (nunca 502/504): o Cloudflare engole 502/504 da origem sem headers CORS.
      const [status, msg] = map[aiResp.status] ?? [422, `Anthropic error ${aiResp.status}: ${t.slice(0, 200)}`];
      return new Response(JSON.stringify({ error: msg }), {
        status, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiJson = await aiResp.json();
    // Como usamos prefill "{", a resposta vem sem a abertura — reconstituímos.
    const rawText: string = (aiJson.content?.[0]?.text ?? "").trim();
    const fullJsonText = rawText.startsWith("{") ? rawText : "{" + rawText;
    let parsed = extractJson(fullJsonText);

    if (!parsed || typeof parsed !== "object") {
      console.error("JSON parse failed. Raw:", fullJsonText.slice(0, 500));
      return new Response(JSON.stringify({
        error: "A IA retornou em formato inesperado. Tente regerar.",
        debug_raw: fullJsonText.slice(0, 300),
      }), { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
