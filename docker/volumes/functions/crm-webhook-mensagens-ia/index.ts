// crm-webhook-mensagens-ia
// Escreve o texto de UMA variável do template para VÁRIAS webhooks de captação de uma vez.
// Mesmo padrão de crm-planilha-ia/gt-ai-improve: Anthropic direto (chave em ai_api_keys),
// fallback pro Lovable AI Gateway (Gemini).
//
// ⚠️ GERA, NUNCA GRAVA. A resposta volta para a tela como uma sugestão por webhook; quem
// escreve em crm_webhook_integrations é o usuário, depois de ver o antes→depois de cada
// mensagem final na confirmação. É a mesma regra do crm-planilha-ia, e aqui ela pesa mais:
// o texto sai por WhatsApp para lead real, em até 123 captações.
//
// Entrada:  { instrucao, variavel, corpoTemplate?, webhooks: [{ id, nome, funil?, etapa?,
//             variaveis: string[] }] }
// Saída:    { sugestoes: [{ id, texto }], modelo }
//
// A resposta é validada antes de sair: uma sugestão por webhook enviada, mesmos ids, sem
// texto vazio. Sugestão faltando é ERRO — silenciosamente escrever em 19 de 20 webhooks
// seria pior que falhar.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

/** Teto de webhooks por chamada: acima disso a resposta fica grande demais para caber num
 *  max_tokens sadio, e o risco de a IA pular linha cresce. A tela divide em lotes. */
const MAX_WEBHOOKS = 40;

interface WebhookEntrada {
  id: string;
  nome: string;
  funil?: string | null;
  etapa?: string | null;
  variaveis: string[];
}

