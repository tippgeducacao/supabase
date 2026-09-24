// ig-agente — o João no DIRECT DO INSTAGRAM (FASE DE TESTE, 24/09/2026)
// ----------------------------------------------------------------------------
// Quem chama: o ig-webhook, com service_role, em dois eventos:
//   inbound  DM de alguém que passou no gate (ig_agente_config + ig_contas + @ do teste)
//   echo     mensagem NOSSA numa conversa em que a IA já está. Se não foi a IA que
//            mandou, foi alguém do time pelo app do Instagram: a IA pausa ali.
//
// O cérebro é o do chat do site (crm-webchat/agente.ts → responderWebchat, canal
// 'instagram'), SEMPRE em modo teste: consulta de verdade (horários, cursos, objeções),
// mas agendamento, cronograma, dados do lead e pausa são SIMULADOS. Nada entra no CRM,
// na agenda de um monitor nem no WhatsApp de ninguém.
//
// Uma DM, do começo ao fim (o "canvas"):
//   gate → token → "/reset"? → espera N s de silêncio → reserva a conversa (trava) →
//   histórico das últimas 24 h → João → balões pela API do Instagram → libera a trava
//   (cursor + estágio + tools) → chegou mensagem nova no meio? repete.
//
// Responde 200 na hora e trabalha em background (EdgeRuntime.waitUntil), como o
// crm-agente-sdr. Deploy por git push (deploy-edges.yml). Mapa: docs/Instagram (IA + Chat).md
// ----------------------------------------------------------------------------
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { responderWebchat, type WebchatToolChamada } from "../crm-webchat/agente.ts";
import { avaliarGateIg } from "../_shared/igAgenteGate.ts";
import { dividirPorBytes, ehTokenInvalido, enviarTextoIg, type ResultadoEnvioIg } from "../_shared/igMensageria.ts";
import {
  atrasoEntreBaloesMs,
  inicioDaJanela,
  type LinhaIg,
  montarHistoricoIg,
  telefoneTesteIg,
  ultimaElegibilidadeTeste,
} from "./historico.ts";

declare const EdgeRuntime: { waitUntil?: (p: Promise<unknown>) => void } | undefined;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

const TTL_RESERVA_S = 150;
/** Quantas levas uma execução responde em sequência (mensagem nova chegando no meio). */
const MAX_RODADAS = 4;
/** Outra execução respondendo esta conversa: espera ela terminar (~60 s no total). */
const ESPERA_OCUPADA_MS = 3_000;
const TENTATIVAS_OCUPADA = 20;
/** O eco pode chegar antes de gravarmos o envio da IA: dá tempo para a gravação. */
const ESPERA_ECO_MS = 4_000;
const COMANDO_RESET = "/reset";
const DESCULPA = "Desculpa, tive um problema aqui e não consegui responder. Pode mandar de novo? 🙏";

