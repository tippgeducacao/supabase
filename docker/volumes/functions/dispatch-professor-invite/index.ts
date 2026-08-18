// dispatch-professor-invite
// Cron de 30 em 30 min (07h–20h30 de Brasília): processa convites a professores e envia
// WhatsApp via Meta Cloud API. Rodava 1x/dia às 09h — e nessa cadência o marco do LINK DO
// DIA (1h antes da aula) nunca era alcançado no próprio dia. Ver docs/Pedagógico.md.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { resolverCampoProfessor } from "../_shared/pedProfessorCampos.ts";
// Régua da fase 2 (30 → 7 → 1 → dia da aula): módulo PURO, coberto por vitest em
// cadenciaFase2.test.ts. Não reescreva a aritmética aqui dentro.
import {
  buildAulaEndIso,
  buildAulaStartIso,
  dateOnlyToDate,
  daysUntilAula,
  pickNextFase2Marco,
} from "./cadenciaFase2.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_GRAPH = "https://graph.facebook.com/v21.0";
const TZ = "America/Sao_Paulo";

// Limite de convites processados por execução do cron.
// Em modo cron normal: evita que um backlog acumulado dispare tudo de uma vez.
// force_live ignora esse limite (processa só o convite_id passado).
const BATCH_LIMIT = 50;

// Delay entre envios pra respeitar rate limit da Meta.
const SEND_DELAY_MS = 150;

// Advisory lock key (qualquer bigint constante) pra serializar execuções concorrentes.
const ADVISORY_LOCK_KEY = 4283719_001;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STATUSES_DISPATCHABLE = [
  "fase1_titular_aguardando",
  "fase1b_reserva_aguardando",
  "fase2_reconfirmacao_30d",
  "fase2_reconfirmacao_14d",
  "fase2_reconfirmacao_7d",
  "fase2_lembrete_1d",
  "dia_aula_link_enviado",
  "pos_aula_realizada",
] as const;

type ConviteStatus = (typeof STATUSES_DISPATCHABLE)[number];

const STATUS_TO_CADENCIA: Record<string, string> = {
  fase2_reconfirmacao_30d: "lembrete_30d",
  // fase2_reconfirmacao_14d NÃO tem cadência: o toque de 14 dias foi aposentado em
  // 2026-07-16. O status continua em STATUSES_DISPATCHABLE de propósito (ver o ramo
  // "STATUS APOSENTADO" adiante) — sem mapa aqui, nada é enviado; com o status na
  // lista, o convite continua sendo LIDO pelo cron e é remigrado pro marco vivo.
  fase2_reconfirmacao_7d: "lembrete_7d",
  fase2_lembrete_1d: "lembrete_1d",
  dia_aula_link_enviado: "dia_aula_link",
  pos_aula_realizada: "pos_aula_status",
};

const FOLLOWUP_CADENCIAS = [
  "convite_inicial",      // 0
  "followup_dia_2",       // 1
  "followup_dia_4",       // 2
  "followup_dia_6",       // 3
  "followup_dia_8",       // 4
  "followup_dia_10",      // 5
  "followup_dia_12",      // 6
  "followup_dia_14",      // 7
  "agradecemos_negativa", // 8 (último — esgota)
] as const;

const FOLLOWUP_MAX = FOLLOWUP_CADENCIAS.length - 1; // 8

function resolveCadencia(status: string, followupCount: number): string | null {
  if (
    status === "fase1_titular_aguardando" ||
    status === "fase1b_reserva_aguardando"
  ) {
    const idx = Math.min(Math.max(followupCount, 0), FOLLOWUP_MAX);
    return FOLLOWUP_CADENCIAS[idx];
  }
  return STATUS_TO_CADENCIA[status] ?? null;
}

function formatPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  // Número internacional já com DDI (veio com '+', ex.: +1 dos EUA): NÃO force o 55.
  if (trimmed.startsWith("+")) return digits;
  // Já vem com o DDI do Brasil (55 + 10/11 dígitos).
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) return digits;
  // Número brasileiro sem DDI: DDD + 8 dígitos (fixo) ou DDD + 9xxxxxxxx (celular).
  // Celular BR de 11 dígitos SEMPRE tem '9' no 3º dígito — 11 dígitos sem esse 9 é
  // internacional sem DDI (ex.: wa_id dos EUA, 1+10) e NÃO pode ganhar 55.
  if (digits.length === 10 || (digits.length === 11 && digits[2] === "9")) return `55${digits}`;
  // Não reconhecido: devolve os dígitos como estão (não corrompe internacional sem '+').
  return digits;
}

// Variantes ±9º dígito (Brasil) — casa o telefone salvo COM o 9 (cadastro) com o
// wa_id que a Meta entrega SEM o 9. Espelha whatsapp-webhook.phoneVariants / sac_phone_variants.
// Opera sobre os dígitos já formatados (NÃO reaplica o 55 — evita corromper número
// internacional já sem '+', ex.: EUA).
function phoneVariants(raw: string | null | undefined): string[] {
  const n = String(raw ?? "").replace(/\D/g, "");
  if (!n) return [];
  const set = new Set<string>([n]);
  if (n.startsWith("55") && n.length >= 12) {
    const ddd = n.slice(2, 4);
    const rest = n.slice(4);
    if (rest.length === 9 && rest.startsWith("9")) set.add("55" + ddd + rest.slice(1)); // sem 9
    else if (rest.length === 8) set.add("55" + ddd + "9" + rest); // com 9
  }
  return [...set];
}

function firstName(full: string | null | undefined): string {
  if (!full) return "";
  return full.trim().split(/\s+/)[0] ?? "";
}

function formatDatePtBR(date: Date): string {
  // "DD de mês YYYY" em America/Sao_Paulo
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ,
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).formatToParts(date);
  const dd = parts.find((p) => p.type === "day")?.value ?? "";
  const mm = parts.find((p) => p.type === "month")?.value ?? "";
  const yy = parts.find((p) => p.type === "year")?.value ?? "";
  return `${dd} de ${mm} ${yy}`;
}

