// ia-admin — IA Administrativa (só diretor/admin). Mapa: docs/IA Administrativa.md.
//
// Auditora interna: lê o banco (somente leitura, via `ia_admin_sql`), lê a documentação
// (docs/ sincronizado pela Action ia-admin-docs.yml), registra ACHADOS com evidência, sugere
// automação e escreve prompt para o desenvolvedor. Não corrige nada.
//
// Ações (POST JSON, campo `acao`):
//   * chat               — admin conversa; resposta em stream NDJSON (eventos de agente.ts).
//   * varredura_iniciar  — admin pede uma rodada (todas as checagens ativas ou uma só).
//   * varredura_tick     — cron (service role) a cada 2 min: processa UM item da fila em
//                          segundo plano (EdgeRuntime.waitUntil) e responde 202 na hora.
//                          Também puxa a fila de prompts das demandas do TI.
//   * prompt_tick        — cutucada do banco (service role) quando nasce um pedido de prompt
//                          (demanda nova do TI, gt_tarefa_prompts): gera em segundo plano.
//   * prompt_refazer     — admin pede (de novo) o prompt de uma tarefa.
//
// ⚠️ O worker vive no máximo 5 min: o laço tem PRAZO e conclui sozinho antes disso.
// ⚠️ Chamada pelo navegador passa pelo Cloudflare (corta conexão parada em ~100 s): o stream
//    manda `ping` a cada 15 s. Recusa antes do stream = JSON 401/403/422; depois, evento `erro`.
import Anthropic from "npm:@anthropic-ai/sdk@0.128.0";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { executarFerramenta, FERRAMENTAS, FERRAMENTAS_PROMPT, type ContextoFerramentas, type EntregaPrompt } from "./ferramentas.ts";
import { blocoContexto, blocoDocs, PROMPT_BASE, type ContextoPedido, type TarefaParaPrompt } from "./prompt.ts";
import {
  custoEstimado,
  motivoDaReserva,
  rodarAgente,
  semCreditoNaIA,
  type EventoIaAdmin,
  type OpcoesAgente,
  type ResumoAgente,
} from "./agente.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Modelo por modo — decisão do usuário (16/10/2026, "não queria ter que gastar com isso"): o
// Opus 5.5 custava ~US$ 0,20–0,60 por checagem. Varredura e prompts (tarefa guiada, com evidência
// conferida por gente) no Haiku 5.5, ~20× mais barato; chat (alguém esperando uma investigação
// boa) no Sonnet 5.5, metade do Opus. Troca sem deploy de código: env IA_ADMIN_MODEL_CHAT /
// _VARREDURA / _PROMPT e IA_ADMIN_EFFORT_CHAT / _VARREDURA / _PROMPT.
const MODELO_CHAT = Deno.env.get("IA_ADMIN_MODEL_CHAT") ?? "claude-sonnet-5-5";
const MODELO_VARREDURA = Deno.env.get("IA_ADMIN_MODEL_VARREDURA") ?? "claude-haiku-5-5";
const MODELO_PROMPT = Deno.env.get("IA_ADMIN_MODEL_PROMPT") ?? "claude-haiku-5-5";
/** Reserva (modelo indisponível ou sobrecarregado): o outro modelo barato. */
const reservaDe = (modelo: string) => (modelo.startsWith("claude-haiku") ? "claude-sonnet-5-5" : "claude-haiku-5-5");
const ESFORCOS = ["low", "medium", "high", "xhigh", "max"];
const esforco = (env: string, padrao: string) => (ESFORCOS.includes(Deno.env.get(env) ?? "") ? Deno.env.get(env)! : padrao);
// `medium` em tudo: é o ponto de partida recomendado para trabalho com várias ferramentas.
const ESFORCO_CHAT = esforco("IA_ADMIN_EFFORT_CHAT", "medium");
const ESFORCO_VARREDURA = esforco("IA_ADMIN_EFFORT_VARREDURA", "medium");
const ESFORCO_PROMPT = esforco("IA_ADMIN_EFFORT_PROMPT", "medium");
const MAX_TOKENS = 32000;

