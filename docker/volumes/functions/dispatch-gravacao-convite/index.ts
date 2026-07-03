// dispatch-gravacao-convite
// Cron (a cada 30 min) + force_live: processa a Fila de Gravações EAD e envia
// WhatsApp via Meta Cloud API. Espelha dispatch-professor-invite (versão enxuta).
// Avanço de fase é MANUAL (time na fila) — aqui só enviamos o template da fase atual
// e fazemos follow-ups (a cada 3 dias, máx 3 tentativas) enquanto a fase não muda.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_GRAPH = "https://graph.facebook.com/v21.0";
const TZ = "America/Sao_Paulo";
const BATCH_LIMIT = 50;
const SEND_DELAY_MS = 150;
const FOLLOWUP_MAX = 3;                       // máx 3 tentativas por fase
const FOLLOWUP_INTERVAL_MS = 3 * 24 * 3600 * 1000; // 3 dias

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// status "de envio" → uso_cadencia do template (ped_wa_templates)
const STATUS_TO_CADENCIA: Record<string, string> = {
  fase1_convite_enviado: "gravacao_convite_proposta",
  fase2_contrato_enviado: "gravacao_contrato",
  fase3_em_gravacao: "gravacao_lembrete_gravacao",
  fase4_pagamento_solicitado: "gravacao_pagamento",
};
const DISPATCHABLE = Object.keys(STATUS_TO_CADENCIA);

function formatPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  const d = trimmed.replace(/\D/g, "");
  if (!d) return null;
  // Número internacional já com DDI (veio com '+', ex.: +1 dos EUA): NÃO force o 55.
  if (trimmed.startsWith("+")) return d;
  // Já vem com o DDI do Brasil (55 + 10/11 dígitos).
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) return d;
  // Número brasileiro sem DDI: DDD + 8 dígitos (fixo) ou DDD + 9xxxxxxxx (celular).
  // Celular BR de 11 dígitos SEMPRE tem '9' no 3º dígito — 11 dígitos sem esse 9 é
  // internacional sem DDI (ex.: wa_id dos EUA, 1+10) e NÃO pode ganhar 55.
  if (d.length === 10 || (d.length === 11 && d[2] === "9")) return `55${d}`;
  // Não reconhecido: devolve os dígitos como estão (não corrompe internacional sem '+').
  return d;
}
function firstName(full: string | null | undefined): string {
  return (full ?? "").trim().split(/\s+/)[0] ?? "";
}
function formatDatePtBR(ymd: string | null): string {
  if (!ymd) return "";
  const d = new Date(`${ymd}T12:00:00-03:00`);
  return new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, day: "2-digit", month: "long", year: "numeric" }).format(d);
}

function buildVar(name: string, ctx: { professor: any; modulo: any; pos: any; convite: any }): string {
  const moduloLabel = ctx.modulo?.modulo_nome || `Módulo ${String(ctx.modulo?.modulo_numero ?? "").padStart(2, "0")}`;
  switch (name) {
    case "nome_professor": return firstName(ctx.professor?.nome);
    case "instituicao": return ctx.pos?.instituicao ?? "PPGVET Educação";
    case "pos_graduacao": return ctx.pos?.nome ?? "";
    case "modulo": return moduloLabel;
    case "data_gravacao": return formatDatePtBR(ctx.convite?.data_gravacao ?? ctx.modulo?.data_agendada ?? null);
    case "valor": return ctx.convite?.valor != null ? Number(ctx.convite.valor).toFixed(2).replace(".", ",") : "";
    default: return "";
  }
}

