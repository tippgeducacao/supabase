import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const ANTHROPIC_KEY_NAME = "ANTHROPIC_API_KEY";
const RECONTATO_CONFIG_KEY = "RECONTATO_CONFIG_V1";

const DEFAULT_SYSTEM =
  'Você é a Mimosa, inteligência comercial da PPGVET Educação. Sua missão aqui é ajudar o vendedor a REVERTER uma pessoa que teve uma reunião e ainda não se matriculou. Você lê a objeção que a pessoa deu e devolve respostas prontas, curtas e práticas — frases que o vendedor pode usar direto no WhatsApp ou numa ligação. Tom humano, respeitoso e confiante, em português brasileiro. NUNCA use a palavra "lead", "prospect" ou "cliente em potencial" — use o primeiro nome ou "a pessoa". Sem jargão de vendas agressivo. Seja direta: nada de textão.';

const DEFAULT_PROMPT = `Estamos no recontato {{etapa}} de {{primeiro_nome}}, que teve reunião sobre {{interesse}} e ainda não se matriculou (já se passaram {{dias_desde_reuniao}} dias da reunião).

OBJEÇÃO REGISTRADA AGORA pelo vendedor (o que a pessoa respondeu nesta etapa):
"{{objecao_atual}}"

Histórico das objeções anteriores neste recontato (se houver):
{{historico_objecoes}}

Contexto da reunião (use só o que ajudar):
- Por que queria fazer a pós: {{dor_objetivo}}
- Resumo da reunião: {{resumo_reuniao}}
- Objeções já apresentadas na reunião: {{objecoes_apresentadas}}
- Proposta feita: {{proposta_feita}}
- Forma de pagamento oferecida: {{forma_pagamento_oferecida}}

Gere a saída em markdown curto, com EXATAMENTE estas 3 seções (mantenha os títulos):

## Objeção identificada
1 a 2 linhas: qual é a real objeção por trás do que {{primeiro_nome}} falou (ex.: preço, timing, indecisão, falta de prioridade, cônjuge/terceiro, concorrente). Se houver mais de uma, cite as principais.

## Rebatidas (use estas)
3 a 5 bullets. Cada bullet é uma FRASE PRONTA, curta, que o vendedor manda/fala — escrita na voz do vendedor falando com {{primeiro_nome}} pelo primeiro nome. Direta, calorosa, sem pressão. Nada de teoria.

## Próximo passo
1 ação concreta e simples para esta etapa ({{etapa}}) — ex.: pergunta de fechamento, oferta de condição, agendar retorno, enviar material. Uma linha.

Regras:
- Curto. Frases prontas, não explicações.
- NUNCA escreva a palavra "lead".
- Saída só em markdown limpo, sem comentários extras.`;

const DEFAULT_CONFIG = {
  enabled: true,
  provider: "anthropic" as "anthropic" | "google",
  model: "claude-sonnet-4-5-20250929",
  systemPrompt: DEFAULT_SYSTEM,
  prompt: DEFAULT_PROMPT,
};

const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 1200;

const ETAPA_LABEL: Record<number, string> = { 1: "D+1", 3: "D+3", 7: "D+7", 15: "D+15" };

function adminClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

async function getApiKey(provider: "anthropic" | "google"): Promise<string | null> {
  // 1) ai_api_keys (universal, primária)
  try {
    const { data } = await adminClient()
      .from("ai_api_keys")
      .select("api_key")
      .eq("provider", provider)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data?.api_key) return data.api_key as string;
  } catch (_) { /* fallback */ }

  // 2) Variável de ambiente
  const envName = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "GOOGLE_API_KEY";
  const envKey = Deno.env.get(envName);
  if (envKey) return envKey;

  // 3) Legacy ped_configuracoes (apenas Anthropic)
  if (provider === "anthropic") {
    try {
      const { data } = await adminClient()
        .from("ped_configuracoes")
        .select("valor")
        .eq("chave", ANTHROPIC_KEY_NAME)
        .maybeSingle();
      return (data?.valor as string) || null;
    } catch { /* */ }
  }
  return null;
}

