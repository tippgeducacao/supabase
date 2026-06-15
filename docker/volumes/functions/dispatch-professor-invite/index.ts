// dispatch-professor-invite
// Cron diário: processa convites a professores e envia WhatsApp via Meta Cloud API.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

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
  fase2_reconfirmacao_14d: "lembrete_14d",
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
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  return digits.startsWith("55") ? digits : `55${digits}`;
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

function dateOnlyToDate(d: string): Date {
  // d = "YYYY-MM-DD" — interpreta em SP (UTC-3) ao meio-dia para evitar drift
  return new Date(`${d}T12:00:00-03:00`);
}

function nowPlus(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function buildAulaStartIso(dataYmd: string, horario: string | null): string {
  // horario esperado "HH:MM-HH:MM" (padronizado pela migration 20260527171000)
  const inicio = (horario ?? "19:00").split(/[-–]/)[0].trim() || "19:00";
  return `${dataYmd}T${inicio.length === 5 ? inicio : "19:00"}:00-03:00`;
}

function buildAulaEndIso(dataYmd: string, horario: string | null): string {
  // Fim da aula. Se horario for "HH:MM-HH:MM", pega o segundo bloco.
  // Fallback: 22:00 (padrão das aulas noturnas).
  const parts = (horario ?? "19:00-22:00").split(/[-–]/);
  const fim = parts.length >= 2 ? parts[parts.length - 1].trim() : "22:00";
  const safe = /^\d{2}:\d{2}$/.test(fim) ? fim : "22:00";
  return `${dataYmd}T${safe}:00-03:00`;
}

function dateMinusDays(dataYmd: string, days: number): string {
  const d = dateOnlyToDate(dataYmd);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

function daysUntilAula(dataYmd: string): number {
  // dias inteiros (ceil) entre agora e a data da aula em SP
  const aula = dateOnlyToDate(dataYmd).getTime();
  const now = Date.now();
  return Math.ceil((aula - now) / (24 * 3600 * 1000));
}

type SmartSkipResult = {
  status:
    | "fase2_reconfirmacao_30d"
    | "fase2_reconfirmacao_14d"
    | "fase2_reconfirmacao_7d"
    | "fase2_lembrete_1d"
    | "dia_aula_link_enviado"
    | "pos_aula_realizada";
  proxima_acao_em: string;
  dias: number;
  marco: string;
};

function pickNextFase2Marco(aula: { data: string; horario: string | null }): SmartSkipResult {
  const dias = daysUntilAula(aula.data);
  if (dias > 30) {
    return {
      status: "fase2_reconfirmacao_30d",
      proxima_acao_em: dateMinusDays(aula.data, 30),
      dias,
      marco: "lembrete_30d",
    };
  }
  if (dias > 14) {
    return {
      status: "fase2_reconfirmacao_14d",
      proxima_acao_em: dateMinusDays(aula.data, 14),
      dias,
      marco: "lembrete_14d",
    };
  }
  if (dias > 7) {
    return {
      status: "fase2_reconfirmacao_7d",
      proxima_acao_em: dateMinusDays(aula.data, 7),
      dias,
      marco: "lembrete_7d",
    };
  }
  if (dias > 1) {
    return {
      status: "fase2_lembrete_1d",
      proxima_acao_em: dateMinusDays(aula.data, 1),
      dias,
      marco: "lembrete_1d",
    };
  }
  if (dias === 1) {
    return {
      status: "fase2_lembrete_1d",
      proxima_acao_em: nowPlus(60 * 60 * 1000),
      dias,
      marco: "lembrete_1d",
    };
  }
  // dias <= 0 → vai direto pro link da aula
  return {
    status: "dia_aula_link_enviado",
    proxima_acao_em: new Date().toISOString(),
    dias,
    marco: "dia_aula_link",
  };
}

function buildVariableValue(
  varName: string,
  ctx: {
    professor: any;
    aula: any;
    pos: any;
  },
): string {
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
      return ctx.aula?.horario ?? "";
    default:
      return "";
  }
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

    for (const convite of convites ?? []) {
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

        const { data: professor } = await supabase
          .from("ped_professores")
          .select("id,nome,contato_whatsapp")
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
            const next = pickNextFase2Marco(aula);
            console.log(
              `[dispatch] smart-skip GUARD convite=${convite.id} status=${convite.status} dias_restantes=${diasAgora} < ${limite} → reagenda p/ ${next.status} (${next.marco}) em ${next.proxima_acao_em} sem disparar`,
            );
            await supabase
              .from("ped_convites")
              .update({
                status: next.status === convite.status ? "dia_aula_link_enviado" : next.status,
                proxima_acao_em:
                  next.status === convite.status
                    ? new Date(
                        new Date(buildAulaStartIso(aula.data, aula.horario)).getTime() -
                          60 * 60 * 1000,
                      ).toISOString()
                    : next.proxima_acao_em,
              })
              .eq("id", convite.id);
            detail.skipped = "smart_skip_marco_passado";
            detail.dias_restantes = diasAgora;
            detail.next_status = next.status;
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

            // 1) busca conversa existente pelo telefone
            const { data: existentes, error: findErr } = await supabase
              .from("ped_conversas_avulsas")
              .select("id")
              .contains("metadata", { telefone: to })
              .order("ultima_atividade_em", { ascending: false })
              .limit(1);
            if (findErr) console.log("[dispatch] find conversa erro:", findErr.message);

            const nowIso = new Date().toISOString();
            let conversaId: string | null = existentes?.[0]?.id ?? null;

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
                // 3a) upsert sac_contatos por telefone
                const { data: contatoExistente } = await supabase
                  .from("sac_contatos")
                  .select("id, tipo, professor_id_ref")
                  .eq("telefone", to)
                  .maybeSingle();

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
                  const { data: atendAberto } = await supabase
                    .from("sac_atendimentos")
                    .select("id, etapa_id")
                    .eq("contato_id", contatoId)
                    .eq("status", "ativo")
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
          // Smart skip: escolhe próximo marco viável baseado em dias restantes
          const next = pickNextFase2Marco(aula);
          console.log(
            `[dispatch] smart-skip convite=${convite.id} aula=${aula.data} status_atual=${status} dias_restantes=${next.dias} -> proximo=${next.status} (${next.marco}) em ${next.proxima_acao_em}`,
          );
          // Se o próximo marco é o mesmo do atual (ex: já estamos em 1d e dias===1),
          // avança pra evitar loop: vai pro link da aula.
          if (next.status === status) {
            const startIso = buildAulaStartIso(aula.data, aula.horario);
            update.status = "dia_aula_link_enviado";
            update.proxima_acao_em = new Date(
              new Date(startIso).getTime() - 60 * 60 * 1000,
            ).toISOString();
            console.log(
              `[dispatch] smart-skip convite=${convite.id} próximo igual ao atual, forçando dia_aula_link_enviado`,
            );
          } else {
            update.status = next.status;
            update.proxima_acao_em = next.proxima_acao_em;
          }
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

        await supabase.from("ped_convites").update(update).eq("id", convite.id);

        if (mode !== "off") sent++;
        detail.template = template.nome;
        detail.cadencia = cadencia;
        detail.next_status = update.status ?? convite.status;
        details.push(detail);
      } catch (e) {
        errors++;
        const msg = e instanceof Error ? e.message : String(e);
        detail.error = msg;
        details.push(detail);
        await supabase.from("ped_convites_eventos").insert({
          convite_id: convite.id,
          aula_id: convite.aula_id,
          tipo: "erro_envio",
          ator: "system",
          payload: { error: msg },
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
