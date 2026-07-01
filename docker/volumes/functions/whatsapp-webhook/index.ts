import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const VERIFY_TOKEN = "ppgvet-pedagogico-v2";

const PUBLIC_SUPABASE_URL = Deno.env.get("PUBLIC_SUPABASE_URL") || "https://api.ppgeducacao.site";

function toPublicUrl(internalUrl: string): string {
  return internalUrl.replace(/^https?:\/\/kong:8000/i, PUBLIC_SUPABASE_URL);
}

// Mapeia texto/id de botão → ação no convite
// action: 'set_status' atualiza convite.status; 'trigger_reserva' aciona busca de reserva; 'log_only' só registra evento
type ButtonAction =
  | { kind: "set_status"; status: string }
  | { kind: "trigger_reserva" }
  | { kind: "confirm_lote_semestre" }
  | { kind: "log_only"; nota: string };

function mapButton(raw: string): ButtonAction | null {
  const t = (raw || "").trim().toLowerCase();
  if (!t) return null;
  // Lote de aulas do semestre — confirma todos os convites pendentes do prof
  if (t.includes("confirmo todas as datas") || t === "confirmo_lote_semestre")
    return { kind: "confirm_lote_semestre" };
  // Lote — abre janela manual com nota
  if (t.includes("preciso conversar sobre datas") || t === "conversar_lote_semestre")
    return { kind: "log_only", nota: "lote_semestre_quer_conversar" };
  if (
    t.includes("confirmo participação") || t.includes("confirmo participacao") ||
    t.includes("confirmo disponibilidade") || t === "confirmo_disponibilidade"
  )
    return { kind: "set_status", status: "fase1_titular_confirmado" };
  if (t.includes("não vou conseguir") || t.includes("nao vou conseguir") || t === "nao_vou_ministrar")
    return { kind: "trigger_reserva" };
  if (t.includes("sigo confirmado") || t === "sigo_confirmado")
    return { kind: "log_only", nota: "professor_segue_confirmado" };
  if (t.includes("preciso conversar") || t === "preciso_conversar")
    return { kind: "set_status", status: "pausado" };
  if (t.includes("aula concluída ok") || t.includes("aula concluida ok") || t === "aula_concluida_ok")
    return { kind: "log_only", nota: "aula_concluida_ok" };
  if (t.includes("tive um problema") || t === "tive_problema")
    return { kind: "log_only", nota: "aula_com_problema" };
  if (t.includes("recebimento confirmado") || t === "recebimento_confirmado")
    return { kind: "log_only", nota: "recebimento_confirmado" };
  if (t.includes("há divergência") || t.includes("ha divergencia") || t === "ha_divergencia")
    return { kind: "log_only", nota: "recebimento_divergente" };
  return null;
}

function normalizePhone(p: string): string {
  return (p || "").replace(/\D/g, "");
}

