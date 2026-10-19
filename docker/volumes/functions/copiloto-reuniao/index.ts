// copiloto-reuniao
// Dicas AO VIVO para o vendedor durante a reunião de vídeo com o lead (13/10/2026).
//
// Quem chama: a extensão "Copiloto de Reunião" do Chrome, que transcreve a chamada do
// Meet (áudio da aba = lead, microfone = vendedor) e manda a conversa para cá a cada
// fala fechada do lead. Esta função NÃO recebe áudio — só texto já transcrito.
//
// Duas ações, sempre com o login do vendedor:
//   * iniciar — acha a reunião pelo código do Meet (`agendamentos.link_reuniao`).
//   * dica    — lê as informações da reunião e devolve UMA dica curta, ou nada.
//   * preparar — gera (uma vez por reunião) o RESUMO do lead: dados, o que foi registrado
//               ao marcar e a conversa de WhatsApp. O vendedor lê no app e a IA das
//               perguntas recebe junto. Guardado em `copiloto_reuniao_resumos`.
//   * sessao_iniciar / falas / sessao_encerrar / avaliar — CAPTURA para avaliação: cada
//               Iniciar vira uma sessão; as falas transcritas e as perguntas mostradas
//               ficam em copiloto_reuniao_*; o vendedor marca 👍/👎 em cada pergunta.
//               A pergunta é gravada aqui mesmo, na ação `dica` (não depende do app).
//   * analisar_uso — (também sozinha ao encerrar) a IA lê a transcrição e marca quais
//               perguntas o vendedor USOU (`usada`, `usada_trecho`). A tela de avaliação
//               do sistema chama para sessões que ficaram sem análise.
//   * evento  — uso e erros do app (`copiloto_app_eventos`).
//   * minhas  — as reuniões em que quem chama é o VENDEDOR, perto de agora (o app de
//               Windows não lê a aba do Meet: o vendedor escolhe a reunião na lista).
//
// De onde vêm as informações (nada é copiado nem mandado pelo navegador):
//   * reunião e lead: `agendamentos` e `leads`, lidos com o JWT de QUEM CHAMA — a RLS
//     decide se a pessoa pode ver aquela reunião. Contexto livre vindo do cliente foi
//     exatamente o defeito da `sales-copilot-chat` aposentada.
//   * mapa de carreira da pós (ramos, sinais e perguntas do comercial):
//     `sdr_carreira_mapa_pos` / `_ramo` / `_pergunta`, também com o JWT.
//
// O foco é o LEAD (decisão do Gustavo, 13/10/2026): aqui NÃO entra preço, catálogo nem
// resposta pronta de objeção. E a fonte das perguntas é o mapa do comercial, não o
// `sdr_carreira_pos` (perguntas técnicas, aposentadas para o SDR em 07/10/2026).
//
// ⚠️ Chamada pelo NAVEGADOR → nunca devolver 502/504 (o Cloudflare troca por página
//    sem CORS). Falha da IA volta 200 com `dica: null` e um `aviso` quando o vendedor
//    precisa saber (sem crédito, chave recusada).
import Anthropic from "npm:@anthropic-ai/sdk@0.128.0";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/cors.ts";
import {
  codigoDoMeet,
  type DadosReuniao,
  ESQUEMA_SAIDA,
  interpretarSaida,
  janelaDasMinhas,
  ehRuido,
  emFechamento,
  lerRespostaLuna,
  repetida,
  limparFalas,
  MOTORES_SESSAO,
  pedidoLuna,
  limparDicasDadas,
  limparTurnos,
  maisProximaDeAgora,
  montarContexto,
  montarPedido,
  type DicaParaUso,
  ESQUEMA_USO,
  type FalaParaUso,
  lerUso,
  limparEventos,
  montarPedidoUso,
  PROMPT_USO,
} from "./logica.ts";
import { PROMPT_BASE, SEM_REUNIAO } from "./prompt.ts";
import { MAX_MENSAGENS, type Mensagem, montarEntradaResumo, PROMPT_RESUMO } from "./resumo.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Haiku 5.5 sem raciocínio: a dica só serve se chegar em ~2 s (medido em 13/10/2026:
// 1,52 s para "nada a mostrar", 2,34 s para uma dica). Troca sem deploy de código:
// env COPILOTO_REUNIAO_MODEL. Modelo que não é Haiku não aceita raciocínio desligado.
const MODELO = Deno.env.get("COPILOTO_REUNIAO_MODEL") ?? "claude-haiku-5-5";
const SEM_RACIOCINIO = MODELO.startsWith("claude-haiku");
const PRAZO_IA_MS = 12_000;

