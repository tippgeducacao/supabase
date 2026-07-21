// pod-convite-dispatch: motor da cadência de convite de CONVIDADOS de podcast.
// Automação = SÓ qualificar interesse. 3 toques a cada 2 dias, e-mail + WhatsApp (Meta) juntos.
// Gate: podcast_dispatch_mode ('off' = só dispara ondas aprovadas via pod_convite_aprovar_onda).
// Interessou (botão/resposta) → webhook marca 'respondeu' (humano assume no SAC/e-mail).
// Silêncio após o 3º toque → 'silenciou' + convidado vira 'convidar_em_6m' (+6 meses).
// NÃO envia enquanto: não houver conta WA do podcast (token) OU o template não estiver 'aprovado'.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { ensureToken, base64UrlEncode, encodeHeaderUtf8, encodeDisplayName } from "../_shared/gmail.ts";
import { logPodcastConversaSac } from "../_shared/podcastSac.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const META_GRAPH = "https://graph.facebook.com/v21.0";

// toque a enviar (0->1 convite, 1->2 followup1, 2->3 followup2) => uso_cadencia
const TOQUE_TEMPLATE: Record<number, string> = {
  1: "podcast_convite",
  2: "podcast_followup_1",
  3: "podcast_followup_2",
};
// FASE DE AGENDAMENTO (Interessado): templates dos follow-ups 1/2/3 que empurram a gravação.
const TOQUE_TEMPLATE_AGENDA: Record<number, string> = {
  1: "podcast_agenda_1",
  2: "podcast_agenda_2",
  3: "podcast_agenda_3",
};

