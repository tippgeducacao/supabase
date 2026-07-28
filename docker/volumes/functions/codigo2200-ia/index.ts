// codigo2200-ia
// Analista de IA do Código 2200 — lê o DOSSIÊ do dia/semana e devolve uma leitura
// assertiva: de onde vieram as vendas e os agendamentos (campanha × orgânico ×
// indicação, por curso), quem está comparecendo e convertendo, o que as conversas
// estão dizendo (objeções, motivos de no-show) e o que fazer agora.
//
// A IA NÃO calcula número: TUDO que ela cita vem da RPC `codigo2200_ia_dossie`
// (régua canônica de matrícula/comparecimento). A edge só monta o contexto, chama
// o modelo com tool-use (saída estruturada) e materializa em `codigo2200_ia_analises`
// junto do dossiê usado → o que a IA disse ontem continua auditável hoje.
//
// ⚠️ Chamada pelo NAVEGADOR → nunca devolver 502/504 (o Cloudflare troca por página
// de erro sem CORS e o front só vê "Failed to send a request"). Recusa = 422.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

// Opus: a análise cruza 9 blocos de dossiê e precisa de raciocínio, não de velocidade
// (decisão do usuário 2026-07-28). Env sobrepõe se um dia quiser baratear.
const MODELO = Deno.env.get("CODIGO2200_IA_MODEL") ?? "claude-opus-5";
// Medido: a análise da semana gasta ~8 mil tokens de saída. O teto folgado evita
// truncar o bloco tool_use (que, truncado, invalida a saída inteira).
const MAX_TOKENS = 16_000;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const admin = () => createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

/** Chave da Anthropic: env do agente > env padrão > ai_api_keys (mesma cascata do resto do sistema). */
async function anthropicKey(): Promise<string | null> {
  const env = Deno.env.get("AGENTE_SDR_ANTHROPIC_KEY") ?? Deno.env.get("ANTHROPIC_API_KEY");
  if (env) return env;
  try {
    const { data } = await admin()
      .from("ai_api_keys")
      .select("api_key")
      .eq("provider", "anthropic")
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data?.api_key as string) ?? null;
  } catch {
    return null;
  }
}

// ── Contrato da saída ────────────────────────────────────────────────────────
// Tool-use forçado: o modelo é obrigado a devolver ESTE shape (nada de markdown
// solto que o front tenha que adivinhar como renderizar).
const FERRAMENTA = {
  name: "entregar_analise",
  description: "Entrega a análise do período no formato que o painel do Código 2200 renderiza.",
  input_schema: {
    type: "object",
    properties: {
      veredito: {
        type: "string",
        description: "Uma frase direta sobre como o período está indo. Sem rodeio, sem elogio vazio.",
      },
      semaforo: {
        type: "string",
        enum: ["verde", "amarelo", "vermelho"],
        description: "verde = no ritmo da meta; amarelo = risco; vermelho = fora do ritmo.",
      },
      numeros_chave: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          properties: {
            rotulo: { type: "string" },
            valor: { type: "string", description: "Número já formatado (2 casas decimais quando for taxa/média)." },
            comparacao: { type: "string", description: "Contra o período anterior ou a meta. Vazio se não houver base." },
          },
          required: ["rotulo", "valor"],
        },
      },
      de_onde_veio: {
        type: "array",
        maxItems: 6,
        description: "Atribuição: de qual origem/campanha vieram as vendas e os agendamentos, por curso.",
        items: {
          type: "object",
          properties: {
            titulo: { type: "string" },
            detalhe: { type: "string" },
          },
          required: ["titulo", "detalhe"],
        },
      },
      quem_esta_indo_bem: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          properties: {
            pessoa: { type: "string" },
            por_que: { type: "string", description: "Com o número que sustenta." },
          },
          required: ["pessoa", "por_que"],
        },
      },
      pontos_de_atencao: {
        type: "array",
        maxItems: 6,
        items: {
          type: "object",
          properties: {
            titulo: { type: "string" },
            evidencia: { type: "string", description: "O número/fato do dossiê que sustenta." },
            impacto: { type: "string", description: "O que isso custa na meta." },
          },
          required: ["titulo", "evidencia"],
        },
      },
      maturacao_e_cadencia: {
        type: "array",
        maxItems: 6,
        description:
          "Há quanto tempo o lead estava na base quando agendou/comprou, velocidade do 1º contato " +
          "(speed-to-lead), leads largados sem contato e o que isso diz sobre a cadência.",
        items: {
          type: "object",
          properties: {
            titulo: { type: "string" },
            detalhe: { type: "string" },
          },
          required: ["titulo", "detalhe"],
        },
      },
      o_que_dizem_as_conversas: {
        type: "array",
        maxItems: 5,
        description: "Padrões nas objeções, resumos de reunião e falas de quem não compareceu.",
        items: {
          type: "object",
          properties: {
            padrao: { type: "string" },
            evidencia: { type: "string", description: "Quantas vezes apareceu e/ou um trecho real." },
          },
          required: ["padrao", "evidencia"],
        },
      },
      acoes: {
        type: "array",
        maxItems: 6,
        description: "O que fazer agora. Específico, executável hoje, ancorado num número do dossiê.",
        items: {
          type: "object",
          properties: {
            acao: { type: "string" },
            para_quem: { type: "string", description: "Pessoa ou time. '—' se for geral." },
            por_que: { type: "string" },
            prioridade: { type: "string", enum: ["alta", "media", "baixa"] },
          },
          required: ["acao", "por_que", "prioridade"],
        },
      },
      projecao: {
        type: "string",
        description: "Onde o período fecha se o ritmo atual se mantiver, com o número.",
      },
      lacunas: {
        type: "array",
        maxItems: 4,
        description: "Perguntas que os dados NÃO respondem (dado ausente/inconclusivo). Vazio se não houver.",
        items: { type: "string" },
      },
    },
    required: ["veredito", "semaforo", "numeros_chave", "de_onde_veio", "pontos_de_atencao", "acoes", "projecao"],
  },
} as const;