const OPCOES_CHAT: OpcoesAgente = { maxPassos: 16, prazoMs: 200_000 };
const OPCOES_VARREDURA: OpcoesAgente = { maxPassos: 18, prazoMs: 170_000 };
// Prompt de demanda: rápido (o TI abre o link logo depois do aviso) e sempre fecha pela entrega.
const OPCOES_PROMPT: OpcoesAgente = { maxPassos: 12, prazoMs: 150_000, ferramentaDeEntrega: "entregar_prompt" };
/** Pedidos de prompt puxados por chamada (cada um roda em paralelo no mesmo worker). */
const PROMPTS_POR_CHAMADA = 3;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const admin = () => createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Chamada do banco (cron/cutucada): a chave de serviço ATUAL das edges, que o banco lê do Vault
 * em `edge_service_role_key`. ⚠️ `_get_service_role_key()` (`app_service_role_key`) é a chave do
 * PROJETO ANTIGO, assinada com outro segredo — com ela o primeiro tick levou 403 (16/10/2026,
 * 13:50). Mesma armadilha do e-mail dos Fluxos (migration 20260928235900).
 */
async function ehServiceRole(token: string): Promise<boolean> {
  return !!token && token === SERVICE_ROLE;
}

/** Mesma ordem das outras IAs: chave cadastrada no sistema, depois env. */
async function chaveAnthropic(): Promise<string | null> {
  try {
    const { data } = await admin().from("ai_api_keys").select("api_key")
      .eq("provider", "anthropic").eq("is_active", true)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (data?.api_key) return String(data.api_key);
  } catch { /* cai para o env */ }
  return Deno.env.get("ANTHROPIC_API_KEY") ?? Deno.env.get("AGENTE_SDR_ANTHROPIC_KEY") ?? null;
}

function paramsDoModelo(modelo: string, esforcoUsado: string): Record<string, unknown> {
  // Fallback do servidor (recusa → outro modelo na mesma chamada): Opus 5/5.5, Fable e Sonnet 5.5
  // (este só na forma "default"). O Haiku 5.5 não tem — recusa nele termina como recusa.
  const comFallback = modelo.startsWith("claude-opus-5") || modelo.startsWith("claude-fable") ||
    modelo.startsWith("claude-sonnet-5-5");
  return {
    model: modelo,
    max_tokens: MAX_TOKENS,
    thinking: { type: "adaptive" },
    output_config: { effort: esforcoUsado },
    ...(comFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
  };
}

function mensagemDeErro(e: unknown): string {
  if (e instanceof Anthropic.APIError && semCreditoNaIA(e)) return "A conta da IA está sem créditos. Avise o TI para recarregar.";
  if (e instanceof Anthropic.RateLimitError || (e instanceof Anthropic.APIError && motivoDaReserva(e) === "sobrecarga")) {
    return "A IA está sobrecarregada agora. Tente de novo em um minuto.";
  }
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return "A chave de acesso à IA foi recusada. Avise o TI.";
  }
  if (e instanceof Anthropic.APIConnectionError) return "Não consegui me conectar à IA. Tente de novo.";
  return "Não consegui concluir agora. Tente de novo em instantes.";
}

/** CLAUDE.md + lista de arquivos + carimbo da sincronização (blocos 2 do system). */
async function carregarDocs(sb: SupabaseClient): Promise<string> {
  const [claude, arquivos, sync] = await Promise.all([
    sb.from("ia_admin_docs").select("secao,conteudo,ordem").eq("arquivo", "CLAUDE.md").order("ordem"),
    sb.from("ia_admin_docs_arquivos").select("arquivo").order("arquivo").limit(2000),
    sb.from("ia_admin_config").select("valor").eq("chave", "docs_sync").maybeSingle(),
  ]);
  const claudeMd = (claude.data ?? [])
    .map((s: { secao: string; conteudo: string }) => `### ${s.secao.split(" › ").pop()}\n${s.conteudo}`)
    .join("\n\n");
  const lista = (arquivos.data ?? []).map((a: { arquivo: string }) => a.arquivo);
  return blocoDocs(claudeMd || null, lista, (sync.data?.valor ?? null) as { em?: string; commit?: string } | null);
}