function primeiroNome(nome?: string | null): string {
  return String(nome ?? "").trim().split(/\s+/)[0] || "Professor(a)";
}
// Meta rejeita \n/tab/4+ espaços em PARÂMETRO de template
function sanitizeWaParam(s: string): string {
  return String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{4,}/g, "   ").trim();
}
function formatPhone(raw?: string | null): string | null {
  if (!raw) return null;
  const t = String(raw).trim();
  const intl = t.startsWith("+");
  let d = t.replace(/\D/g, "");
  if (!d) return null;
  if (intl) return d; // já com DDI internacional
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) return d;
  // Número brasileiro sem DDI: DDD + 8 dígitos (fixo) ou DDD + 9xxxxxxxx (celular).
  // Celular BR de 11 dígitos SEMPRE tem '9' no 3º dígito — 11 dígitos sem esse 9 é
  // internacional sem DDI (ex.: wa_id dos EUA, 1+10) e NÃO pode ganhar 55.
  if (d.length === 10 || (d.length === 11 && d[2] === "9")) return "55" + d;
  return d;
}
function htmlEscape(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
// Número do PODCAST (nosso) p/ montar o link wa.me: só dígitos (aceita "+55 46 ...", "554699101299").
function waDigits(raw?: string | null): string {
  return String(raw ?? "").replace(/\D/g, "");
}
// Exibição amigável do nosso número: +55 (DD) NNNNN-NNNN / +55 (DD) NNNN-NNNN.
function formatWaDisplay(digits: string): string {
  const d = String(digits ?? "").replace(/\D/g, "");
  if (d.startsWith("55") && d.length === 13) return `+55 (${d.slice(2, 4)}) ${d.slice(4, 9)}-${d.slice(9)}`;
  if (d.startsWith("55") && d.length === 12) return `+55 (${d.slice(2, 4)}) ${d.slice(4, 8)}-${d.slice(8)}`;
  return d ? `+${d}` : "";
}
// Link "chamar no WhatsApp" já com a mensagem de interesse pré-preenchida.
function waLink(digits: string, msg: string): string {
  return `https://wa.me/${digits}?text=${encodeURIComponent(msg)}`;
}
// Bloco HTML: botão verde "Agendar episódio no WhatsApp" + convite pra levar a conversa pro zap.
// Se não houver número do podcast, cai no fallback "responda este e-mail".
function blocoWhatsapp(nome: string, podcast: string, waNumero: string): string {
  const digits = waDigits(waNumero);
  if (!digits) {
    return `<p><strong>Tem interesse?</strong> É só responder este e-mail. 🙂</p>`;
  }
  const msg = `Olá! Vi o convite de vocês e tenho interesse em gravar um episódio no ${podcast} Podcast 🎙️`;
  const link = htmlEscape(waLink(digits, msg));
  const display = htmlEscape(formatWaDisplay(digits));
  return (
    `<div style="margin:28px 0;text-align:center;">` +
      `<a href="${link}" style="display:inline-block;background-color:#25D366;color:#ffffff;` +
      `text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;` +
      `padding:15px 32px;border-radius:12px;box-shadow:0 2px 6px rgba(37,211,102,0.35);">` +
      `💬 Agendar episódio no WhatsApp</a>` +
      `<div style="margin-top:10px;color:#6b7280;font-family:Arial,Helvetica,sans-serif;font-size:13px;">` +
      `Responde na hora — é bem mais rápido por lá 😉</div>` +
    `</div>` +
    `<p>Prefere conversar pelo <strong>WhatsApp</strong>? É só tocar no botão acima ou me chamar direto no ` +
    `<a href="${link}">${display}</a>. E se preferir que <strong>eu</strong> te chame, é só responder este ` +
    `e-mail com o seu número que eu falo com você por lá. 🙂</p>` +
    `<p>Se preferir seguir por aqui mesmo, também pode responder este e-mail.</p>`
  );
}
// Renderiza o corpo do template ({{1}},{{2}}…) com os parâmetros — texto legível p/ o SAC.
function renderTemplate(corpo: string | null | undefined, params: Array<{ text: string }>): string {
  let t = String(corpo ?? "");
  params.forEach((p, i) => { t = t.split(`{{${i + 1}}}`).join(p.text ?? ""); });
  return t.trim();
}
// resolve o valor de uma variável do template pelo NOME semântico (variaveis_mapping)
function resolverVar(nomeVar: string, ctx: { nome: string; podcast: string; youtube: string }): string {
  const v = String(nomeVar ?? "").toLowerCase();
  if (v.includes("youtube")) return ctx.youtube;
  if (v.includes("podcast")) return ctx.podcast;
  if (v.includes("nome") || v.includes("convidado")) return ctx.nome;
  return "";
}

Deno.serve(handler);

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    // FASE DE AGENDAMENTO (Interessado): envio de UM convidado, sob demanda (clique do
    // atendente = a aprovação). NÃO é o cron — o cron nunca manda body com modo 'agenda'.
    // Gate: só usuário do pedagógico dispara (o modo envia mensagem real a uma pessoa).
    const body = await req.json().catch(() => ({} as any));
    if (body?.modo === "agenda" && body?.candidato_id) {
      const authHeader = req.headers.get("Authorization") ?? "";
      const userClient = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_ANON_KEY") ?? "",
        { global: { headers: { Authorization: authHeader } } },
      );
      const { data: { user } } = await userClient.auth.getUser();
      if (!user) return json({ ok: false, error: "não autenticado" }, 401);
      const { data: pode } = await admin.rpc("user_can_access_pedagogico", { _user_id: user.id });
      if (!pode) return json({ ok: false, error: "sem permissão (pedagógico)" }, 403);
      return await dispatchAgenda(admin, String(body.candidato_id), json);
    }

    let mode = "off";
    let intervaloH = 48;
    let caixaId: string | null = null;
    {
      const { data: cfg } = await admin
        .from("ped_configuracoes")
        .select("chave, valor")
        .in("chave", ["podcast_dispatch_mode", "podcast_toque_intervalo_horas", "podcast_email_caixa_id"]);
      const map = new Map((cfg ?? []).map((c: any) => [c.chave, c.valor]));
      mode = (map.get("podcast_dispatch_mode") as string) || "off";
      intervaloH = parseInt((map.get("podcast_toque_intervalo_horas") as string) || "48", 10) || 48;
      caixaId = (map.get("podcast_email_caixa_id") as string) || null;
    }
    const proximaEm = () => new Date(Date.now() + intervaloH * 3600_000).toISOString();

    // conta WA do podcast (token). Sem ela, não dá pra fazer "e-mail + WhatsApp juntos".
    const { data: waRow } = await admin.rpc("get_wa_account_podcast");
    const wa = Array.isArray(waRow) ? waRow[0] : waRow;
    if (!wa?.phone_number_id || !wa?.access_token) {
      return json({ ok: true, skipped: "sem_conta_wa_podcast (token não cadastrado)", enviados: 0 });
    }

    // templates aprovados por uso_cadencia
    const { data: tpls } = await admin
      .from("ped_wa_templates")
      .select("id, nome, idioma, corpo, uso_cadencia, botoes, status, ativo, variaveis_mapping")
      .in("uso_cadencia", ["podcast_convite", "podcast_followup_1", "podcast_followup_2"])
      .eq("status", "aprovado")
      .eq("ativo", true);
    const tplPorUso = new Map((tpls ?? []).map((t: any) => [t.uso_cadencia, t]));

    // caixa de e-mail (resolvida 1x)
    const emailCtx = await resolverEmail(admin, caixaId);

    const nowIso = new Date().toISOString();
    const SEL = "id, podcast_id, professor_id, status, toque, aprovado_em, proxima_acao_em, " +
      "professor:ped_professores(nome,email,contato_whatsapp), podcast:ped_podcasts(nome,youtube_url)";

    // 1) toque inicial: na_fila liberados (mode on OU onda aprovada)
    let q1 = admin.from("pod_convite_candidatos").select(SEL).eq("status", "na_fila").limit(60);
    if (mode !== "on") q1 = q1.not("aprovado_em", "is", null);
    const { data: novos } = await q1;

    // 2) follow-ups vencidos
    const { data: seguindo } = await admin
      .from("pod_convite_candidatos").select(SEL)
      .eq("status", "convidando").lte("proxima_acao_em", nowIso).limit(120);

    const fila = [...(novos ?? []), ...(seguindo ?? [])];
    let enviados = 0, silenciados = 0, pulados = 0, erros = 0;

    for (const c of fila) {
      try {
        const proxToque = (c.toque ?? 0) + 1;

        // esgotou os 3 toques → silenciou + convidado 'convidar_em_6m'
        if (proxToque > 3) {
          // guarda anti-corrida: se respondeu (webhook/e-mail/manual) entre o SELECT da fila
          // e aqui, NÃO sobrescreve nem rebaixa o convidado
          const { data: sil } = await admin.from("pod_convite_candidatos")
            .update({ status: "silenciou" }).eq("id", c.id)
            .in("status", ["na_fila", "convidando"]).select("id");
          if ((sil ?? []).length > 0) {
            const seis = new Date(); seis.setMonth(seis.getMonth() + 6);
            await admin.from("ped_professores")
              .update({ status_podcast: "convidar_em_6m", reconvidar_a_partir_de: seis.toISOString().slice(0, 10) })
              .eq("id", c.professor_id)
              .eq("status_podcast", "a_convidar"); // só rebaixa quem ainda está 'a_convidar'
            silenciados++;
          }
          continue;
        }

        const tpl = tplPorUso.get(TOQUE_TEMPLATE[proxToque]);
        if (!tpl) { pulados++; continue; } // template não aprovado ainda

        const nome = primeiroNome(c.professor?.nome);
        const podcastNome = c.podcast?.nome ?? "podcast";
        const youtube = c.podcast?.youtube_url ?? "";
        const varCtx = { nome, podcast: podcastNome, youtube };

        // parâmetros na ordem {{1}},{{2}},{{3}}... a partir do variaveis_mapping do template
        const vm = (tpl.variaveis_mapping && typeof tpl.variaveis_mapping === "object")
          ? tpl.variaveis_mapping : { "1": "nome_convidado", "2": "nome_podcast" };
        const bodyParams = Object.keys(vm).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b))
          .map((k) => ({ type: "text", text: sanitizeWaParam(resolverVar(vm[k], varCtx)) }));

        // ---- WhatsApp (Meta template) ----
        const to = formatPhone(c.professor?.contato_whatsapp);
        let waOk = false;
        let waMsgId: string | null = null;
        if (to) {
          const payload = {
            messaging_product: "whatsapp",
            to,
            type: "template",
            template: {
              name: tpl.nome,
              language: { code: tpl.idioma || "pt_BR" },
              components: [{ type: "body", parameters: bodyParams }],
            },
          };
          const r = await fetch(`${META_GRAPH}/${wa.phone_number_id}/messages`, {
            method: "POST",
            headers: { Authorization: `Bearer ${wa.access_token}`, "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          waOk = r.ok;
          const waResp = await r.json().catch(() => ({} as any));
          if (r.ok) {
            waMsgId = waResp?.messages?.[0]?.id ?? null;
            // Espelha o convite no SAC pedagógico (funil "Atendimento"): find-or-create da
            // conversa do convidado + mensagem OUTBOUND. A resposta pela SAC sairá pelo
            // número do podcast (metadata.wa_account_id). Best-effort — não derruba o disparo.
            const textoConvite = renderTemplate(tpl.corpo, bodyParams) || `Convite ${podcastNome}`;
            await logPodcastConversaSac(admin, {
              professorId: c.professor_id,
              telefone: c.professor?.contato_whatsapp ?? null,
              nome: c.professor?.nome ?? null,
              podcastId: c.podcast_id,
              waAccountId: wa.id ?? null,
              direcao: "outbound",
              conteudo: textoConvite,
              waMessageId: waMsgId,
              templateName: tpl.nome,
              enviadaEm: nowIso,
            });
          } else {
            console.error("[pod-dispatch] wa fail", c.id, JSON.stringify(waResp));
          }
        }

        // ---- E-mail (best-effort) ----
        let emailOk = false;
        if (emailCtx && c.professor?.email) {
          emailOk = await enviarEmail(emailCtx, c.professor.email, nome, podcastNome, youtube, proxToque, wa.phone_number ?? "");
        }

        // ---- atualiza estado ----
        const upd: Record<string, any> = {
          status: "convidando",
          toque: proxToque,
          ultimo_toque_em: nowIso,
          proxima_acao_em: proximaEm(),
        };
        if (waOk) upd.wpp_enviado_em = nowIso;
        if (emailOk) upd.email_enviado_em = nowIso;
        // .in(status): se o convidado respondeu DURANTE esta rodada (webhook do WhatsApp,
        // trigger de e-mail ou marcação manual), não volta o status pra 'convidando'
        await admin.from("pod_convite_candidatos").update(upd)
          .eq("id", c.id).in("status", ["na_fila", "convidando"]);
        if (waOk || emailOk) enviados++; else erros++;
      } catch (e) {
        erros++;
        console.error("[pod-dispatch] erro candidato", c.id, String(e));
      }
    }

    return json({ ok: true, mode, enviados, silenciados, pulados, erros, processados: fila.length });
  } catch (e) {
    console.error("[pod-dispatch] fatal", String(e));
    return json({ ok: false, error: String(e) }, 500);
  }
}

