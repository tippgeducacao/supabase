// crm-planilha-ia
// IA embutida da Planilha do CRM Comercial (Fase 6) — mesmo padrão de gt-ai-improve/index.ts
// (Anthropic direto via chave em ai_api_keys, fallback pro Lovable AI Gateway/Gemini).
//
// Cinco ações (campo `acao` no corpo), cada uma com um formato de resposta JSON próprio:
//   formula          → { formula: "=SOMASE(...)" }               fórmula pra célula ativa
//   preencher_coluna → { tipo: "formula", formula: "=..." }       preferido: fórmula que recalcula
//                    | { tipo: "valores", valores: [...] }        fallback: texto não-formulável
//   limpar_dados     → { valores: [...] }                         mesma quantidade/ordem da amostra enviada
//   perguntar        → { resposta: "texto" }                      só leitura, não mexe na grade
//   resumir          → { resumo: "texto" }                        só leitura, não mexe na grade
//
// TODA escrita na grade (formula/preencher_coluna/limpar_dados) é responsabilidade do CLIENTE
// aplicar via undo — este function só GERA o conteúdo, nunca grava em crm_planilha_abas.
// Telemetria: sempre grava uma linha em crm_planilha_ia_eventos no final (sucesso ou erro),
// best-effort (nunca derruba a resposta principal por causa disso).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
// claude-sonnet-4-20250514 (Sonnet 4.0) foi descontinuado em 15/06/2026 → 404.
const MODEL = "claude-sonnet-4-6";

const MAX_LINHAS_AMOSTRA = 500;

type Acao = "formula" | "preencher_coluna" | "limpar_dados" | "perguntar" | "resumir";
const ACOES: Acao[] = ["formula", "preencher_coluna", "limpar_dados", "perguntar", "resumir"];