function nowPlus(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

// Nº de falhas consecutivas de envio antes de PARAR e escalar pra um humano.
const MAX_FALHAS_ENVIO = 3;

// Backoff após falha: MENOR que o período do cron (24h). Com 24h, o proxima_acao_em
// caía alguns segundos DEPOIS do horário da execução seguinte e o convite perdia um
// dia inteiro a cada tentativa.
const BACKOFF_FALHA_MS = 20 * 3600 * 1000;

// Janela do guard anti-repetição: tem que ser MAIOR que o intervalo do cron (24h),
// senão o guard nunca dispara no caso que ele existe para impedir — as repetições
// reais de julho/2026 tinham gap de exatamente 24,00h. 47h cobre o cron diário com
// folga para atraso e ainda deixa passar a cadência de follow-up (a cada 48h).
const JANELA_ANTI_REPETICAO_MS = 47 * 3600 * 1000;

/** Status em que "sem professor" é a semântica real — só neles a escalação pode trocar o status. */
const STATUS_FASE1 = new Set(["fase1_titular_aguardando", "fase1b_reserva_aguardando"]);

/**
 * Falha de envio → backoff; na 3ª consecutiva PARA o convite e escala pra um humano.
 *
 * Antes disso, erro permanente (template com variável quebrada, número inválido)
 * não mexia em proxima_acao_em: o convite continuava vencido e o cron re-tentava
 * TODO DIA para sempre, gravando uma mensagem nova no SAC a cada tentativa.
 *
 * ⚠️ A escalação NUNCA sobrescreve o status de um convite já CONFIRMADO: trocar
 * fase2 / dia_aula_link_enviado / pos_aula_realizada por 'critico_escalacao_manual'
 * apagaria a confirmação do professor (a Fila de Convites voltaria a mostrar a aula
 * como "aguardando") só porque um WhatsApp não saiu. Nesses casos o convite PARA
 * (proxima_acao_em null) com metadata.escalado=true, preservando o estado de negócio.
 */
async function registrarFalhaEnvio(
  supabase: any,
  convite: any,
  motivo: string,
  extra: Record<string, unknown> = {},
): Promise<{ falhas: number; escalado: boolean }> {
  const meta = (convite.metadata as Record<string, unknown>) ?? {};
  const falhas = Number(meta.falhas_envio_consecutivas ?? 0) + 1;
  const escalado = falhas >= MAX_FALHAS_ENVIO;
  const podeTrocarStatus = STATUS_FASE1.has(String(convite.status));

  const { error } = await supabase
    .from("ped_convites")
    .update({
      ...(escalado
        ? {
            proxima_acao_em: null,
            ...(podeTrocarStatus ? { status: "critico_escalacao_manual" } : {}),
          }
        : { proxima_acao_em: nowPlus(BACKOFF_FALHA_MS) }),
      metadata: {
        ...meta,
        falhas_envio_consecutivas: falhas,
        ultima_falha_envio_em: new Date().toISOString(),
        ultima_falha_envio_motivo: motivo,
        // Lido pelo aviso do portal (ped_v2_aviso_disparos_travados_refresh): é o que
        // sinaliza escalação quando o status NÃO pôde ser trocado.
        ...(escalado ? { escalado: true, escalado_em: new Date().toISOString(), escalado_motivo: motivo } : {}),
        ...extra,
      },
    })
    .eq("id", convite.id);

  if (error) console.error(`[dispatch] registrarFalhaEnvio UPDATE falhou convite=${convite.id}: ${error.message}`);

  if (escalado) {
    await supabase.from("ped_convites_eventos").insert({
      convite_id: convite.id,
      aula_id: convite.aula_id,
      tipo: "escalado_falhas_envio",
      ator: "system",
      payload: { falhas, motivo, status_preservado: !podeTrocarStatus, status: convite.status, ...extra },
    });
  }
  return { falhas, escalado };
}

/**
 * GUARD ANTI-REPETIÇÃO — rede de segurança contra o mesmo template sair 2x pro mesmo
 * convite sem o estado ter avançado (foi assim que um professor recebeu a mesma
 * mensagem 5 dias seguidos: o UPDATE de estado falhava calado e o cron re-selecionava
 * o convite todo dia).
 *
 * Conta só ENVIO BEM-SUCEDIDO (`mensagem_enviada`): tentativa que a Meta recusou não
 * entregou nada, e o retry dela é governado pelo backoff/escalação de registrarFalhaEnvio.
 *
 * Fail-CLOSED: se a consulta falhar, assume "já enviado" e não manda — a rede de
 * segurança não pode virar porta aberta por causa de um timeout.
 */
async function envioJaFeitoRecentemente(
  supabase: any,
  conviteId: string,
  templateNome: string,
): Promise<{ bloquear: boolean; motivo?: string }> {
  const desde = new Date(Date.now() - JANELA_ANTI_REPETICAO_MS).toISOString();
  const { data, error } = await supabase
    .from("ped_convites_eventos")
    .select("created_at, payload")
    .eq("convite_id", conviteId)
    .eq("template_name", templateNome)
    .eq("tipo", "mensagem_enviada")
    .gte("created_at", desde)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error(`[dispatch] guard anti-repetição: consulta falhou (${error.message}) → fail-closed`);
    return { bloquear: true, motivo: "consulta_guard_falhou" };
  }
  const ultimo = data?.[0];
  if (!ultimo) return { bloquear: false };
  return { bloquear: true, motivo: `enviado_em_${ultimo.created_at}` };
}

function buildVariableValue(
  varName: string,
  ctx: {
    professor: any;
    aula: any;
    pos: any;
  },
): string {
  // Campos do CADASTRO do professor mapeados no template ("professor.*")
  const doProf = resolverCampoProfessor(varName, ctx.professor);
  if (doProf !== null) return doProf;
  const aulaDate = ctx.aula?.data ? dateOnlyToDate(ctx.aula.data) : null;
  const tomorrow = aulaDate ? new Date(aulaDate) : null;
  switch (varName) {
    case "nome_professor":
      return firstName(ctx.professor?.nome);
    case "instituicao":
      return ctx.pos?.instituicao ?? "";
    case "pos_graduacao":
      return ctx.pos?.nome ?? "";
    case "aula_titulo":
      return ctx.aula?.titulo ?? "";
    case "data":
    case "data_aula":
    case "data_conclusao":
      return aulaDate ? formatDatePtBR(aulaDate) : "";
    case "data_amanha":
      return tomorrow ? formatDatePtBR(tomorrow) : "";
    case "horario":
      // NUNCA vazio: aula sem horário cadastrado zerava o {{n}} e a Meta recusava o
      // template inteiro (131008) — o lembrete de 30d ficou repetindo dias seguidos
      // por causa de UMA aula sem horário. "a combinar" entrega a mensagem.
      return String(ctx.aula?.horario ?? "").trim() || "a combinar";
    case "link_sala_aula":
      // Link da sala (cadastro do CURSO em /pedagogico-v2/cursos), com override por aula
      return String(ctx.aula?.link_sala_override || ctx.pos?.link_sala_meet || "");
    default:
      return "";
  }
}

// ── Consolidação de disparos por PROFESSOR ────────────────────────────────
// Problema: um professor com N aulas na MESMA fase de confirmação recebia N
// mensagens no mesmo dia (uma por convite). A partir daqui, quando um professor
// tem >1 convite de FASE 1 (confirmação inicial) vencendo no mesmo run, enviamos
// UMA mensagem consolidada (template 'convite_semestre_lote', que lista as aulas
// e cujo botão "Confirmo todas as datas" o webhook já resolve confirmando todas).
// O caminho individual (fase2 lembretes 30/14/7/1d, link do dia, pós-aula) segue
// intacto — essas cadências dependem da DATA de cada aula e não geram o spam.
const FASE1_CONSOLIDAVEL = new Set([
  "fase1_titular_aguardando",
  "fase1b_reserva_aguardando",
]);

// "DD/MM/YYYY" em SP — item da lista consolidada de aulas.
function formatDataCurta(dataYmd: string | null | undefined): string {
  if (!dataYmd) return "";
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric",
  }).formatToParts(dateOnlyToDate(dataYmd));
  const dd = parts.find((p) => p.type === "day")?.value ?? "";
  const mm = parts.find((p) => p.type === "month")?.value ?? "";
  const yy = parts.find((p) => p.type === "year")?.value ?? "";
  return `${dd}/${mm}/${yy}`;
}