async function getRecontatoConfig() {
  try {
    const { data } = await adminClient()
      .from("ped_configuracoes")
      .select("valor")
      .eq("chave", RECONTATO_CONFIG_KEY)
      .maybeSingle();
    if (data?.valor) {
      const parsed = typeof data.valor === "string" ? JSON.parse(data.valor) : data.valor;
      return { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch (_) {
    // fallback
  }
  return DEFAULT_CONFIG;
}

function fillPlaceholders(template: string, data: Record<string, string>) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => (data[key] ?? "").toString());
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorResponse(code: string, message: string, status = 500, extras: Record<string, unknown> = {}) {
  return jsonResponse({ ok: false, code, error: message, ...extras }, status);
}

async function getUserId(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;
  try {
    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data } = await supa.auth.getUser();
    return data.user?.id ?? null;
  } catch {
    return null;
  }
}

async function callAnthropic(apiKey: string, config: any, userPrompt: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model || DEFAULT_CONFIG.model,
        max_tokens: DEFAULT_MAX_TOKENS,
        temperature: DEFAULT_TEMPERATURE,
        system: config.systemPrompt || DEFAULT_SYSTEM,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

async function callGoogle(apiKey: string, config: any, userPrompt: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  const model = config.model || "gemini-2.5-pro";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: config.systemPrompt || DEFAULT_SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: { temperature: DEFAULT_TEMPERATURE, maxOutputTokens: DEFAULT_MAX_TOKENS },
      }),
    });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const payload = await req.json();
    const acao = payload?.acao;

    if (acao === "gerar") {
      const {
        agendamento_id,
        etapa,
        lead_id = null,
        motivo = "",
        versao_anterior = 0,
      } = payload;

      if (!agendamento_id || !etapa) {
        return errorResponse("BAD_REQUEST", "agendamento_id e etapa obrigatórios", 400);
      }

      const config = await getRecontatoConfig();
      if (!config.enabled) {
        return errorResponse("DISABLED", "A Mimosa de recontato está desativada nas configurações.", 400);
      }

      const provider: "anthropic" | "google" = config.provider === "google" ? "google" : "anthropic";
      const apiKey = await getApiKey(provider);
      if (!apiKey) {
        return errorResponse("MISSING_API_KEY", `A chave do provedor ${provider} não está configurada. Avise o TI (Configuração IA).`, 400);
      }

      // Busca contexto completo no banco via service role.
      const admin = adminClient();
      let agFull: any = null;
      let leadFull: any = null;
      let interacoes: any[] = [];
      try {
        const { data: ag } = await admin.from("agendamentos").select("*").eq("id", agendamento_id).maybeSingle();
        agFull = ag || null;
        const leadIdFinal = lead_id || agFull?.lead_id || null;
        if (leadIdFinal) {
          const { data: l } = await admin.from("leads").select("*").eq("id", leadIdFinal).maybeSingle();
          leadFull = l || null;
        }
        const { data: hist } = await admin
          .from("recontato_interacoes")
          .select("etapa, motivo, created_at")
          .eq("agendamento_id", agendamento_id)
          .order("etapa", { ascending: true });
        interacoes = hist || [];
      } catch (e) {
        console.warn("Falha buscando contexto do recontato:", e);
      }

      const nomeCompleto = leadFull?.nome || "";
      const interesse = agFull?.pos_graduacao_interesse
        || leadFull?.curso_interesse
        || leadFull?.area_interesse
        || "";

      const dataMs = agFull?.data_agendamento ? new Date(agFull.data_agendamento).getTime() : NaN;
      const diasDesde = Number.isFinite(dataMs)
        ? Math.max(0, Math.floor((Date.now() - dataMs) / (24 * 60 * 60 * 1000)))
        : "";

      // Histórico de objeções das etapas anteriores (exclui a etapa atual).
      const historico = interacoes
        .filter((i) => Number(i.etapa) !== Number(etapa) && (i.motivo || "").trim())
        .map((i) => `- ${ETAPA_LABEL[Number(i.etapa)] || `D+${i.etapa}`}: ${i.motivo.trim()}`)
        .join("\n");

      const objecaoAtual = (motivo || "").trim()
        || interacoes.find((i) => Number(i.etapa) === Number(etapa))?.motivo
        || "";

      if (!objecaoAtual.trim()) {
        return errorResponse("SEM_OBJECAO", "Sem objeção registrada nesta etapa para analisar.", 400);
      }

      const placeholders: Record<string, string> = {
        primeiro_nome: (nomeCompleto.split(" ")[0]) || "a pessoa",
        nome_completo: nomeCompleto,
        interesse: interesse || "a pós-graduação",
        etapa: ETAPA_LABEL[Number(etapa)] || `D+${etapa}`,
        objecao_atual: objecaoAtual.trim(),
        historico_objecoes: historico || "(nenhuma etapa anterior registrada)",
        dias_desde_reuniao: String(diasDesde),
        dor_objetivo: agFull?.principal_dor_objetivo || "",
        resumo_reuniao: agFull?.resumo_reuniao || "",
        objecoes_apresentadas: agFull?.objecoes_apresentadas || "",
        proposta_feita: agFull?.proposta_feita || "",
        forma_pagamento_oferecida: agFull?.forma_pagamento_oferecida || "",
      };

      const userPrompt = fillPlaceholders(config.prompt || DEFAULT_PROMPT, placeholders);

      let res: Response;
      try {
        res = provider === "google"
          ? await callGoogle(apiKey, config, userPrompt)
          : await callAnthropic(apiKey, config, userPrompt);
      } catch (e) {
        const msg = (e as Error).message || "";
        if (msg.includes("aborted") || (e as Error).name === "AbortError") {
          // 422 (nunca 502/504): o Cloudflare engole 502/504 da origem sem headers CORS.
          return errorResponse("TIMEOUT", "A Mimosa demorou demais para responder. Tente novamente.", 422);
        }
        return errorResponse("NETWORK", "Sem conexão com a Mimosa. Verifique sua internet.", 422);
      }

      if (!res.ok) {
        const body = await res.text();
        console.error(`${provider} error`, res.status, body);
        if (res.status === 429) return errorResponse("RATE_LIMIT", "A Mimosa está sobrecarregada. Aguarde alguns segundos e tente novamente.", 429);
        if (res.status === 402) return errorResponse("CREDITS", "Créditos da Mimosa esgotados. Avise o TI para recarregar.", 402);
        if (res.status === 401 || res.status === 403) return errorResponse("MISSING_API_KEY", "Chave da Mimosa inválida ou expirada. Avise o TI.", 401);
        return errorResponse("UPSTREAM_ERROR", `Falha ao gerar a abordagem (${provider} ${res.status}). Tente de novo.`, 422, { upstream_status: res.status });
      }

      const data = await res.json();
      let conteudo = (provider === "google"
        ? (data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text).filter(Boolean).join("\n") || "")
        : (data?.content?.[0]?.text || "")
      ).trim();

      const stripFences = (s: string) => s
        .replace(/^```(?:json|markdown|md)?\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
      conteudo = stripFences(conteudo);

      if (!conteudo) {
        return errorResponse("EMPTY", "A Mimosa retornou uma resposta vazia. Tente regenerar.", 422);
      }

      const userId = await getUserId(req);
      const vendedorId = agFull?.vendedor_id || userId;

      const { data: upserted, error: upsertErr } = await admin
        .from("recontato_analises")
        .upsert(
          {
            agendamento_id,
            lead_id: lead_id || agFull?.lead_id || null,
            vendedor_id: vendedorId,
            etapa: Number(etapa),
            motivo_analisado: objecaoAtual.trim(),
            conteudo_markdown: conteudo,
            modelo: config.model,
            versao: (versao_anterior || 0) + 1,
            prompt_usado: userPrompt,
            status: "gerada",
            editada_pelo_usuario: false,
            gerada_por: userId,
            approved_at: null,
          },
          { onConflict: "agendamento_id,etapa" },
        )
        .select("id, versao, modelo, conteudo_markdown, etapa")
        .single();

      if (upsertErr) {
        console.error("Upsert recontato_analises error", upsertErr);
        return errorResponse("DB_ERROR", "Abordagem gerada, mas falhou ao salvar. Tente novamente.", 500);
      }

      return jsonResponse({ ok: true, ...upserted });
    }

    if (acao === "aprovar") {
      const { analise_id, conteudo_final, editado } = payload;
      if (!analise_id) return errorResponse("BAD_REQUEST", "analise_id obrigatório", 400);
      const admin = adminClient();
      const updates: Record<string, unknown> = {
        status: editado ? "editada" : "aprovada",
        editada_pelo_usuario: !!editado,
        approved_at: new Date().toISOString(),
      };
      if (typeof conteudo_final === "string" && conteudo_final.trim()) {
        updates.conteudo_markdown = conteudo_final.trim();
      }

      const { data, error } = await admin
        .from("recontato_analises")
        .update(updates)
        .eq("id", analise_id)
        .select("id, versao, conteudo_markdown, modelo, status")
        .single();

      if (error) return errorResponse("DB_ERROR", error.message, 500);
      return jsonResponse({ ok: true, ...data });
    }

    return errorResponse("BAD_REQUEST", "Ação não reconhecida. Use 'gerar' ou 'aprovar'.", 400);
  } catch (e) {
    console.error("recontato-analise fatal", e);
    return errorResponse("INTERNAL", e instanceof Error ? e.message : "Erro desconhecido", 500);
  }
});