// Perguntas ao vivo pela Luna 6 (gpt-6-luna, a mesma do João) desde 14/10/2026, a pedido do
// Gustavo. Mesma chave do agente SDR. O Haiku acima vira a reserva: Luna fora do ar, sem
// chave ou com erro ⇒ a pergunta sai pelo Haiku, sem o vendedor perceber.
// Trocas sem deploy de código: COPILOTO_REUNIAO_PROVEDOR (openai | anthropic),
// COPILOTO_REUNIAO_MODELO_OPENAI e COPILOTO_REUNIAO_ESFORCO_OPENAI (none | low | medium | high).
const PROVEDOR_DICA = Deno.env.get("COPILOTO_REUNIAO_PROVEDOR") ?? "openai";
const MODELO_OPENAI = Deno.env.get("COPILOTO_REUNIAO_MODELO_OPENAI") ?? "gpt-6-luna";
const ESFORCO_OPENAI = Deno.env.get("COPILOTO_REUNIAO_ESFORCO_OPENAI") ?? "low";
const CHAVE_OPENAI = Deno.env.get("AGENTE_SDR_OPENAI_KEY") ?? Deno.env.get("OPENAI_API_KEY") ?? "";

/** Uma pergunta pela Luna (Responses API, saída presa ao mesmo esquema do Haiku). */
async function dicaPelaLuna(contexto: string, pedido: string) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${CHAVE_OPENAI}` },
    signal: AbortSignal.timeout(PRAZO_IA_MS),
    body: JSON.stringify(pedidoLuna({ modelo: MODELO_OPENAI, esforco: ESFORCO_OPENAI, instrucoes: `${PROMPT_BASE}\n\n${contexto}`, pedido })),
  });
  const resposta = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Luna ${r.status}: ${JSON.stringify(resposta?.error ?? resposta).slice(0, 300)}`);
  return lerRespostaLuna(resposta);
}

// Resumo do lead: uma vez por reunião, antes de começar — aqui vale mais acertar que ser
// rápido. Opus 5.5 com esforço baixo; troca pelo secret COPILOTO_REUNIAO_MODELO_RESUMO.
const MODELO_RESUMO = Deno.env.get("COPILOTO_REUNIAO_MODELO_RESUMO") ?? "claude-opus-5-5";
const PRAZO_RESUMO_MS = 50_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAMPOS_REUNIAO =
  "id, lead_id, pos_graduacao_interesse, data_agendamento, status, observacoes, principal_dor_objetivo, local_trabalho, canal_contato, origem";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const admin = () => createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

/** Mesma ordem das outras IAs do sistema: chave cadastrada na tela, depois env. */
async function chaveAnthropic(): Promise<string | null> {
  try {
    const { data } = await admin().from("ai_api_keys").select("api_key")
      .eq("provider", "anthropic").eq("is_active", true)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (data?.api_key) return String(data.api_key);
  } catch { /* cai para o env */ }
  return Deno.env.get("ANTHROPIC_API_KEY") ?? Deno.env.get("AGENTE_SDR_ANTHROPIC_KEY") ?? null;
}

// ── Guardas em memória (por worker; perder ao reciclar não quebra nada) ──────

// Informações da reunião: lidas uma vez e reusadas durante a chamada. Além de poupar o
// banco a cada fala, garante o texto IDÊNTICO que mantém o cache do prompt.
const CONTEXTO_TTL_MS = 10 * 60 * 1000;
const contextos = new Map<string, { texto: string; ate: number }>();

// Teto por pessoa: a extensão já espera a fala fechar, isto só segura um laço com defeito.
const MAX_POR_MINUTO = 40;
const chamadas = new Map<string, number[]>();

function passouDoTeto(userId: string, agora: number): boolean {
  const recentes = (chamadas.get(userId) ?? []).filter((t) => agora - t < 60_000);
  if (recentes.length >= MAX_POR_MINUTO) {
    chamadas.set(userId, recentes);
    return true;
  }
  recentes.push(agora);
  chamadas.set(userId, recentes);
  return false;
}

// ── Informações da reunião ───────────────────────────────────────────────────