interface ReqBody {
  instrucao: string;
  variavel: number;
  corpoTemplate?: string | null;
  webhooks: WebhookEntrada[];
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function buildSystemPrompt(variavel: number, corpoTemplate?: string | null): string {
  const corpo = corpoTemplate?.trim()
    ? `O texto que você escreve entra no lugar de {{${variavel + 1}}} DESTE modelo aprovado do WhatsApp:\n"""\n${corpoTemplate.trim()}\n"""\nEntão NÃO repita o cumprimento nem a pergunta final que o modelo já traz — escreva só o pedaço que falta.`
    : `O texto que você escreve entra no lugar de {{${variavel + 1}}} de um modelo aprovado do WhatsApp, junto com outros pedaços. Escreva só esse pedaço.`;

  return `Você escreve mensagens de WhatsApp para a PPGVET, instituição brasileira de pós-graduação e cursos para veterinária, zootecnia e agronegócio. Responda SOMENTE em português do Brasil.

${corpo}

Regras do texto:
- Fale com UMA pessoa, em tom cordial e direto, como um monitor do curso falaria. Sem "prezado", sem linguagem de marketing, sem emoji, sem CAPS.
- Nada de promessa de resultado, preço, desconto ou urgência artificial.
- Uma ou duas frases. Nunca mais que 300 caracteres.
- NÃO use {{1}}, {{2}} nem chaves de nenhum tipo no texto que você escrever.
- Cada webhook é uma captação de um curso/aula diferente: o texto tem que ser específico daquele assunto e daquele público, nunca genérico. Use o nome da captação para saber o tema.
- Se o nome da captação trouxer uma data, respeite-a exatamente como está.

Responda APENAS um objeto JSON, sem markdown, sem crase, sem comentário:
{"sugestoes":[{"id":"<id recebido>","texto":"<texto>"}]}
Devolva EXATAMENTE uma entrada por webhook recebida, com o MESMO id, na mesma ordem. Não pule nenhuma, não invente id.`;
}

function buildUserMessage(body: ReqBody): string {
  const lista = body.webhooks.map((w) => ({
    id: w.id,
    captacao: w.nome,
    funil: w.funil ?? undefined,
    etapa: w.etapa ?? undefined,
    // O texto atual é referência de TOM e de tamanho — a instrução do usuário manda.
    texto_atual: w.variaveis[body.variavel] ?? "",
    outras_partes: w.variaveis.filter((_, i) => i !== body.variavel),
  }));
  return [
    `Instrução do usuário: ${body.instrucao.trim()}`,
    `Webhooks (JSON):\n${JSON.stringify(lista)}`,
  ].join("\n\n");
}

function parseJsonResposta(texto: string): Record<string, unknown> {
  const limpo = texto.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  return JSON.parse(limpo);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const inicio = Date.now();
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  let body: ReqBody | undefined;
  let usuarioId: string | null = null;

  const registrarEvento = async (extra: {
    modelo?: string | null; tokensEntrada?: number | null; tokensSaida?: number | null;
    sugestoes?: number; erro?: string | null;
  }) => {
    try {
      await supabase.from("crm_webhook_mensagens_ia_eventos").insert({
        usuario_id: usuarioId,
        webhooks_enviadas: body?.webhooks?.length ?? 0,
        sugestoes_recebidas: extra.sugestoes ?? 0,
        variavel: body?.variavel ?? null,
        instrucao: body?.instrucao?.slice(0, 2000) ?? null,
        modelo: extra.modelo ?? null,
        tokens_entrada: extra.tokensEntrada ?? null,
        tokens_saida: extra.tokensSaida ?? null,
        duracao_ms: Date.now() - inicio,
        erro: extra.erro ?? null,
      });
    } catch (e) {
      console.error("crm-webhook-mensagens-ia: falha ao registrar telemetria:", e);
    }
  };

  try {
    const authHeader = req.headers.get("authorization");
    if (authHeader) {
      const { data: userData } = await supabase.auth.getUser(authHeader.replace(/^Bearer\s+/i, ""));
      usuarioId = userData?.user?.id ?? null;
    }
    // Sugestão de texto não expõe dado de ninguém, mas é chamada paga: exige sessão.
    if (!usuarioId) return json({ error: "Faça login para usar a IA." }, 401);

    body = (await req.json()) as ReqBody;

    if (!body.instrucao?.trim()) return json({ error: "Diga o que a IA deve escrever." }, 400);
    if (!Number.isInteger(body.variavel) || body.variavel < 0) return json({ error: "variavel inválida" }, 400);
    if (!Array.isArray(body.webhooks) || body.webhooks.length === 0) {
      return json({ error: "Marque pelo menos uma webhook." }, 400);
    }
    if (body.webhooks.length > MAX_WEBHOOKS) {
      return json({ error: `Peça para até ${MAX_WEBHOOKS} webhooks por vez — foram enviadas ${body.webhooks.length}.` }, 400);
    }

    const systemPrompt = buildSystemPrompt(body.variavel, body.corpoTemplate);
    const userMessage = buildUserMessage(body);

    const chamarAnthropic = (apiKey: string) =>
      fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          system: systemPrompt,
          max_tokens: 8192,
          messages: [{ role: "user", content: userMessage }],
        }),
      });

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
        console.error("crm-webhook-mensagens-ia: Lovable AI Gateway error:", res.status, errText);
        if (res.status === 429) return { error: "Limite de requisições da IA excedido. Aguarde alguns segundos.", status: 429 };
        if (res.status === 402) return { error: "Créditos da IA esgotados.", status: 402 };
        return { error: `Erro do gateway de IA (${res.status})`, status: 500 };
      }
      const data = await res.json();
      return { texto: (data?.choices?.[0]?.message?.content as string | undefined)?.trim() ?? "" };
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
        console.error("crm-webhook-mensagens-ia: Anthropic error:", aiRes.status, errText);
        const deveCairNoFallback =
          aiRes.status === 401 || aiRes.status === 402 || aiRes.status === 404 ||
          aiRes.status === 429 || aiRes.status >= 500 || /credit|balance|billing|quota|not_found|model/i.test(errText);
        if (!deveCairNoFallback) {
          await registrarEvento({ erro: `Anthropic ${aiRes.status}` });
          return json({ error: `Erro Anthropic ${aiRes.status}` }, 500);
        }
        console.warn("crm-webhook-mensagens-ia: Anthropic indisponível, usando fallback Lovable AI Gateway…");
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

    let obj: Record<string, unknown>;
    try {
      obj = parseJsonResposta(textoResposta);
    } catch {
      await registrarEvento({ modelo: modeloUsado, tokensEntrada, tokensSaida, erro: "resposta não é JSON válido" });
      return json({ error: "A IA não devolveu um formato válido. Tente reformular o pedido." }, 502);
    }

    // ── Validação: uma sugestão por webhook, mesmos ids, nada vazio ──────────
    // Aceitar uma resposta parcial escreveria em 19 de 20 webhooks e deixaria a 20ª com o
    // texto velho, sem ninguém notar. Falhar é melhor.
    const brutas = Array.isArray(obj.sugestoes) ? (obj.sugestoes as Record<string, unknown>[]) : [];
    const porId = new Map<string, string>();
    for (const s of brutas) {
      const id = typeof s?.id === "string" ? s.id : "";
      const texto = typeof s?.texto === "string" ? s.texto.trim() : "";
      if (id && texto) porId.set(id, texto);
    }
    const faltando = body.webhooks.filter((w) => !porId.has(w.id));
    if (faltando.length > 0) {
      await registrarEvento({
        modelo: modeloUsado, tokensEntrada, tokensSaida, sugestoes: porId.size,
        erro: `faltaram ${faltando.length} sugestões`,
      });
      return json({
        error: `A IA devolveu ${porId.size} de ${body.webhooks.length} sugestões. Tente de novo, ou marque menos webhooks por vez.`,
      }, 502);
    }

    const sugestoes = body.webhooks.map((w) => ({ id: w.id, texto: porId.get(w.id)! }));
    await registrarEvento({ modelo: modeloUsado, tokensEntrada, tokensSaida, sugestoes: sugestoes.length });
    return json({ sugestoes, modelo: modeloUsado });
  } catch (e: any) {
    console.error("crm-webhook-mensagens-ia error:", e);
    await registrarEvento({ erro: e?.message || "Erro desconhecido" });
    return json({ error: e?.message || "Erro desconhecido" }, 500);
  }
});