function montarSystem(docs: string, contexto: ContextoPedido): Anthropic.Beta.BetaTextBlockParam[] {
  return [
    { type: "text", text: PROMPT_BASE, cache_control: { type: "ephemeral" } },
    { type: "text", text: docs, cache_control: { type: "ephemeral" } },
    { type: "text", text: blocoContexto(contexto) },
  ];
}

/** Roda o agente com reserva de modelo (404/sobrecarga antes de qualquer texto visível). */
async function rodarComReserva(
  cliente: Anthropic,
  entrada: Parameters<typeof rodarAgente>[0],
  depsBase: Omit<Parameters<typeof rodarAgente>[1], "abrirStream">,
  opcoes: OpcoesAgente,
  esforcoUsado: string,
  sinal: AbortSignal,
  modeloInicial: string,
): Promise<{ resumo: ResumoAgente; modelo: string }> {
  let modelo = modeloInicial;
  const reserva = reservaDe(modeloInicial);
  let textoVisivel = false;
  let proximoPasso = 0;
  const deps = {
    ...depsBase,
    emitir: (ev: EventoIaAdmin) => {
      if (ev.tipo === "texto") textoVisivel = true;
      if ("passo" in ev) proximoPasso = Math.max(proximoPasso, ev.passo + 1);
      depsBase.emitir(ev);
    },
    abrirStream: (params: Record<string, unknown>) =>
      cliente.beta.messages.stream({ ...params, ...paramsDoModelo(modelo, esforcoUsado) } as never, { signal: sinal }),
  };
  try {
    return { resumo: await rodarAgente(entrada, deps, opcoes), modelo };
  } catch (e) {
    const motivo = e instanceof Anthropic.APIError ? motivoDaReserva(e) : null;
    if (!motivo || modelo === reserva || textoVisivel || sinal.aborted) throw e;
    console.warn("[ia-admin] usando reserva", motivo, modelo, "→", reserva);
    modelo = reserva;
    return { resumo: await rodarAgente(entrada, deps, { ...opcoes, passoInicial: proximoPasso }), modelo };
  }
}

function auditor(base: { origem: "chat" | "varredura" | "prompt"; usuario_id?: string | null; conversa_id?: string | null; rodada_item_id?: string | null; task_id?: string | null }) {
  return async (log: { ferramenta: string; entrada: string; ok: boolean; linhas?: number; ms?: number; erro?: string }) => {
    try {
      await admin().from("ia_admin_consultas").insert({
        ...base,
        ferramenta: log.ferramenta,
        entrada: log.entrada.slice(0, 20000),
        ok: log.ok,
        linhas: log.linhas ?? null,
        ms: log.ms != null ? Math.round(log.ms) : null,
        erro: log.erro?.slice(0, 2000) ?? null,
      });
    } catch (e) {
      console.error("[ia-admin] auditoria", (e as Error)?.message);
    }
  };
}

// ════════════════════════════════════════════════════════════════════════════════════
// Varredura
// ════════════════════════════════════════════════════════════════════════════════════
interface ItemFila {
  item_id: string;
  rodada_id: string;
  checagem: { id: string; slug: string; titulo: string; area: string; objetivo: string; ultima_execucao_em: string | null; ultimo_resumo: string | null };
}