function phoneVariants(from: string): string[] {
  const n = normalizePhone(from);
  const variants = new Set<string>([from, n]);
  // Brasil: 55 + DDD + (9?) + 8 dígitos
  if (n.startsWith("55") && n.length >= 12) {
    const ddd = n.slice(2, 4);
    const rest = n.slice(4);
    if (rest.length === 9 && rest.startsWith("9")) {
      variants.add("55" + ddd + rest.slice(1)); // sem 9
    } else if (rest.length === 8) {
      variants.add("55" + ddd + "9" + rest); // com 9
    }
  }
  return [...variants].filter(Boolean);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);

  // === GET: verificação Meta ===
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    console.log("[whatsapp-webhook] GET verify", { mode, tokenOk: token === VERIFY_TOKEN, challenge });
    if (mode === "subscribe" && token === VERIFY_TOKEN && challenge) {
      return new Response(challenge, { status: 200, headers: { ...corsHeaders, "Content-Type": "text/plain" } });
    }
    return new Response("forbidden", { status: 403, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Roteamento: mensagens recebidas no número do PODCAST (convite de convidados) são
  // tratadas à parte — só qualificam INTERESSE, não entram no fluxo de convite de professor.
  let podcastPhoneId: string | null = null;
  try {
    const { data: pacc } = await supabase.rpc("get_wa_account_podcast");
    const acc = Array.isArray(pacc) ? pacc[0] : pacc;
    podcastPhoneId = acc?.phone_number_id ?? null;
  } catch (_e) { /* conta do podcast ainda não cadastrada */ }

  let body: any = null;
  try {
    body = await req.json();
    console.log("[whatsapp-webhook] POST body:", JSON.stringify(body));
  } catch (e) {
    console.log("[whatsapp-webhook] POST body parse error", (e as Error).message);
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  try {
    const entries = Array.isArray(body?.entry) ? body.entry : [];
    for (const entry of entries) {
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const change of changes) {
        const field = change?.field;
        const value = change?.value || {};
        console.log("[whatsapp-webhook] change.field=", field);

        // === MENSAGENS ===
        if (field === "messages") {
          // Número do PODCAST → só qualifica interesse (marca o candidato 'respondeu')
          if (podcastPhoneId && value?.metadata?.phone_number_id === podcastPhoneId) {
            try { await handlePodcastInbound(supabase, value); } catch (e) {
              console.error("[whatsapp-webhook] podcast inbound erro", String(e));
            }
            continue;
          }
          // === STATUS UPDATES (sent/delivered/read/failed) ===
          const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
          for (const status of statuses) {
            try {
              console.log("[whatsapp-webhook] status update:", JSON.stringify(status));
              const wamid = status?.id;
              const st = status?.status;
              const ts = status?.timestamp;
              if (!wamid || !st) continue;

              const update: Record<string, any> = {};
              if (st === "read" && ts) {
                update.lida_em = new Date(parseInt(String(ts), 10) * 1000).toISOString();
              }
              if (st === "failed") {
                update.classificacao_ia = { meta_error: status?.errors || null, status: "failed" };
                console.error("[whatsapp-webhook] Mensagem falhou:", wamid, JSON.stringify(status?.errors || []));
              }

              if (Object.keys(update).length > 0) {
                const { error: stErr } = await supabase
                  .from("ped_conversas_mensagens")
                  .update(update)
                  .eq("wa_message_id", wamid);
                if (stErr) console.log("[whatsapp-webhook] update status erro:", stErr.message);

                // Espelha status para sac_mensagens (fonte de verdade nova)
                const sacUpdate: Record<string, any> = {};
                if (st === "delivered") sacUpdate.status_entrega = "entregue";
                else if (st === "read") sacUpdate.status_entrega = "lida";
                else if (st === "sent") sacUpdate.status_entrega = "enviada";
                else if (st === "failed") {
                  sacUpdate.status_entrega = "falhou";
                  sacUpdate.erro_codigo = String(status?.errors?.[0]?.code ?? "");
                }
                if (Object.keys(sacUpdate).length > 0) {
                  const { error: sacStErr } = await supabase
                    .from("sac_mensagens")
                    .update(sacUpdate)
                    .eq("wa_message_id", wamid);
                  if (sacStErr) console.log("[whatsapp-webhook] update sac status erro:", sacStErr.message);
                }
              }
            } catch (sErr: any) {
              console.log("[whatsapp-webhook] erro status:", sErr.message, sErr.stack);
            }
          }

          const messages = Array.isArray(value?.messages) ? value.messages : [];
          for (const msg of messages) {
            try {
              const from: string = msg?.from || "";
              let tipoEvento: "inbound_text" | "inbound_button" | "inbound_media" = "inbound_text";
              let buttonRaw = "";
              let textoLivre = "";
              let mediaInbound: { tipo: string; id: string; mime_type?: string; filename?: string; caption?: string } | null = null;
              // Quando o usuário responde citando uma mensagem nossa, a Meta envia
              // `context.id` apontando para o wa_message_id da mensagem original.
              const replyToWaMessageId: string | null = msg?.context?.id || null;

              if (msg?.type === "interactive" && msg?.interactive?.type === "button_reply") {
                tipoEvento = "inbound_button";
                buttonRaw = msg.interactive.button_reply?.id || msg.interactive.button_reply?.title || "";
              } else if (msg?.type === "button") {
                tipoEvento = "inbound_button";
                buttonRaw = msg.button?.payload || msg.button?.text || "";
              } else if (msg?.type === "text") {
                tipoEvento = "inbound_text";
                textoLivre = msg.text?.body || "";
              } else if (msg?.type === "audio" || msg?.type === "voice") {
                tipoEvento = "inbound_media";
                mediaInbound = { tipo: "audio", id: msg.audio?.id, mime_type: msg.audio?.mime_type };
              } else if (msg?.type === "image") {
                tipoEvento = "inbound_media";
                mediaInbound = { tipo: "image", id: msg.image?.id, mime_type: msg.image?.mime_type, caption: msg.image?.caption };
              } else if (msg?.type === "video") {
                tipoEvento = "inbound_media";
                mediaInbound = { tipo: "video", id: msg.video?.id, mime_type: msg.video?.mime_type, caption: msg.video?.caption };
              } else if (msg?.type === "document") {
                tipoEvento = "inbound_media";
                mediaInbound = { tipo: "document", id: msg.document?.id, mime_type: msg.document?.mime_type, filename: msg.document?.filename, caption: msg.document?.caption };
              } else if (msg?.type === "sticker") {
                tipoEvento = "inbound_media";
                mediaInbound = { tipo: "sticker", id: msg.sticker?.id, mime_type: msg.sticker?.mime_type || "image/webp" };
              } else if (msg?.type === "reaction") {
                // Reação a uma mensagem (emoji). Antes caía no else e virava
                // conteúdo vazio -> card mostrava o "[anexo]" genérico.
                textoLivre = msg.reaction?.emoji
                  ? `↩️ Reagiu ${msg.reaction.emoji}`
                  : "↩️ Reação removida";
              } else if (msg?.type === "location") {
                const loc = msg.location || {};
                const ref = loc.name || loc.address;
                textoLivre = ref ? `📍 Localização: ${ref}` : "📍 Localização";
              } else if (msg?.type === "contacts") {
                const nomeContato = msg.contacts?.[0]?.name?.formatted_name;
                textoLivre = nomeContato ? `👤 Contato: ${nomeContato}` : "👤 Contato";
              } else {
                // Tipo desconhecido / "unsupported" (enquete, ver-uma-vez, etc.):
                // a Meta NÃO entrega o arquivo. Registra O QUE chegou em vez de
                // gravar vazio — que era o que virava "[anexo]" no card e deixava
                // o atendente sem saber o que o contato mandou.
                textoLivre = `⚠️ Mensagem não suportada${msg?.type ? ` (${msg.type})` : ""}`;
                console.log("[whatsapp-webhook] msg type nao suportado:", msg?.type);
              }

              console.log("[whatsapp-webhook] msg", { from, tipoEvento, buttonRaw, textoLivre, mediaInbound });

              // busca professor por telefone NORMALIZADO (tolera 55, o 9 e a
              // formatação salva no banco — ex.: "(51) 9739-3008"). A comparação
              // direta por string nunca casava com o número só-dígitos do webhook.
              const variants = phoneVariants(from);
              let prof: any = null;
              const { data: profMatch, error: profErr } = await supabase
                .rpc("ped_professor_por_whatsapp", { p_telefone: from });
              if (profErr) console.log("[whatsapp-webhook] prof lookup erro:", profErr.message);
              prof = (Array.isArray(profMatch) ? profMatch[0] : profMatch) || null;
              // fallback: tentativa antiga por igualdade exata (caso algum número já esteja só em dígitos)
              if (!prof) {
                const { data: profs } = await supabase
                  .from("ped_professores")
                  .select("id, nome, contato_whatsapp")
                  .in("contato_whatsapp", variants);
                prof = profs?.[0] || null;
              }
              console.log("[whatsapp-webhook] prof match", prof?.id || "none", "from", from);

              // busca convite ativo (apenas se botão; texto não atualiza convite)
              let convite: any = null;
              if (prof && tipoEvento === "inbound_button") {
                const { data: convites, error: convErr } = await supabase
                  .from("ped_convites")
                  .select("id, aula_id, status")
                  .eq("professor_atual_id", prof.id)
                  .in("status", [
                    "fase1_titular_aguardando",
                    "fase1b_reserva_aguardando",
                    "fase2_reconfirmacao_30d",
                    "fase2_reconfirmacao_14d",
                    "fase2_reconfirmacao_7d",
                    "fase2_lembrete_1d",
                  ])
                  .order("proxima_acao_em", { ascending: false })
                  .limit(1);
                if (convErr) console.log("[whatsapp-webhook] convite lookup erro:", convErr.message);
                convite = convites?.[0] || null;
                console.log("[whatsapp-webhook] convite ativo", convite?.id || "none");
              }

              // ação do botão
              let assunto = textoLivre ? `Mensagem livre: ${textoLivre.slice(0, 60)}` : "Resposta sem texto";
              let acaoLog: any = { tipo: "nenhuma" };

              if (tipoEvento === "inbound_button" && buttonRaw) {
                const action = mapButton(buttonRaw);
                assunto = `Botão: ${buttonRaw}`;
                console.log("[whatsapp-webhook] button mapped", buttonRaw, "→", action);

                if (action?.kind === "confirm_lote_semestre" && prof?.id) {
                  // Confirma TODOS os convites do prof que foram enviados no mesmo lote
                  // (metadata.disparo_inicial_lote = true) e ainda não confirmados.
                  const { data: lote } = await supabase
                    .from("ped_convites")
                    .select("id, status, papel")
                    .eq("professor_atual_id", prof.id)
                    .in("status", ["fase1_titular_aguardando", "fase1b_reserva_aguardando"])
                    .contains("metadata", { disparo_inicial_lote: true });
                  let confirmados = 0;
                  for (const c of (lote ?? []) as any[]) {
                    const novoStatus = (c.papel ?? "").toLowerCase().includes("reserva")
                      ? "fase1b_reserva_confirmado"
                      : "fase1_titular_confirmado";
                    await supabase.from("ped_convites").update({ status: novoStatus }).eq("id", c.id);
                    await supabase.from("ped_convites_eventos").insert({
                      convite_id: c.id,
                      tipo: "botao_clicado",
                      payload: { msg, acao: { tipo: "confirm_lote_semestre", novo_status: novoStatus } },
                    });
                    confirmados++;
                  }
                  acaoLog = { tipo: "confirm_lote_semestre", confirmados };
                } else if (convite && action) {
                  if (action.kind === "set_status") {
                    await supabase.from("ped_convites").update({ status: action.status }).eq("id", convite.id);
                    acaoLog = { tipo: "set_status", status: action.status };
                  } else if (action.kind === "trigger_reserva") {
                    await supabase.from("ped_convites").update({ status: "fase1_titular_recusado" }).eq("id", convite.id);
                    acaoLog = { tipo: "trigger_reserva" };
                  } else if (action.kind === "log_only") {
                    acaoLog = { tipo: "log_only", nota: action.nota };
                  }

                  await supabase.from("ped_convites_eventos").insert({
                    convite_id: convite.id,
                    tipo: "botao_clicado",
                    payload: { msg, acao: acaoLog },
                  });
                }
              }

              // conteúdo da mensagem real
              const conteudoMsg =
                textoLivre ||
                (msg?.interactive?.button_reply?.title || msg?.interactive?.button_reply?.id) ||
                (msg?.button?.text || msg?.button?.payload) ||
                (mediaInbound?.caption) ||
                (mediaInbound ? `[${mediaInbound.tipo}]` : "");
              const profileName = value?.contacts?.[0]?.profile?.name || null;
              const nowIso = new Date().toISOString();
              const enviadaEm = msg?.timestamp
                ? new Date(parseInt(String(msg.timestamp), 10) * 1000).toISOString()
                : nowIso;

              // 1) busca conversa avulsa existente por telefone.
              // IMPORTANTE: casa por VARIANTES ±9º dígito. A Meta entrega o wa_id
              // do lead BR sem o 9º dígito, mas o convite de saída gravou o telefone
              // COM o 9 (cadastro do professor) — casar exato criava um 2º card.
              let conversaId: string | null = null;
              {
                for (const tel of phoneVariants(from)) {
                  const { data: existentes, error: findErr } = await supabase
                    .from("ped_conversas_avulsas")
                    .select("id")
                    .contains("metadata", { telefone: tel })
                    .order("ultima_atividade_em", { ascending: false })
                    .limit(1);
                  if (findErr) console.log("[whatsapp-webhook] find conversa erro:", findErr.message);
                  if (existentes?.[0]?.id) { conversaId = existentes[0].id; break; }
                }
              }

              if (conversaId) {
                // 2a) UPDATE atividade
                const { error: upErr } = await supabase
                  .from("ped_conversas_avulsas")
                  .update({ ultima_atividade_em: nowIso })
                  .eq("id", conversaId);
                if (upErr) console.log("[whatsapp-webhook] update conversa erro:", upErr.message);
              } else {
                // 2b) cria nova conversa
                const previewAssunto = (conteudoMsg || assunto).slice(0, 50);
                const { data: novaConv, error: insErr } = await supabase
                  .from("ped_conversas_avulsas")
                  .insert({
                    tipo: tipoEvento,
                    assunto: previewAssunto,
                    professores_alvo: prof ? [prof.id] : [],
                    status: "inbox",
                    contexto_convite_id: convite?.id || null,
                    contexto_aula_id: convite?.aula_id || null,
                    primeira_mensagem_em: nowIso,
                    ultima_atividade_em: nowIso,
                    metadata: {
                      telefone: from,
                      profile_name: profileName,
                      prof_id: prof?.id || null,
                      acao: acaoLog,
                    },
                  })
                  .select("id")
                  .single();
                if (insErr) console.log("[whatsapp-webhook] insert conversa erro:", insErr.message);
                conversaId = novaConv?.id || null;
              }

              // 3) Se for mídia, baixar da Meta e salvar no Storage
              let anexos: any[] = [];
              if (mediaInbound?.id) {
                try {
                  const { data: waRow } = await supabase.rpc("get_wa_account_pedagogico");
                  const wa = Array.isArray(waRow) ? waRow[0] : waRow;
                  const accessToken: string | undefined = wa?.access_token;
                  if (accessToken) {
                    // a) get media URL
                    const metaUrlRes = await fetch(`https://graph.facebook.com/v21.0/${mediaInbound.id}`, {
                      headers: { Authorization: `Bearer ${accessToken}` },
                    });
                    const metaUrlJson: any = await metaUrlRes.json().catch(() => ({}));
                    const mediaUrl: string | undefined = metaUrlJson?.url;
                    const mime: string = metaUrlJson?.mime_type || mediaInbound.mime_type || "application/octet-stream";
                    if (mediaUrl) {
                      // b) download bytes
                      const binRes = await fetch(mediaUrl, {
                        headers: { Authorization: `Bearer ${accessToken}` },
                      });
                      const bin = new Uint8Array(await binRes.arrayBuffer());
                      // c) upload to storage
                      const ext = (mime.includes("ogg") ? "ogg" :
                        mime.includes("mpeg") && mime.includes("audio") ? "mp3" :
                        mime.includes("mp4") && mime.includes("audio") ? "m4a" :
                        mime === "video/mp4" ? "mp4" :
                        mime === "image/jpeg" ? "jpg" :
                        mime === "image/png" ? "png" :
                        mime === "image/webp" ? "webp" :
                        mime === "application/pdf" ? "pdf" : "bin");
                      const path = `${new Date().toISOString().slice(0, 10)}/inbound-${crypto.randomUUID()}.${ext}`;
                      const { error: stErr } = await supabase.storage.from("whatsapp-anexos").upload(path, bin, {
                        contentType: mime, upsert: false,
                      });
                      if (stErr) {
                        console.log("[whatsapp-webhook] storage upload inbound fail:", stErr.message);
                      } else {
                        const pub = toPublicUrl(supabase.storage.from("whatsapp-anexos").getPublicUrl(path).data.publicUrl);
                        anexos = [{
                          tipo: mediaInbound.tipo,
                          mime_type: mime,
                          meta_media_id: mediaInbound.id,
                          url: pub,
                          url_storage: pub,
                          filename: mediaInbound.filename || `${mediaInbound.tipo}.${ext}`,
                        }];
                      }
                    } else {
                      console.log("[whatsapp-webhook] inbound media sem URL:", JSON.stringify(metaUrlJson));
                    }
                  }
                } catch (mediaErr: any) {
                  console.log("[whatsapp-webhook] erro download mídia inbound:", mediaErr.message);
                }
              }

              // 4) INSERT mensagem real
              if (conversaId) {
                const { error: msgInsErr } = await supabase.from("ped_conversas_mensagens").insert({
                  conversa_id: conversaId,
                  direcao: "inbound",
                  conteudo: conteudoMsg,
                  professor_id: prof?.id || null,
                  wa_message_id: msg?.id || null,
                  enviada_em: enviadaEm,
                  anexos,
                  reply_to_wa_message_id: replyToWaMessageId,
                });
                if (msgInsErr) console.log("[whatsapp-webhook] insert mensagem erro:", msgInsErr.message);
                else console.log("[whatsapp-webhook] mensagem salva conversa=", conversaId, "anexos=", anexos.length);
              }
            } catch (msgErr: any) {
              console.log("[whatsapp-webhook] erro msg:", msgErr.message, msgErr.stack);
            }
          }
        }

        // === STATUS DE TEMPLATE ===
        else if (field === "message_template_status_update") {
          try {
            const metaTemplateId = String(value?.message_template_id || "");
            const ev = String(value?.event || "").toUpperCase();
            const statusMap: Record<string, string> = {
              APPROVED: "aprovado",
              REJECTED: "rejeitado",
              PENDING: "pendente",
              FLAGGED: "pendente",
              PAUSED: "pausado",
              DISABLED: "rejeitado",
            };
            const novoStatus = statusMap[ev] || "pendente";
            console.log("[whatsapp-webhook] template status", { metaTemplateId, ev, novoStatus });

            if (metaTemplateId) {
              const { error: upErr } = await supabase
                .from("ped_wa_templates")
                .update({ status: novoStatus })
                .eq("meta_template_id", metaTemplateId);
              if (upErr) console.log("[whatsapp-webhook] update template erro:", upErr.message);
            }
            // NOTA: NÃO criamos conversa avulsa para eventos de status de template.
            // Apenas atualizamos ped_wa_templates acima.
          } catch (tplErr: any) {
            console.log("[whatsapp-webhook] erro template:", tplErr.message, tplErr.stack);
          }
        } else {
          console.log("[whatsapp-webhook] field não tratado:", field);
        }
      }
    }
  } catch (err: any) {
    console.log("[whatsapp-webhook] erro geral:", err.message, err.stack);
  }

  // Sempre 200 pro Meta não reenviar
  return new Response("ok", { status: 200, headers: corsHeaders });
});

