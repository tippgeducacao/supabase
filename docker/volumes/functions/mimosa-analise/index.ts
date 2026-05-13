import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const ANTHROPIC_KEY_NAME = "ANTHROPIC_API_KEY";
const MIMOSA_CONFIG_KEY = "MIMOSA_CONFIG_V2";

const DEFAULT_PROMPT_PRE = `Você é a Mimosa. Gere uma PRÉ-REUNIÃO personalizada para {{primeiro_nome}}, que demonstrou interesse em {{interesse}}.

Use os seguintes dados como base:
- Nome: {{nome_completo}}
- E-mail: {{email}}
- WhatsApp: {{whatsapp}}
- Local de trabalho: {{local_trabalho}}
- Por que quer fazer a pós: {{dor_objetivo}}
- Origem do contato: {{fonte}}

Estruture a saída em 4 seções (mantenha exatamente esses títulos):
1. "Olá, {{primeiro_nome}}" — saudação acolhedora e personalizada
2. "Seu Contexto" — interpretação respeitosa do momento profissional
3. "O que vamos abordar" — 3 a 5 tópicos numerados que serão tratados na call
4. "Como será nosso encontro" — explicação do formato (≈30min, sem pressão, troca honesta)

Regras:
- NUNCA use a palavra "lead". Use o primeiro nome ou "você".
- Sem jargão de vendas. Tom humano, profissional, em português brasileiro.
- Saída em markdown limpo, pronto para leitura.`;

const DEFAULT_SYSTEM = 'Você é a Mimosa, inteligência comercial da PPGVET Educação. Sua missão é apoiar o time comercial gerando análises humanizadas e personalizadas para cada lead, sempre tratando o lead pelo primeiro nome (em segunda pessoa, "você") e nunca usando o termo "lead". Mantenha o tom acolhedor, profissional e orientado a próximos passos.';

const DEFAULT_CONFIG = {
  enabled: true,
  provider: "anthropic" as "anthropic" | "google",
  model: "claude-sonnet-4-5-20250929",
  systemPrompt: DEFAULT_SYSTEM,
  prompts: {
    pre: DEFAULT_PROMPT_PRE,
    posSemVenda: DEFAULT_PROMPT_PRE,
    posComVenda: DEFAULT_PROMPT_PRE,
  },
};

// Defaults server-side (não são mais configuráveis pela UI)
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 2000;

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