// FASE DE AGENDAMENTO — envia UM follow-up de agendamento para UM convidado 'respondeu'
// (chamado pelo clique do atendente na tela; o clique É a aprovação). Reusa toda a máquina
// de envio (template Meta por uso_cadencia 'podcast_agenda_N' + e-mail 0704/5/6 + SAC).
// WhatsApp só sai se o template estiver 'aprovado' na Meta; senão vai só e-mail (no-op no zap).
async function dispatchAgenda(admin: any, candidatoId: string, json: (b: unknown, s?: number) => Response): Promise<Response> {
  const { data: cfg } = await admin
    .from("ped_configuracoes").select("chave, valor")
    .in("chave", ["podcast_agenda_intervalo_horas", "podcast_email_caixa_id"]);
  const map = new Map((cfg ?? []).map((c: any) => [c.chave, c.valor]));
  const intervaloH = parseInt((map.get("podcast_agenda_intervalo_horas") as string) || "72", 10) || 72;
  const caixaId = (map.get("podcast_email_caixa_id") as string) || null;
  const nowIso = new Date().toISOString();
  const proximaEm = new Date(Date.now() + intervaloH * 3600_000).toISOString();

  const { data: c } = await admin
    .from("pod_convite_candidatos")
    .select("id, podcast_id, professor_id, status, agenda_toque, professor:ped_professores(nome,email,contato_whatsapp), podcast:ped_podcasts(nome,youtube_url)")
    .eq("id", candidatoId).maybeSingle();
  if (!c) return json({ ok: false, error: "candidato não encontrado" }, 404);
  if (c.status !== "respondeu") return json({ ok: false, error: `candidato não está em Interessado (status=${c.status})` }, 409);

  const proxToque = (c.agenda_toque ?? 0) + 1;
  if (proxToque > 3) return json({ ok: false, error: "esgotou os 3 follow-ups de agendamento", esgotado: true }, 409);

  const nome = primeiroNome(c.professor?.nome);
  const podcastNome = c.podcast?.nome ?? "podcast";
  const youtube = c.podcast?.youtube_url ?? "";

  // ---- WhatsApp (Meta template 'podcast_agenda_N', se aprovado + convidado tem número) ----
  const { data: waRow } = await admin.rpc("get_wa_account_podcast");
  const wa = Array.isArray(waRow) ? waRow[0] : waRow;
  const { data: tpls } = await admin
    .from("ped_wa_templates")
    .select("nome, idioma, corpo, variaveis_mapping")
    .eq("uso_cadencia", TOQUE_TEMPLATE_AGENDA[proxToque]).eq("status", "aprovado").eq("ativo", true).limit(1);
  const tpl = (tpls ?? [])[0];

  const to = formatPhone(c.professor?.contato_whatsapp);
  let waOk = false;
  if (wa?.phone_number_id && wa?.access_token && tpl && to) {
    const vm = (tpl.variaveis_mapping && typeof tpl.variaveis_mapping === "object")
      ? tpl.variaveis_mapping : { "1": "nome_convidado", "2": "nome_podcast" };
    const bodyParams = Object.keys(vm).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b))
      .map((k) => ({ type: "text", text: sanitizeWaParam(resolverVar(vm[k], { nome, podcast: podcastNome, youtube })) }));
    const r = await fetch(`${META_GRAPH}/${wa.phone_number_id}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${wa.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp", to, type: "template",
        template: { name: tpl.nome, language: { code: tpl.idioma || "pt_BR" }, components: [{ type: "body", parameters: bodyParams }] },
      }),
    });
    waOk = r.ok;
    const waResp = await r.json().catch(() => ({} as any));
    if (r.ok) {
      const textoAgenda = renderTemplate(tpl.corpo, bodyParams) || `Follow-up de agendamento · ${podcastNome}`;
      await logPodcastConversaSac(admin, {
        professorId: c.professor_id, telefone: c.professor?.contato_whatsapp ?? null, nome: c.professor?.nome ?? null,
        podcastId: c.podcast_id, waAccountId: wa.id ?? null, direcao: "outbound",
        conteudo: textoAgenda, waMessageId: waResp?.messages?.[0]?.id ?? null, templateName: tpl.nome, enviadaEm: nowIso,
      });
    } else {
      console.error("[pod-dispatch agenda] wa fail", c.id, JSON.stringify(waResp));
    }
  }

  // ---- E-mail (best-effort; templates 0704/5/6) ----
  let emailOk = false;
  const emailCtx = await resolverEmail(admin, caixaId, TEMPLATE_EMAIL_AGENDA);
  if (emailCtx && c.professor?.email) {
    emailOk = await enviarEmail(emailCtx, c.professor.email, nome, podcastNome, youtube, proxToque, wa?.phone_number ?? "", "agenda");
  }

  if (!waOk && !emailOk) {
    return json({
      ok: false,
      error: to || c.professor?.email
        ? "não foi possível enviar (WhatsApp e e-mail falharam ou o template do WhatsApp ainda não foi aprovado e o convidado não tem e-mail)"
        : "convidado sem e-mail e sem WhatsApp válido",
      enviados: 0,
    }, 422);
  }

  const upd: Record<string, any> = {
    agenda_toque: proxToque, agenda_ultimo_toque_em: nowIso, agenda_proxima_acao_em: proximaEm,
  };
  if (waOk) upd.agenda_wpp_em = nowIso;
  if (emailOk) upd.agenda_email_em = nowIso;
  // guard: só avança quem ainda está 'respondeu' (não sobrescreve se o atendente mudou o status)
  await admin.from("pod_convite_candidatos").update(upd).eq("id", c.id).eq("status", "respondeu");

  return json({ ok: true, enviados: (waOk ? 1 : 0) + (emailOk ? 1 : 0), wa: waOk, email: emailOk, toque: proxToque });
}

// Os 3 e-mails automáticos viraram templates EDITÁVEIS na aba Templates (ids fixos). Se existirem e
// estiverem ativos, o motor usa o corpo editável; senão cai no corpo embutido (corpoEmailFixo).
const TEMPLATE_EMAIL_TOQUE: Record<number, string> = {
  1: "9dc0a5e1-0000-4000-8000-000000000701",
  2: "9dc0a5e1-0000-4000-8000-000000000702",
  3: "9dc0a5e1-0000-4000-8000-000000000703",
};
// FASE DE AGENDAMENTO: e-mails editáveis dos follow-ups 1/2/3 do Interessado.
const TEMPLATE_EMAIL_AGENDA: Record<number, string> = {
  1: "9dc0a5e1-0000-4000-8000-000000000704",
  2: "9dc0a5e1-0000-4000-8000-000000000705",
  3: "9dc0a5e1-0000-4000-8000-000000000706",
};
type TplEmail = { assunto: string; corpo: string };

async function carregarTemplatesEmail(admin: any, idMap: Record<number, string> = TEMPLATE_EMAIL_TOQUE): Promise<Map<number, TplEmail>> {
  const ids = Object.values(idMap);
  const m = new Map<number, TplEmail>();
  try {
    const { data } = await admin
      .from("email_templates").select("id, assunto, corpo_html, ativo")
      .in("id", ids).eq("ativo", true);
    const byId = new Map((data ?? []).map((t: any) => [t.id, t]));
    for (const [toque, id] of Object.entries(idMap)) {
      const t: any = byId.get(id);
      if (t?.corpo_html) m.set(Number(toque), { assunto: t.assunto ?? "", corpo: t.corpo_html });
    }
  } catch (_) { /* fallback embutido */ }
  return m;
}

async function resolverEmail(admin: any, caixaId: string | null, idMap: Record<number, string> = TEMPLATE_EMAIL_TOQUE) {
  if (!caixaId) return null;
  const { data: caixa } = await admin
    .from("email_caixas_conectadas")
    .select("id, email_caixa, nome_exibicao, calendar_integration_id, ativo")
    .eq("id", caixaId).eq("ativo", true).maybeSingle();
  if (!caixa) return null;
  const { data: integ } = await admin
    .from("calendar_integrations").select("*").eq("id", caixa.calendar_integration_id).maybeSingle();
  if (!integ) return null;
  const tplEmail = await carregarTemplatesEmail(admin, idMap);
  return { admin, caixa, integ, tplEmail };
}

// Renderiza um template EDITÁVEL da aba Templates com os placeholders resolvidos por lead.
function renderTemplateEmail(tpl: TplEmail, nome: string, podcast: string, youtube: string, waNumero: string): { assunto: string; html: string } {
  const ytHtml = youtube ? `🎬 <a href="${htmlEscape(youtube)}">${htmlEscape(youtube)}</a>` : "";
  const botao = blocoWhatsapp(nome, podcast, waNumero);
  let html = String(tpl.corpo ?? "")
    .split("{{nome}}").join(htmlEscape(nome))
    .split("{{podcast}}").join(htmlEscape(podcast))
    .split("{{link_youtube}}").join(ytHtml)
    .split("{{botao_whatsapp}}").join(botao);
  // GARANTIA: se o usuário removeu o {{botao_whatsapp}} ao editar, reinjeta o botão antes da
  // assinatura (o botão de WhatsApp nunca some do e-mail).
  if (!html.includes("Agendar episódio no WhatsApp")) {
    const antes = html.replace(/(<p>\s*Um abra[çc]o)/i, `${botao}$1`);
    html = antes !== html ? antes : html + botao;
  }
  // se o podcast não tem canal, remove o parágrafo do canal que ficaria vazio
  if (!youtube) html = html.replace(/<p>[^<]*canal:\s*<\/p>/gi, "");
  const assunto = (String(tpl.assunto ?? "").split("{{podcast}}").join(podcast)).trim()
    || `Convite para gravar no ${podcast} Podcast`;
  return { assunto, html };
}

// Fallback embutido da FASE DE AGENDAMENTO (só se o template editável 0704/5/6 for apagado).
function corpoEmailAgendaFallback(nome: string, podcast: string, toque: number, waNumero: string): { assunto: string; html: string } {
  const p = htmlEscape(podcast);
  const assunto = toque === 1
    ? `Vamos agendar sua gravação no ${podcast}?`
    : `Sobre a sua gravação no ${podcast}`;
  let corpo: string;
  if (toque === 1) {
    corpo = `<p>Que bom que você tem interesse em gravar com a gente! 🎙️</p>` +
      `<p>Para seguir, é só me dizer um ou dois dias/horários que funcionem melhor para você que eu já reservo a sua gravação no <strong>${p} Podcast</strong>. É online, de 30 a 45 minutos, e nós cuidamos de toda a edição.</p>`;
  } else if (toque === 2) {
    corpo = `<p>Passando para saber se você conseguiu ver as datas para a sua gravação no <strong>${p} Podcast</strong>. Me diz o melhor dia/horário para você que a gente já deixa tudo reservado.</p>`;
  } else {
    corpo = `<p>Estou passando uma última vez para fecharmos a agenda da sua gravação no <strong>${p} Podcast</strong> 🙂.</p>` +
      `<p>Se ainda tiver interesse, é só me dizer um horário que funcione. Se preferir deixar para mais para frente, sem problema — é só me avisar.</p>`;
  }
  const html = `<p>Olá ${htmlEscape(nome)}, tudo bem?</p>` + corpo + blocoWhatsapp(nome, podcast, waNumero) + `<p>Um abraço,<br>Janaína · PPGVET</p>`;
  return { assunto, html };
}

function corpoEmail(nome: string, podcast: string, youtube: string, toque: number, waNumero: string, tplEmail?: Map<number, TplEmail>, fase: "fria" | "agenda" = "fria"): { assunto: string; html: string } {
  const tpl = tplEmail?.get(toque);
  if (tpl) return renderTemplateEmail(tpl, nome, podcast, youtube, waNumero);
  if (fase === "agenda") return corpoEmailAgendaFallback(nome, podcast, toque, waNumero);
  // ---- fallback embutido (caso o template tenha sido apagado/desativado na UI) ----
  const p = htmlEscape(podcast);
  const assunto = toque === 1
    ? `Convite para gravar no ${podcast} Podcast`
    : `Sobre o convite para o ${podcast} Podcast`;
  let corpo: string;
  if (toque === 1) {
    corpo =
      `<p>Aqui é a Janaína, falo em nome da PPGVET e dos nossos podcasts (O Aviário, Suinocast, Mais Rúmen e PetFood).</p>` +
      `<p>O motivo do meu contato é um convite: eu gostaria de convidar você para uma gravação de episódio no <strong>${p} Podcast</strong>.</p>` +
      (youtube ? `<p>Caso ainda não conheça, deixo aqui o nosso canal: 🎬 <a href="${htmlEscape(youtube)}">${htmlEscape(youtube)}</a></p>` : "") +
      `<p>É um bate-papo técnico de 30 a 45 minutos, gravado remotamente e sem necessidade de slides. Uma conversa leve com um host da área, focada em conteúdo prático e relevante para o setor.</p>`;
  } else if (toque === 2) {
    corpo = `<p>Passando para saber se você teve a oportunidade de ver meu convite para participar do <strong>${p} Podcast</strong>. Acredito que sua experiência e atuação no setor agregariam muito ao nosso público.</p>`;
  } else {
    corpo =
      `<p>Estou voltando para reforçar o convite: seria um prazer receber você em uma gravação do <strong>${p} Podcast</strong>.</p>` +
      `<p>Caso não seja o momento agora, sem problemas. Também quero deixar aqui uma oportunidade: se você conhece alguém que acredita ser um bom nome para dividir conteúdo relevante com a nossa audiência, sua indicação também será muito bem-vinda.</p>`;
  }
  const html =
    `<p>Olá ${htmlEscape(nome)}, tudo bem?</p>` +
    corpo +
    blocoWhatsapp(nome, podcast, waNumero) +
    `<p>Um abraço,<br>Janaína · PPGVET</p>`;
  return { assunto, html };
}

async function enviarEmail(ctx: any, to: string, nome: string, podcast: string, youtube: string, toque: number, waNumero: string, fase: "fria" | "agenda" = "fria"): Promise<boolean> {
  try {
    const { assunto, html } = corpoEmail(nome, podcast, youtube, toque, waNumero, ctx.tplEmail, fase);
    const token = await ensureToken(ctx.admin, ctx.integ);
    const raw = [
      `From: ${encodeDisplayName(ctx.caixa.nome_exibicao || "PPGVET")} <${ctx.caixa.email_caixa}>`,
      `To: ${to}`,
      `Subject: ${encodeHeaderUtf8(assunto)}`,
      "MIME-Version: 1.0",
      'Content-Type: text/html; charset="UTF-8"',
      "",
      html,
    ].join("\r\n");
    const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw: base64UrlEncode(raw) }),
    });
    if (!r.ok) console.error("[pod-dispatch] email fail", to, await r.text());
    return r.ok;
  } catch (e) {
    console.error("[pod-dispatch] email erro", String(e));
    return false;
  }
}