// === PODCAST: número dedicado → só qualifica INTERESSE do convidado ===
// Qualquer resposta (botão "Tenho interesse"/"Quero saber mais" ou texto livre) marca o(s)
// candidato(s) ativo(s) daquele convidado como 'respondeu' → responsáveis do pedagógico assumem
// manualmente (SAC/e-mail). Não envia data/Calendly (automação só descobre interesse).
async function handlePodcastInbound(supabase: any, value: any) {
  const messages = Array.isArray(value?.messages) ? value.messages : [];
  for (const msg of messages) {
    const from: string = msg?.from || "";
    if (!from) continue;
    let resposta = "";
    if (msg?.type === "interactive" && msg?.interactive?.type === "button_reply") {
      resposta = msg.interactive.button_reply?.title || msg.interactive.button_reply?.id || "";
    } else if (msg?.type === "button") {
      resposta = msg.button?.text || msg.button?.payload || "";
    } else if (msg?.type === "text") {
      resposta = msg.text?.body || "";
    } else {
      resposta = `[${msg?.type || "mensagem"}]`;
    }

    // match do convidado por telefone (variantes ±9º dígito)
    const { data: prof } = await supabase.rpc("ped_professor_por_whatsapp", { p_telefone: from });
    const profRow = Array.isArray(prof) ? prof[0] : prof;
    if (!profRow?.id) {
      console.log("[whatsapp-webhook] podcast: convidado não encontrado p/", from);
      continue;
    }

    const { data: cands } = await supabase
      .from("pod_convite_candidatos")
      .select("id, metadata")
      .eq("professor_id", profRow.id)
      .in("status", ["na_fila", "convidando"]);
    for (const c of (cands ?? [])) {
      await supabase.from("pod_convite_candidatos")
        .update({
          status: "respondeu",
          respondeu_em: new Date().toISOString(),
          metadata: { ...(c.metadata || {}), ultima_resposta: resposta },
        })
        .eq("id", c.id);
    }
    console.log("[whatsapp-webhook] podcast:", profRow.id, "respondeu:", resposta, "→", (cands ?? []).length, "cand.");
  }
}
