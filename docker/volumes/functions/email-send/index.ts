// Edge Function: email-send
// Renderiza template, checa idempotência, envia via Gmail API usando OAuth do Workspace
// (mesma conexão reaproveitada do Google Calendar -> tabela calendar_integrations).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CALENDAR_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CALENDAR_CLIENT_SECRET")!;

interface SendPayload {
  template_id?: string;
  automacao_id?: string | null;
  remetente_id?: string;
  destinatario_email: string;
  destinatario_nome?: string;
  variaveis?: Record<string, string>;
  contexto_tipo?: string;
  contexto_id?: string;
  anexos?: Array<{ filename: string; content_base64: string; content_type?: string }>;
  idempotencia_key?: string;
  assunto?: string;
  corpo_html?: string;
  corpo_texto?: string;
}

function renderTemplate(s: string, vars: Record<string, string>): string {
  return s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k) => (vars[k] ?? `{{${k}}}`));
}

function base64url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildRFC2822({
  fromEmail, fromName, to, subject, html, text, replyTo, anexos,
}: {
  fromEmail: string; fromName: string; to: string; subject: string;
  html: string; text?: string | null; replyTo?: string | null;
  anexos?: Array<{ filename: string; content_base64: string; content_type?: string }>;
}): string {
  const boundaryAlt = `alt_${crypto.randomUUID()}`;
  const boundaryMix = `mix_${crypto.randomUUID()}`;
  const encSubject = `=?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`;
  const encFromName = `=?UTF-8?B?${btoa(unescape(encodeURIComponent(fromName)))}?=`;
  const headers: string[] = [
    `From: ${encFromName} <${fromEmail}>`,
    `To: ${to}`,
    `Subject: ${encSubject}`,
    "MIME-Version: 1.0",
  ];
  if (replyTo) headers.push(`Reply-To: ${replyTo}`);

  const hasAttachments = !!anexos?.length;
  const altPart = [
    `Content-Type: multipart/alternative; boundary="${boundaryAlt}"`,
    "",
    `--${boundaryAlt}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    text ?? html.replace(/<[^>]+>/g, ""),
    "",
    `--${boundaryAlt}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    html,
    "",
    `--${boundaryAlt}--`,
  ].join("\r\n");

  if (!hasAttachments) {
    return [...headers, altPart].join("\r\n");
  }

  const parts = [
    `Content-Type: multipart/mixed; boundary="${boundaryMix}"`,
    "",
    `--${boundaryMix}`,
    altPart,
  ];
  for (const a of anexos!) {
    parts.push(
      `--${boundaryMix}`,
      `Content-Type: ${a.content_type ?? "application/octet-stream"}; name="${a.filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${a.filename}"`,
      "",
      a.content_base64.replace(/(.{76})/g, "$1\r\n"),
    );
  }
  parts.push(`--${boundaryMix}--`);
  return [...headers, parts.join("\r\n")].join("\r\n");
}

