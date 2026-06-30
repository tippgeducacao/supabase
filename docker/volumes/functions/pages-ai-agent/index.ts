/**
 * pages-ai-agent — Edição assistida por IA do PPG Pages (chat "Editar com IA").
 *
 * O usuário conversa em PT-BR e o Claude EDITA a landing page: recebe os blocos
 * atuais + o catálogo de elementos (enviado do front, sempre em sincronia) + a
 * conversa, e responde via TOOL-USE devolvendo a PÁGINA INTEIRA nova + um resumo.
 *
 * "Logado, sem token no front": a chamada exige um JWT válido (usuário autenticado
 * no sistema); a API key da Anthropic vive na tabela `ai_api_keys` (server-side).
 * Quem tem acesso ao Pages usa livremente — não há sistema de créditos.
 *
 * Deploy: git push (workflow deploy-edges.yml). NUNCA o "Deploy" do Dokploy.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 8192;

const ELEMENT_TYPES = [
  "titulo", "paragrafo", "formulario", "botao", "imagem", "slider", "video",
  "icone", "caixa", "circulo", "linha-vertical", "linha-horizontal", "timer", "faq", "html",
];

interface ChatMessage { role: "user" | "assistant"; content: string }
interface ReqBody {
  blocks?: unknown[];
  messages?: ChatMessage[];
  /** Mapa { [tipo]: defaultProps } enviado do front (catálogo real, sempre em sincronia). */
  catalog?: Record<string, Record<string, unknown>>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

/** Ferramenta que o Claude chama para devolver a página inteira de forma estruturada. */
const EDIT_TOOL = {
  name: "editar_pagina",
  description:
    "Define o conteúdo COMPLETO da página de destino (todos os blocos). Use sempre que o " +
    "usuário pedir qualquer mudança no conteúdo/layout. Retorne a página INTEIRA, repetindo " +
    "igual o que não muda e preservando os ids existentes.",
  input_schema: {
    type: "object",
    properties: {
      resumo: {
        type: "string",
        description: "Frase curta em PT-BR resumindo o que você mudou (ex.: 'Adicionei uma seção de depoimentos').",
      },
      blocks: {
        type: "array",
        description: "Lista ordenada de blocos (faixas horizontais) que compõem a página.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Mantenha o id existente; omita em blocos novos." },
            background: { type: "string", description: "Cor CSS ou gradiente, ex.: '#ffffff' ou 'linear-gradient(...)'." },
            paddingY: { type: "number", description: "Espaçamento vertical em px (ex.: 56)." },
            align: { type: "string", enum: ["left", "center", "right", "justify"] },
            elements: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", description: "Mantenha o id existente; omita em elementos novos." },
                  type: { type: "string", enum: ELEMENT_TYPES },
                  props: { type: "object", description: "Props do tipo (use os nomes EXATOS do catálogo)." },
                },
                required: ["type", "props"],
              },
            },
          },
          required: ["background", "paddingY", "align", "elements"],
        },
      },
    },
    required: ["resumo", "blocks"],
  },
};

function buildSystemPrompt(blocks: unknown[], catalog: Record<string, unknown>): string {
  return `Você é um designer especialista em landing pages de alta conversão, integrado ao editor visual PPG Pages. O usuário conversa com você em Português do Brasil e você EDITA a landing page dele.

## Modelo de dados
Uma página é uma LISTA DE BLOCOS (faixas horizontais full-width, empilhadas verticalmente). Cada bloco:
- background: cor CSS ou gradiente (ex.: "#ffffff", "linear-gradient(135deg,#1A73E8,#00C2D6)")
- paddingY: espaçamento vertical interno, em px (ex.: 56)
- align: alinhamento do conteúdo ("left" | "center" | "right" | "justify")
- elements: lista de elementos empilhados dentro do bloco

Cada ELEMENTO tem: { type, props } (e id quando já existe). Os tipos disponíveis e suas props PADRÃO (use EXATAMENTE estes nomes de prop; valores são só exemplos do default):
${JSON.stringify(catalog, null, 2)}

## Regras
- SEMPRE responda chamando a ferramenta "editar_pagina" com a PÁGINA INTEIRA. O que não muda, repita idêntico (mesmos ids).
- PRESERVE os ids de blocos/elementos que continuam existindo. Crie elementos/blocos novos SEM id (o sistema gera).
- Use SOMENTE props que existem no catálogo do tipo. Não invente campos.
- Cores em hex. Para imagens, só preencha "src"/"images"/"url" com URLs reais e públicas quando o usuário pedir imagem/vídeo específico; senão deixe "" (placeholder aparece no editor).
- Escreva copy persuasiva, clara e em PT-BR, coerente com o que o usuário pede.
- Para seções ricas (hero, benefícios, depoimentos, preço, FAQ, CTA) componha vários elementos (titulo + paragrafo + botao + imagem/icone/faq/formulario) e ajuste background/paddingY do bloco para dar respiro.
- Se o pedido for ambíguo, faça a melhor interpretação e siga — você pode refinar nas próximas mensagens.

## Página atual (JSON dos blocos)
${JSON.stringify(blocks, null, 2)}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

    // ── Gate "logado": exige JWT válido (qualquer usuário autenticado) ──────────────
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!jwt) return json({ error: "Não autenticado." }, 401);
    const { data: userData, error: userErr } = await supabase.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "Sessão inválida." }, 401);

    const { blocks = [], messages = [], catalog = {} } = (await req.json()) as ReqBody;
    if (!Array.isArray(messages) || messages.length === 0) {
      return json({ error: "messages é obrigatório." }, 400);
    }

    // ── API key da Anthropic (server-side) ──────────────────────────────────────────
    const { data: keyRow } = await supabase
      .from("ai_api_keys")
      .select("api_key")
      .eq("provider", "anthropic")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (!keyRow?.api_key) {
      return json({ error: "IA indisponível: nenhuma chave Anthropic ativa configurada." }, 503);
    }

    const systemPrompt = buildSystemPrompt(Array.isArray(blocks) ? blocks : [], catalog);
    const chat = messages
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => ({ role: m.role, content: m.content }));

    const aiRes = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": keyRow.api_key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        tools: [EDIT_TOOL],
        messages: chat,
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      console.error("Anthropic error:", aiRes.status, errText);
      return json({ error: `Erro da IA (${aiRes.status}). Tente novamente.` }, 502);
    }

    const data = await aiRes.json();
    const content: Array<Record<string, unknown>> = Array.isArray(data?.content) ? data.content : [];
    const toolUse = content.find((b) => b.type === "tool_use");
    const textBlock = content
      .filter((b) => b.type === "text")
      .map((b) => (b.text as string) ?? "")
      .join("\n")
      .trim();

    if (toolUse && typeof toolUse.input === "object" && toolUse.input) {
      const input = toolUse.input as { blocks?: unknown[]; resumo?: string };
      return json({
        blocks: Array.isArray(input.blocks) ? input.blocks : null,
        resumo: typeof input.resumo === "string" ? input.resumo : undefined,
        message: textBlock || undefined,
      });
    }

    // Sem tool_use → a IA respondeu só em texto (ex.: pediu esclarecimento). Sem edição.
    return json({ blocks: null, message: textBlock || "Não entendi o pedido. Pode detalhar?" });
  } catch (e) {
    console.error("pages-ai-agent error:", e);
    return json({ error: (e as Error)?.message || "Erro desconhecido" }, 500);
  }
});
