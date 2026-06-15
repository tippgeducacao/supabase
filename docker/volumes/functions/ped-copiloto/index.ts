// Copiloto Pedagógico — agente conversacional com tool use.
// Recebe { messages: [{role, content}], user_id } e devolve { reply, tools_used }.
// As tools são RPCs Postgres (ped_copiloto_*) que retornam JSON pronto.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_MODEL = Deno.env.get("ANTHROPIC_MODEL_COPILOTO") ?? "claude-sonnet-4-5-20250929";

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
  if (!data?.api_key) throw new Error("Chave Anthropic ativa não encontrada em ai_api_keys.");
  return data.api_key as string;
}

const SYSTEM_PROMPT = `Você é o "Professor — Ou Vai Ou Vai", o assistente de IA do setor Pedagógico do Ruflo/PPGVet. Apresente-se como "Professor" no início da primeira resposta de uma conversa nova. Você ajuda os atendentes do pedagógico a operar o sistema.

Você tem acesso a ferramentas que buscam dados reais do sistema (turmas, cursos, professores, aulas, alertas operacionais). Use-as SEMPRE que a pergunta envolver dados específicos — não invente IDs, datas ou nomes.

CONCEITOS-CHAVE DO SISTEMA:
- Curso (pos-graduação) tem um blueprint de módulos e aulas. Cada turma do curso segue esse blueprint.
- Turma tem dia_semana_aulas (ex: [2]=terça) e opcionalmente dia_semana_intensivo (dias ADICIONAIS para módulos marcados como INTENSIVO no curso). O motor usa a UNIÃO dos dois nos módulos intensivos.
- Aula = encontro de UMA turma com data, horário, professor. Pode estar compartilhada via ped_aula_turmas com várias turmas (Modo Caravana).
- Modo Caravana: turma nova entra no ciclo de turmas ativas e compartilha aulas com elas. As aulas que faltaram (já ministradas) são geradas como próprias depois do último compartilhamento.
- Bônus de Janeiro: janeiro não tem aula curricular; o curso pode ter 2 aulas bônus com data manual replicadas pras turmas ativas.
- Módulos práticos: ofertas presenciais (cidade+data+horário+professor). Fluxo ainda em definição.
- Convite: comunicação WhatsApp com o professor sobre uma aula. Tem fluxo de aprovação manual → fase 1 → confirmação → lembretes (30/14/7/1d).
- Cobertura: % de aulas entregues + pendentes + canceladas + sem professor.

ESTILO DE RESPOSTA:
- Em português, direto, sem rodeios.
- Use markdown leve (negrito, listas, mas SEM cabeçalhos H1-H3).
- Quando trouxer turmas/cursos/aulas, mostre nome + datas curtas + IDs entre colchetes.
- Se não achar nada, diga claramente "não encontrei X" — não invente.
- Se a pergunta for ambígua, pergunte de volta de forma objetiva (1 linha).
- Se a pergunta for operacional ("como faço X"), responda referenciando o Processo Operacional do setor.

REGRAS:
- NUNCA execute mutações (edits/inserts/deletes). Suas ferramentas são só de leitura.
- Se o atendente pedir "altere X", diga onde no sistema ele faz isso, NÃO faça.
- Se a ferramenta retornar erro "Sem permissao", informe o atendente que ele precisa de acesso pedagógico.`;