async function processarItem(item: ItemFila): Promise<void> {
  const sb = admin();
  const concluir = (dados: Record<string, unknown>) =>
    sb.rpc("ia_admin_varredura_concluir", { p_item_id: item.item_id, p_dados: dados }).then(({ error }) => {
      if (error) console.error("[ia-admin] concluir", error.message);
    });

  const chave = await chaveAnthropic();
  if (!chave) {
    await concluir({ status: "erro", erro: "Sem chave da Anthropic configurada (Configuração IA › APIs de IA)." });
    return;
  }

  try {
    const [docs, abertos] = await Promise.all([
      carregarDocs(sb),
      sb.from("ia_admin_achados").select("assinatura,titulo,casos,vezes_visto,ultima_vez_visto_em")
        .eq("checagem_id", item.checagem.id).in("status", ["aberto", "em_andamento"]),
    ]);
    const system = montarSystem(docs, {
      agora: new Date(),
      modo: "varredura",
      checagem: item.checagem,
      achadosDaChecagem: abertos.data ?? [],
    });
    const ctx: ContextoFerramentas = {
      cliente: sb,
      modo: "varredura",
      checagemId: item.checagem.id,
      rodadaItemId: item.item_id,
      auditar: auditor({ origem: "varredura", rodada_item_id: item.item_id }),
    };
    const cliente = new Anthropic({ apiKey: chave, maxRetries: 2, timeout: 150_000 });
    const abortar = new AbortController();
    const { resumo, modelo } = await rodarComReserva(
      cliente,
      {
        system,
        tools: FERRAMENTAS,
        messages: [{ role: "user", content: `Execute agora a checagem "${item.checagem.titulo}", seguindo o método. Ao final, escreva o RESUMO.` }],
      },
      {
        executar: (nome, entrada) => executarFerramenta(ctx, nome, entrada),
        emitir: () => {},
        ehErroDaApi: (e) => e instanceof Anthropic.APIError,
      },
      OPCOES_VARREDURA,
      ESFORCO_VARREDURA,
      abortar.signal,
      MODELO_VARREDURA,
    );
    // Sem resumo não é "ok": a checagem rodou mas ninguém sabe o que ela achou.
    const ok = resumo.terminou === "resposta" && !!resumo.textoFinal.trim();
    await concluir({
      status: ok ? "ok" : "erro",
      resumo: resumo.textoFinal.trim() || null,
      erro: ok
        ? null
        : `${resumo.terminou === "resposta" ? "Terminou sem escrever o resumo." : `Terminou em: ${resumo.terminou}.`}` +
          (resumo.vazias.length ? ` Rodadas vazias: ${resumo.vazias.join(" | ")}` : ""),
      achados: resumo.achados.length,
      consultas: resumo.consultas,
      tokens_entrada: resumo.uso.entrada + resumo.uso.cacheLeitura + resumo.uso.cacheEscrita,
      tokens_saida: resumo.uso.saida,
      custo_usd: custoEstimado(modelo, resumo.usoPorRodada),
      modelo,
    });
  } catch (e) {
    console.error("[ia-admin] varredura", item.checagem.slug, (e as Error)?.message);
    await concluir({ status: "erro", erro: `${mensagemDeErro(e)} (${String((e as Error)?.message ?? e).slice(0, 300)})` });
  }
}

/** Trabalho que continua depois da resposta (EdgeRuntime.waitUntil); sem o runtime, espera. */
async function emSegundoPlano(trabalho: Promise<void>): Promise<void> {
  // deno-lint-ignore no-explicit-any
  const runtime = (globalThis as any).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(trabalho);
  else await trabalho;
}

/** Pega o próximo item da fila e o processa em segundo plano. */
async function dispararProximo(): Promise<{ disparou: boolean; motivo?: string }> {
  const sb = admin();
  const { count } = await sb.from("ia_admin_docs_arquivos").select("arquivo", { count: "exact", head: true });
  if (!count) return { disparou: false, motivo: "documentação ainda não sincronizada" };
  const { data, error } = await sb.rpc("ia_admin_varredura_proximo");
  if (error) throw new Error(error.message);
  if (!data) return { disparou: false, motivo: "fila vazia ou item em andamento" };
  await emSegundoPlano(processarItem(data as ItemFila));
  return { disparou: true };
}

