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
//
// ⚠️ O contrato é de DADOS, não de texto (decisão do usuário 2026-07-28: "a IA
// está gerando muito texto; quero bater o olho e entender, mostrando quantos são
// de cada coisa"). Por isso: `blocos` são séries `{rotulo, valor}` que o painel
// desenha como BARRAS, e todo campo de texto tem `maxLength` curto. Prosa longa
// aqui vira parede de texto na tela — se precisar explicar, o lugar é `nota`.
const FERRAMENTA = {
  name: "entregar_analise",
  description: "Entrega a leitura do período em DADOS (números por categoria), não em texto corrido.",
  input_schema: {
    type: "object",
    properties: {
      veredito: {
        type: "string",
        maxLength: 130,
        description: "UMA frase curta, com número. Ex.: '15 vendas de 62 (24,19%) — conversão caiu de 27,86% para 12,50%.'",
      },
      semaforo: {
        type: "string",
        enum: ["verde", "amarelo", "vermelho"],
        description: "verde = no ritmo da meta; amarelo = risco; vermelho = fora do ritmo.",
      },
      placar: {
        type: "array",
        minItems: 4,
        maxItems: 6,
        description: "Os números que resumem o período. Só o essencial — é a primeira coisa que o gestor olha.",
        items: {
          type: "object",
          properties: {
            rotulo: { type: "string", maxLength: 26 },
            valor: { type: "string", maxLength: 14, description: "Número já formatado (2 casas em taxa, ponto de milhar)." },
            comparacao: { type: "string", maxLength: 34, description: "Contra o período anterior ou a meta. Vazio se não houver base." },
            tendencia: { type: "string", enum: ["subiu", "caiu", "igual", "sem_base"] },
            bom: { type: "boolean", description: "true se o número é positivo para a operação, false se é ruim." },
          },
          required: ["rotulo", "valor"],
        },
      },
      blocos: {
        type: "array",
        minItems: 3,
        maxItems: 7,
        description:
          "Séries de QUANTIDADE por categoria — o painel desenha cada uma como barras. " +
          "Use para: vendas por origem, vendas por curso, reuniões por origem, comparecimento por " +
          "idade do lead, tempo até o 1º contato por origem, objeções por tipo, reuniões por vendedor. " +
          "Escolha os cruzamentos que EXPLICAM o período — não repita a mesma informação em dois blocos.",
        items: {
          type: "object",
          properties: {
            titulo: { type: "string", maxLength: 46, description: "Ex.: 'De onde vieram as 15 vendas'." },
            categoria: {
              type: "string",
              enum: ["origem", "curso", "cadencia", "pessoas", "conversas", "reunioes"],
              description: "Define a cor do bloco no painel.",
            },
            unidade: { type: "string", maxLength: 16, description: "Ex.: vendas, reuniões, leads, %, dias, min." },
            itens: {
              type: "array",
              minItems: 2,
              maxItems: 8,
              items: {
                type: "object",
                properties: {
                  rotulo: { type: "string", maxLength: 38 },
                  valor: { type: "number", description: "A quantidade. Taxa vai como número (ex.: 54.17), não como texto." },
                  nota: { type: "string", maxLength: 28, description: "Complemento curto. Ex.: 'ciclo 6 dias', '0 vendas'." },
                  tom: { type: "string", enum: ["bom", "neutro", "ruim"] },
                },
                required: ["rotulo", "valor"],
              },
            },
          },
          required: ["titulo", "categoria", "unidade", "itens"],
        },
      },
      alertas: {
        type: "array",
        maxItems: 4,
        description: "O que está sangrando AGORA. Número na frente, frase curta.",
        items: {
          type: "object",
          properties: {
            numero: { type: "string", maxLength: 14 },
            texto: { type: "string", maxLength: 72 },
            gravidade: { type: "string", enum: ["alta", "media"] },
          },
          required: ["numero", "texto", "gravidade"],
        },
      },
      acoes: {
        type: "array",
        maxItems: 5,
        description: "O que fazer hoje. Verbo no início, curto, com o número que justifica.",
        items: {
          type: "object",
          properties: {
            texto: { type: "string", maxLength: 96 },
            para_quem: { type: "string", maxLength: 26 },
            prioridade: { type: "string", enum: ["alta", "media", "baixa"] },
          },
          required: ["texto", "prioridade"],
        },
      },
      lacunas: {
        type: "array",
        maxItems: 3,
        description: "O que os dados NÃO respondem. Frase curta. Vazio se não houver.",
        items: { type: "string", maxLength: 90 },
      },
    },
    required: ["veredito", "semaforo", "placar", "blocos", "acoes"],
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
- ⚠️ "resumo.leads" NÃO é só demanda: quando o TI importa uma planilha, a base importada entra nesse
  número. "resumo.leads_de_planilha" diz QUANTOS desses vieram de importação. Antes de dizer que lead
  subiu ou caiu, desconte: demanda = leads − leads_de_planilha. Um salto em que quase tudo é planilha
  é IMPORTAÇÃO DE BASE, não captação — diga isso com os dois números e não trate como crescimento.
  (speed_to_lead e funil_da_safra já excluem a base importada, então os "nunca contatados" de lá são
  leads de demanda de verdade.)
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
  · "comparecimento_por_idade_do_lead": a taxa é sobre as AVALIADAS da faixa, e cada faixa traz
    "agendadas" e "avaliadas" separadas. ⚠️ No bloco, o rótulo do item TEM QUE citar a base
    avaliada (ex.: "31 a 90 dias (26 avaliadas)") e NUNCA as agendadas — a soma das agendadas das
    faixas é o total de reuniões do período (toda reunião cai em UMA faixa), então usar agendadas
    no rótulo faz parecer que houve mais reunião do que houve. Compare as faixas e diga se alguma
    destoa — mas só chame de diferença o que estiver fora da margem de uma base pequena.
  · "safra_do_lead": de qual mês de cadastro veio a colheita. É o retrato do estoque que sustenta
    a operação hoje.
  · "funil_da_safra_que_entrou": leitura PARCIAL (safra nova ainda vai madurar) — nunca apresente
    como taxa final de conversão da origem.
- "textos" é o que foi realmente dito: objeções de quem não comprou, resumos de reunião, motivos de
  desqualificação e as últimas mensagens de quem não compareceu. Use para explicar o PORQUÊ dos números.

COMO ESCREVER — LEIA COM ATENÇÃO, É O QUE MAIS IMPORTA
Você NÃO escreve relatório. Você entrega um PAINEL: números por categoria que o gestor
entende batendo o olho, sem ler parágrafo.

1. PREFIRA SEMPRE UM BLOCO DE BARRAS a uma frase. Se der para dizer com "categoria → quantidade",
   é bloco. Frase só quando o número sozinho não se explica.
2. Cada bloco responde UMA pergunta e traz a QUANTIDADE de cada coisa. Bons blocos:
   · De onde vieram as N vendas (origem → nº de vendas)
   · Quais cursos venderam (curso → nº)
   · Reuniões por origem (origem → nº) e comparecimento por origem (origem → %)
   · Comparecimento por idade do lead (faixa → %)
   · Tempo até o 1º contato por origem (origem → minutos)
   · Objeções mais repetidas (motivo → nº de vezes) — CONTE as ocorrências nos textos
   · Reuniões e fechamento por vendedor (pessoa → nº)
3. Ordene os itens do MAIOR para o menor. Use 'tom': bom (verde), ruim (vermelho), neutro.
   'nota' é complemento de 2 a 4 palavras, não uma frase.
4. Nada de texto redundante: se o número está no bloco, não repita no veredito nem na ação.
5. Limites são LIMITES: veredito é UMA frase; ação começa com verbo e cabe em uma linha;
   alerta é número + no máximo 8 palavras.
6. Máximo 7 blocos. Escolha os que EXPLICAM o período — bloco que não muda decisão fica fora.

TOM: português brasileiro, telegráfico, de quem opera. Zero jargão de consultoria, zero
introdução, zero "é importante notar que". Você fala com o diretor e com o time comercial.`;

function promptUsuario(escopo: string, dossie: any): string {
  const j = dossie?.janela ?? {};
  const periodo = escopo === "dia"
    ? `o DIA ${j.de}`
    : `a SEMANA ${j.de} → ${j.ate}${j.ate !== j.semana_fim ? " (semana em curso — ainda não fechou)" : ""}`;
  return `Analise ${periodo} da operação comercial.

Monte o painel — QUANTOS de cada coisa, não texto:

· placar: os 4 a 6 números que resumem o período (venda, meta, comparecimento, conversão…),
  cada um comparado ao período anterior.
· blocos (barras): escolha os cruzamentos que EXPLICAM o período. Comece por
  "de onde vieram as vendas" (origem → quantidade) e "quais cursos venderam".
  Depois os que revelarem mais: reuniões por origem, comparecimento por origem ou por idade
  do lead, tempo até o 1º contato por origem, objeções mais repetidas (CONTE nos textos),
  desempenho por vendedor.
· alertas: o que está sangrando agora — número na frente (lead sem contato, conversa parada,
  falha de disparo, origem que agenda e não fecha).
· acoes: o que fazer hoje, começando por verbo.

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