const TOOLS = [
  {
    name: "buscar",
    description: "Busca textual em turmas, cursos, professores e aulas. Use quando o atendente pedir 'cadê', 'onde está', 'que turma tem X', etc.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Texto a buscar (nome, parte do título)." },
        tipo: {
          type: "string",
          enum: ["turma", "curso", "professor", "aula"],
          description: "Restringe ao tipo. Omita para buscar em todos.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "turma_detalhe",
    description: "Detalhe completo de uma turma: config, curso, cobertura (aulas entregues/sem prof/canceladas/compartilhadas), próxima aula. Use quando o atendente pedir 'me explica essa turma' ou 'qual a cobertura da X'.",
    input_schema: {
      type: "object",
      properties: { turma_id: { type: "string", description: "UUID da turma." } },
      required: ["turma_id"],
    },
  },
  {
    name: "curso_detalhe",
    description: "Resumo de um curso: módulos (com flag intensivo, mês previsto, aulas), formato, área, número de turmas ativas. Use quando pedirem 'me explica o curso X' ou 'quantos módulos tem'.",
    input_schema: {
      type: "object",
      properties: { curso_id: { type: "string", description: "UUID do curso." } },
      required: ["curso_id"],
    },
  },
  {
    name: "alertas_globais",
    description: "Lista aulas problemáticas: sem professor nos próximos 30 dias, em escalação crítica, sem confirmação nos próximos 7 dias. Use quando perguntarem sobre 'o que tá pendente', 'aulas sem prof', 'urgências'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "turmas_do_curso",
    description: "Lista as turmas (ativas e arquivadas) de um curso específico. Use quando perguntarem 'que turmas tem o curso X'.",
    input_schema: {
      type: "object",
      properties: { curso_id: { type: "string" } },
      required: ["curso_id"],
    },
  },
  {
    name: "comparar_turmas",
    description: "Compara DUAS turmas lado a lado (config + cobertura). Use quando o atendente pedir 'compara X e Y', 'diferença entre X e Y'.",
    input_schema: {
      type: "object",
      properties: {
        turma_1: { type: "string", description: "UUID da primeira turma." },
        turma_2: { type: "string", description: "UUID da segunda turma." },
      },
      required: ["turma_1", "turma_2"],
    },
  },
  {
    name: "comparar_cursos",
    description: "Compara DOIS cursos lado a lado (módulos, formato, número de turmas ativas).",
    input_schema: {
      type: "object",
      properties: {
        curso_1: { type: "string" },
        curso_2: { type: "string" },
      },
      required: ["curso_1", "curso_2"],
    },
  },
  {
    name: "aulas_do_professor",
    description: "Lista as próximas aulas (curriculares ou reservas) de um professor específico. Inclui status de cada convite.",
    input_schema: {
      type: "object",
      properties: {
        professor_id: { type: "string", description: "UUID do professor." },
        limit: { type: "integer", description: "Quantas aulas trazer (1-50). Default 20." },
      },
      required: ["professor_id"],
    },
  },
  {
    name: "carga_professor",
    description: "Agrupa as aulas do professor por semana nas próximas N semanas. Use pra ver se o prof tá sobrecarregado.",
    input_schema: {
      type: "object",
      properties: {
        professor_id: { type: "string" },
        semanas: { type: "integer", description: "Quantas semanas pra frente (default 8)." },
      },
      required: ["professor_id"],
    },
  },
  {
    name: "aulas_em_data_bloqueada",
    description: "Lista aulas marcadas em datas que deveriam estar bloqueadas (janeiro curricular, recesso 23/12-07/01). Atenção: precisam ser remarcadas.",
    input_schema: {
      type: "object",
      properties: { dias: { type: "integer", description: "Janela em dias a verificar (default 90)." } },
    },
  },
  {
    name: "turmas_terminando",
    description: "Lista turmas com data_fim nos próximos N dias. Use pra preparar certificado e encerramento.",
    input_schema: {
      type: "object",
      properties: { dias: { type: "integer", description: "Janela em dias (default 60)." } },
    },
  },
  {
    name: "convites_pendentes",
    description: "Lista convites WhatsApp sem confirmação há mais de N dias. Use pra encontrar pendências antigas.",
    input_schema: {
      type: "object",
      properties: { dias_min: { type: "integer", description: "Mínimo de dias aguardando (default 7)." } },
    },
  },
  {
    name: "sac_sem_resposta",
    description: "Conversas SAC com última mensagem do professor (entrada) sem resposta do atendente há mais de N dias.",
    input_schema: {
      type: "object",
      properties: { dias_min: { type: "integer", description: "Default 2." } },
    },
  },
  {
    name: "simular_caravana",
    description: "Simula Modo Caravana para uma turma SEM gerar nada — só devolve número de aulas compartilhadas, próprias e quais turmas fonte. Use pra responder 'vale caravana?'.",
    input_schema: {
      type: "object",
      properties: { turma_id: { type: "string" } },
      required: ["turma_id"],
    },
  },
  {
    name: "sugerir_data_inicio",
    description: "Para um curso, varre datas candidatas (de 7 em 7 dias) num mês alvo e devolve quantas aulas seriam compartilháveis em cada data. Use pra responder 'qual a melhor data pra abrir turma de X em julho?'.",
    input_schema: {
      type: "object",
      properties: {
        curso_id: { type: "string" },
        mes: { type: "integer", description: "Mês alvo (1-12). Omita pra usar próximos 60 dias." },
        ano: { type: "integer", description: "Ano alvo (default ano atual)." },
      },
      required: ["curso_id"],
    },
  },
];