// ════════════════════════════════════════════════════════════════════════════════════
// Prompt das demandas novas do TI (gt_tarefa_prompts)
// ════════════════════════════════════════════════════════════════════════════════════
async function processarPrompt(tarefa: TarefaParaPrompt): Promise<void> {
  const sb = admin();
  const concluir = (dados: Record<string, unknown>) =>
    sb.rpc("ia_admin_prompt_concluir", { p_task_id: tarefa.task_id, p_dados: dados }).then(({ error }) => {
      if (error) console.error("[ia-admin] prompt concluir", error.message);
    });

  const chave = await chaveAnthropic();
  if (!chave) {
    await concluir({ status: "erro", erro: "Sem chave da Anthropic configurada (Configuração IA › APIs de IA)." });
    return;
  }

  try {
    let entrega = null as EntregaPrompt | null;
    const ctx: ContextoFerramentas = {
      cliente: sb,
      modo: "prompt",
      entregarPrompt: (e) => { entrega = e; },
      auditar: auditor({ origem: "prompt", task_id: tarefa.task_id }),
    };
    const system = montarSystem(await carregarDocs(sb), { agora: new Date(), modo: "prompt", tarefa });
    const cliente = new Anthropic({ apiKey: chave, maxRetries: 2, timeout: 150_000 });
    const { resumo, modelo } = await rodarComReserva(
      cliente,
      {
        system,
        tools: FERRAMENTAS_PROMPT,
        messages: [{ role: "user", content: "Analise a demanda e entregue o resultado com entregar_prompt." }],
      },
      {
        executar: (nome, entrada) => executarFerramenta(ctx, nome, entrada),
        emitir: () => {},
        ehErroDaApi: (e) => e instanceof Anthropic.APIError,
      },
      OPCOES_PROMPT,
      ESFORCO_PROMPT,
      new AbortController().signal,
      MODELO_PROMPT,
    );

    const e = entrega as EntregaPrompt | null;
    const final = resumo.textoFinal.trim();
    const resultado = e
      ? {
        status: (e.tipo === "codigo" || e.tipo === "operacao") && e.prompt ? "pronto" : "sem_prompt",
        tipo: e.tipo,
        entendimento: e.entendimento,
        motivo: e.motivo,
        prompt: e.prompt,
        perguntas: e.perguntas,
      }
      : final
        // Não chamou a entrega mas escreveu: guarda o texto (melhor que perder a análise).
        ? { status: "pronto", prompt: final, motivo: "A IA não classificou a demanda; o texto é a análise dela." }
        : { status: "erro", erro: `Terminou sem entregar o prompt (${resumo.terminou}).` };
    await concluir({
      ...resultado,
      etapas: resumo.etapas,
      modelo,
      tokens_entrada: resumo.uso.entrada + resumo.uso.cacheLeitura + resumo.uso.cacheEscrita,
      tokens_saida: resumo.uso.saida,
      custo_usd: custoEstimado(modelo, resumo.usoPorRodada),
    });
  } catch (e) {
    console.error("[ia-admin] prompt", tarefa.task_id, (e as Error)?.message);
    await concluir({ status: "erro", erro: `${mensagemDeErro(e)} (${String((e as Error)?.message ?? e).slice(0, 300)})` });
  }
}

/** Puxa até PROMPTS_POR_CHAMADA pedidos de prompt e gera em segundo plano. */
async function dispararPrompts(): Promise<{ prompts: number }> {
  const sb = admin();
  const trabalhos: Promise<void>[] = [];
  for (let i = 0; i < PROMPTS_POR_CHAMADA; i++) {
    const { data, error } = await sb.rpc("ia_admin_prompt_proximo");
    if (error) throw new Error(error.message);
    if (!data) break;
    trabalhos.push(processarPrompt(data as TarefaParaPrompt));
  }
  if (trabalhos.length) await emSegundoPlano(Promise.all(trabalhos).then(() => {}));
  return { prompts: trabalhos.length };
}