interface ReqBody {
  acao: Acao;
  prompt: string;
  planilhaId?: string | null;
  abaId?: string | null;
  colunas: string[];
  amostra: Record<string, unknown>[];
  colunaAlvo?: string | null;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const FORMATO_POR_ACAO: Record<Acao, string> = {
  formula: `Responda APENAS um objeto JSON, sem markdown, sem crase, sem comentário: {"formula": "=FUNÇÃO(...)"}.
A fórmula deve começar com "=" e usar SOMENTE estas funções (em português ou inglês, tanto faz):
SOMA/SUM, MEDIA/AVERAGE, MIN, MAX, CONT.NUM/COUNT, CONT.SE/COUNTIF, SOMASE/SUMIF, SE/IF, CONCAT, HOJE/TODAY, PROCV/VLOOKUP.
Referências de célula usam letra+número (A1, B2...) baseado na ORDEM das colunas fornecidas (1ª coluna = A, 2ª = B...).`,
  preencher_coluna: `Responda APENAS um objeto JSON, sem markdown, sem crase, sem comentário.
Se o valor de cada linha puder ser calculado por uma fórmula ÚNICA que funcione pra qualquer linha (usando as mesmas funções do modo "formula"), responda {"tipo":"formula","formula":"=..."}.
Se NÃO der pra expressar como fórmula (ex.: precisa interpretar texto livre, classificar, traduzir), responda {"tipo":"valores","valores":[...]} com EXATAMENTE um valor por linha da amostra, NA MESMA ORDEM.`,
  limpar_dados: `Responda APENAS um objeto JSON, sem markdown, sem crase, sem comentário: {"valores": [...]}.
O array "valores" deve ter EXATAMENTE o mesmo número de itens que a amostra enviada, NA MESMA ORDEM — um valor limpo/normalizado por item de entrada. Não pule, não junte, não reordene linhas.`,
  perguntar: `Responda APENAS um objeto JSON, sem markdown, sem crase, sem comentário: {"resposta": "texto direto, sem formatação markdown"}.`,
  resumir: `Responda APENAS um objeto JSON, sem markdown, sem crase, sem comentário: {"resumo": "texto direto, sem formatação markdown"}.`,
};

function buildSystemPrompt(acao: Acao): string {
  return `Você é o assistente de IA embutido numa planilha estilo Excel (PPGVET, PT-BR).
O usuário está trabalhando com uma seleção de dados da planilha e pediu uma ação. Responda SOMENTE em português.

${FORMATO_POR_ACAO[acao]}

Nunca invente colunas ou dados que não foram enviados. Se a instrução do usuário for ambígua ou impossível com os dados enviados, ainda assim responda no formato JSON pedido, usando sua melhor interpretação.`;
}

function buildUserMessage(body: ReqBody): string {
  const partes = [
    `Instrução do usuário: ${body.prompt.trim()}`,
    `Colunas disponíveis (nesta ordem — 1ª = A, 2ª = B...): ${body.colunas.join(", ")}`,
  ];
  if (body.colunaAlvo) partes.push(`Coluna alvo (onde o resultado vai entrar): ${body.colunaAlvo}`);
  partes.push(`Amostra de dados (JSON, um objeto por linha):\n${JSON.stringify(body.amostra)}`);
  return partes.join("\n\n");
}

function parseJsonResposta(texto: string): Record<string, unknown> {
  const limpo = texto.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  return JSON.parse(limpo);
}

function validarResposta(acao: Acao, obj: Record<string, unknown>): { ok: true } | { ok: false; erro: string } {
  switch (acao) {
    case "formula":
      return typeof obj.formula === "string" && obj.formula.startsWith("=")
        ? { ok: true } : { ok: false, erro: "IA não devolveu uma fórmula válida" };
    case "preencher_coluna":
      if (obj.tipo === "formula" && typeof obj.formula === "string" && obj.formula.startsWith("=")) return { ok: true };
      if (obj.tipo === "valores" && Array.isArray(obj.valores)) return { ok: true };
      return { ok: false, erro: "IA não devolveu um formato reconhecido (nem fórmula, nem lista de valores)" };
    case "limpar_dados":
      return Array.isArray(obj.valores) ? { ok: true } : { ok: false, erro: "IA não devolveu a lista de valores limpos" };
    case "perguntar":
      return typeof obj.resposta === "string" ? { ok: true } : { ok: false, erro: "IA não devolveu uma resposta" };
    case "resumir":
      return typeof obj.resumo === "string" ? { ok: true } : { ok: false, erro: "IA não devolveu um resumo" };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const inicio = Date.now();
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  let body: ReqBody;
  let usuarioId: string | null = null;

  const registrarEvento = async (extra: {
    modelo?: string | null; tokensEntrada?: number | null; tokensSaida?: number | null; erro?: string | null;
  }) => {
    try {
      await supabase.from("crm_planilha_ia_eventos").insert({
        planilha_id: body?.planilhaId ?? null,
        aba_id: body?.abaId ?? null,
        usuario_id: usuarioId,
        acao: body?.acao ?? "perguntar",
        prompt: body?.prompt?.slice(0, 2000) ?? null,
        modelo: extra.modelo ?? null,
        tokens_entrada: extra.tokensEntrada ?? null,
        tokens_saida: extra.tokensSaida ?? null,
        duracao_ms: Date.now() - inicio,
        erro: extra.erro ?? null,
      });
    } catch (e) {
      console.error("crm-planilha-ia: falha ao registrar telemetria:", e);
    }
  };

  try {
    // Identifica o usuário autenticado (só pra telemetria — a autorização de acesso à
    // planilha/aba já foi conferida pela RLS quando o cliente carregou os dados que manda aqui).
    const authHeader = req.headers.get("authorization");
    if (authHeader) {
      const { data: userData } = await supabase.auth.getUser(authHeader.replace(/^Bearer\s+/i, ""));
      usuarioId = userData?.user?.id ?? null;
    }

    body = (await req.json()) as ReqBody;

    if (!body.acao || !ACOES.includes(body.acao)) {
      return json({ error: `acao inválida (esperado: ${ACOES.join(", ")})` }, 400);
    }
    if (!body.prompt || typeof body.prompt !== "string" || !body.prompt.trim()) {
      return json({ error: "prompt é obrigatório" }, 400);
    }
    if (!Array.isArray(body.colunas) || body.colunas.length === 0) {
      return json({ error: "colunas é obrigatório" }, 400);
    }
    if (!Array.isArray(body.amostra)) {
      return json({ error: "amostra é obrigatório (pode ser vazio)" }, 400);
    }
    if (body.amostra.length > MAX_LINHAS_AMOSTRA) {
      return json({ error: `Selecione até ${MAX_LINHAS_AMOSTRA} linhas por vez para usar a IA — foram enviadas ${body.amostra.length}.` }, 400);
    }

    const systemPrompt = buildSystemPrompt(body.acao);
    const userMessage = buildUserMessage(body);

    const chamarAnthropic = async (apiKey: string) => {
      const res = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          system: systemPrompt,
          max_tokens: 4096,
          messages: [{ role: "user", content: userMessage }],
        }),
      });
      return res;
    };

    const chamarLovableGateway = async (): Promise<{ texto?: string; error?: string; status?: number }> => {
      const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
      if (!LOVABLE_API_KEY) return { error: "LOVABLE_API_KEY não configurada (fallback indisponível)", status: 500 };
      const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        console.error("crm-planilha-ia: Lovable AI Gateway error:", res.status, errText);
        if (res.status === 429) return { error: "Limite de requisições da IA excedido. Aguarde alguns segundos.", status: 429 };
        if (res.status === 402) return { error: "Créditos da IA esgotados.", status: 402 };
        return { error: `Erro do gateway de IA (${res.status})`, status: 500 };
      }
      const data = await res.json();
      const texto = (data?.choices?.[0]?.message?.content as string | undefined)?.trim() ?? "";
      return { texto };
    };

    let textoResposta: string | null = null;
    let modeloUsado: string | null = null;
    let tokensEntrada: number | null = null;
    let tokensSaida: number | null = null;

    const { data: keyRow } = await supabase
      .from("ai_api_keys")
      .select("api_key")
      .eq("provider", "anthropic")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (keyRow?.api_key) {
      const aiRes = await chamarAnthropic(keyRow.api_key);
      if (aiRes.ok) {
        const data = await aiRes.json();
        textoResposta = data?.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim() ?? "";
        modeloUsado = data?.model ?? MODEL;
        tokensEntrada = data?.usage?.input_tokens ?? null;
        tokensSaida = data?.usage?.output_tokens ?? null;
      } else {
        const errText = await aiRes.text();
        console.error("crm-planilha-ia: Anthropic error:", aiRes.status, errText);
        const deveCairNoFallback =
          aiRes.status === 401 || aiRes.status === 402 || aiRes.status === 404 ||
          aiRes.status === 429 || aiRes.status >= 500 || /credit|balance|billing|quota|not_found|model/i.test(errText);
        if (!deveCairNoFallback) {
          await registrarEvento({ erro: `Anthropic ${aiRes.status}` });
          return json({ error: `Erro Anthropic ${aiRes.status}` }, 500);
        }
        console.warn("crm-planilha-ia: Anthropic indisponível, usando fallback Lovable AI Gateway…");
      }
    }

    if (textoResposta === null) {
      const fallback = await chamarLovableGateway();
      if (fallback.error) {
        await registrarEvento({ erro: fallback.error });
        return json({ error: fallback.error }, fallback.status ?? 500);
      }
      textoResposta = fallback.texto ?? "";
      modeloUsado = "google/gemini-2.5-flash";
    }

    let objResposta: Record<string, unknown>;
    try {
      objResposta = parseJsonResposta(textoResposta);
    } catch {
      await registrarEvento({ modelo: modeloUsado, tokensEntrada, tokensSaida, erro: "resposta não é JSON válido" });
      return json({ error: "A IA não devolveu um formato válido. Tente reformular o pedido." }, 502);
    }

    const validacao = validarResposta(body.acao, objResposta);
    if (!validacao.ok) {
      await registrarEvento({ modelo: modeloUsado, tokensEntrada, tokensSaida, erro: validacao.erro });
      return json({ error: validacao.erro }, 502);
    }

    await registrarEvento({ modelo: modeloUsado, tokensEntrada, tokensSaida });
    return json({ ...objResposta, modelo: modeloUsado });
  } catch (e: any) {
    console.error("crm-planilha-ia error:", e);
    await registrarEvento({ erro: e?.message || "Erro desconhecido" });
    return json({ error: e?.message || "Erro desconhecido" }, 500);
  }
});