const SISTEMA = `Você é o analista de operação comercial da PPGVET, dentro do painel da missão "Código 2200"
(meta: 2.200 pós-graduações até 31/12/2026; o time tem meta semanal FIXA de matrículas).

Seu trabalho: ler o dossiê do período e dizer, sem enrolação, O QUE ESTÁ ACONTECENDO e O QUE FAZER.

REGRAS INEGOCIÁVEIS
1. Você NÃO calcula nada por conta própria. Todo número que você citar tem que estar no dossiê.
   Se um número que você quer citar não existe lá, não cite — registre em "lacunas".
2. NUNCA arredonde. Taxas, médias e percentuais saem com 2 casas decimais exatamente como vêm do
   dossiê (ex.: 54,17%, não "cerca de 54%"). Contagens (reuniões, vendas, leads) são inteiras.
   Escreva número em formato brasileiro: vírgula decimal e ponto de milhar.
3. Nomes de campanha, curso, vendedor e SDR: copie EXATAMENTE como estão no dossiê. Não abrevie,
   não traduza, não invente. "(sem campanha)" e "(sem origem)" significam que o lead não trouxe
   essa informação — diga isso, não chame de orgânico.
4. Não repita o dossiê. Cruze: origem × curso × pessoa × conversa. O valor está no cruzamento.
5. Diferencie CAUSA de RUÍDO. Base pequena (menos de 5 casos) não sustenta conclusão — se for citar,
   diga que a amostra é pequena.
6. Nada de elogio genérico nem de alarme genérico. Todo ponto tem número junto.

COMO LER O DOSSIÊ
- "resumo" é o período; "anterior" é o mesmo número de dias imediatamente antes (é a sua base de comparação).
- Comparecimento = comparecidas ÷ avaliadas (reunião cancelada e desqualificada ficam FORA de tudo).
- Conversão = matrículas do período ÷ reuniões comparecidas do período. Pode passar de 100% quando
  fecham vendas de reuniões antigas — isso é esperado, não é erro.
- ⚠️ "converteu" (nos blocos de reunião) e "vendas" NÃO são a mesma coisa e NUNCA devem ser somados
  ou comparados como se fossem: "converteu" é a reunião que o vendedor marcou como comprou; "vendas"
  é a matrícula com contrato assinado (é ela que conta na meta). Um dia pode ter mais "converteu"
  que "vendas" porque o contrato ainda não foi assinado — se notar essa diferença, diga que é
  contrato pendente de assinatura, não trate como erro nem como venda a mais.
- "reunioes_sem_resultado" são reuniões que ainda não têm desfecho marcado. Num período em curso,
  a maioria delas simplesmente ainda vai acontecer — não conclua nada de comparecimento com base nelas.
- "reunioes.por_origem" tem o funil por fonte: agendadas → compareceu → converteu. É aqui que se vê
  qual origem só enche agenda e qual origem vira matrícula.
- "vendas.por_origem[].ciclo_medio_dias" é quanto tempo o lead levou do cadastro até assinar.
  Ciclo longo em uma origem = a venda de hoje foi paga por mídia de meses atrás.
- "vendas.sem_origem_identificada" são matrículas cujo lead não casou — não atribua essas a ninguém.
- "reunioes_da_ia" são as agendadas pelo agente de IA (a conta "IA SDR" aparece como SDR).
- "conversas.pendencias_agora" é uma foto do AGORA (não do período): conversas em que o lead falou
  por último e ninguém respondeu.
- "cadencia" responde HÁ QUANTO TEMPO o lead estava na base e QUÃO RÁPIDO foi atendido. Leia
  "cadencia.como_ler" ANTES de concluir qualquer coisa dali — em especial: "contato" e "toque"
  contam QUALQUER mensagem nossa, inclusive disparo em massa, então volume de toque NÃO é esforço
  individual do SDR.
  · "speed_to_lead": minutos até a primeira mensagem nossa + quantos leads NUNCA foram contatados.
    Lead quente largado horas é perda direta — trate como prioridade.
  · "maturacao_na_reuniao/na_venda": dias entre cadastro e reunião/assinatura. Mediana alta numa
    origem significa que a colheita do período veio de base ANTIGA daquela origem, não da mídia
    desta semana — isso muda completamente a leitura de "campanha que está performando".
  · "comparecimento_por_idade_do_lead": compare as faixas. Se lead novo comparece MENOS que lead
    de 31 a 90 dias, diga isso explicitamente — é contra-intuitivo e muda a régua de priorização.
  · "safra_do_lead": de qual mês de cadastro veio a colheita. É o retrato do estoque que sustenta
    a operação hoje.
  · "funil_da_safra_que_entrou": leitura PARCIAL (safra nova ainda vai madurar) — nunca apresente
    como taxa final de conversão da origem.
- "textos" é o que foi realmente dito: objeções de quem não comprou, resumos de reunião, motivos de
  desqualificação e as últimas mensagens de quem não compareceu. Use para explicar o PORQUÊ dos números.

TOM: português brasileiro, direto, de quem opera. Frases curtas. Zero jargão de consultoria.
Você fala com o diretor e com o time comercial — eles conhecem o negócio, não precisam de introdução.`;