async function lerReuniao(sbUsuario: SupabaseClient, agendamentoId: string, comMapa = true): Promise<DadosReuniao | null> {
  const { data: ag } = await sbUsuario.from("agendamentos").select(CAMPOS_REUNIAO).eq("id", agendamentoId).maybeSingle();
  if (!ag) return null;

  const [leadR, anterioresR, cursoR, resumoR] = await Promise.all([
    ag.lead_id
      ? sbUsuario.from("leads")
        .select("nome, profissao, tempo_formacao, cargo, local_trabalho, regiao, curso_interesse, area_interesse, observacoes")
        .eq("id", ag.lead_id).maybeSingle()
      : Promise.resolve({ data: null }),
    ag.lead_id
      ? sbUsuario.from("agendamentos")
        .select("data_agendamento, pos_graduacao_interesse, resultado_reuniao, objecoes_apresentadas, resumo_reuniao, observacoes_resultado")
        .eq("lead_id", ag.lead_id).neq("id", ag.id).not("resultado_reuniao", "is", null)
        .order("data_agendamento", { ascending: false }).limit(3)
      : Promise.resolve({ data: [] }),
    ag.pos_graduacao_interesse && comMapa
      ? admin().from("cursos").select("id").eq("nome", ag.pos_graduacao_interesse).limit(1).maybeSingle()
      : Promise.resolve({ data: null }),
    // só depois de a RLS liberar a reunião (a linha acima veio com o JWT de quem chama)
    admin().from("copiloto_reuniao_resumos").select("resumo").eq("agendamento_id", ag.id).maybeSingle(),
  ]);

  const dados: DadosReuniao = {
    agendamento: ag, lead: leadR.data, anteriores: anterioresR.data ?? [], resumo: resumoR.data?.resumo ?? null,
  };
  const cursoId = cursoR.data?.id;
  if (!cursoId) return dados;

  const { data: mapaPos } = await sbUsuario.from("sdr_carreira_mapa_pos").select("grupo").eq("curso_id", cursoId).limit(1).maybeSingle();
  if (!mapaPos?.grupo) return dados;

  const [ramosR, perguntasR] = await Promise.all([
    sbUsuario.from("sdr_carreira_mapa_ramo").select("ramo, nome, sinais, argumento, ordem").eq("grupo", mapaPos.grupo).eq("ativo", true),
    sbUsuario.from("sdr_carreira_mapa_pergunta").select("ramo, etapa, texto, ordem").eq("grupo", mapaPos.grupo).eq("ativo", true),
  ]);
  dados.mapa = { ramos: ramosR.data ?? [], perguntas: perguntasR.data ?? [] };
  return dados;
}

// ── Ações ────────────────────────────────────────────────────────────────────

async function iniciar(sbUsuario: SupabaseClient, body: Record<string, unknown>) {
  const codigo = codigoDoMeet(body?.meet);
  if (!codigo) return json({ encontrada: false, motivo: "sem_codigo" });

  // Uma semana para cada lado: o mesmo link é reusado (10 códigos repetidos em 30 dias,
  // medido em 13/10/2026), e reunião de meses atrás com o mesmo link não é esta.
  const agora = new Date();
  const semana = 7 * 24 * 60 * 60 * 1000;
  const { data } = await sbUsuario.from("agendamentos")
    .select("id, lead_id, pos_graduacao_interesse, data_agendamento, status")
    .ilike("link_reuniao", `%meet.google.com/${codigo}%`)
    .gte("data_agendamento", new Date(agora.getTime() - semana).toISOString())
    .lte("data_agendamento", new Date(agora.getTime() + semana).toISOString())
    .order("data_agendamento", { ascending: false }).limit(20);
  const reuniao = maisProximaDeAgora(data ?? [], agora);
  if (!reuniao) return json({ encontrada: false, motivo: "sem_reuniao" });

  const { data: lead } = reuniao.lead_id
    ? await sbUsuario.from("leads").select("nome").eq("id", reuniao.lead_id).maybeSingle()
    : { data: null };
  return json({
    encontrada: true,
    agendamento_id: reuniao.id,
    lead: lead?.nome ?? null,
    pos: reuniao.pos_graduacao_interesse ?? null,
    quando: reuniao.data_agendamento,
  });
}

