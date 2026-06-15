// dispatch-semester-batch
// Envia UM template ("convite_semestre_lote_v1") por professor, listando TODAS as
// aulas do lote, em vez de uma mensagem por aula. Após o envio, cada convite do
// grupo é marcado como fase1_titular_aguardando (ou fase1b_reserva_aguardando)
// com followup_count=1 — ou seja, o convite inicial individual fica "saltado" e
// a próxima cadência automática que o cron vai disparar é followup_dia_2 daqui 2 dias.
//
// Payload:
//   POST { convite_ids: string[] }
//
// Resposta:
//   { ok: true, grupos: number, enviados: number, falhas: number, details: [...] }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_GRAPH = "https://graph.facebook.com/v21.0";
const TZ = "America/Sao_Paulo";

function firstName(full: string | null | undefined): string {
  if (!full) return "";
  return full.trim().split(/\s+/)[0] ?? "";
}

function formatDateBR(dataYmd: string | null | undefined): string {
  if (!dataYmd) return "";
  const d = new Date(`${dataYmd}T12:00:00-03:00`);
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ, day: "2-digit", month: "long", year: "numeric",
  }).format(d);
}

function formatPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  return digits.startsWith("55") ? digits : `55${digits}`;
}

// A API da Meta REJEITA parâmetros de template que contenham quebra de linha,
// tab ou 4+ espaços consecutivos (erro 132000/131009). Por isso todo valor de
// parâmetro passa por aqui antes de ir no payload.
function sanitizeWaParam(s: string | null | undefined): string {
  return (s ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
  const details: any[] = [];
  let enviados = 0;
  let falhas = 0;

  try {
    const body = await req.json().catch(() => ({}));
    const convite_ids: string[] = Array.isArray(body?.convite_ids) ? body.convite_ids : [];
    if (convite_ids.length === 0) {
      return new Response(JSON.stringify({ ok: false, error: "convite_ids vazio" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 1) Template ativo
    const { data: template, error: tErr } = await supabase
      .from("ped_wa_templates")
      .select("nome, idioma, corpo, variaveis_mapping, botoes")
      .eq("uso_cadencia", "convite_semestre_lote")
      .eq("ativo", true)
      .eq("status", "aprovado")
      .maybeSingle();
    if (tErr) throw tErr;
    if (!template) {
      return new Response(JSON.stringify({
        ok: false,
        error: "Template 'convite_semestre_lote' ainda não está ativo/aprovado. Submeta à Meta primeiro.",
      }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 2) Conta WhatsApp
    const { data: waRow, error: waErr } = await supabase.rpc("get_wa_account_pedagogico");
    if (waErr) throw waErr;
    const wa = Array.isArray(waRow) ? waRow[0] : waRow;
    const phoneNumberId = wa?.phone_number_id;
    const accessToken = wa?.access_token;
    if (!phoneNumberId || !accessToken) {
      return new Response(JSON.stringify({ ok: false, error: "Conta WhatsApp Pedagógico não configurada" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3) Carrega convites + aula + pos + professor
    const { data: convites, error: cErr } = await supabase
      .from("ped_convites")
      .select(`
        id, status, papel, professor_atual_id, aula_id, metadata,
        aula:ped_aulas!inner(id, data, horario, titulo,
          pos:ped_pos_graduacoes(id, nome, instituicao)
        ),
        professor:ped_professores!ped_convites_professor_atual_id_fkey(id, nome, contato_whatsapp)
      `)
      .in("id", convite_ids)
      .eq("status", "aguardando_aprovacao_humana");
    if (cErr) throw cErr;

    if (!convites || convites.length === 0) {
      return new Response(JSON.stringify({
        ok: false,
        error: "Nenhum convite elegível em 'aguardando_aprovacao_humana'",
      }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 4) Agrupa por professor_atual_id
    const grupos = new Map<string, any[]>();
    for (const c of convites as any[]) {
      if (!c.professor_atual_id) continue;
      const arr = grupos.get(c.professor_atual_id) ?? [];
      arr.push(c);
      grupos.set(c.professor_atual_id, arr);
    }

    // 5) Para cada grupo: envia 1 mensagem
    for (const [profId, lista] of grupos.entries()) {
      const detail: any = { professor_id: profId, aulas: lista.length };
      try {
        const prof = lista[0].professor;
        const telefone = formatPhone(prof?.contato_whatsapp);
        if (!telefone) {
          detail.skipped = "professor_sem_whatsapp";
          details.push(detail);
          falhas++;
          continue;
        }

        // Ordena por data e monta lista_aulas
        const aulasOrdenadas = [...lista].sort((a: any, b: any) =>
          (a.aula?.data ?? "").localeCompare(b.aula?.data ?? "")
        );
        const linhasAulas = aulasOrdenadas.map((c: any) => {
          const dataFmt = formatDateBR(c.aula?.data);
          const pos = c.aula?.pos?.nome ?? "—";
          return `${dataFmt} — Pós em ${pos}`;
        });
        // Lista INLINE (sem \n): a Meta rejeita quebra de linha em parâmetro.
        // Os marcadores "•" separam visualmente as aulas dentro da mesma linha.
        const listaAulas = sanitizeWaParam("• " + linhasAulas.join("   • "));

        // Monta payload Meta com parâmetros do template
        const components: any[] = [
          {
            type: "body",
            parameters: [
              { type: "text", text: sanitizeWaParam(firstName(prof?.nome)) },
              { type: "text", text: listaAulas },
            ],
          },
        ];

        const waPayload = {
          messaging_product: "whatsapp",
          to: telefone,
          type: "template",
          template: {
            name: template.nome,
            language: { code: template.idioma || "pt_BR" },
            components,
          },
        };

        const r = await fetch(`${META_GRAPH}/${phoneNumberId}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(waPayload),
        });
        const waResp = await r.json().catch(() => ({}));
        console.log("[dispatch-semester-batch] meta resp:", r.status, JSON.stringify(waResp));
        if (!r.ok) {
          detail.error = waResp?.error?.message || `Meta API ${r.status}`;
          detail.meta_response = waResp;
          falhas++;
          details.push(detail);
          continue;
        }

        const waMsgId = waResp?.messages?.[0]?.id ?? null;
        const conteudoPersist = `[lote ${aulasOrdenadas.length} aulas] ${template.nome}`;
        const nowIso = new Date().toISOString();

        // 6) Cria/atualiza ped_conversas_avulsas (uma por professor)
        let conversaId: string | null = null;
        const { data: convExistente } = await supabase
          .from("ped_conversas_avulsas")
          .select("id")
          .eq("metadata->>prof_id", profId)
          .maybeSingle();
        if (convExistente?.id) {
          conversaId = convExistente.id;
          await supabase
            .from("ped_conversas_avulsas")
            .update({ ultima_atividade_em: nowIso, status: "em_conversa" })
            .eq("id", conversaId);
        } else {
          const { data: novaConv } = await supabase
            .from("ped_conversas_avulsas")
            .insert({
              tipo: "outbound_template",
              status: "em_conversa",
              ultima_atividade_em: nowIso,
              primeira_mensagem_em: nowIso,
              metadata: { telefone, prof_id: profId, origem: "despacho_semestre_lote" },
            })
            .select("id").single();
          conversaId = novaConv?.id ?? null;
        }

        // 7) Insere mensagem outbound (espelha pro SAC via trigger)
        if (conversaId) {
          await supabase.from("ped_conversas_mensagens").insert({
            conversa_id: conversaId,
            direcao: "outbound",
            conteudo: conteudoPersist,
            template_name: template.nome,
            professor_id: profId,
            wa_message_id: waMsgId,
            enviada_em: nowIso,
          });
        }

        // 8) Marca convites do grupo como em fase1 (titular ou reserva).
        // followup_count = 1 → o convite inicial individual já foi "consumido"
        // pelo lote; cron vai disparar followup_dia_2 daqui 2 dias.
        const proximaAcao = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
        for (const c of aulasOrdenadas) {
          const isReserva = (c.papel ?? "").toLowerCase().includes("reserva");
          const novoStatus = isReserva ? "fase1b_reserva_aguardando" : "fase1_titular_aguardando";
          await supabase
            .from("ped_convites")
            .update({
              status: novoStatus,
              followup_count: 1,
              proxima_acao_em: proximaAcao,
              metadata: { ...(c.metadata ?? {}), disparo_inicial_lote: true, lote_wa_message_id: waMsgId },
            })
            .eq("id", c.id);

          await supabase.from("ped_convites_eventos").insert({
            convite_id: c.id,
            aula_id: c.aula_id,
            tipo: "mensagem_enviada",
            payload: { template: template.nome, modo: "lote_semestre", wa_message_id: waMsgId, aulas_no_lote: aulasOrdenadas.length },
          });
        }

        // 9) Sincroniza SAC: upsert sac_contatos + cria/atualiza sac_atendimento ativo
        try {
          let contatoId: string | null = null;
          const { data: contatoExistente } = await supabase
            .from("sac_contatos")
            .select("id, tipo")
            .eq("telefone", telefone)
            .maybeSingle();
          if (contatoExistente?.id) {
            contatoId = contatoExistente.id;
            await supabase
              .from("sac_contatos")
              .update({ tipo: "professor", professor_id_ref: profId })
              .eq("id", contatoId);
          } else {
            const { data: novoContato } = await supabase
              .from("sac_contatos")
              .insert({ nome: prof.nome, telefone, tipo: "professor", professor_id_ref: profId })
              .select("id").single();
            contatoId = novoContato?.id ?? null;
          }

          if (contatoId) {
            const { data: atendAberto } = await supabase
              .from("sac_atendimentos")
              .select("id")
              .eq("contato_id", contatoId)
              .eq("status", "ativo")
              .maybeSingle();
            const { data: funilRow } = await supabase
              .from("sac_funis").select("id").order("created_at", { ascending: true }).limit(1).maybeSingle();
            const funilId = funilRow?.id;
            let etapaInicialId: string | null = null;
            if (funilId) {
              const { data: etapaRow } = await supabase
                .from("sac_funis_etapas").select("id")
                .eq("funil_id", funilId)
                .eq("comportamento_entrada", "auto_template_enviado")
                .eq("ativo", true)
                .order("ordem", { ascending: true }).limit(1).maybeSingle();
              etapaInicialId = etapaRow?.id ?? null;
            }
            if (atendAberto?.id) {
              await supabase.from("sac_atendimentos").update({
                ped_conversa_id_legacy: conversaId,
                ultima_mensagem_preview: conteudoPersist.slice(0, 140),
                ultima_mensagem_em: nowIso,
              }).eq("id", atendAberto.id);
            } else if (funilId && etapaInicialId) {
              await supabase.from("sac_atendimentos").insert({
                contato_id: contatoId, funil_id: funilId, etapa_id: etapaInicialId,
                status: "ativo", nao_lido: false,
                ultima_mensagem_preview: conteudoPersist.slice(0, 140),
                ultima_mensagem_em: nowIso, entrou_na_etapa_em: nowIso,
                ped_conversa_id_legacy: conversaId,
              });
            }
          }
        } catch (sErr: any) {
          console.log("[dispatch-semester-batch] sync SAC falhou:", sErr?.message);
        }

        enviados++;
        detail.wa_message_id = waMsgId;
        detail.conversa_id = conversaId;
        details.push(detail);
      } catch (e: any) {
        detail.error = e?.message ?? String(e);
        falhas++;
        details.push(detail);
      }
    }

    const primeiroErro = details.find((d: any) => d.error || d.skipped);
    return new Response(JSON.stringify({
      ok: true,
      grupos: grupos.size,
      enviados,
      falhas,
      primeiro_erro: primeiroErro ? (primeiroErro.error ?? primeiroErro.skipped) : null,
      details,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message ?? String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