// Meta rejeita quebra de linha / tab / 4+ espaços em PARÂMETRO de template (132000).
function sanitizeWaParam(s: string | null | undefined): string {
  return (s ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim();
}

// Avanço de estado da FASE 1 (titular/reserva). Extraído do loop individual SEM
// mudança de comportamento — usado pelo caminho CONSOLIDADO (o individual mantém
// a lógica inline própria, para zero regressão no caso de 1 aula).
function computeFase1Update(convite: any, aula: any): Record<string, any> {
  const update: Record<string, any> = { ultima_mensagem_enviada_em: new Date().toISOString() };
  const fc = convite.followup_count ?? 0;
  const status = convite.status;
  if (status === "fase1_titular_aguardando") {
    const nextFc = fc + 1;
    if (fc >= FOLLOWUP_MAX) {
      if (convite.papel === "titular" && aula?.professor_reserva_id) {
        update.status = "fase1b_reserva_aguardando";
        update.professor_atual_id = aula.professor_reserva_id;
        update.followup_count = 0;
        update.proxima_acao_em = new Date().toISOString();
        update.papel = "reserva";
        update.decisao_fase1_em = new Date().toISOString();
      } else {
        update.status = "esgotado_sem_titular";
        update.followup_count = nextFc;
        update.proxima_acao_em = null;
        update.decisao_fase1_em = new Date().toISOString();
      }
    } else {
      update.followup_count = nextFc;
      update.proxima_acao_em = nowPlus(2 * 24 * 3600 * 1000);
    }
  } else if (status === "fase1b_reserva_aguardando") {
    const nextFc = fc + 1;
    if (fc >= FOLLOWUP_MAX) {
      update.status = "esgotado_sem_titular_nem_reserva";
      update.followup_count = nextFc;
      update.proxima_acao_em = null;
      update.decisao_fase1b_em = new Date().toISOString();
    } else {
      update.followup_count = nextFc;
      update.proxima_acao_em = nowPlus(2 * 24 * 3600 * 1000);
    }
  }
  return update;
}

function getMeetSlug(aula: any, pos: any): string {
  const override = aula?.link_sala_override as string | null | undefined;
  const base = override || pos?.link_sala_meet || "";
  if (!base) return "";
  // Extrai slug do final da URL
  try {
    const url = new URL(base);
    const parts = url.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? base;
  } catch {
    const parts = base.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? base;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  const details: any[] = [];
  let processed = 0;
  let sent = 0;
  let errors = 0;

  // Body opcional: { force_live?: boolean, convite_id?: string }
  // Quando force_live=true, ignora dispatch_mode='off' e processa apenas o convite_id passado.
  let forceLive = false;
  let onlyConviteId: string | null = null;
  try {
    if (req.method === "POST") {
      const ct = (req.headers.get("content-type") ?? "").toLowerCase();
      if (ct.includes("application/json")) {
        const body = await req.json().catch(() => ({}));
        forceLive = Boolean(body?.force_live);
        if (typeof body?.convite_id === "string") onlyConviteId = body.convite_id;
      }
    }
  } catch (_) { /* ignore */ }

  try {
    // 1) dispatch_mode
    const { data: cfgRow } = await supabase
      .from("ped_configuracoes")
      .select("valor")
      .eq("chave", "dispatch_mode")
      .maybeSingle();
    const configuredMode = (cfgRow?.valor ?? "off").toLowerCase();
    const mode = forceLive ? "live" : configuredMode;

    if (mode === "off") {
      return new Response(
        JSON.stringify({ success: true, mode, processed: 0, sent: 0, errors: 0, details: [] }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 1.5) Advisory lock: garante que só UMA execução do cron roda por vez.
    // Se outra instância já está rodando, esta sai sem fazer nada.
    // force_live (aprovação manual de 1 convite específico) ignora o lock.
    if (!forceLive) {
      const { data: gotLock } = await supabase.rpc("ped_dispatch_try_lock");
      if (gotLock === false) {
        return new Response(
          JSON.stringify({ success: true, mode, processed: 0, sent: 0, errors: 0, details: [], skipped: "lock_busy" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // 2) WA account
    const { data: waRow, error: waErr } = await supabase.rpc("get_wa_account_pedagogico");
    if (waErr || !waRow) throw new Error(`get_wa_account_pedagogico: ${waErr?.message ?? "vazio"}`);
    const waAccount = Array.isArray(waRow) ? waRow[0] : waRow;
    const phoneNumberId = waAccount?.phone_number_id;
    const accessToken = waAccount?.access_token;
    if (!phoneNumberId || !accessToken) throw new Error("WA account incompleto");

    // 3) convites elegíveis (com LIMIT pra não cuspir backlog inteiro de uma vez)
    const nowIso = new Date().toISOString();
    let convitesQuery = supabase
      .from("ped_convites")
      .select("*")
      .lte("proxima_acao_em", nowIso)
      .in("status", STATUSES_DISPATCHABLE as unknown as string[])
      .order("proxima_acao_em", { ascending: true })
      .limit(BATCH_LIMIT);

    if (onlyConviteId) {
      convitesQuery = supabase
        .from("ped_convites")
        .select("*")
        .eq("id", onlyConviteId)
        .in("status", STATUSES_DISPATCHABLE as unknown as string[]);
    }

    const { data: convites, error: cErr } = await convitesQuery;
    if (cErr) throw cErr;

    // ── SPLIT: agrupa convites de FASE 1 do mesmo professor (mesmo status) que
    // vencem neste run; o resto segue individual. Grupo com >1 aula → 1 mensagem
    // consolidada. force_live (1 convite) cai naturalmente em `individuais`.
    const gruposFase1 = new Map<string, any[]>();
    const individuais: any[] = [];
    for (const c of convites ?? []) {
      if (FASE1_CONSOLIDAVEL.has(c.status) && c.professor_atual_id) {
        const key = `${c.professor_atual_id}|${c.status}`;
        const arr = gruposFase1.get(key) ?? [];
        arr.push(c);
        gruposFase1.set(key, arr);
      } else {
        individuais.push(c);
      }
    }

    // Template plural (já aprovado e com botão "Confirmo todas as datas" tratado
    // pelo webhook via metadata.disparo_inicial_lote). Sem ele → cai no individual.
    const { data: loteTpl } = await supabase
      .from("ped_wa_templates")
      .select("*")
      .eq("uso_cadencia", "convite_semestre_lote")
      .eq("status", "aprovado")
      .eq("ativo", true)
      .maybeSingle();

    for (const [key, grupoRaw] of gruposFase1.entries()) {
      // grupos de 1 aula, ou sem template de lote → processa individualmente.
      if (grupoRaw.length < 2 || !loteTpl) {
        individuais.push(...grupoRaw);
        continue;
      }

      // Carrega as aulas do grupo; filtra as MUITO ANTIGAS (>7d passadas) — mesma
      // guarda do caminho individual (marca 2099 pra nunca reprocessar).
      const grupo: any[] = [];
      let profId = grupoRaw[0].professor_atual_id;
      for (const c of grupoRaw) {
        const { data: aula } = await supabase
          .from("ped_aulas")
          .select("id,data,horario,titulo,pos_graduacao_id,professor_reserva_id")
          .eq("id", c.aula_id)
          .maybeSingle();
        if (!aula) { individuais.push(c); continue; }
        const diasDesde = -daysUntilAula(aula.data);
        if (diasDesde > 7) {
          await supabase.from("ped_convites").update({
            proxima_acao_em: "2099-12-31T23:59:59Z",
            metadata: { ...((c.metadata as Record<string, unknown>) ?? {}), pulado_por_aula_antiga: true, pulado_em: new Date().toISOString(), pulado_dias_desde_aula: diasDesde },
          }).eq("id", c.id);
          processed++;
          details.push({ convite_id: c.id, status: c.status, skipped: "aula_muito_antiga", dias_desde_aula: diasDesde });
          continue;
        }
        c.__aula = aula;
        grupo.push(c);
      }
      // Depois do filtro: sobrou 1 (ou 0) → individual (o single tem template com escalonamento).
      if (grupo.length < 2) { individuais.push(...grupo); continue; }

      // GUARD ANTI-REPETIÇÃO também no caminho CONSOLIDADO — é por aqui que a fase 1
      // dispara na prática (professor com 2+ aulas), e sem o guard uma falha de estado
      // aqui reenviaria o lote todo dia, com a Meta ACEITANDO (spam entregue de verdade).
      if (!forceLive) {
        const bloqueados: any[] = [];
        for (const c of grupo) {
          const g = await envioJaFeitoRecentemente(supabase, c.id, loteTpl.nome);
          if (g.bloquear) bloqueados.push({ c, motivo: g.motivo });
        }
        if (bloqueados.length === grupo.length) {
          console.log(`[dispatch] ANTI-REPETIÇÃO lote grupo=${key} já disparado → pulando`);
          for (const b of bloqueados) {
            await supabase.from("ped_convites_eventos").insert({
              convite_id: b.c.id,
              aula_id: b.c.aula_id,
              tipo: "envio_repetido_bloqueado",
              template_name: loteTpl.nome,
              ator: "system",
              payload: { modo: "consolidado_fase1", status: b.c.status, motivo: b.motivo },
            });
            await supabase.from("ped_convites")
              .update({ proxima_acao_em: nowPlus(BACKOFF_FALHA_MS) })
              .eq("id", b.c.id);
          }
          processed += grupo.length;
          details.push({ grupo: key, consolidado: true, skipped: "envio_repetido_bloqueado", aulas: grupo.length });
          continue;
        }
      }

      processed += grupo.length;
      const detailG: any = { grupo: key, professor_id: profId, aulas: grupo.length, consolidado: true };
      try {
        const { data: professor } = await supabase
          .from("ped_professores").select("id,nome,contato_whatsapp").eq("id", profId).maybeSingle();
        if (!professor) throw new Error("professor não encontrado");
        const to = formatPhone(professor.contato_whatsapp);
        if (!to) throw new Error("whatsapp do professor inválido");

        // Lista INLINE (Meta rejeita \n em parâmetro): "Título — DD/MM/YYYY  •  ..."
        const aulasOrd = [...grupo].sort((a, b) => (a.__aula?.data ?? "").localeCompare(b.__aula?.data ?? ""));
        const listaAulas = sanitizeWaParam(
          aulasOrd.map((c) => `${(c.__aula?.titulo ?? "aula").trim()} — ${formatDataCurta(c.__aula?.data)}`).join("   •   ")
        );

        // {{1}}=primeiro nome, {{2}}=lista de aulas (mapeamento do convite_semestre_lote)
        const components = [{
          type: "body",
          parameters: [
            { type: "text", text: sanitizeWaParam(firstName(professor.nome)) },
            { type: "text", text: listaAulas },
          ],
        }];
        const wapayload = {
          messaging_product: "whatsapp", to, type: "template",
          template: { name: loteTpl.nome, language: { code: loteTpl.idioma || "pt_BR" }, components },
        };

        const r = await fetch(`${META_GRAPH}/${phoneNumberId}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(wapayload),
        });
        const waResp = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(waResp?.error?.message ?? `Meta API ${r.status}`);
        const waMsgId = waResp?.messages?.[0]?.id ?? null;

        // Corpo renderizado p/ persistir (uma mensagem no SAC cobrindo o lote).
        let corpoRender = String(loteTpl.corpo ?? "");
        corpoRender = corpoRender.split("{{1}}").join(firstName(professor.nome)).split("{{2}}").join(listaAulas);
        const nowIso2 = new Date().toISOString();

        // Persiste UMA mensagem outbound na conversa do professor (variantes ±9º dígito).
        let conversaId: string | null = null;
        for (const tel of phoneVariants(to)) {
          const { data } = await supabase.from("ped_conversas_avulsas").select("id")
            .contains("metadata", { telefone: tel }).order("ultima_atividade_em", { ascending: false }).limit(1);
          if (data?.[0]?.id) { conversaId = data[0].id; break; }
        }
        if (conversaId) {
          await supabase.from("ped_conversas_avulsas").update({ ultima_atividade_em: nowIso2 }).eq("id", conversaId);
        } else {
          const { data: novaConv } = await supabase.from("ped_conversas_avulsas").insert({
            tipo: "outbound_template", assunto: loteTpl.nome, professores_alvo: [profId], status: "enviada",
            primeira_mensagem_em: nowIso2, ultima_atividade_em: nowIso2,
            metadata: { telefone: to, profile_name: professor.nome, prof_id: profId },
          }).select("id").single();
          conversaId = novaConv?.id ?? null;
        }
        if (conversaId) {
          await supabase.from("ped_conversas_mensagens").insert({
            conversa_id: conversaId, direcao: "outbound", conteudo: corpoRender,
            template_name: loteTpl.nome, professor_id: profId, wa_message_id: waMsgId,
            enviada_em: nowIso2, status_envio: "enviada",
          });
          // SAC: garante 1 atendimento por contato (mesma lógica do batch)
          try {
            const { data: contatosMatch } = await supabase.from("sac_contatos")
              .select("id, tipo").in("telefone", phoneVariants(to)).limit(1);
            let contatoId = contatosMatch?.[0]?.id ?? null;
            if (contatoId) {
              await supabase.from("sac_contatos").update({ tipo: "professor", professor_id_ref: profId }).eq("id", contatoId);
            } else {
              const { data: novoContato } = await supabase.from("sac_contatos")
                .insert({ nome: professor.nome, telefone: to, tipo: "professor", professor_id_ref: profId }).select("id").single();
              contatoId = novoContato?.id ?? null;
            }
            if (contatoId) {
              const { data: atendAberto } = await supabase.from("sac_atendimentos")
                .select("id, status").eq("contato_id", contatoId).maybeSingle();
              const { data: funilRow } = await supabase.from("sac_funis").select("id").order("created_at", { ascending: true }).limit(1).maybeSingle();
              const funilId = funilRow?.id;
              let etapaInicialId: string | null = null;
              if (funilId) {
                const { data: etapaRow } = await supabase.from("sac_funis_etapas").select("id")
                  .eq("funil_id", funilId).eq("comportamento_entrada", "auto_template_enviado").eq("ativo", true)
                  .order("ordem", { ascending: true }).limit(1).maybeSingle();
                etapaInicialId = etapaRow?.id ?? null;
              }
              if (atendAberto?.id) {
                await supabase.from("sac_atendimentos").update({
                  ped_conversa_id_legacy: conversaId, ultima_mensagem_preview: corpoRender.slice(0, 140), ultima_mensagem_em: nowIso2,
                  ...(atendAberto.status !== "ativo" ? { status: "ativo", resolvido_em: null } : {}),
                }).eq("id", atendAberto.id);
              } else if (funilId && etapaInicialId) {
                await supabase.from("sac_atendimentos").insert({
                  contato_id: contatoId, funil_id: funilId, etapa_id: etapaInicialId, status: "ativo", nao_lido: false,
                  ultima_mensagem_preview: corpoRender.slice(0, 140), ultima_mensagem_em: nowIso2, entrou_na_etapa_em: nowIso2,
                  ped_conversa_id_legacy: conversaId,
                });
              }
            }
          } catch (sacErr: any) { console.log("[dispatch] consolidado SAC erro:", sacErr?.message ?? sacErr); }
        }

        // Avança cada convite do grupo (mesma máquina de estado da fase1) e loga.
        for (const c of aulasOrd) {
          const update = computeFase1Update(c, c.__aula);
          // marca que o disparo saiu consolidado (o botão "Confirmo todas" já casa
          // por disparo_inicial_lote; garantimos a flag caso venha de convite antigo).
          const meta = {
            ...((c.metadata as Record<string, unknown>) ?? {}),
            disparo_inicial_lote: true,
            ultimo_disparo_consolidado_em: nowIso2,
            lote_wa_message_id: waMsgId,
            falhas_envio_consecutivas: 0, // envio deu certo: zera o contador de escalação
          };
          // ⚠️ Checar o erro é obrigatório aqui também: sem isso o convite fica com
          // proxima_acao_em vencido e o lote inteiro é reenviado no dia seguinte —
          // com a Meta ACEITANDO (o professor recebe de verdade, todo dia).
          const { error: updLoteErr } = await supabase
            .from("ped_convites").update({ ...update, metadata: meta }).eq("id", c.id);
          if (updLoteErr) {
            console.error(`[dispatch] consolidado: UPDATE falhou convite=${c.id}: ${updLoteErr.message}`);
            await registrarFalhaEnvio(supabase, c, `erro_state_machine: ${updLoteErr.message}`);
            await supabase.from("ped_convites_eventos").insert({
              convite_id: c.id, aula_id: c.aula_id, tipo: "erro_state_machine",
              template_name: loteTpl.nome, ator: "system",
              payload: { update, error: updLoteErr.message, modo: "consolidado_fase1" },
            });
          }
          await supabase.from("ped_convites_eventos").insert({
            convite_id: c.id, aula_id: c.aula_id, tipo: "mensagem_enviada", template_name: loteTpl.nome, ator: "system",
            payload: { template: loteTpl.nome, modo: "consolidado_fase1", wa_message_id: waMsgId, aulas_no_lote: aulasOrd.length, next_status: update.status ?? c.status },
          });
        }

        await supabase.from("ped_wa_templates").update({
          total_disparos: (loteTpl.total_disparos ?? 0) + 1, ultimo_disparo_em: nowIso2,
        }).eq("id", loteTpl.id);

        sent++;
        detailG.wa_message_id = waMsgId;
        details.push(detailG);
      } catch (e) {
        errors++;
        const msgG = e instanceof Error ? e.message : String(e);
        detailG.error = msgG;
        // Backoff + evento POR CONVITE: sem isso o grupo reentrava no run seguinte com
        // proxima_acao_em vencido e re-tentava para sempre, sem escalar e — pior — SEM
        // gravar `erro_envio`, ficando invisível também para o aviso do portal.
        for (const c of grupo) {
          await supabase.from("ped_convites_eventos").insert({
            convite_id: c.id, aula_id: c.aula_id, tipo: "erro_envio",
            template_name: loteTpl.nome, ator: "system",
            payload: { error: msgG, modo: "consolidado_fase1" },
          });
          const r = await registrarFalhaEnvio(supabase, c, msgG, { modo: "consolidado_fase1" });
          if (r.escalado) detailG.escalados = (detailG.escalados ?? 0) + 1;
        }
        details.push(detailG);
      }
      if (!forceLive) await sleep(SEND_DELAY_MS);
    }

    for (const convite of individuais) {
      processed++;
      const detail: any = { convite_id: convite.id, status: convite.status };
      try {
        // 4) joins
        const { data: aula } = await supabase
          .from("ped_aulas")
          .select("id,data,horario,titulo,pos_graduacao_id,link_sala_override,professor_reserva_id")
          .eq("id", convite.aula_id)
          .maybeSingle();
        if (!aula) throw new Error("aula não encontrada");

        // GUARD: nunca disparar para aulas com data > 7 dias no passado.
        // Protege contra acordadas em massa (ex: backfill, mudança de fix, cron parado por dias)
        // que de outro modo mandariam dezenas de mensagens "sua aula foi concluída em [data antiga]"
        // pra professores que já lecionaram meses atrás. Convite é marcado pra nunca mais reprocessar.
        const diasDesdeAula = -daysUntilAula(aula.data); // positivo se aula já passou
        if (diasDesdeAula > 7) {
          await supabase
            .from("ped_convites")
            .update({
              proxima_acao_em: "2099-12-31T23:59:59Z",
              metadata: {
                ...((convite.metadata as Record<string, unknown>) ?? {}),
                pulado_por_aula_antiga: true,
                pulado_em: new Date().toISOString(),
                pulado_dias_desde_aula: diasDesdeAula,
              },
            })
            .eq("id", convite.id);
          detail.skipped = "aula_muito_antiga";
          detail.dias_desde_aula = diasDesdeAula;
          details.push(detail);
          continue;
        }

        // ── STATUS APOSENTADO: reconfirmação de 14 DIAS (removida em 2026-07-16).
        // O status CONTINUA em STATUSES_DISPATCHABLE de propósito: fora da lista o convite
        // vira ÓRFÃO — não dispara, não erra, e a Fila segue verde "ENVIADO E CONFIRMADO".
        // Foi assim que 137 convites ficaram semanas sem lembrete (caso Pansera, 13/08).
        // Aqui ele é RE-ROTEADO pro marco vivo da régua (30 → 7 → 1 → dia da aula) e NADA
        // é enviado. Tem que ficar DEPOIS do guard de aula antiga (senão aula velha viraria
        // link de sala) e ANTES do fetch do professor (que dá throw e joga na escalação) e
        // do resolveCadencia (que sem o mapa cairia em "cadencia_nao_mapeada", um `continue`
        // que NÃO mexe em proxima_acao_em ⇒ o convite voltaria em todo run comendo vaga do
        // BATCH_LIMIT, que é ordenado por proxima_acao_em ASC).
        if (convite.status === "fase2_reconfirmacao_14d") {
          const next = pickNextFase2Marco(aula, convite.status);
          // Aula já ocorrida (até 7 dias atrás, o guard acima barra o resto): NÃO reproduzir
          // o `dia_aula_link_enviado` imediato do pickNextFase2Marco — mandaria "segue o link
          // da sua sala" pra aula da semana passada. Encerra a cadência.
          const encerrar = next.dias <= 0;
          const patch = encerrar
            ? { proxima_acao_em: null }
            : { status: next.status, proxima_acao_em: next.proxima_acao_em };
          const { error: migErr } = await supabase
            .from("ped_convites")
            .update(patch)
            .eq("id", convite.id);
          if (migErr) {
            // NÃO usar registrarFalhaEnvio aqui: pra status de fase 2 ela não troca o status
            // e, na 3ª falha, grava proxima_acao_em = NULL — o convite sairia do universo do
            // cron (a query exige .lte("proxima_acao_em", now), e NULL nunca casa) e viraria
            // órfão PERMANENTE. Migração de status aposentado não é falha de envio: só backoff,
            // e o evento entra como erro_state_machine, que o aviso do portal vigia.
            console.error(
              `[dispatch] migracao 14d FALHOU convite=${convite.id}: ${migErr.message}`,
            );
            await supabase
              .from("ped_convites")
              .update({ proxima_acao_em: nowPlus(BACKOFF_FALHA_MS) })
              .eq("id", convite.id);
          }
          const { error: evErr } = await supabase.from("ped_convites_eventos").insert({
            convite_id: convite.id,
            aula_id: convite.aula_id,
            tipo: migErr ? "erro_state_machine" : "status_aposentado_migrado",
            ator: "sistema",
            status_anterior: "fase2_reconfirmacao_14d",
            status_novo: migErr || encerrar ? null : next.status,
            payload: {
              motivo: "toque_14d_removido_2026-07-16",
              dias_restantes: next.dias,
              marco: encerrar ? "cadencia_encerrada_aula_ja_ocorrida" : next.marco,
              enviado: false,
              erro: migErr?.message ?? null,
            },
          });
          if (evErr) {
            console.error(
              `[dispatch] evento da migracao 14d FALHOU convite=${convite.id}: ${evErr.message}`,
            );
          }
          console.log(
            `[dispatch] 14d APOSENTADO convite=${convite.id} dias=${next.dias} → ${
              encerrar ? "cadência encerrada" : next.status
            } (sem envio)`,
          );
          detail.skipped = "status_aposentado_14d";
          detail.next_status = encerrar ? null : next.status;
          details.push(detail);
          continue;
        }

        const { data: professor } = await supabase
          .from("ped_professores")
          .select("*") // linha completa: variaveis_mapping pode apontar qualquer campo do cadastro
          .eq("id", convite.professor_atual_id)
          .maybeSingle();
        if (!professor) throw new Error("professor não encontrado");

        const { data: pos } = await supabase
          .from("ped_pos_graduacoes")
          .select("id,nome,instituicao,link_sala_meet")
          .eq("id", aula.pos_graduacao_id)
          .maybeSingle();

        // 5) cadência → template
        const cadencia = resolveCadencia(convite.status, convite.followup_count ?? 0);
        if (!cadencia) {
          detail.skipped = "cadencia_nao_mapeada";
          details.push(detail);
          continue;
        }

        // 5.1) Smart skip guard: para fase2_*, valida que o marco ainda faz sentido.
        // Se a janela do lembrete já passou (ex: cron está em fase2_30d mas faltam 20d),
        // pula o envio e reagenda para o próximo marco viável.
        const fase2Statuses = new Set([
          "fase2_reconfirmacao_30d",
          "fase2_reconfirmacao_14d",
          "fase2_reconfirmacao_7d",
          "fase2_lembrete_1d",
        ]);
        if (fase2Statuses.has(convite.status)) {
          const diasAgora = daysUntilAula(aula.data);
          const minDias: Record<string, number> = {
            fase2_reconfirmacao_30d: 30,
            fase2_reconfirmacao_14d: 14,
            fase2_reconfirmacao_7d: 7,
            fase2_lembrete_1d: 1,
          };
          const limite = minDias[convite.status];
          if (diasAgora < limite) {
            // `statusAtual` garante que o próximo marco é um degrau ABAIXO — não existe
            // mais o caso "próximo igual ao atual" que antes exigia o atalho pro dia da aula.
            const next = pickNextFase2Marco(aula, convite.status);
            console.log(
              `[dispatch] smart-skip GUARD convite=${convite.id} status=${convite.status} dias_restantes=${diasAgora} < ${limite} → reagenda p/ ${next.status} (${next.marco}) em ${next.proxima_acao_em} sem disparar`,
            );
            await supabase
              .from("ped_convites")
              .update({
                status: next.status,
                proxima_acao_em: next.proxima_acao_em,
              })
              .eq("id", convite.id);
            detail.skipped = "smart_skip_marco_passado";
            detail.dias_restantes = diasAgora;
            detail.next_status = next.status;
            details.push(detail);
            continue;
          }
        }

        // 5.2) GUARD DO LINK DO DIA — o link da sala só serve ANTES de a aula começar.
        // Enquanto o cron rodou 1x/dia às 09h, esse marco (1h antes da aula, ou seja 18h
        // para a aula das 19h) NUNCA era alcançado no próprio dia: vencia à noite e só era
        // visto na rodada da manhã seguinte, mandando "segue o link da sua aula" DEPOIS da
        // aula. Dos 7 envios reais até 17/08/2026, 3 chegaram com 1 dia de atraso e nenhum
        // acertou uma aula de 19h. O cron passou a rodar de 30 em 30 min (alcança o marco),
        // e este guard fica como rede: aula já começada ⇒ pula o link e vai pro pós-aula.
        if (cadencia === "dia_aula_link") {
          const inicioMs = new Date(buildAulaStartIso(aula.data, aula.horario)).getTime();
          if (Date.now() >= inicioMs) {
            const fimMs = new Date(buildAulaEndIso(aula.data, aula.horario)).getTime();
            await supabase
              .from("ped_convites")
              .update({
                status: "pos_aula_realizada",
                proxima_acao_em: new Date(fimMs + 5 * 60 * 1000).toISOString(),
              })
              .eq("id", convite.id);
            await supabase.from("ped_convites_eventos").insert({
              convite_id: convite.id,
              aula_id: convite.aula_id,
              tipo: "link_do_dia_perdido",
              ator: "system",
              payload: {
                motivo: "a aula já havia começado quando o marco venceu",
                aula_data: aula.data,
                horario: aula.horario,
              },
            });
            console.log(
              `[dispatch] link do dia PERDIDO convite=${convite.id} aula=${aula.data} — já começou, pulando pro pós-aula`,
            );
            detail.skipped = "link_do_dia_aula_ja_comecou";
            details.push(detail);
            continue;
          }
        }


        const { data: template } = await supabase
          .from("ped_wa_templates")
          .select("*")
          .eq("uso_cadencia", cadencia)
          .eq("status", "aprovado")
          .eq("ativo", true)
          .maybeSingle();

        if (!template) {
          await supabase.from("ped_convites_eventos").insert({
            convite_id: convite.id,
            aula_id: convite.aula_id,
            tipo: "template_indisponivel",
            template_name: cadencia,
            ator: "system",
            payload: { cadencia, status: convite.status },
          });
          detail.skipped = "template_indisponivel";
          detail.cadencia = cadencia;
          details.push(detail);
          continue;
        }

        // 6.5) GUARD ANTI-REPETIÇÃO (rede de segurança contra spam)
        // Qualquer bug que impeça o convite de avançar de estado (UPDATE recusado,
        // proxima_acao_em no passado, cadência que não muda) fazia o cron reenviar o
        // MESMO template todo dia, indefinidamente — foi o caso real de 24→28/07
        // (5 disparos idênticos ao mesmo professor) e de 01→08/07 (11 disparos).
        // Regra: o mesmo convite não recebe o MESMO template 2x em menos de 20h.
        // force_live (reenvio manual pelo painel) ignora o guard de propósito.
        if (!forceLive) {
          const guard = await envioJaFeitoRecentemente(supabase, convite.id, template.nome);
          if (guard.bloquear) {
            console.log(
              `[dispatch] ANTI-REPETIÇÃO convite=${convite.id} template=${template.nome} (${guard.motivo}) → pulando`,
            );
            await supabase.from("ped_convites_eventos").insert({
              convite_id: convite.id,
              aula_id: convite.aula_id,
              tipo: "envio_repetido_bloqueado",
              template_name: template.nome,
              ator: "system",
              payload: {
                cadencia,
                status: convite.status,
                janela_horas: JANELA_ANTI_REPETICAO_MS / 3600000,
                motivo: guard.motivo,
              },
            });
            // Reagenda pra frente pra não ficar re-avaliando o convite a cada execução.
            await supabase
              .from("ped_convites")
              .update({ proxima_acao_em: nowPlus(BACKOFF_FALHA_MS) })
              .eq("id", convite.id);
            detail.skipped = "envio_repetido_bloqueado";
            detail.template = template.nome;
            details.push(detail);
            continue;
          }
        }

        // 7) parameters via variaveis_mapping (em ordem das variáveis {{1}}, {{2}}, ...)
        // Aceita 3 formatos por retrocompat:
        //   ["nome_professor","instituicao",...]                    → array direto
        //   { "body": [...] }                                       → objeto com array body
        //   { "1": "nome_professor", "2": "instituicao", ... }      → objeto com chaves numéricas
        let mapping: string[] = [];
        const vm = template.variaveis_mapping;
        if (Array.isArray(vm)) {
          mapping = vm;
        } else if (vm && typeof vm === "object") {
          if (Array.isArray(vm.body)) {
            mapping = vm.body;
          } else {
            const numKeys = Object.keys(vm)
              .filter((k) => /^\d+$/.test(k))
              .sort((a, b) => Number(a) - Number(b));
            mapping = numKeys.map((k) => vm[k]).filter((x) => typeof x === "string");
          }
        }

        const ctx = { professor, aula, pos };
        const bodyParams = mapping.map((v) => ({
          type: "text",
          text: buildVariableValue(v, ctx),
        }));

        // 7.1) GUARD PARÂMETRO VAZIO — a Meta RECUSA o template inteiro quando um
        // parâmetro vem vazio (131008 "Parameter of type text is missing text value").
        // Foi o que quebrou o pos_aula_status_v2_v2 de 24→28/07: o mapping apontava
        // uma variável que o dispatcher não sabia resolver ⇒ texto "" ⇒ 131008 todo dia.
        // Melhor NÃO enviar (e escalar) do que rodar o mesmo erro diariamente.
        const varsVazias = mapping
          .map((v, i) => ({ pos: i + 1, campo: v, valor: bodyParams[i]?.text ?? "" }))
          .filter((p) => !String(p.valor).trim());

        if (varsVazias.length) {
          console.error(
            `[dispatch] PARAMETRO VAZIO convite=${convite.id} template=${template.nome} vars=${JSON.stringify(varsVazias)}`,
          );
          await supabase.from("ped_convites_eventos").insert({
            convite_id: convite.id,
            aula_id: convite.aula_id,
            tipo: "erro_envio",
            template_name: template.nome,
            ator: "system",
            payload: {
              error: "parametro_vazio",
              detalhe: "Meta recusaria o template (131008). Envio não realizado.",
              cadencia,
              variaveis_vazias: varsVazias,
            },
          });
          const r = await registrarFalhaEnvio(supabase, convite, "parametro_vazio", {
            variaveis_vazias: varsVazias.map((v) => v.campo),
          });
          errors++;
          detail.error = "parametro_vazio";
          detail.variaveis_vazias = varsVazias;
          detail.escalado = r.escalado;
          details.push(detail);
          continue;
        }

        const components: any[] = [{ type: "body", parameters: bodyParams }];

        // botão URL dinâmico se cadência usa slug
        const usesUrlBtn =
          cadencia === "dia_aula_link" ||
          (Array.isArray(template.botoes) &&
            template.botoes.some((b: any) => b?.type === "URL" && b?.url?.includes("{{")));
        if (usesUrlBtn) {
          const slug = getMeetSlug(aula, pos);
          if (slug) {
            components.push({
              type: "button",
              sub_type: "url",
              index: 0,
              parameters: [{ type: "text", text: slug }],
            });
          }
        }

        const to = formatPhone(professor.contato_whatsapp);
        if (!to) throw new Error("whatsapp do professor inválido");

        const wapayload = {
          messaging_product: "whatsapp",
          to,
          type: "template",
          template: {
            name: template.nome,
            language: { code: template.idioma || "pt_BR" },
            components,
          },
        };

        // Renderiza o corpo do template ANTES do envio para podermos gravar
        // a tentativa no SAC mesmo se a Meta API rejeitar.
        let corpoRender = String(template.corpo ?? "");
        bodyParams.forEach((p, i) => {
          corpoRender = corpoRender.split(`{{${i + 1}}}`).join(p.text ?? "");
        });

        // 8) envio (live) ou dry — captura erro sem throw imediato pra gravar a tentativa
        let waResponse: any = { dry_run: true };
        let envioErro: { http_status?: number; message: string; body: any } | null = null;
        if (mode !== "off") {
          try {
            const r = await fetch(`${META_GRAPH}/${phoneNumberId}/messages`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(wapayload),
            });
            waResponse = await r.json();
            if (!r.ok) {
              envioErro = {
                http_status: r.status,
                message: waResponse?.error?.message ?? `Meta API ${r.status}`,
                body: waResponse,
              };
            }
          } catch (fetchErr: any) {
            envioErro = {
              message: fetchErr?.message ?? "fetch falhou",
              body: { fetch_error: String(fetchErr) },
            };
          }
        }

        const envioOk = mode !== "off" ? !envioErro : true;

        // 10) log evento (sucesso ou falha)
        await supabase.from("ped_convites_eventos").insert({
          convite_id: convite.id,
          aula_id: convite.aula_id,
          tipo: envioOk ? "mensagem_enviada" : "erro_envio",
          template_name: template.nome,
          ator: "system",
          payload: {
            template: template.nome,
            cadencia,
            parameters: bodyParams,
            wa: waResponse,
            mode,
            ...(envioErro ? { error: envioErro.message, error_detail: envioErro } : {}),
          },
        });

        // 11) bump template (apenas em live e com sucesso)
        if (mode !== "off" && envioOk) {
          await supabase
            .from("ped_wa_templates")
            .update({
              total_disparos: (template.total_disparos ?? 0) + 1,
              ultimo_disparo_em: new Date().toISOString(),
            })
            .eq("id", template.id);
        }

        // 11.5) registra tentativa em ped_conversas_avulsas + ped_conversas_mensagens.
        // GRAVA SEMPRE em live (sucesso OU falha) pra ficar visível no SAC.
        if (mode !== "off") {
          try {

            // 1) busca conversa existente pelo telefone — por VARIANTES ±9º dígito,
            // pra reusar a conversa que a resposta do professor (wa_id sem o 9) já
            // possa ter criado; senão o convite abriria um 2º card.
            let existente: { id: string } | null = null;
            for (const tel of phoneVariants(to)) {
              const { data, error: findErr } = await supabase
                .from("ped_conversas_avulsas")
                .select("id")
                .contains("metadata", { telefone: tel })
                .order("ultima_atividade_em", { ascending: false })
                .limit(1);
              if (findErr) console.log("[dispatch] find conversa erro:", findErr.message);
              if (data?.[0]?.id) { existente = data[0]; break; }
            }

            const nowIso = new Date().toISOString();
            let conversaId: string | null = existente?.id ?? null;

            if (conversaId) {
              await supabase
                .from("ped_conversas_avulsas")
                .update({ ultima_atividade_em: nowIso })
                .eq("id", conversaId);
            } else {
              const { data: novaConv, error: insConvErr } = await supabase
                .from("ped_conversas_avulsas")
                .insert({
                  tipo: "outbound_template",
                  assunto: template.nome,
                  professores_alvo: [professor.id],
                  status: "enviada",
                  contexto_convite_id: convite.id,
                  contexto_aula_id: convite.aula_id,
                  primeira_mensagem_em: nowIso,
                  ultima_atividade_em: nowIso,
                  metadata: {
                    telefone: to,
                    profile_name: professor.nome,
                    prof_id: professor.id,
                  },
                })
                .select("id")
                .single();
              if (insConvErr) console.log("[dispatch] insert conversa erro:", insConvErr.message);
              conversaId = novaConv?.id ?? null;
            }

            // 2) insere mensagem outbound (com status conforme resultado do envio)
            if (conversaId) {
              const waMsgId = envioOk ? (waResponse?.messages?.[0]?.id ?? null) : null;
              const { error: msgErr } = await supabase
                .from("ped_conversas_mensagens")
                .insert({
                  conversa_id: conversaId,
                  direcao: "outbound",
                  conteudo: corpoRender,
                  template_name: template.nome,
                  // Snapshot dos botões: é o que o SAC mostra como chips no balão
                  // ("o que o professor pode responder com 1 toque").
                  template_botoes: Array.isArray(template.botoes) ? template.botoes : null,
                  professor_id: professor.id,
                  wa_message_id: waMsgId,
                  enviada_em: nowIso,
                  status_envio: envioOk ? "enviada" : "falhou",
                  erro_envio: envioErro
                    ? {
                        message: envioErro.message,
                        http_status: envioErro.http_status ?? null,
                        meta_error: envioErro.body?.error ?? null,
                      }
                    : null,
                });
              if (msgErr) console.log("[dispatch] insert mensagem erro:", msgErr.message);

              // 3) sincroniza com SAC: upsert sac_contatos + cria sac_atendimentos vinculado
              try {
                // 3a) upsert sac_contatos por telefone — por VARIANTES ±9º dígito,
                // pra reusar o contato que a resposta do professor já tenha criado.
                const { data: contatosMatch } = await supabase
                  .from("sac_contatos")
                  .select("id, tipo, professor_id_ref")
                  .in("telefone", phoneVariants(to))
                  .limit(1);
                const contatoExistente = contatosMatch?.[0] ?? null;

                let contatoId = contatoExistente?.id ?? null;
                if (contatoId) {
                  // garante vínculo de tipo/professor
                  await supabase
                    .from("sac_contatos")
                    .update({
                      tipo: "professor",
                      professor_id_ref: professor.id,
                      nome: contatoExistente?.tipo === "professor" ? undefined : professor.nome,
                    })
                    .eq("id", contatoId);
                } else {
                  const { data: novoContato, error: contErr } = await supabase
                    .from("sac_contatos")
                    .insert({
                      nome: professor.nome,
                      telefone: to,
                      tipo: "professor",
                      professor_id_ref: professor.id,
                    })
                    .select("id")
                    .single();
                  if (contErr) console.log("[dispatch] insert sac_contato erro:", contErr.message);
                  contatoId = novoContato?.id ?? null;
                }

                // 3b) cria/atualiza sac_atendimentos ativo
                if (contatoId) {
                  // 1 atendimento por contato (constraint uq_sac_atend_um_por_contato):
                  // busca o existente em QUALQUER status — reabre abaixo se estiver dormindo.
                  const { data: atendAberto } = await supabase
                    .from("sac_atendimentos")
                    .select("id, etapa_id, status")
                    .eq("contato_id", contatoId)
                    .maybeSingle();

                  // funil e etapa pedagógicos
                  const { data: funilRow } = await supabase
                    .from("sac_funis")
                    .select("id")
                    .order("created_at", { ascending: true })
                    .limit(1)
                    .maybeSingle();
                  const funilId = funilRow?.id;
                  let etapaInicialId: string | null = null;
                  if (funilId) {
                    const { data: etapaRow } = await supabase
                      .from("sac_funis_etapas")
                      .select("id")
                      .eq("funil_id", funilId)
                      .eq("comportamento_entrada", "auto_template_enviado")
                      .eq("ativo", true)
                      .order("ordem", { ascending: true })
                      .limit(1)
                      .maybeSingle();
                    etapaInicialId = etapaRow?.id ?? null;
                  }

                  if (atendAberto?.id) {
                    await supabase
                      .from("sac_atendimentos")
                      .update({
                        ped_conversa_id_legacy: conversaId,
                        ultima_mensagem_preview: corpoRender.slice(0, 140),
                        ultima_mensagem_em: nowIso,
                        // reabre se estava resolvido/arquivado
                        ...(atendAberto.status !== "ativo" ? { status: "ativo", resolvido_em: null } : {}),
                      })
                      .eq("id", atendAberto.id);
                  } else if (funilId && etapaInicialId) {
                    await supabase
                      .from("sac_atendimentos")
                      .insert({
                        contato_id: contatoId,
                        funil_id: funilId,
                        etapa_id: etapaInicialId,
                        status: "ativo",
                        nao_lido: false,
                        ultima_mensagem_preview: corpoRender.slice(0, 140),
                        ultima_mensagem_em: nowIso,
                        entrou_na_etapa_em: nowIso,
                        ped_conversa_id_legacy: conversaId,
                      });
                  }
                }
              } catch (sacErr: any) {
                console.log("[dispatch] sync SAC erro:", sacErr?.message ?? sacErr);
              }
            }
          } catch (convPersistErr: any) {
            console.log("[dispatch] persist conversa/msg erro:", convPersistErr.message);
          }
        }

        // Se o envio ao Meta falhou, sai do try aqui pra ser contado em `errors`
        // (já gravamos o erro_envio na conversa para visibilidade no SAC).
        if (envioErro) {
          throw new Error(envioErro.message);
        }

        // 9) state machine
        const update: Record<string, any> = {
          ultima_mensagem_enviada_em: new Date().toISOString(),
        };

        const fc = convite.followup_count ?? 0;
        const status = convite.status as ConviteStatus;

        if (status === "fase1_titular_aguardando") {
          const nextFc = fc + 1;
          if (fc >= FOLLOWUP_MAX) {
            // Já enviamos agradecemos_negativa (followup_count == 8). Esgota titular.
            if (convite.papel === "titular" && aula.professor_reserva_id) {
              console.log(
                `[dispatch] fase1 esgotada convite=${convite.id} → trocando para RESERVA (${aula.professor_reserva_id})`,
              );
              update.status = "fase1b_reserva_aguardando";
              update.professor_atual_id = aula.professor_reserva_id;
              update.followup_count = 0;
              update.proxima_acao_em = new Date().toISOString();
              update.papel = "reserva";
              update.decisao_fase1_em = new Date().toISOString();
            } else {
              console.log(
                `[dispatch] fase1 esgotada convite=${convite.id} sem reserva → esgotado_sem_titular`,
              );
              update.status = "esgotado_sem_titular";
              update.followup_count = nextFc;
              update.proxima_acao_em = null;
              update.decisao_fase1_em = new Date().toISOString();
            }
          } else {
            console.log(
              `[dispatch] fase1 convite=${convite.id} followup ${fc}→${nextFc} (template enviado=${cadencia}) próximo em +2d`,
            );
            update.followup_count = nextFc;
            update.proxima_acao_em = nowPlus(2 * 24 * 3600 * 1000);
          }
        } else if (status === "fase1b_reserva_aguardando") {
          const nextFc = fc + 1;
          if (fc >= FOLLOWUP_MAX) {
            console.log(
              `[dispatch] fase1b reserva esgotada convite=${convite.id} → esgotado_sem_titular_nem_reserva`,
            );
            update.status = "esgotado_sem_titular_nem_reserva";
            update.followup_count = nextFc;
            update.proxima_acao_em = null;
            update.decisao_fase1b_em = new Date().toISOString();
          } else {
            console.log(
              `[dispatch] fase1b convite=${convite.id} followup ${fc}→${nextFc} (template enviado=${cadencia}) próximo em +2d`,
            );
            update.followup_count = nextFc;
            update.proxima_acao_em = nowPlus(2 * 24 * 3600 * 1000);
          }
        } else if (
          status === "fase2_reconfirmacao_30d" ||
          status === "fase2_reconfirmacao_14d" ||
          status === "fase2_reconfirmacao_7d" ||
          status === "fase2_lembrete_1d"
        ) {
          // Próximo degrau da régua, sempre ABAIXO do que acabou de ser enviado.
          const next = pickNextFase2Marco(aula, status);
          console.log(
            `[dispatch] smart-skip convite=${convite.id} aula=${aula.data} status_atual=${status} dias_restantes=${next.dias} -> proximo=${next.status} (${next.marco}) em ${next.proxima_acao_em}`,
          );
          update.status = next.status;
          update.proxima_acao_em = next.proxima_acao_em;
        } else if (status === "dia_aula_link_enviado") {
          update.status = "pos_aula_realizada";
          // Pós-aula vai 5 minutos depois do FIM da aula (ex: aula 19-22h → 22:05)
          const endIso = buildAulaEndIso(aula.data, aula.horario);
          update.proxima_acao_em = new Date(
            new Date(endIso).getTime() + 5 * 60 * 1000,
          ).toISOString();
        } else if (status === "pos_aula_realizada") {
          update.status = "pos_aula_status_aguardando_acao";
          update.proxima_acao_em = null;
        }

        // Zera o contador de falhas — o envio deu certo.
        if ((convite.metadata as any)?.falhas_envio_consecutivas) {
          update.metadata = {
            ...((convite.metadata as Record<string, unknown>) ?? {}),
            falhas_envio_consecutivas: 0,
          };
        }

        // ⚠️ CHECAR O ERRO É OBRIGATÓRIO: sem isso, um UPDATE recusado pelo banco
        // (status fora do enum, NOT NULL, CHECK) passa CALADO — o convite fica no
        // estado antigo com proxima_acao_em vencido e o cron reenvia a mesma
        // mensagem todo dia. Foi exatamente a causa do spam de julho/2026.
        const { error: updErr } = await supabase
          .from("ped_convites")
          .update(update)
          .eq("id", convite.id);

        if (updErr) {
          console.error(
            `[dispatch] STATE MACHINE UPDATE FALHOU convite=${convite.id} update=${JSON.stringify(update)} erro=${updErr.message}`,
          );
          // Backoff + contador: um UPDATE que falha de forma PERSISTENTE (constraint,
          // enum, lock) tem que parar e escalar como qualquer outra falha — senão o
          // convite volta amanhã, e no dia seguinte, indefinidamente (o bug original).
          await registrarFalhaEnvio(supabase, convite, `erro_state_machine: ${updErr.message}`);
          await supabase.from("ped_convites_eventos").insert({
            convite_id: convite.id,
            aula_id: convite.aula_id,
            tipo: "erro_state_machine",
            template_name: template.nome,
            ator: "system",
            payload: { update, error: updErr.message, status_atual: convite.status },
          });
          detail.erro_state_machine = updErr.message;
        }

        if (mode !== "off") sent++;
        detail.template = template.nome;
        detail.cadencia = cadencia;
        detail.next_status = update.status ?? convite.status;
        details.push(detail);
      } catch (e) {
        errors++;
        const msg = e instanceof Error ? e.message : String(e);
        detail.error = msg;
        // Backoff + escalação: sem isso o convite continuava vencido e o cron
        // re-tentava o MESMO envio todo dia (spam no SAC + ruído na Meta).
        const r = await registrarFalhaEnvio(supabase, convite, msg);
        detail.falhas_consecutivas = r.falhas;
        detail.escalado = r.escalado;
        details.push(detail);
        await supabase.from("ped_convites_eventos").insert({
          convite_id: convite.id,
          aula_id: convite.aula_id,
          tipo: "erro_envio",
          ator: "system",
          payload: { error: msg, falhas_consecutivas: r.falhas, escalado: r.escalado },
        });
      }

      // Delay entre envios pra respeitar rate limit da Meta (não aplica em force_live de 1 só)
      if (!forceLive && (convites?.length ?? 0) > 1) {
        await sleep(SEND_DELAY_MS);
      }
    }

    return new Response(
      JSON.stringify({ success: true, mode, processed, sent, errors, details, batch_limit: BATCH_LIMIT }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e: any) {
    // Logging agressivo para diagnosticar erros que escaparam dos try/catch internos.
    console.error("[dispatch] ERRO FATAL no handler:");
    console.error("  typeof:", typeof e);
    console.error("  instanceof Error:", e instanceof Error);
    try { console.error("  JSON:", JSON.stringify(e, Object.getOwnPropertyNames(e || {}))); } catch { /* */ }
    try { console.error("  message:", e?.message); } catch { /* */ }
    try { console.error("  stack:", e?.stack); } catch { /* */ }
    try { console.error("  code:", e?.code, "details:", e?.details, "hint:", e?.hint); } catch { /* */ }

    let msg = "Erro desconhecido";
    if (e instanceof Error) msg = e.message;
    else if (typeof e === "string") msg = e;
    else if (e && typeof e === "object") {
      msg = e.message || e.error_description || e.error || JSON.stringify(e, Object.getOwnPropertyNames(e));
    }

    return new Response(JSON.stringify({
      success: false,
      error: msg,
      error_detail: e && typeof e === "object" ? {
        code: e.code,
        details: e.details,
        hint: e.hint,
      } : undefined,
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