const dormir = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function log(...partes: unknown[]) {
  console.log("[ig-agente]", ...partes);
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

type Conversa = {
  contaId: string;
  igsid: string;
  igUserId: string;
  token: string;
  nome: string;
};

type Reserva = {
  status: string;
  ultimo_inbound_em?: string;
  estagio?: string;
  historico_desde?: string | null;
  teste_tool_chamadas?: unknown;
};

// ── Gate: a mesma régua do ig-webhook, conferida de novo antes de falar ─────────
async function abrirConversa(
  contaId: string,
  igsid: string,
): Promise<{ conversa: Conversa; debounceS: number } | { motivo: string }> {
  const [{ data: cfg }, { data: conta }, { data: perfil }, { data: segredo }] = await Promise.all([
    supabase.from("ig_agente_config").select("modo, usernames_teste, debounce_segundos").eq("id", 1).maybeSingle(),
    supabase.from("ig_contas").select("ig_user_id, ativo, agente_ia_ativo").eq("id", contaId).maybeSingle(),
    supabase.from("ig_perfis").select("username, nome").eq("igsid", igsid).maybeSingle(),
    supabase.from("ig_contas_secrets").select("access_token").eq("conta_id", contaId).maybeSingle(),
  ]);
  const gate = avaliarGateIg({
    modo: cfg?.modo,
    usernamesTeste: cfg?.usernames_teste,
    contaIaAtiva: conta?.ativo === true && conta?.agente_ia_ativo === true,
    username: perfil?.username,
  });
  if (!gate.liberado) return { motivo: gate.motivo };
  const token = String(segredo?.access_token ?? "");
  if (!token) return { motivo: "sem_token" };
  return {
    conversa: {
      contaId,
      igsid,
      igUserId: String(conta?.ig_user_id ?? ""),
      token,
      nome: String(perfil?.nome || perfil?.username || "").trim(),
    },
    debounceS: Number(cfg?.debounce_segundos ?? 5),
  };
}

// ── Saída: grava o que foi (ou não foi) para o direct ─────────────────────────
async function registrarSaida(c: Conversa, texto: string, envio: ResultadoEnvioIg, metadata: Record<string, unknown>) {
  const base = {
    conta_id: c.contaId,
    ig_user_id: c.igUserId,
    contato_igsid: c.igsid,
    direcao: "outbound",
    tipo: "text",
    conteudo: texto,
  };
  const { error } = envio.ok
    // upsert SEM ignoreDuplicates: se o eco do webhook chegou antes e gravou a mensagem
    // como "humano", esta escrita corrige para a origem certa. É isso que impede a IA de
    // achar que um humano assumiu e se pausar sozinha.
    ? await supabase.from("ig_mensagens").upsert(
      { ...base, mid: envio.mid, status_entrega: "enviado", metadata: { is_echo: false, ...metadata } },
      { onConflict: "mid" },
    )
    : await supabase.from("ig_mensagens").insert(
      { ...base, mid: null, status_entrega: "erro", erro: envio.erro, metadata: { is_echo: false, ...metadata } },
    );
  if (error) log("não gravou a saída:", error.message);
}

async function estaPausada(c: Conversa): Promise<boolean> {
  const { data } = await supabase.from("ig_conversa_ia").select("pausada")
    .eq("conta_id", c.contaId).eq("igsid", c.igsid).maybeSingle();
  return data?.pausada === true;
}

// ── /reset: recomeça o teste do zero (espelho do /excluirdados do WhatsApp) ────
async function zerarConversa(c: Conversa) {
  const agora = new Date().toISOString();
  const { error } = await supabase.from("ig_conversa_ia").upsert({
    conta_id: c.contaId,
    igsid: c.igsid,
    estagio: "validacao",
    pausada: false,
    pausa_motivo: null,
    pausada_em: null,
    historico_desde: agora,
    respondido_ate: agora,
    reserva_token: null,
    reserva_ate: null,
    teste_tool_chamadas: [],
    updated_at: agora,
  }, { onConflict: "conta_id,igsid" });
  if (error) {
    log("reset falhou:", error.message);
    return;
  }
  const texto = "🔄 conversa zerada (modo teste). pode começar de novo.";
  const envio = await enviarTextoIg(c.token, c.igsid, texto);
  await registrarSaida(c, texto, envio, { origem: "sistema", comando: "reset" });
}

// ── Uma rodada: histórico → João → balões → libera a trava ────────────────────
// Devolve false quando não adianta tentar a próxima leva (token da conta morto).
async function responderRodada(c: Conversa, tokenReserva: string, reserva: Reserva): Promise<boolean> {
  const estagioSalvo = reserva.estagio === "qualificador" ? "qualificador" : "validacao";
  let chunks: string[] = [];
  let estagio: "validacao" | "qualificador" = estagioSalvo;
  let tools: WebchatToolChamada[] = [];
  let erroCerebro: string | null = null;

  try {
    const { data: linhas, error } = await supabase.from("ig_mensagens")
      .select("direcao, tipo, conteudo, created_at")
      .eq("conta_id", c.contaId)
      .eq("contato_igsid", c.igsid)
      .gte("created_at", inicioDaJanela(reserva.historico_desde, new Date()))
      .lte("created_at", String(reserva.ultimo_inbound_em))
      .order("created_at", { ascending: true })
      .limit(200);
    if (error) throw new Error(`histórico: ${error.message}`);
    const resposta = await responderWebchat(
      c.nome,
      telefoneTesteIg(c.igsid),
      null,
      montarHistoricoIg((linhas ?? []) as LinhaIg[]),
      estagioSalvo,
      null,
      "pos",
      true, // SEMPRE teste: agendamento, cronograma e dados do lead são simulados
      null,
      { canal: "instagram", elegibilidadeInicial: ultimaElegibilidadeTeste(reserva.teste_tool_chamadas) },
    );
    chunks = resposta.chunks;
    estagio = resposta.estagio;
    tools = resposta.tools;
  } catch (e) {
    erroCerebro = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    log("o João falhou:", erroCerebro);
    chunks = [DESCULPA];
  }

  const metadata = {
    origem: erroCerebro ? "sistema" : "ia",
    modo_teste: true,
    estagio,
    tools: tools.map((t) => t.nome),
    ...(erroCerebro ? { erro_cerebro: erroCerebro } : {}),
  };
  const baloes = chunks.flatMap((chunk) => dividirPorBytes(chunk));
  let enviados = 0;
  let humanoAssumiu = false;
  let tokenMorto = false;
  for (const balao of baloes) {
    // O humano pode ter respondido pelo app enquanto o João pensava.
    if (await estaPausada(c)) {
      humanoAssumiu = true;
      log("humano assumiu no meio da rodada — parou de enviar", c.igsid);
      break;
    }
    if (enviados > 0) await dormir(atrasoEntreBaloesMs(balao));
    const envio = await enviarTextoIg(c.token, c.igsid, balao);
    await registrarSaida(c, balao, envio, metadata);
    if (!envio.ok) {
      log("envio falhou:", JSON.stringify(envio.erro));
      tokenMorto = ehTokenInvalido(envio.erro);
      break;
    }
    enviados++;
  }

  // O cursor só anda se a rodada resolveu: respondeu, escolheu o silêncio ou o humano
  // assumiu. Envio que falhou deixa a mensagem pendente para a próxima DM tentar de novo.
  const resolveu = baloes.length === 0 || enviados > 0 || humanoAssumiu;
  const { error } = await supabase.rpc("ig_ia_liberar", {
    p_conta_id: c.contaId,
    p_igsid: c.igsid,
    p_token: tokenReserva,
    p_respondido_ate: resolveu ? reserva.ultimo_inbound_em : null,
    p_estagio: estagio,
    p_tools: tools.map((t) => ({ ...t, em: new Date().toISOString() })),
  });
  if (error) log("não liberou a trava:", error.message);
  return resolveu && !tokenMorto;
}

async function reservar(c: Conversa, token: string): Promise<Reserva | null> {
  const { data, error } = await supabase.rpc("ig_ia_reservar", {
    p_conta_id: c.contaId,
    p_igsid: c.igsid,
    p_token: token,
    p_ttl_segundos: TTL_RESERVA_S,
  });
  if (error) {
    log("reserva falhou:", error.message);
    return null;
  }
  return data as Reserva;
}

// Responde o que estiver pendente, em levas, até esvaziar.
async function responderPendentes(c: Conversa) {
  for (let leva = 0; leva < MAX_RODADAS; leva++) {
    const token = crypto.randomUUID();
    let reserva = await reservar(c, token);
    // Outra execução respondendo: ela drena o que chegar, mas esta mensagem pode ter
    // chegado depois da última olhada dela. Esperar e tentar de novo fecha o buraco.
    for (let t = 0; reserva?.status === "ocupada" && t < TENTATIVAS_OCUPADA; t++) {
      await dormir(ESPERA_OCUPADA_MS);
      reserva = await reservar(c, token);
    }
    if (reserva?.status !== "reservada") {
      if (reserva?.status !== "sem_pendencia") log("sem rodada:", reserva?.status ?? "erro", c.igsid);
      return;
    }
    if (!(await responderRodada(c, token, reserva))) return;
  }
}

// ── Eventos ──────────────────────────────────────────────────────────────────
async function tratarInbound(contaId: string, igsid: string, mid: string) {
  const aberta = await abrirConversa(contaId, igsid);
  if ("motivo" in aberta) {
    log("gate fechado:", aberta.motivo, igsid);
    return;
  }
  const { conversa, debounceS } = aberta;

  const { data: gatilho } = await supabase.from("ig_mensagens").select("conteudo").eq("mid", mid).maybeSingle();
  if (String(gatilho?.conteudo ?? "").trim().toLowerCase() === COMANDO_RESET) {
    await zerarConversa(conversa);
    return;
  }

  // Quem manda três mensagens seguidas recebe UMA resposta: se chegou outra depois
  // desta, a execução DELA responde tudo.
  if (debounceS > 0) await dormir(debounceS * 1000);
  const { data: ultima } = await supabase.from("ig_mensagens").select("mid")
    .eq("conta_id", contaId)
    .eq("contato_igsid", igsid)
    .eq("direcao", "inbound")
    .neq("tipo", "reaction")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (ultima?.mid && ultima.mid !== mid) return;

  await responderPendentes(conversa);
}

async function tratarEco(contaId: string, igsid: string, mid: string) {
  await dormir(ESPERA_ECO_MS);
  const { data: msg } = await supabase.from("ig_mensagens").select("metadata").eq("mid", mid).maybeSingle();
  const origem = String(msg?.metadata?.origem ?? "");
  if (origem === "ia" || origem === "sistema") return;
  // Não foi a IA: alguém do time respondeu pelo app. A IA sai da conversa até o /reset
  // (no teste) — nunca fala por cima de um humano.
  const { data } = await supabase.from("ig_conversa_ia")
    .update({ pausada: true, pausa_motivo: "humano_respondeu", pausada_em: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("conta_id", contaId)
    .eq("igsid", igsid)
    .eq("pausada", false)
    .select("igsid");
  if (data?.length) log("humano respondeu pelo app — IA pausada nesta conversa", igsid);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "método não suportado" }, 405);
  const auth = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!SERVICE_ROLE || auth !== SERVICE_ROLE) return json({ error: "não autorizado" }, 401);

  // deno-lint-ignore no-explicit-any
  let body: any = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const evento = String(body?.evento ?? "");
  const contaId = String(body?.conta_id ?? "");
  const igsid = String(body?.igsid ?? "");
  const mid = String(body?.mid ?? "");
  if (!contaId || !igsid || !mid || (evento !== "inbound" && evento !== "echo")) {
    return json({ error: "payload inválido" }, 400);
  }

  const trabalho = (evento === "echo" ? tratarEco(contaId, igsid, mid) : tratarInbound(contaId, igsid, mid))
    .catch((e) => console.error("[ig-agente] falhou:", e instanceof Error ? e.message : String(e)));
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
    EdgeRuntime.waitUntil(trabalho);
  } else {
    await trabalho;
  }
  return json({ ok: true });
});