function promptUsuario(escopo: string, dossie: any): string {
  const j = dossie?.janela ?? {};
  const periodo = escopo === "dia"
    ? `o DIA ${j.de}`
    : `a SEMANA ${j.de} → ${j.ate}${j.ate !== j.semana_fim ? " (semana em curso — ainda não fechou)" : ""}`;
  return `Analise ${periodo} da operação comercial.

Foque, nesta ordem:
1. Estamos no ritmo da meta? (compare com o período anterior e com a meta do dossiê)
2. DE ONDE veio cada venda e cada reunião — qual campanha/origem entregou matrícula de qual curso,
   e qual origem está gerando agenda que não converte.
3. MATURAÇÃO E CADÊNCIA: há quanto tempo o lead estava na base quando agendou e quando assinou;
   quais origens vivem de base fria; onde o 1º contato está lento ou não aconteceu; qual faixa de
   idade de lead comparece mais. Aponte lead quente sendo largado — com o número.
4. Quem está comparecendo e fechando (vendedor e SDR), e quem está com número fora da curva.
5. O que as conversas revelam (objeções repetidas, motivo de no-show, o que o lead escreveu).
6. O que fazer AGORA — ações específicas, com nome e número.

DOSSIÊ (JSON):
${JSON.stringify(dossie)}`;
}