async function refreshGoogleToken(refreshToken: string): Promise<{ access_token: string; expires_in: number } | null> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    console.error("refresh failed", await res.text());
    return null;
  }
  return await res.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const payload = (await req.json()) as SendPayload;
    if (!payload.destinatario_email) {
      return new Response(JSON.stringify({ error: "destinatario_email obrigatório" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let userId: string | null = null;
    const authHeader = req.headers.get("Authorization");
    if (authHeader) {
      const { data: { user } } = await supabaseAdmin.auth.getUser(authHeader.replace("Bearer ", ""));
      userId = user?.id ?? null;
    }

    // Idempotência
    if (payload.idempotencia_key) {
      const { data: existente } = await supabaseAdmin
        .from("emails_enviados")
        .select("id, status")
        .eq("idempotencia_key", payload.idempotencia_key)
        .maybeSingle();
      if (existente) {
        return new Response(JSON.stringify({ ok: true, duplicado: true, id: existente.id }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Resolve template
    let assunto = payload.assunto ?? "";
    let corpoHtml = payload.corpo_html ?? "";
    let corpoTexto = payload.corpo_texto ?? null;
    let remetenteId = payload.remetente_id ?? null;
    let templateId = payload.template_id ?? null;

    if (templateId) {
      const { data: tpl, error: tplErr } = await supabaseAdmin
        .from("email_templates").select("*").eq("id", templateId).single();
      if (tplErr || !tpl) {
        return new Response(JSON.stringify({ error: "template não encontrado" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      assunto = tpl.assunto;
      corpoHtml = tpl.corpo_html;
      corpoTexto = tpl.corpo_texto;
      remetenteId = remetenteId ?? tpl.remetente_id;
    }

    const vars = payload.variaveis ?? {};
    assunto = renderTemplate(assunto, vars);
    corpoHtml = renderTemplate(corpoHtml, vars);
    if (corpoTexto) corpoTexto = renderTemplate(corpoTexto, vars);

    // Resolve remetente -> caixa Gmail
    if (!remetenteId) {
      return new Response(JSON.stringify({ error: "remetente_id obrigatório" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: rem, error: remErr } = await supabaseAdmin
      .from("email_remetentes").select("*").eq("id", remetenteId).single();
    if (remErr || !rem) {
      return new Response(JSON.stringify({ error: "remetente não encontrado" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const caixaEmail = rem.gmail_caixa_email ?? rem.email_completo;
    const fromName = rem.nome_remetente;
    const replyTo = rem.reply_to_email;

    // Busca integração Gmail desse Workspace
    const { data: integ } = await supabaseAdmin
      .from("calendar_integrations")
      .select("id, oauth_access_token, oauth_refresh_token, oauth_token_expires_at, scopes, account_email")
      .eq("account_email", caixaEmail)
      .not("oauth_refresh_token", "is", null)
      .order("is_primary", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!integ?.oauth_refresh_token) {
      return new Response(JSON.stringify({
        error: "Caixa não conectada ao Google. Conecte via Calendário e reautorize com escopos Gmail.",
        caixa: caixaEmail,
      }), { status: 412, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (integ.scopes && !integ.scopes.includes("gmail.send")) {
      return new Response(JSON.stringify({
        error: "Conexão Google sem escopo gmail.send. Reconecte essa caixa para autorizar envio de email.",
        caixa: caixaEmail,
      }), { status: 412, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Renova token se expirado/quase
    let accessToken = integ.oauth_access_token as string;
    const expiresAt = integ.oauth_token_expires_at ? new Date(integ.oauth_token_expires_at).getTime() : 0;
    if (!accessToken || expiresAt - Date.now() < 60_000) {
      const refreshed = await refreshGoogleToken(integ.oauth_refresh_token as string);
      if (!refreshed) {
        return new Response(JSON.stringify({ error: "Falha ao renovar token Google" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      accessToken = refreshed.access_token;
      await supabaseAdmin.from("calendar_integrations").update({
        oauth_access_token: accessToken,
        oauth_token_expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
      }).eq("id", integ.id);
    }

    // Cria log enfileirado
    const { data: log, error: logErr } = await supabaseAdmin
      .from("emails_enviados").insert({
        template_id: templateId,
        automacao_id: payload.automacao_id ?? null,
        remetente_id: remetenteId,
        contexto_tipo: payload.contexto_tipo ?? null,
        contexto_id: payload.contexto_id ?? null,
        destinatario_email: payload.destinatario_email,
        destinatario_nome: payload.destinatario_nome ?? null,
        assunto_render: assunto,
        corpo_html_render: corpoHtml,
        corpo_texto_render: corpoTexto,
        anexos: payload.anexos ?? [],
        status: "enfileirado",
        idempotencia_key: payload.idempotencia_key ?? null,
        enviado_por: userId,
      }).select("id").single();

    if (logErr || !log) {
      return new Response(JSON.stringify({ error: "falha ao registrar log", details: logErr?.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Injeta pixel de tracking de abertura antes de </body> (ou no fim)
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const pixelTag = `<img src="${supabaseUrl}/functions/v1/email-track-open?id=${log.id}" width="1" height="1" alt="" style="display:none" />`;
    if (/<\/body>/i.test(corpoHtml)) {
      corpoHtml = corpoHtml.replace(/<\/body>/i, `${pixelTag}</body>`);
    } else {
      corpoHtml = `${corpoHtml}\n${pixelTag}`;
    }

    // Monta RFC 2822 e envia via Gmail API (com 1 retry em 429)
    const rfc = buildRFC2822({
      fromEmail: caixaEmail, fromName,
      to: payload.destinatario_nome
        ? `${payload.destinatario_nome} <${payload.destinatario_email}>`
        : payload.destinatario_email,
      subject: assunto, html: corpoHtml, text: corpoTexto, replyTo,
      anexos: payload.anexos,
    });
    const raw = base64url(rfc);

    async function callGmail() {
      return await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ raw }),
      });
    }
    let gmailRes = await callGmail();
    if (gmailRes.status === 429) {
      await new Promise((r) => setTimeout(r, 60_000));
      gmailRes = await callGmail();
    }
    const gmailData = await gmailRes.json();

    if (!gmailRes.ok) {
      await supabaseAdmin.from("emails_enviados").update({
        status: "falhou", erro_msg: JSON.stringify(gmailData),
      }).eq("id", log.id);
      return new Response(JSON.stringify({ error: "Gmail API falhou", details: gmailData, log_id: log.id }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await supabaseAdmin.from("emails_enviados").update({
      status: "enviado",
      corpo_html_render: corpoHtml,
      gmail_message_id: gmailData.id ?? null,
      gmail_thread_id: gmailData.threadId ?? null,
      enviado_em: new Date().toISOString(),
    }).eq("id", log.id);

    return new Response(JSON.stringify({
      ok: true, log_id: log.id, gmail_id: gmailData.id, thread_id: gmailData.threadId,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "erro desconhecido";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
