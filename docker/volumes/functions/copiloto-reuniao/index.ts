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
  limparDicasDadas,
  limparTurnos,
  maisProximaDeAgora,
  montarContexto,
  montarPedido,
} from "./logica.ts";
import { PROMPT_BASE, SEM_REUNIAO } from "./prompt.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Haiku 5.5 sem raciocínio: a dica só serve se chegar em ~2 s (medido em 13/10/2026:
// 1,52 s para "nada a mostrar", 2,34 s para uma dica). Troca sem deploy de código:
// env COPILOTO_REUNIAO_MODEL. Modelo que não é Haiku não aceita raciocínio desligado.
const MODELO = Deno.env.get("COPILOTO_REUNIAO_MODEL") ?? "claude-haiku-5-5";
const SEM_RACIOCINIO = MODELO.startsWith("claude-haiku");
const PRAZO_IA_MS = 12_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAMPOS_REUNIAO =
  "id, lead_id, pos_graduacao_interesse, data_agendamento, status, observacoes, principal_dor_objetivo, local_trabalho, canal_contato";

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

async function lerReuniao(sbUsuario: SupabaseClient, agendamentoId: string): Promise<DadosReuniao | null> {
  const { data: ag } = await sbUsuario.from("agendamentos").select(CAMPOS_REUNIAO).eq("id", agendamentoId).maybeSingle();
  if (!ag) return null;

  const [leadR, anterioresR, cursoR] = await Promise.all([
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
    ag.pos_graduacao_interesse
      ? admin().from("cursos").select("id").eq("nome", ag.pos_graduacao_interesse).limit(1).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const dados: DadosReuniao = { agendamento: ag, lead: leadR.data, anteriores: anterioresR.data ?? [] };
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

async function dica(sbUsuario: SupabaseClient, userId: string, body: Record<string, unknown>) {
  const inicio = Date.now();
  const turnos = limparTurnos(body?.turnos);
  if (!turnos.length || turnos[turnos.length - 1].quem !== "lead") return json({ dica: null });
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
      messages: [{ role: "user", content: montarPedido(turnos, limparDicasDadas(body?.dicas_dadas)) }],
    } as never) as Anthropic.Message;

    const texto = resposta.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
    const saida = resposta.stop_reason === "refusal" ? null : interpretarSaida(texto);
    const ms = Date.now() - inicio;
    console.log(JSON.stringify({
      fn: "copiloto-reuniao", usuario: userId, agendamento: agendamentoId, ms, mostrou: !!saida,
      entrada: resposta.usage.input_tokens, cache_lido: resposta.usage.cache_read_input_tokens,
      cache_escrito: resposta.usage.cache_creation_input_tokens, saida: resposta.usage.output_tokens,
    }));
    return json({ dica: saida, ms });
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
    return json({ erro: "ação desconhecida" }, 422);
  } catch (e) {
    console.error("[copiloto-reuniao] erro", (e as Error)?.message);
    return json({ erro: "Não consegui atender agora." }, 422);
  }
});