async function preparar(sbUsuario: SupabaseClient, userId: string, body: Record<string, unknown>) {
  const agendamentoId = typeof body?.agendamento_id === "string" && UUID.test(body.agendamento_id) ? body.agendamento_id : null;
  if (!agendamentoId) return json({ erro: "reunião inválida" }, 422);

  // RLS: só segue se quem chama pode ver a reunião
  const dados = await lerReuniao(sbUsuario, agendamentoId, false);
  if (!dados) return json({ erro: "Não achei essa reunião, ou ela não é sua." }, 422);
  const leadId = (dados.agendamento as { lead_id?: string }).lead_id ?? null;

  const [guardadoR, mensagensR, analiseR] = await Promise.all([
    admin().from("copiloto_reuniao_resumos").select("resumo, mensagens_ate, gerado_em").eq("agendamento_id", agendamentoId).maybeSingle(),
    leadId
      ? admin().from("crm_whatsapp_messages")
        .select("direcao, tipo, conteudo, template_name, created_at, audio:metadata->>audio_transcricao, audio_sdr:metadata->>sdr_audio_transcricao")
        .eq("lead_id", leadId).order("created_at", { ascending: false }).limit(MAX_MENSAGENS)
      : Promise.resolve({ data: [] }),
    admin().from("mimosa_analises").select("conteudo_markdown")
      .eq("agendamento_id", agendamentoId).eq("tipo", "pre_reuniao").neq("status", "descartada")
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const mensagens = (mensagensR.data ?? []) as Mensagem[];
  const ultima = mensagens[0]?.created_at ?? null; // veio da mais nova para a mais antiga
  const guardado = guardadoR.data;

  // já resumido e nenhuma mensagem nova desde então: devolve o que tem
  if (guardado && (!ultima || (guardado.mensagens_ate && new Date(guardado.mensagens_ate) >= new Date(ultima)))) {
    return json({ resumo: guardado.resumo, gerado_em: guardado.gerado_em, novo: false });
  }

  const chave = await chaveAnthropic();
  if (!chave) return json({ erro: "IA sem chave configurada. Avise o TI." }, 422);

  const entrada = montarEntradaResumo({
    contexto: montarContexto({ ...dados, resumo: null }),
    analisePreReuniao: analiseR.data?.conteudo_markdown ?? null,
    mensagens,
  });

  const cliente = new Anthropic({ apiKey: chave, maxRetries: 1, timeout: PRAZO_RESUMO_MS });
  const comFallback = MODELO_RESUMO.startsWith("claude-opus-5") || MODELO_RESUMO.startsWith("claude-fable");
  let resumo: string | undefined;
  try {
    const resposta = await cliente.beta.messages.create({
      model: MODELO_RESUMO,
      max_tokens: 4000,
      output_config: { effort: "low" },
      ...(comFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
      system: PROMPT_RESUMO,
      messages: [{ role: "user", content: entrada }],
    } as never) as Anthropic.Beta.BetaMessage;
    if (resposta.stop_reason !== "refusal") {
      resumo = resposta.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
    }
    console.log(JSON.stringify({
      fn: "copiloto-reuniao", acao: "preparar", agendamento: agendamentoId, mensagens: mensagens.length,
      entrada: resposta.usage.input_tokens, saida: resposta.usage.output_tokens, modelo: resposta.model,
    }));
  } catch (e) {
    console.error("[copiloto-reuniao] resumo", (e as Error)?.message);
  }
  // falhou agora, mas havia um resumo antigo: melhor ele que nada
  if (!resumo) {
    return guardado
      ? json({ resumo: guardado.resumo, gerado_em: guardado.gerado_em, novo: false, aviso: "Não consegui atualizar o resumo; este é o anterior." })
      : json({ erro: "Não consegui preparar o resumo do lead agora. As perguntas seguem funcionando." }, 422);
  }

  const agora = new Date().toISOString();
  const { error } = await admin().from("copiloto_reuniao_resumos").upsert({
    agendamento_id: agendamentoId, lead_id: leadId, resumo, mensagens_usadas: mensagens.length,
    mensagens_ate: ultima, modelo: MODELO_RESUMO, gerado_por: userId, gerado_em: agora,
  });
  if (error) console.error("[copiloto-reuniao] gravar resumo", error.message);
  // o contexto das perguntas guardado em memória ficou velho: o próximo pedido relê com o resumo
  for (const k of contextos.keys()) if (k.endsWith(`:${agendamentoId}`)) contextos.delete(k);
  return json({ resumo, gerado_em: agora, novo: true });
}

async function minhas(sbUsuario: SupabaseClient, userId: string) {
  // Filtro explícito por vendedor_id: a RLS deixa diretor e coordenador verem TODAS as
  // reuniões, e a lista é "as que eu vou conduzir".
  const { de, ate } = janelaDasMinhas(new Date());
  const { data } = await sbUsuario.from("agendamentos")
    .select("id, lead_id, pos_graduacao_interesse, data_agendamento, status")
    .eq("vendedor_id", userId).neq("status", "cancelado")
    .gte("data_agendamento", de).lte("data_agendamento", ate)
    .order("data_agendamento", { ascending: true }).limit(20);
  const reunioes = data ?? [];
  const idsLead = [...new Set(reunioes.map((r) => r.lead_id).filter(Boolean))];
  const { data: leads } = idsLead.length
    ? await sbUsuario.from("leads").select("id, nome").in("id", idsLead)
    : { data: [] };
  const nomes = new Map((leads ?? []).map((l: { id: string; nome: string | null }) => [l.id, l.nome]));
  return json({
    reunioes: reunioes.map((r) => ({
      agendamento_id: r.id,
      lead: nomes.get(r.lead_id) ?? null,
      pos: r.pos_graduacao_interesse ?? null,
      quando: r.data_agendamento,
    })),
  });
}

// ── Captura (avaliação) ──────────────────────────────────────────────────────

// sessão → dono, para não ir ao banco a cada fala
const donoDaSessao = new Map<string, string>();

/** A sessão existe e é de quem chama? (escrita só na própria sessão) */
async function sessaoDe(userId: string, sessaoId: unknown): Promise<string | null> {
  if (typeof sessaoId !== "string" || !UUID.test(sessaoId)) return null;
  const guardado = donoDaSessao.get(sessaoId);
  if (guardado) return guardado === userId ? sessaoId : null;
  const { data } = await admin().from("copiloto_reuniao_sessoes").select("vendedor_id").eq("id", sessaoId).maybeSingle();
  if (!data) return null;
  donoDaSessao.set(sessaoId, data.vendedor_id);
  return data.vendedor_id === userId ? sessaoId : null;
}

async function sessaoIniciar(sbUsuario: SupabaseClient, userId: string, body: Record<string, unknown>) {
  const motor = (MOTORES_SESSAO as readonly string[]).includes(String(body?.motor)) ? String(body.motor) : "local";
  let agendamentoId: string | null = null;
  if (typeof body?.agendamento_id === "string" && UUID.test(body.agendamento_id)) {
    // RLS: só liga a sessão a uma reunião que quem chama pode ver
    const { data } = await sbUsuario.from("agendamentos").select("id").eq("id", body.agendamento_id).maybeSingle();
    agendamentoId = data?.id ?? null;
  }
  const { data, error } = await admin().from("copiloto_reuniao_sessoes").insert({
    vendedor_id: userId, agendamento_id: agendamentoId, motor,
    app_versao: typeof body?.app_versao === "string" ? body.app_versao.slice(0, 40) : null,
  }).select("id").single();
  if (error || !data) {
    console.error("[copiloto-reuniao] sessão", error?.message);
    return json({ erro: "Não consegui abrir a sessão de captura." }, 422);
  }
  donoDaSessao.set(data.id, userId);
  return json({ sessao_id: data.id });
}

async function registrarFalas(userId: string, body: Record<string, unknown>) {
  const sessaoId = await sessaoDe(userId, body?.sessao_id);
  if (!sessaoId) return json({ erro: "sessão inválida" }, 422);
  const falas = limparFalas(body?.falas);
  if (!falas.length) return json({ gravadas: 0 });
  const { error } = await admin().from("copiloto_reuniao_falas")
    .upsert(falas.map((f) => ({ ...f, sessao_id: sessaoId })), { onConflict: "sessao_id,motor,ordem" });
  if (error) {
    console.error("[copiloto-reuniao] falas", error.message);
    return json({ erro: "Não consegui gravar as falas." }, 422);
  }
  return json({ gravadas: falas.length });
}

async function sessaoEncerrar(userId: string, body: Record<string, unknown>) {
  const sessaoId = await sessaoDe(userId, body?.sessao_id);
  if (!sessaoId) return json({ erro: "sessão inválida" }, 422);
  await admin().from("copiloto_reuniao_sessoes").update({ encerrada_em: new Date().toISOString() }).eq("id", sessaoId);
  // a análise de uso leva alguns segundos: o app não espera por ela
  const analise = analisarUso(sessaoId).catch((e) => console.error("[copiloto-reuniao] análise de uso", (e as Error)?.message));
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime?.waitUntil?.(analise);
  return json({ ok: true });
}

// ── Pergunta usada? ──────────────────────────────────────────────────────────
const MODELO_USO = Deno.env.get("COPILOTO_REUNIAO_MODELO_USO") ?? "claude-haiku-5-5";

/** Marca `usada` em todas as perguntas da sessão (refaz se `forcar`). */
async function analisarUso(sessaoId: string, forcar = false): Promise<{ analisadas: number; usadas: number }> {
  const db = admin();
  const { data: sessao } = await db.from("copiloto_reuniao_sessoes").select("motor").eq("id", sessaoId).maybeSingle();
  if (!sessao) return { analisadas: 0, usadas: 0 };
  let consulta = db.from("copiloto_reuniao_dicas").select("id, texto, criada_em").eq("sessao_id", sessaoId).order("criada_em");
  if (!forcar) consulta = consulta.is("uso_analisado_em", null);
  const { data: dicas } = await consulta;
  if (!dicas?.length) return { analisadas: 0, usadas: 0 };
  const motor = sessao.motor === "nuvem" ? "gemini" : "parakeet";
  const { data: falas } = await db.from("copiloto_reuniao_falas").select("quem, texto, falada_em")
    .eq("sessao_id", sessaoId).eq("motor", motor).order("ordem").limit(3000);
  const agora = new Date().toISOString();
  if (!falas?.some((f) => f.quem === "vendedor")) {
    // sem fala do vendedor não há o que conferir: não usada
    await db.from("copiloto_reuniao_dicas").update({ usada: false, usada_trecho: null, uso_analisado_em: agora }).in("id", dicas.map((d) => d.id));
    return { analisadas: dicas.length, usadas: 0 };
  }
  const chave = await chaveAnthropic();
  if (!chave) throw new Error("sem chave da Anthropic");
  const ia = new Anthropic({ apiKey: chave });
  const r = await ia.messages.create({
    model: MODELO_USO,
    max_tokens: 4000,
    system: PROMPT_USO,
    tools: [{ name: "resultado", description: "Uso de cada pergunta sugerida", input_schema: ESQUEMA_USO as unknown as Anthropic.Tool.InputSchema }],
    tool_choice: { type: "tool", name: "resultado" },
    messages: [{ role: "user", content: montarPedidoUso(dicas as DicaParaUso[], falas as FalaParaUso[]) }],
  });
  const bloco = r.content.find((b) => b.type === "tool_use");
  const uso = lerUso(bloco && "input" in bloco ? bloco.input : null, dicas as DicaParaUso[]);
  let usadas = 0;
  for (const [id, u] of uso) {
    if (u.usada) usadas++;
    await db.from("copiloto_reuniao_dicas").update({ usada: u.usada, usada_trecho: u.trecho, uso_analisado_em: agora }).eq("id", id);
  }
  console.log(JSON.stringify({ fn: "copiloto-reuniao", acao: "analisar_uso", sessao: sessaoId, perguntas: dicas.length, usadas, entrada: r.usage.input_tokens, saida: r.usage.output_tokens }));
  return { analisadas: dicas.length, usadas };
}

/** A tela de avaliação pede a análise de uma sessão que ela pode ver (RLS de quem chama). */
async function analisarUsoPedido(sbUsuario: SupabaseClient, body: Record<string, unknown>) {
  if (typeof body?.sessao_id !== "string" || !UUID.test(body.sessao_id)) return json({ erro: "sessão inválida" }, 422);
  const { data } = await sbUsuario.from("copiloto_reuniao_sessoes").select("id").eq("id", body.sessao_id).maybeSingle();
  if (!data) return json({ erro: "Sessão não encontrada." }, 422);
  try {
    return json(await analisarUso(data.id, body?.forcar === true));
  } catch (e) {
    console.error("[copiloto-reuniao] análise de uso", (e as Error)?.message);
    return json({ erro: "Não consegui analisar agora. Tente de novo em instantes." }, 422);
  }
}

// ── Eventos do app ───────────────────────────────────────────────────────────
async function registrarEventos(userId: string, body: Record<string, unknown>) {
  const eventos = limparEventos(body?.eventos);
  if (!eventos.length) return json({ gravados: 0 });
  const versao = typeof body?.app_versao === "string" ? body.app_versao.slice(0, 40) : null;
  const { error } = await admin().from("copiloto_app_eventos")
    .insert(eventos.map((e) => ({ ...e, vendedor_id: userId, app_versao: versao })));
  if (error) {
    console.error("[copiloto-reuniao] eventos", error.message);
    return json({ erro: "Não consegui gravar os eventos." }, 422);
  }
  return json({ gravados: eventos.length });
}

async function avaliar(userId: string, body: Record<string, unknown>) {
  if (typeof body?.dica_id !== "string" || !UUID.test(body.dica_id) || typeof body?.util !== "boolean") {
    return json({ erro: "avaliação inválida" }, 422);
  }
  const { data } = await admin().from("copiloto_reuniao_dicas").select("sessao_id").eq("id", body.dica_id).maybeSingle();
  if (!data || !(await sessaoDe(userId, data.sessao_id))) return json({ erro: "pergunta não encontrada" }, 422);
  await admin().from("copiloto_reuniao_dicas").update({ util: body.util, avaliada_em: new Date().toISOString() }).eq("id", body.dica_id);
  return json({ ok: true });
}

/** Grava a pergunta mostrada (se o app mandou a sessão) e devolve o id para o 👍/👎. */
async function guardarDica(userId: string, body: Record<string, unknown>, dicaMostrada: { tipo: string; texto: string } | null, modelo: string | undefined, ms: number, falaDoLead: string) {
  if (!dicaMostrada) return null;
  const sessaoId = await sessaoDe(userId, body?.sessao_id).catch(() => null);
  if (!sessaoId) return null;
  const { data, error } = await admin().from("copiloto_reuniao_dicas").insert({
    sessao_id: sessaoId, tipo: dicaMostrada.tipo, texto: dicaMostrada.texto, modelo: modelo ?? null, ms, fala_do_lead: falaDoLead.slice(0, 2000),
  }).select("id").single();
  if (error) console.error("[copiloto-reuniao] gravar pergunta", error.message);
  return data?.id ?? null;
}

// ── Freios (19/10/2026) ──────────────────────────────────────────────────────
// No máximo uma pergunta a cada INTERVALO_MS por reunião, nunca uma parecida com outra já
// mostrada. Em memória do worker: se o worker reciclar, no pior caso sai uma pergunta antes.
const INTERVALO_MS = Number(Deno.env.get("COPILOTO_REUNIAO_INTERVALO_S") ?? "90") * 1000;
// fechou = a reunião já entrou em negociação/fechamento: dali em diante o painel fica calado
// (medido na reunião da Ana: no meio da negociação o assunto muda por um instante e a
// janela das últimas falas deixava passar 5 perguntas)
const mostradas = new Map<string, { em: number; textos: string[]; fechou?: boolean }>();

function chaveDaReuniao(userId: string, body: Record<string, unknown>) {
  const ref = typeof body?.sessao_id === "string" ? body.sessao_id : typeof body?.agendamento_id === "string" ? body.agendamento_id : "avulsa";
  return `${userId}:${ref}`;
}

/** Só passa a pergunta que não repete nenhuma anterior; a que passa marca o relógio. */
function aplicarFreio(chave: string, dicaNova: { tipo: string; texto: string } | null, dadas: string[]) {
  if (!dicaNova) return null;
  const memoria = mostradas.get(chave) ?? { em: 0, textos: [] };
  if (repetida(dicaNova.texto, [...dadas, ...memoria.textos])) return null;
  mostradas.set(chave, { ...memoria, em: Date.now(), textos: [...memoria.textos, dicaNova.texto].slice(-20) });
  return dicaNova;
}

async function dica(sbUsuario: SupabaseClient, userId: string, body: Record<string, unknown>) {
  const inicio = Date.now();
  // ruído do transcritor ("Thank you", "Yeah", "hum") nem entra na conversa
  const turnos = limparTurnos(body?.turnos).filter((t) => !ehRuido(t.texto));
  if (!turnos.length || turnos[turnos.length - 1].quem !== "lead") return json({ dica: null });
  // negociação/fechamento: o lead já está comprando, o painel fica quieto
  const chaveFreio = chaveDaReuniao(userId, body);
  const memoriaFreio = mostradas.get(chaveFreio);
  if (memoriaFreio?.fechou) return json({ dica: null, motivo: "fechamento" });
  if (emFechamento(turnos)) {
    mostradas.set(chaveFreio, { em: memoriaFreio?.em ?? 0, textos: memoriaFreio?.textos ?? [], fechou: true });
    return json({ dica: null, motivo: "fechamento" });
  }
  if (inicio - (mostradas.get(chaveFreio)?.em ?? 0) < INTERVALO_MS) return json({ dica: null, motivo: "intervalo" });
  if (passouDoTeto(userId, inicio)) return json({ dica: null, aviso: "Muitas falas seguidas: segurando as dicas por um minuto." });

  const agendamentoId = typeof body?.agendamento_id === "string" && UUID.test(body.agendamento_id) ? body.agendamento_id : null;
  let contexto = SEM_REUNIAO;
  if (agendamentoId) {
    const chaveCache = `${userId}:${agendamentoId}`;
    const guardado = contextos.get(chaveCache);
    if (guardado && guardado.ate > inicio) {
      contexto = guardado.texto;
    } else {
      const dados = await lerReuniao(sbUsuario, agendamentoId);
      if (!dados) return json({ erro: "Não achei essa reunião, ou ela não é sua." }, 422);
      contexto = montarContexto(dados);
      contextos.set(chaveCache, { texto: contexto, ate: inicio + CONTEXTO_TTL_MS });
    }
  }

  const dadas = limparDicasDadas(body?.dicas_dadas);
  const pedido = montarPedido(turnos, dadas);

  // 1º a Luna 6 (decisão do Gustavo, 14/10/2026); falhou, o Haiku responde no lugar
  if (PROVEDOR_DICA === "openai" && CHAVE_OPENAI) {
    try {
      const r = await dicaPelaLuna(contexto, pedido);
      const ms = Date.now() - inicio;
      console.log(JSON.stringify({
        fn: "copiloto-reuniao", usuario: userId, agendamento: agendamentoId, ms, mostrou: !!r.dica, modelo: r.modelo,
        entrada: r.uso.entrada, cache_lido: r.uso.cacheLido, saida: r.uso.saida, raciocinio: r.uso.raciocinio,
      }));
      const final = aplicarFreio(chaveFreio, r.dica, dadas);
      const dicaId = await guardarDica(userId, body, final, r.modelo, ms, turnos[turnos.length - 1].texto);
      return json({ dica: final, ms, modelo: r.modelo, dica_id: dicaId });
    } catch (e) {
      console.error("[copiloto-reuniao] luna, indo para o haiku", (e as Error)?.message);
    }
  }

  const chave = await chaveAnthropic();
  if (!chave) return json({ dica: null, aviso: "IA sem chave configurada. Avise o TI." });

  const cliente = new Anthropic({ apiKey: chave, maxRetries: 0, timeout: PRAZO_IA_MS });
  try {
    const resposta = await cliente.messages.create({
      model: MODELO,
      max_tokens: SEM_RACIOCINIO ? 400 : 4000,
      ...(SEM_RACIOCINIO ? { thinking: { type: "disabled" } } : {}),
      output_config: { effort: "low", format: { type: "json_schema", schema: ESQUEMA_SAIDA } },
      system: [
        { type: "text", text: PROMPT_BASE },
        { type: "text", text: contexto, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: pedido }],
    } as never) as Anthropic.Message;

    const texto = resposta.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
    const saida = resposta.stop_reason === "refusal" ? null : interpretarSaida(texto);
    const ms = Date.now() - inicio;
    console.log(JSON.stringify({
      fn: "copiloto-reuniao", usuario: userId, agendamento: agendamentoId, ms, mostrou: !!saida,
      entrada: resposta.usage.input_tokens, cache_lido: resposta.usage.cache_read_input_tokens,
      cache_escrito: resposta.usage.cache_creation_input_tokens, saida: resposta.usage.output_tokens, modelo: resposta.model,
    }));
    const final = aplicarFreio(chaveFreio, saida, dadas);
    const dicaId = await guardarDica(userId, body, final, resposta.model, ms, turnos[turnos.length - 1].texto);
    return json({ dica: final, ms, modelo: resposta.model, dica_id: dicaId });
  } catch (e) {
    console.error("[copiloto-reuniao] ia", (e as Error)?.message);
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      return json({ dica: null, aviso: "A chave da IA foi recusada. Avise o TI." });
    }
    if (e instanceof Anthropic.BadRequestError && /credit balance/i.test(e.message)) {
      return json({ dica: null, aviso: "A IA está sem créditos. Avise o TI." });
    }
    // lentidão, sobrecarga ou queda: dica atrasada não serve, o painel só fica calado
    return json({ dica: null });
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ erro: "método não suportado" }, 405);

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ erro: "não autenticado" }, 401);
  const sbUsuario = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const { data: userData } = await sbUsuario.auth.getUser();
  const user = userData?.user;
  if (!user) return json({ erro: "Sua sessão expirou. Entre de novo no copiloto." }, 401);

  const body = await req.json().catch(() => ({}));
  try {
    if (body?.acao === "iniciar") return await iniciar(sbUsuario, body);
    if (body?.acao === "dica") return await dica(sbUsuario, user.id, body);
    if (body?.acao === "minhas") return await minhas(sbUsuario, user.id);
    if (body?.acao === "preparar") return await preparar(sbUsuario, user.id, body);
    if (body?.acao === "sessao_iniciar") return await sessaoIniciar(sbUsuario, user.id, body);
    if (body?.acao === "falas") return await registrarFalas(user.id, body);
    if (body?.acao === "sessao_encerrar") return await sessaoEncerrar(user.id, body);
    if (body?.acao === "avaliar") return await avaliar(user.id, body);
    if (body?.acao === "analisar_uso") return await analisarUsoPedido(sbUsuario, body);
    if (body?.acao === "evento") return await registrarEventos(user.id, body);
    return json({ erro: "ação desconhecida" }, 422);
  } catch (e) {
    console.error("[copiloto-reuniao] erro", (e as Error)?.message);
    return json({ erro: "Não consegui atender agora." }, 422);
  }
});
