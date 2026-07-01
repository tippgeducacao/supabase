// pod-convite-dispatch: motor da cadência de convite de CONVIDADOS de podcast.
// Automação = SÓ qualificar interesse. 3 toques a cada 2 dias, e-mail + WhatsApp (Meta) juntos.
// Gate: podcast_dispatch_mode ('off' = só dispara ondas aprovadas via pod_convite_aprovar_onda).
// Interessou (botão/resposta) → webhook marca 'respondeu' (humano assume no SAC/e-mail).
// Silêncio após o 3º toque → 'silenciou' + convidado vira 'convidar_em_6m' (+6 meses).
// NÃO envia enquanto: não houver conta WA do podcast (token) OU o template não estiver 'aprovado'.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { ensureToken, base64UrlEncode } from "../_shared/gmail.ts";

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
  if (!d.startsWith("55")) d = "55" + d;
  return d;
}
function htmlEscape(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
      .select("id, nome, idioma, corpo, uso_cadencia, botoes, status, ativo")
      .in("uso_cadencia", ["podcast_convite", "podcast_followup_1", "podcast_followup_2"])
      .eq("status", "aprovado")
      .eq("ativo", true);
    const tplPorUso = new Map((tpls ?? []).map((t: any) => [t.uso_cadencia, t]));

    // caixa de e-mail (resolvida 1x)
    const emailCtx = await resolverEmail(admin, caixaId);

    const nowIso = new Date().toISOString();
    const SEL = "id, podcast_id, professor_id, status, toque, aprovado_em, proxima_acao_em, " +
      "professor:ped_professores(nome,email,contato_whatsapp), podcast:ped_podcasts(nome)";

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

        // ---- WhatsApp (Meta template) ----
        const to = formatPhone(c.professor?.contato_whatsapp);
        let waOk = false;
        if (to) {
          const payload = {
            messaging_product: "whatsapp",
            to,
            type: "template",
            template: {
              name: tpl.nome,
              language: { code: tpl.idioma || "pt_BR" },
              components: [{
                type: "body",
                parameters: [
                  { type: "text", text: sanitizeWaParam(nome) },
                  { type: "text", text: sanitizeWaParam(podcastNome) },
                ],
              }],
            },
          };
          const r = await fetch(`${META_GRAPH}/${wa.phone_number_id}/messages`, {
            method: "POST",
            headers: { Authorization: `Bearer ${wa.access_token}`, "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          waOk = r.ok;
          if (!r.ok) console.error("[pod-dispatch] wa fail", c.id, await r.text());
        }

        // ---- E-mail (best-effort) ----
        let emailOk = false;
        if (emailCtx && c.professor?.email) {
          emailOk = await enviarEmail(emailCtx, c.professor.email, nome, podcastNome, proxToque);
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

function corpoEmail(nome: string, podcast: string, toque: number): { assunto: string; html: string } {
  const assunto = toque === 1
    ? `Convite para gravar no ${podcast} Podcast`
    : `Sobre o convite — ${podcast} Podcast`;
  const intro = toque === 1
    ? `Gostaríamos de convidá-lo(a) para gravar um episódio online no <strong>${htmlEscape(podcast)} Podcast</strong>. São episódios de 30 a 45 minutos, gravados remotamente, sem necessidade de slides — nós cuidamos de toda a edição.`
    : toque === 2
      ? `Passando para saber se você teve a oportunidade de ver meu convite para participar do <strong>${htmlEscape(podcast)} Podcast</strong>. Sua experiência agregaria muito ao nosso público.`
      : `Passando mais uma vez sobre o convite para gravar no <strong>${htmlEscape(podcast)} Podcast</strong>. Caso não seja o momento, sem problemas — fico à disposição para quando quiser.`;
  const html =
    `<p>Olá ${htmlEscape(nome)}, tudo bem?</p>` +
    `<p>Aqui é a Janaína, da PPGVET e Wisenetix.</p>` +
    `<p>${intro}</p>` +
    `<p><strong>Você teria interesse em participar?</strong> É só responder este e-mail. 🙂</p>` +
    `<p>Um abraço,<br>Janaína — PPGVET / Wisenetix</p>`;
  return { assunto, html };
}

async function enviarEmail(ctx: any, to: string, nome: string, podcast: string, toque: number): Promise<boolean> {
  try {
    const { assunto, html } = corpoEmail(nome, podcast, toque);
    const token = await ensureToken(ctx.admin, ctx.integ);
    const raw = [
      `From: "${ctx.caixa.nome_exibicao || "PPGVET"}" <${ctx.caixa.email_caixa}>`,
      `To: ${to}`,
      `Subject: ${assunto}`,
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