async function callTool(sb: any, name: string, input: any): Promise<any> {
  const map: Record<string, [string, any]> = {
    buscar: ["ped_copiloto_buscar", { p_query: input.query, p_tipo: input.tipo ?? null }],
    turma_detalhe: ["ped_copiloto_turma_detalhe", { p_turma_id: input.turma_id }],
    curso_detalhe: ["ped_copiloto_curso_detalhe", { p_curso_id: input.curso_id }],
    alertas_globais: ["ped_copiloto_alertas_globais", {}],
    turmas_do_curso: ["ped_copiloto_turmas_curso", { p_curso_id: input.curso_id }],
    comparar_turmas: ["ped_copiloto_comparar_turmas", { p_t1: input.turma_1, p_t2: input.turma_2 }],
    comparar_cursos: ["ped_copiloto_comparar_cursos", { p_c1: input.curso_1, p_c2: input.curso_2 }],
    aulas_do_professor: ["ped_copiloto_aulas_professor", { p_prof_id: input.professor_id, p_limit: input.limit ?? 20 }],
    carga_professor: ["ped_copiloto_carga_professor", { p_prof_id: input.professor_id, p_semanas: input.semanas ?? 8 }],
    aulas_em_data_bloqueada: ["ped_copiloto_aulas_em_data_bloqueada", { p_dias: input.dias ?? 90 }],
    turmas_terminando: ["ped_copiloto_turmas_terminando", { p_dias: input.dias ?? 60 }],
    convites_pendentes: ["ped_copiloto_convites_pendentes", { p_dias_min: input.dias_min ?? 7 }],
    sac_sem_resposta: ["ped_copiloto_sac_sem_resposta", { p_dias_min: input.dias_min ?? 2 }],
    simular_caravana: ["ped_copiloto_simular_caravana", { p_turma_id: input.turma_id }],
    sugerir_data_inicio: ["ped_copiloto_sugerir_data_inicio", { p_curso_id: input.curso_id, p_mes_alvo: input.mes ?? null, p_ano_alvo: input.ano ?? null }],
  };
  const entry = map[name];
  if (!entry) return { error: `Tool desconhecida: ${name}` };
  const [rpc, args] = entry;
  const { data, error } = await sb.rpc(rpc, args);
  if (error) return { error: error.message };
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json();
    const messages: Array<{ role: "user" | "assistant"; content: any }> = body.messages ?? [];
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: "messages required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Usa o token do usuário pra que o RLS/auth.uid() funcione nas RPCs.
    const authHeader = req.headers.get("Authorization") ?? "";
    const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const sbService = createClient(SUPABASE_URL, SERVICE_KEY);
    const apiKey = await getAnthropicKey(sbService);

    const toolsUsed: Array<{ name: string; input: any; output: any }> = [];
    const conversation = [...messages];
    let finalReply = "";

    // Loop com tool use — até 12 iterações (algumas perguntas chamam várias tools).
    for (let iter = 0; iter < 12; iter++) {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 2000,
          system: SYSTEM_PROMPT,
          tools: TOOLS,
          messages: conversation,
        }),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Anthropic ${resp.status}: ${errText.slice(0, 500)}`);
      }
      const result = await resp.json();
      const blocks = result.content as Array<any>;
      const toolUseBlocks = blocks.filter((b) => b.type === "tool_use");

      if (toolUseBlocks.length === 0) {
        // Resposta final — concatena todos os textos.
        finalReply = blocks
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        break;
      }

      // Adiciona o turn do assistant com tool_use
      conversation.push({ role: "assistant", content: blocks });

      // Executa cada tool e adiciona os resultados
      const toolResults: any[] = [];
      for (const tu of toolUseBlocks) {
        const output = await callTool(sb, tu.name, tu.input);
        toolsUsed.push({ name: tu.name, input: tu.input, output });
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(output),
        });
      }
      conversation.push({ role: "user", content: toolResults });
    }

    if (!finalReply) finalReply = "(O agente excedeu o limite de iterações. Tente reformular a pergunta.)";

    return new Response(JSON.stringify({ reply: finalReply, tools_used: toolsUsed.map((t) => t.name) }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[ped-copiloto] erro:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