// ════════════════════════════════════════════════════════════════════════════════════
// Chat
// ════════════════════════════════════════════════════════════════════════════════════
async function chat(
  body: Record<string, unknown>,
  usuario: { id: string; nome: string; cargo: string },
  sbUsuario: SupabaseClient,
): Promise<Response> {
  const mensagem = typeof body.mensagem === "string" ? body.mensagem.trim().slice(0, 6000) : "";
  if (!mensagem) return json({ erro: "Mensagem vazia." }, 422);
  const sb = admin();

  let conversaId = typeof body.conversa_id === "string" && UUID.test(body.conversa_id) ? body.conversa_id : null;
  let achadoId: string | null = null;
  if (conversaId) {
    const { data: conv } = await sb.from("ia_admin_conversas").select("id,usuario_id,achado_id").eq("id", conversaId).maybeSingle();
    if (!conv || conv.usuario_id !== usuario.id) return json({ erro: "Conversa não encontrada." }, 404);
    achadoId = conv.achado_id;
  } else {
    achadoId = typeof body.achado_id === "string" && UUID.test(body.achado_id) ? body.achado_id : null;
    const { data: nova, error } = await sb.from("ia_admin_conversas")
      .insert({ usuario_id: usuario.id, titulo: mensagem.replace(/\s+/g, " ").slice(0, 80), achado_id: achadoId })
      .select("id").single();
    if (error || !nova) return json({ erro: "Não consegui abrir a conversa. Tente de novo." }, 422);
    conversaId = nova.id;
  }

  const [historicoR, achadoR, docs, chave] = await Promise.all([
    sb.from("ia_admin_mensagens").select("papel,conteudo,contexto_modelo")
      .eq("conversa_id", conversaId).order("criado_em", { ascending: false }).limit(16),
    achadoId
      ? sb.from("ia_admin_achados").select("id,titulo,gravidade,area,status,resumo,impacto,casos,evidencias,causa_provavel,regra_documentada,correcao_imediata,automacao_sugerida,nota,ultima_vez_visto_em").eq("id", achadoId).maybeSingle()
      : Promise.resolve({ data: null }),
    carregarDocs(sbUsuario),
    chaveAnthropic(),
  ]);
  if (!chave) return json({ erro: "A IA está sem chave configurada. Avise o TI (Configuração IA › APIs de IA)." }, 422);

  const historico: Anthropic.Beta.BetaMessageParam[] = ((historicoR.data ?? []) as Array<{ papel: "user" | "assistant"; conteudo: string; contexto_modelo: string | null }>)
    .reverse()
    .filter((m) => m.conteudo?.trim())
    .map((m) => ({
      role: m.papel,
      content: m.papel === "assistant" && m.contexto_modelo
        ? `${m.conteudo}\n\n<consultas_feitas>\n${m.contexto_modelo}\n</consultas_feitas>`
        : m.conteudo,
    }));
  while (historico.length && historico[0].role !== "user") historico.shift();

  await sb.from("ia_admin_mensagens").insert({ conversa_id: conversaId, papel: "user", conteudo: mensagem });

  const system = montarSystem(docs, {
    agora: new Date(),
    modo: "chat",
    quem: { nome: usuario.nome, cargo: usuario.cargo },
    achado: (achadoR.data ?? null) as Record<string, unknown> | null,
  });
  const ctx: ContextoFerramentas = {
    cliente: sbUsuario,
    modo: "chat",
    auditar: auditor({ origem: "chat", usuario_id: usuario.id, conversa_id: conversaId }),
  };
  const cliente = new Anthropic({ apiKey: chave, maxRetries: 2, timeout: 150_000 });
  const encoder = new TextEncoder();
  const abortar = new AbortController();
  const idConversa = conversaId!;

  const corpo = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enviar = (ev: EventoIaAdmin) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(ev)}\n`));
        } catch { /* navegador já foi embora */ }
      };
      const batimento = setInterval(() => enviar({ tipo: "ping" }), 15_000);
      enviar({ tipo: "conversa", id: idConversa });

      let resumo: ResumoAgente | null = null;
      let modelo = MODELO_CHAT;
      try {
        const r = await rodarComReserva(
          cliente,
          { system, tools: FERRAMENTAS, messages: [...historico, { role: "user", content: mensagem }] },
          {
            executar: (nome, entrada) => executarFerramenta(ctx, nome, entrada),
            emitir: enviar,
            ehErroDaApi: (e) => e instanceof Anthropic.APIError,
            cancelado: () => abortar.signal.aborted,
          },
          OPCOES_CHAT,
          ESFORCO_CHAT,
          abortar.signal,
          MODELO_CHAT,
        );
        resumo = r.resumo;
        modelo = r.modelo;
        enviar({ tipo: "fim", modelo, passos: resumo.passos, custo_usd: custoEstimado(modelo, resumo.usoPorRodada) });
      } catch (e) {
        if (!abortar.signal.aborted) {
          console.error("[ia-admin] chat", (e as Error)?.message);
          enviar({ tipo: "erro", mensagem: mensagemDeErro(e) });
        }
      } finally {
        clearInterval(batimento);
        if (resumo?.textoFinal.trim()) {
          await sb.from("ia_admin_mensagens").insert({
            conversa_id: idConversa,
            papel: "assistant",
            conteudo: resumo.textoFinal.trim(),
            contexto_modelo: resumo.memoria.join("\n").slice(0, 12000) || null,
            etapas: resumo.etapas,
            modelo,
            tokens_entrada: resumo.uso.entrada + resumo.uso.cacheLeitura + resumo.uso.cacheEscrita,
            tokens_saida: resumo.uso.saida,
            custo_usd: custoEstimado(modelo, resumo.usoPorRodada),
          });
        }
        await sb.from("ia_admin_conversas").update({ atualizado_em: new Date().toISOString() }).eq("id", idConversa);
        try {
          controller.close();
        } catch { /* já fechado */ }
      }
    },
    cancel() {
      abortar.abort();
    },
  });

  return new Response(corpo, {
    headers: {
      ...corsHeaders,
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}

// ════════════════════════════════════════════════════════════════════════════════════
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ erro: "método não suportado" }, 405);

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const acao = String(body.acao ?? "");
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();

  try {
    // ── Cron (service role) ───────────────────────────────────────────────────
    if (acao === "varredura_tick" || acao === "prompt_tick") {
      if (!(await ehServiceRole(token))) return json({ erro: "não autorizado" }, 403);
      // Prompt primeiro: alguém está esperando por ele no aviso do WhatsApp.
      const p = await dispararPrompts();
      const r = acao === "varredura_tick" ? await dispararProximo() : { disparou: false };
      return json({ ok: true, ...p, ...r }, r.disparou || p.prompts ? 202 : 200);
    }

    // ── Diretor/admin logado ──────────────────────────────────────────────────
    if (!token) return json({ erro: "não autenticado" }, 401);
    const sbUsuario = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false },
    });
    const { data: userData } = await sbUsuario.auth.getUser();
    const user = userData?.user;
    if (!user) return json({ erro: "Sua sessão expirou. Entre de novo no sistema." }, 401);
    const { data: pode } = await sbUsuario.rpc("ia_admin_pode");
    if (pode !== true) return json({ erro: "A IA Administrativa é só para diretores e admins." }, 403);
    const { data: perfil } = await admin().from("profiles").select("name,user_type").eq("id", user.id).maybeSingle();
    const usuario = { id: user.id, nome: String(perfil?.name ?? "admin"), cargo: String(perfil?.user_type ?? "admin") };

    if (acao === "chat") return await chat(body, usuario, sbUsuario);

    if (acao === "varredura_iniciar") {
      const checagemId = typeof body.checagem_id === "string" && UUID.test(body.checagem_id) ? body.checagem_id : null;
      const { data: rodadaId, error } = await sbUsuario.rpc("ia_admin_varredura_iniciar", { p_checagem_id: checagemId, p_origem: "manual" });
      if (error) return json({ erro: error.message }, 422);
      const r = await dispararProximo();
      return json({ ok: true, rodada_id: rodadaId, ...r }, 202);
    }

    if (acao === "prompt_refazer") {
      const taskId = typeof body.task_id === "string" && UUID.test(body.task_id) ? body.task_id : null;
      if (!taskId) return json({ erro: "Tarefa inválida." }, 422);
      const { error } = await sbUsuario.rpc("ia_admin_prompt_refazer", { p_task_id: taskId });
      if (error) return json({ erro: error.message.includes("não encontrada") ? "Tarefa não encontrada." : error.message }, 422);
      const p = await dispararPrompts();
      return json({ ok: true, ...p }, 202);
    }

    return json({ erro: "ação desconhecida" }, 422);
  } catch (e) {
    console.error("[ia-admin]", acao, (e as Error)?.message);
    return json({ erro: "Erro inesperado. Tente de novo." }, 422);
  }
});