/** Body da chamada ao modelo. Fica aqui (e não no SQL) para o prompt viver num lugar só. */
function corpoDaChamada(escopo: string, dossie: any) {
  return {
    model: MODELO,
    max_tokens: MAX_TOKENS,
    // tool_choice forçado exige thinking desligado explicitamente (o Sonnet 5/Opus 5
    // ligam o adaptativo quando o campo é omitido).
    thinking: { type: "disabled" },
    system: [{ type: "text", text: SISTEMA, cache_control: { type: "ephemeral" } }],
    tools: [FERRAMENTA],
    tool_choice: { type: "tool", name: FERRAMENTA.name },
    messages: [{ role: "user", content: promptUsuario(escopo, dossie) }],
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ error: "não autorizado" }, 401);
    const asUser = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    const { data: userData } = await asUser.auth.getUser();
    const user = userData?.user;
    if (!user) return json({ error: "não autorizado" }, 401);

    const body = await req.json().catch(() => ({}));
    const escopo: string = body?.escopo === "dia" ? "dia" : "semana";
    const ref: string | null = typeof body?.ref === "string" && body.ref ? body.ref : null;
    const forcar = body?.forcar === true;

    const db = admin();

    // Gate de GERAÇÃO (a leitura é livre pra quem está logado): gestão ou membro
    // do time da missão. Quem não pode, ainda enxerga a última análise salva.
    const { data: podeGerar } = await db.rpc("codigo2200_ia_pode_gerar", { p_user: user.id });
    if (!podeGerar) {
      return json({ error: "Você não tem permissão para gerar a análise do Código 2200." }, 403);
    }

    // 1) Dossiê (service_role: sem o statement_timeout de 8s do papel do navegador).
    const { data: dossie, error: dossieErr } = await db.rpc("codigo2200_ia_dossie_admin", {
      p_escopo: escopo,
      p_ref: ref,
    });
    if (dossieErr) return json({ error: `Falha ao montar o dossiê: ${dossieErr.message}` }, 422);
    if (!dossie) return json({ error: "Código 2200 sem configuração — nada a analisar." }, 422);

    const janela = (dossie as any).janela ?? {};
    const refFinal = escopo === "dia" ? janela.de : janela.semana_inicio ?? janela.de;

    // 2) Cache: já existe análise desta janela? (regerar só com `forcar`)
    if (!forcar) {
      const { data: existente } = await db
        .from("codigo2200_ia_analises")
        .select("id, escopo, ref, de, ate, analise, modelo, gerado_em, gerado_por_nome")
        .eq("escopo", escopo)
        .eq("ref", refFinal)
        .maybeSingle();
      if (existente) {
        return json({ ...existente, resumo_dossie: (dossie as any).resumo, cache: true });
      }
    }

    // 3) DISPARA a análise e devolve o job na hora.
    //    A espera acontece no pg_net (dentro do banco), fora do caminho HTTP do
    //    navegador — senão o Cloudflare mataria a requisição em ~100 s (524) e o
    //    front veria só "Failed to send a request".
    const key = await anthropicKey();
    if (!key) {
      return json({ error: "Nenhuma chave da Anthropic configurada (ai_api_keys ou env)." }, 422);
    }

    const { data: perfil } = await db.from("profiles").select("name").eq("id", user.id).maybeSingle();
    const { data: jobId, error: jobErr } = await db.rpc("codigo2200_ia_job_disparar", {
      p_escopo: escopo,
      p_ref: refFinal,
      p_de: janela.de,
      p_ate: janela.ate,
      p_dossie: dossie,
      p_body: corpoDaChamada(escopo, dossie),
      p_api_key: key,
      p_modelo: MODELO,
      p_user: user.id,
      p_user_nome: perfil?.name ?? null,
    });
    if (jobErr) return json({ error: `Não foi possível iniciar a análise: ${jobErr.message}` }, 422);

    return json({
      job_id: jobId,
      status: "processando",
      escopo,
      ref: refFinal,
      de: janela.de,
      ate: janela.ate,
      modelo: MODELO,
      resumo_dossie: (dossie as any).resumo,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: msg }, 422);
  }
});