function mappingToArray(vm: any): string[] {
  if (Array.isArray(vm)) return vm;
  if (vm && typeof vm === "object") {
    if (Array.isArray(vm.body)) return vm.body;
    return Object.keys(vm).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b)).map((k) => vm[k]).filter((x) => typeof x === "string");
  }
  return [];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);
  let processed = 0, sent = 0, errors = 0;
  const details: any[] = [];

  try {
    let onlyConviteId: string | null = null;
    let forceLive = false;
    try {
      const body = await req.json();
      onlyConviteId = body?.convite_id ?? null;
      forceLive = body?.force_live === true;
    } catch { /* cron: sem body */ }

    // modo global (off por padrão); force_live ignora o off
    const { data: cfg } = await supabase.from("ped_configuracoes").select("valor").eq("chave", "gravacao_dispatch_mode").maybeSingle();
    const mode = forceLive ? "on" : (cfg?.valor === "on" ? "on" : "off");

    // lock (cron concorrente) — force_live não trava
    if (!forceLive) {
      const { data: gotLock } = await supabase.rpc("ped_gravacao_dispatch_try_lock");
      if (gotLock === false) {
        return new Response(JSON.stringify({ success: true, mode, processed: 0, skipped: "lock_busy" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    // conta WhatsApp pedagógica
    const { data: waRow, error: waErr } = await supabase.rpc("get_wa_account_pedagogico");
    if (waErr || !waRow) throw new Error(`get_wa_account_pedagogico: ${waErr?.message ?? "vazio"}`);
    const wa = Array.isArray(waRow) ? waRow[0] : waRow;
    const phoneNumberId = wa?.phone_number_id, accessToken = wa?.access_token;
    if (!phoneNumberId || !accessToken) throw new Error("WA account incompleto");

    const nowIso = new Date().toISOString();
    let q = supabase.from("ped_convites_gravacao").select("*").in("status", DISPATCHABLE).lte("proxima_acao_em", nowIso).order("proxima_acao_em", { ascending: true }).limit(BATCH_LIMIT);
    if (onlyConviteId) q = supabase.from("ped_convites_gravacao").select("*").eq("id", onlyConviteId).in("status", DISPATCHABLE);
    const { data: convites, error: cErr } = await q;
    if (cErr) throw cErr;

    for (const convite of convites ?? []) {
      processed++;
      const detail: any = { convite_id: convite.id, status: convite.status };
      try {
        const { data: modulo } = await supabase.from("ped_modulo_gravacao").select("id,modulo_numero,modulo_nome,pos_graduacao_id,data_agendada").eq("id", convite.modulo_gravacao_id).maybeSingle();
        if (!modulo) throw new Error("modulo de gravação não encontrado");
        const { data: professor } = await supabase.from("ped_professores").select("id,nome,contato_whatsapp").eq("id", convite.professor_atual_id).maybeSingle();
        if (!professor) throw new Error("professor não encontrado");
        const { data: pos } = await supabase.from("ped_pos_graduacoes").select("id,nome,instituicao").eq("id", modulo.pos_graduacao_id).maybeSingle();

        const cadencia = STATUS_TO_CADENCIA[convite.status];
        const { data: template } = await supabase.from("ped_wa_templates").select("*").eq("uso_cadencia", cadencia).eq("status", "aprovado").eq("ativo", true).maybeSingle();
        if (!template) {
          await supabase.from("ped_convites_gravacao_eventos").insert({ convite_id: convite.id, modulo_gravacao_id: convite.modulo_gravacao_id, tipo: "template_indisponivel", template_name: cadencia, ator: "system", payload: { cadencia, status: convite.status } });
          detail.skipped = "template_indisponivel"; detail.cadencia = cadencia; details.push(detail); continue;
        }

        const mapping = mappingToArray(template.variaveis_mapping);
        const ctx = { professor, modulo, pos, convite };
        const bodyParams = mapping.map((v) => ({ type: "text", text: buildVar(v, ctx) }));
        const to = formatPhone(professor.contato_whatsapp);
        if (!to) throw new Error("whatsapp do professor inválido");

        // corpo renderizado (para gravar a conversa no SAC mesmo se a Meta rejeitar)
        let corpoRender = String(template.corpo ?? "");
        bodyParams.forEach((p, i) => { corpoRender = corpoRender.split(`{{${i + 1}}}`).join(p.text ?? ""); });

        const wapayload = {
          messaging_product: "whatsapp", to, type: "template",
          template: { name: template.nome, language: { code: template.idioma || "pt_BR" }, components: [{ type: "body", parameters: bodyParams }] },
        };

        let waResponse: any = { dry_run: true };
        let envioErro: any = null;
        if (mode !== "off") {
          try {
            const r = await fetch(`${META_GRAPH}/${phoneNumberId}/messages`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify(wapayload) });
            waResponse = await r.json();
            if (!r.ok) envioErro = { http_status: r.status, message: waResponse?.error?.message ?? `Meta API ${r.status}`, body: waResponse };
          } catch (fe: any) {
            envioErro = { message: fe?.message ?? "fetch falhou", body: { fetch_error: String(fe) } };
          }
        }
        const envioOk = mode !== "off" ? !envioErro : true;

        await supabase.from("ped_convites_gravacao_eventos").insert({
          convite_id: convite.id, modulo_gravacao_id: convite.modulo_gravacao_id,
          tipo: envioOk ? "mensagem_enviada" : "erro_envio", template_name: template.nome, ator: "system",
          payload: { template: template.nome, cadencia, parameters: bodyParams, wa: waResponse, mode, ...(envioErro ? { error: envioErro.message } : {}) },
        });

        if (mode !== "off" && envioOk) {
          await supabase.from("ped_wa_templates").update({ total_disparos: (template.total_disparos ?? 0) + 1, ultimo_disparo_em: new Date().toISOString() }).eq("id", template.id);
        }

        // registra o ENVIO no SAC (conversa + mensagem outbound + contato/atendimento),
        // espelhando o dispatch-professor-invite, pra a conversa ficar completa quando o
        // professor responder (o webhook de entrada já grava o inbound por telefone).
        if (mode !== "off") {
          try {
            const nowIso = new Date().toISOString();
            const { data: existentes } = await supabase
              .from("ped_conversas_avulsas").select("id")
              .contains("metadata", { telefone: to })
              .order("ultima_atividade_em", { ascending: false }).limit(1);
            let conversaId: string | null = existentes?.[0]?.id ?? null;
            if (conversaId) {
              await supabase.from("ped_conversas_avulsas").update({ ultima_atividade_em: nowIso }).eq("id", conversaId);
            } else {
              const { data: novaConv } = await supabase.from("ped_conversas_avulsas").insert({
                tipo: "outbound_template", assunto: template.nome, professores_alvo: [professor.id], status: "enviada",
                contexto_convite_id: null, contexto_aula_id: null,
                primeira_mensagem_em: nowIso, ultima_atividade_em: nowIso,
                metadata: { telefone: to, profile_name: professor.nome, prof_id: professor.id,
                  gravacao_convite_id: convite.id, modulo_gravacao_id: convite.modulo_gravacao_id, fluxo: "gravacao" },
              }).select("id").single();
              conversaId = novaConv?.id ?? null;
            }

            if (conversaId) {
              const waMsgId = envioOk ? (waResponse?.messages?.[0]?.id ?? null) : null;
              await supabase.from("ped_conversas_mensagens").insert({
                conversa_id: conversaId, direcao: "outbound", conteudo: corpoRender, template_name: template.nome,
                professor_id: professor.id, wa_message_id: waMsgId, enviada_em: nowIso,
                status_envio: envioOk ? "enviada" : "falhou",
                erro_envio: envioErro ? { message: envioErro.message, http_status: envioErro.http_status ?? null, meta_error: envioErro.body?.error ?? null } : null,
              });

              try {
                // upsert sac_contatos por telefone
                const { data: contatoExistente } = await supabase.from("sac_contatos").select("id, tipo").eq("telefone", to).maybeSingle();
                let contatoId = contatoExistente?.id ?? null;
                if (contatoId) {
                  await supabase.from("sac_contatos").update({ tipo: "professor", professor_id_ref: professor.id }).eq("id", contatoId);
                } else {
                  const { data: novoContato } = await supabase.from("sac_contatos").insert({ nome: professor.nome, telefone: to, tipo: "professor", professor_id_ref: professor.id }).select("id").single();
                  contatoId = novoContato?.id ?? null;
                }
                if (contatoId) {
                  // 1 atendimento por contato (constraint uq_sac_atend_um_por_contato): busca em QUALQUER status
                  const { data: atendAberto } = await supabase.from("sac_atendimentos").select("id, status").eq("contato_id", contatoId).maybeSingle();
                  const { data: funilRow } = await supabase.from("sac_funis").select("id").order("created_at", { ascending: true }).limit(1).maybeSingle();
                  const funilId = funilRow?.id;
                  let etapaInicialId: string | null = null;
                  if (funilId) {
                    const { data: etapaRow } = await supabase.from("sac_funis_etapas").select("id").eq("funil_id", funilId).eq("comportamento_entrada", "auto_template_enviado").eq("ativo", true).order("ordem", { ascending: true }).limit(1).maybeSingle();
                    etapaInicialId = etapaRow?.id ?? null;
                  }
                  if (atendAberto?.id) {
                    await supabase.from("sac_atendimentos").update({ ped_conversa_id_legacy: conversaId, ultima_mensagem_preview: corpoRender.slice(0, 140), ultima_mensagem_em: nowIso, ...(atendAberto.status !== "ativo" ? { status: "ativo", resolvido_em: null } : {}) }).eq("id", atendAberto.id);
                  } else if (funilId && etapaInicialId) {
                    await supabase.from("sac_atendimentos").insert({ contato_id: contatoId, funil_id: funilId, etapa_id: etapaInicialId, status: "ativo", nao_lido: false, ultima_mensagem_preview: corpoRender.slice(0, 140), ultima_mensagem_em: nowIso, entrou_na_etapa_em: nowIso, ped_conversa_id_legacy: conversaId });
                  }
                }
              } catch (sacErr: any) { console.log("[dispatch-gravacao] sync SAC erro:", sacErr?.message ?? sacErr); }
            }
          } catch (persistErr: any) { console.log("[dispatch-gravacao] persist conversa erro:", persistErr?.message ?? persistErr); }
        }

        // avança follow-up: +3 dias até FOLLOWUP_MAX; depois para e espera ação manual
        const fc = (convite.followup_count ?? 0) + 1;
        await supabase.from("ped_convites_gravacao").update({
          followup_count: fc,
          ultima_mensagem_enviada_em: new Date().toISOString(),
          proxima_acao_em: fc >= FOLLOWUP_MAX ? "2099-12-31T23:59:59Z" : new Date(Date.now() + FOLLOWUP_INTERVAL_MS).toISOString(),
        }).eq("id", convite.id);

        if (envioOk) sent++; else errors++;
        detail.sent = envioOk; detail.cadencia = cadencia; detail.followup = fc;
        details.push(detail);
        if (mode !== "off") await sleep(SEND_DELAY_MS);
      } catch (e: any) {
        errors++; detail.error = e?.message ?? String(e); details.push(detail);
      }
    }

    return new Response(JSON.stringify({ success: true, mode, processed, sent, errors, details }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e: any) {
    return new Response(JSON.stringify({ success: false, error: e?.message ?? String(e), processed, sent, errors }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
