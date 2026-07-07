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
          await admin.from("pod_convite_candidatos")
            .update({ status: "silenciou" }).eq("id", c.id);
          const seis = new Date(); seis.setMonth(seis.getMonth() + 6);
          await admin.from("ped_professores")
            .update({ status_podcast: "convidar_em_6m", reconvidar_a_partir_de: seis.toISOString().slice(0, 10) })
            .eq("id", c.professor_id)
            .eq("status_podcast", "a_convidar"); // só rebaixa quem ainda está 'a_convidar'
          silenciados++;
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
          emailOk = await enviarEmail(emailCtx, c.professor.email, nome, podcastNome, youtube, proxToque);
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
        await admin.from("pod_convite_candidatos").update(upd).eq("id", c.id);
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

async function resolverEmail(admin: any, caixaId: string | null) {
  if (!caixaId) return null;
  const { data: caixa } = await admin
    .from("email_caixas_conectadas")
    .select("id, email_caixa, nome_exibicao, calendar_integration_id, ativo")
    .eq("id", caixaId).eq("ativo", true).maybeSingle();
  if (!caixa) return null;
  const { data: integ } = await admin
    .from("calendar_integrations").select("*").eq("id", caixa.calendar_integration_id).maybeSingle();
  if (!integ) return null;
  return { admin, caixa, integ };
}

function corpoEmail(nome: string, podcast: string, youtube: string, toque: number): { assunto: string; html: string } {
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
    `<p><strong>Tem interesse?</strong> É só responder este e-mail. 🙂</p>` +
    `<p>Um abraço,<br>Janaína · PPGVET</p>`;
  return { assunto, html };
}

async function enviarEmail(ctx: any, to: string, nome: string, podcast: string, youtube: string, toque: number): Promise<boolean> {
  try {
    const { assunto, html } = corpoEmail(nome, podcast, youtube, toque);
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