async function getMimosaConfig() {
  try {
    const { data } = await adminClient()
      .from("ped_configuracoes")
      .select("valor")
      .eq("chave", MIMOSA_CONFIG_KEY)
      .maybeSingle();
    if (data?.valor) {
      const parsed = typeof data.valor === "string" ? JSON.parse(data.valor) : data.valor;
      return { ...DEFAULT_CONFIG, ...parsed, prompts: { ...DEFAULT_CONFIG.prompts, ...(parsed.prompts || {}) } };
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
      const { tipo = "pre_reuniao", lead_id, lead_snapshot = {}, dados = {}, agendamento_id = null, versao_anterior = 0 } = payload;

      const config = await getMimosaConfig();
      if (!config.enabled) {
        return errorResponse("DISABLED", "A Mimosa está desativada nas configurações.", 400);
      }

      const provider: "anthropic" | "google" = config.provider === "google" ? "google" : "anthropic";
      const apiKey = await getApiKey(provider);
      if (!apiKey) {
        return errorResponse("MISSING_API_KEY", `A chave do provedor ${provider} não está configurada. Avise o TI (Configuração IA).`, 400);
      }

      const promptTemplate =
        tipo === "pos_sem_venda" ? config.prompts.posSemVenda
        : tipo === "pos_com_venda" ? config.prompts.posComVenda
        : config.prompts.pre;

      // Busca dados completos no banco (lead + agendamento + sdr + vendedor)
      // para garantir que a IA receba TODO o contexto, mesmo que o cliente
      // tenha enviado snapshots parciais.
      const adminFetch = adminClient();
      let leadFull: any = null;
      let agFull: any = null;
      let sdrProfile: any = null;
      let vendedorProfile: any = null;
      try {
        if (lead_id) {
          const { data } = await adminFetch.from("leads").select("*").eq("id", lead_id).maybeSingle();
          leadFull = data || null;
        }
        if (agendamento_id) {
          const { data } = await adminFetch.from("agendamentos").select("*").eq("id", agendamento_id).maybeSingle();
          agFull = data || null;
          if (agFull?.sdr_id) {
            const { data: p } = await adminFetch.from("profiles").select("name, email, user_type").eq("id", agFull.sdr_id).maybeSingle();
            sdrProfile = p || null;
          }
          if (agFull?.vendedor_id) {
            const { data: p } = await adminFetch.from("profiles").select("name, email, user_type").eq("id", agFull.vendedor_id).maybeSingle();
            vendedorProfile = p || null;
          }
        }
      } catch (e) {
        console.warn("Falha buscando contexto completo:", e);
      }

      const interesseFinal = agFull?.pos_graduacao_interesse
        || dados.pos_graduacao_nome
        || lead_snapshot.interesse
        || leadFull?.curso_interesse
        || leadFull?.area_interesse
        || "";

      const placeholders: Record<string, string> = {
        primeiro_nome: ((leadFull?.nome || lead_snapshot.nome) || "").split(" ")[0] || "",
        nome_completo: leadFull?.nome || lead_snapshot.nome || "",
        email: leadFull?.email || lead_snapshot.email || "",
        whatsapp: leadFull?.whatsapp || lead_snapshot.whatsapp || "",
        interesse: interesseFinal,
        local_trabalho: agFull?.local_trabalho || dados.local_trabalho || "",
        dor_objetivo: agFull?.principal_dor_objetivo || dados.principal_dor_objetivo || "",
        fonte: leadFull?.fonte_referencia || leadFull?.fonte || lead_snapshot.fonte || "",
        observacoes_resultado: agFull?.observacoes_resultado || dados.observacoes_resultado || "",
        data_resultado: agFull?.data_resultado || dados.data_resultado || "",
        informacoes_adicionais: dados.informacoes_adicionais || "",
        // Campos da reunião (preenchidos no Não Comprou / Criar Venda)
        resumo_reuniao: agFull?.resumo_reuniao || dados.resumo_reuniao || "",
        objecoes_apresentadas: agFull?.objecoes_apresentadas || dados.objecoes_apresentadas || "",
        proposta_feita: agFull?.proposta_feita || dados.proposta_feita || "",
        vagas_disponiveis_informadas: agFull?.vagas_disponiveis_informadas || dados.vagas_disponiveis_informadas || "",
        forma_pagamento_oferecida: agFull?.forma_pagamento_oferecida || dados.forma_pagamento_oferecida || "",
        resultado_reuniao: agFull?.resultado_reuniao || dados.resultado_reuniao || "",
      };

      // Monta bloco de contexto completo com TODOS os campos relevantes do lead,
      // agendamento, SDR e vendedor responsáveis. A IA decide o que usar.
      const fmt = (label: string, value: any) => {
        if (value === null || value === undefined || value === "") return "";
        const v = typeof value === "object" ? JSON.stringify(value) : String(value);
        return `- ${label}: ${v}\n`;
      };

      let contextoCompleto = "\n\n---\nCONTEXTO COMPLETO (use somente o que fizer sentido na análise; NÃO liste tudo cru):\n\n";
      contextoCompleto += "## Lead\n";
      if (leadFull) {
        contextoCompleto += fmt("Nome", leadFull.nome);
        contextoCompleto += fmt("Email", leadFull.email);
        contextoCompleto += fmt("WhatsApp", leadFull.whatsapp);
        contextoCompleto += fmt("Profissão", leadFull.profissao);
        contextoCompleto += fmt("Tempo de formação", leadFull.tempo_formacao);
        contextoCompleto += fmt("Região", leadFull.regiao);
        contextoCompleto += fmt("Área de interesse", leadFull.area_interesse);
        contextoCompleto += fmt("Curso de interesse", leadFull.curso_interesse);
        contextoCompleto += fmt("Fonte de referência", leadFull.fonte_referencia);
        contextoCompleto += fmt("Fonte", leadFull.fonte);
        contextoCompleto += fmt("Página de captura", leadFull.pagina_nome);
        contextoCompleto += fmt("UTM source", leadFull.utm_source);
        contextoCompleto += fmt("UTM medium", leadFull.utm_medium);
        contextoCompleto += fmt("UTM campaign", leadFull.utm_campaign);
        contextoCompleto += fmt("UTM content", leadFull.utm_content);
        contextoCompleto += fmt("UTM term", leadFull.utm_term);
        contextoCompleto += fmt("Dispositivo", leadFull.dispositivo);
        contextoCompleto += fmt("Status", leadFull.status);
        contextoCompleto += fmt("Observações do lead", leadFull.observacoes);
        contextoCompleto += fmt("Criado em", leadFull.created_at);
      } else {
        contextoCompleto += fmt("Nome", lead_snapshot.nome);
        contextoCompleto += fmt("Email", lead_snapshot.email);
        contextoCompleto += fmt("WhatsApp", lead_snapshot.whatsapp);
        contextoCompleto += fmt("Interesse", lead_snapshot.interesse);
        contextoCompleto += fmt("Fonte", lead_snapshot.fonte);
      }

      contextoCompleto += "\n## Agendamento / Reunião\n";
      if (agFull) {
        contextoCompleto += fmt("Pós-graduação de interesse", agFull.pos_graduacao_interesse);
        contextoCompleto += fmt("Local de trabalho", agFull.local_trabalho);
        contextoCompleto += fmt("Principal dor / objetivo", agFull.principal_dor_objetivo);
        contextoCompleto += fmt("Data do agendamento", agFull.data_agendamento);
        contextoCompleto += fmt("Status", agFull.status);
        contextoCompleto += fmt("Resultado da reunião", agFull.resultado_reuniao);
        contextoCompleto += fmt("Data do resultado", agFull.data_resultado);
        contextoCompleto += fmt("Observações da reunião", agFull.observacoes_resultado || agFull.observacoes);
        contextoCompleto += fmt("Resumo da reunião", agFull.resumo_reuniao);
        contextoCompleto += fmt("Objeções apresentadas", agFull.objecoes_apresentadas);
        contextoCompleto += fmt("Proposta feita", agFull.proposta_feita);
        contextoCompleto += fmt("Vagas disponíveis informadas", agFull.vagas_disponiveis_informadas);
        contextoCompleto += fmt("Forma de pagamento oferecida", agFull.forma_pagamento_oferecida);
        contextoCompleto += fmt("Origem", agFull.origem);
        contextoCompleto += fmt("Estudo do lead", agFull.estudo_lead);
      }

      contextoCompleto += "\n## Responsáveis (apenas para registro interno — NÃO citar na análise)\n";
      if (sdrProfile) {
        contextoCompleto += fmt("SDR", `${sdrProfile.name || ""} (${sdrProfile.email || ""})`);
      }
      if (vendedorProfile) {
        contextoCompleto += fmt("Vendedor", `${vendedorProfile.name || ""} (${vendedorProfile.email || ""})`);
      }

      // Bloco de dados confirmados — DEVE ser usado pela IA (não é opcional).
      // Incluímos no TOPO do prompt para garantir que campos críticos
      // (local de trabalho e por que quer fazer a pós) apareçam na análise.
      const dadosConfirmados =
        `DADOS CONFIRMADOS DO LEAD — USE OBRIGATORIAMENTE NA ANÁLISE (não escreva "[a confirmar]" nem "[Investigar na reunião]" para estes campos, pois já foram coletados pelo SDR):\n` +
        `- nome_lead: ${placeholders.primeiro_nome || placeholders.nome_completo || "(não informado)"}\n` +
        `- local_trabalho: ${placeholders.local_trabalho?.trim() || "(não informado — pode marcar para investigar)"}\n` +
        `- por_que_pos / dor_objetivo: ${placeholders.dor_objetivo?.trim() || "(não informado — pode marcar para investigar)"}\n` +
        `- interesse / pos_graduacao: ${placeholders.interesse || "(não informado)"}\n\n` +
        `Regra: ao montar a seção "Perfil", cite o local_trabalho real acima. Ao montar "Dores e objetivos", use o por_que_pos real acima como ponto de partida (parafraseie, classifique e expanda). Só use "[Investigar na reunião]" para campos NÃO listados aqui.\n\n---\n\n`;

      let userPrompt = dadosConfirmados + fillPlaceholders(promptTemplate, placeholders);
      userPrompt += contextoCompleto;
      if (dados.informacoes_adicionais && dados.informacoes_adicionais.trim()) {
        userPrompt += `\n\n---\nINFORMAÇÕES ADICIONAIS FORNECIDAS PELO VENDEDOR (considere e incorpore na análise):\n${dados.informacoes_adicionais.trim()}`;
      }

      let res: Response;
      try {
        res = provider === "google"
          ? await callGoogle(apiKey, config, userPrompt)
          : await callAnthropic(apiKey, config, userPrompt);
      } catch (e) {
        const msg = (e as Error).message || "";
        if (msg.includes("aborted") || (e as Error).name === "AbortError") {
          return errorResponse("TIMEOUT", "A Mimosa demorou demais para responder. Tente novamente.", 504);
        }
        return errorResponse("NETWORK", "Sem conexão com a Mimosa. Verifique sua internet.", 502);
      }

      if (!res.ok) {
        const body = await res.text();
        console.error(`${provider} error`, res.status, body);
        if (res.status === 429) return errorResponse("RATE_LIMIT", "A Mimosa está sobrecarregada. Aguarde alguns segundos e tente novamente.", 429);
        if (res.status === 402) return errorResponse("CREDITS", "Créditos da Mimosa esgotados. Avise o TI para recarregar.", 402);
        if (res.status === 401 || res.status === 403) return errorResponse("MISSING_API_KEY", "Chave da Mimosa inválida ou expirada. Avise o TI.", 401);
        return errorResponse("UPSTREAM_ERROR", `Falha ao gerar análise (${provider} ${res.status}). Tente de novo ou crie sem análise.`, 502, { upstream_status: res.status });
      }

      const data = await res.json();
      let conteudo = (provider === "google"
        ? (data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text).filter(Boolean).join("\n") || "")
        : (data?.content?.[0]?.text || "")
      ).trim();

      // Normaliza saída: se o modelo devolveu JSON (com ou sem fences ```json),
      // extrai o campo de markdown. A visualização é sempre markdown formatado.
      const stripFences = (s: string) => s
        .replace(/^```(?:json|markdown|md)?\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
      conteudo = stripFences(conteudo);
      if (conteudo.startsWith("{") || conteudo.startsWith("[")) {
        try {
          const parsed = JSON.parse(conteudo);
          const md = parsed?.analise_markdown
            || parsed?.markdown
            || parsed?.analise
            || parsed?.conteudo_markdown
            || parsed?.conteudo;
          if (typeof md === "string" && md.trim()) {
            conteudo = md.trim();
          }
        } catch { /* mantém como veio */ }
      }

      if (!conteudo) {
        return errorResponse("EMPTY", "A Mimosa retornou uma resposta vazia. Tente regenerar.", 502);
      }

      const userId = await getUserId(req);
      const admin = adminClient();
      const { data: inserted, error: insertErr } = await admin
        .from("mimosa_analises")
        .insert({
          agendamento_id,
          lead_id,
          tipo,
          versao: (versao_anterior || 0) + 1,
          conteudo_markdown: conteudo,
          modelo: config.model,
          prompt_usado: userPrompt,
          input_snapshot: { lead_snapshot, dados },
          status: "gerada",
          gerada_por: userId,
        })
        .select("id, versao, modelo, conteudo_markdown")
        .single();

      if (insertErr) {
        console.error("Insert mimosa_analises error", insertErr);
        return errorResponse("DB_ERROR", "Análise gerada, mas falhou ao salvar. Tente novamente.", 500);
      }

      return jsonResponse({ ok: true, ...inserted });
    }

    if (acao === "aprovar") {
      const { analise_id, conteudo_final, editado, agendamento_id } = payload;
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
      if (agendamento_id) updates.agendamento_id = agendamento_id;

      const { data, error } = await admin
        .from("mimosa_analises")
        .update(updates)
        .eq("id", analise_id)
        .select("id, versao, conteudo_markdown, modelo, status")
        .single();

      if (error) return errorResponse("DB_ERROR", error.message, 500);
      return jsonResponse({ ok: true, ...data });
    }

    if (acao === "vincular_agendamento") {
      const { analise_id, agendamento_id } = payload;
      if (!analise_id || !agendamento_id) return errorResponse("BAD_REQUEST", "analise_id e agendamento_id obrigatórios", 400);
      const { error } = await adminClient()
        .from("mimosa_analises")
        .update({ agendamento_id })
        .eq("id", analise_id);
      if (error) return errorResponse("DB_ERROR", error.message, 500);
      return jsonResponse({ ok: true });
    }

    return errorResponse("BAD_REQUEST", "Ação não reconhecida. Use 'gerar', 'aprovar' ou 'vincular_agendamento'.", 400);
  } catch (e) {
    console.error("mimosa-analise fatal", e);
    return errorResponse("INTERNAL", e instanceof Error ? e.message : "Erro desconhecido", 500);
  }
});
