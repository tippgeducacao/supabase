// Edge Function: email-send
// Renderiza template, checa idempotência e envia por UM DE DOIS MOTORES, escolhido
// pelo `provider` do remetente (email_remetentes.provider):
//
//   gmail  -> Gmail API com OAuth do Workspace (calendar_integrations). E-mail 1:1:
//             a resposta do aluno cai na caixa e o enviado aparece na thread.
//   resend -> API do Resend. Disparo em massa/automação: métrica de entrega real,
//             bounce/spam via webhook e domínio próprio.
//
// A separação é de propósito: bounce de campanha não pode queimar a reputação do
// domínio que manda o e-mail de aprovação de TCC. Ver docs/E-mail e Caixas.md.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  chaveIdempotencia,
  enviarEmail,
  formatarFrom,
  linkDescadastro,
  tagSegura,
  temResend,
} from "../_shared/resend.ts";
import { ErroEnvio, obterProvedor } from "../_shared/emailProviders/index.ts";
import { buscarSupressao, supressaoSeAplica } from "../_shared/supressao.ts";

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
  // Janela (min) p/ a dedup por idempotencia_key. Sem isto, casa QUALQUER linha com a
  // mesma key (mesmo antiga) → reenvio de etapa >24h virava falso "duplicado" sem entrega.
  idempotencia_janela_min?: number;
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

    // Idempotência (opcionalmente limitada a uma janela de tempo)
    if (payload.idempotencia_key) {
      let dupQuery = supabaseAdmin
        .from("emails_enviados")
        .select("id, status")
        .eq("idempotencia_key", payload.idempotencia_key);
      if (payload.idempotencia_janela_min && payload.idempotencia_janela_min > 0) {
        const desde = new Date(Date.now() - payload.idempotencia_janela_min * 60_000).toISOString();
        dupQuery = dupQuery.gte("criado_em", desde);
      }
      const { data: existente } = await dupQuery
        .order("criado_em", { ascending: false })
        .limit(1)
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
    const provider: "gmail" | "resend" | "ses" =
      rem.provider === "resend" ? "resend" : rem.provider === "ses" ? "ses" : "gmail";
    const caixaEmail = rem.gmail_caixa_email ?? rem.email_completo;
    const fromName = rem.nome_remetente;
    const replyTo = rem.reply_to_email;
    const ehCampanha = payload.contexto_tipo === "campanha";

    // Supressão: quem deu bounce duro/spam/descadastro não recebe mais DISPARO.
    // Não vale para o 1:1 do Gmail (funil TCC) — lá a Secretaria decide reenviar.
    if (supressaoSeAplica(provider, ehCampanha)) {
      const suprimido = await buscarSupressao(supabaseAdmin, payload.destinatario_email);
      if (suprimido) {
        return new Response(JSON.stringify({
          ok: true, suprimido: true, motivo: suprimido.motivo,
          destinatario: payload.destinatario_email,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    // --- Motor Gmail: resolve a caixa conectada e o token ------------------------
    let accessToken = "";
    if (provider === "gmail") {
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
      accessToken = integ.oauth_access_token as string;
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
      // `provider === "ses"` não precisa de checagem prévia: a AWS só é contatada no
      // envio, e sem credencial o SDK devolve erro nomeado que o catch traduz.
    } else if (provider === "resend" && !temResend()) {
      // Falha cedo e com nome: sem a chave, o Resend devolveria 401 já com o log gravado.
      return new Response(JSON.stringify({
        error: "RESEND_API_KEY não configurada no ambiente das edge functions. " +
          "Configure a secret antes de usar um remetente Resend.",
        remetente: rem.email_completo,
      }), { status: 412, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Cria log enfileirado
    const logRow = {
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
      provider,
      idempotencia_key: payload.idempotencia_key ?? null,
      enviado_por: userId,
    };

    let { data: log, error: logErr } = await supabaseAdmin
      .from("emails_enviados").insert(logRow).select("id").single();

    // ⚠️ idempotencia_key tem índice ÚNICO GLOBAL (idx_emails_enviados_idempot, SEM
    // janela). Quando a dedup é por JANELA (idempotencia_janela_min) e a etapa já foi
    // enviada FORA da janela, o SELECT de dedup acima libera o reenvio, mas este INSERT
    // colidiria com a linha antiga (mesma chave) → "falha ao registrar log" e o e-mail
    // não sai (ex.: reenviar a etapa de um TCC que já passou por ela dias atrás).
    if (logErr && (logErr as { code?: string }).code === "23505" && payload.idempotencia_key) {
      // Distingue 2 causas da colisão:
      //  (a) CORRIDA real — outro disparo gravou a MESMA chave AGORA (dentro da janela):
      //      é duplicado de verdade, NÃO reenvia.
      //  (b) REENVIO legítimo de etapa enviada FORA da janela: grava NOVO registro com
      //      chave de-colidida (preserva o histórico e entrega o e-mail).
      let dupCheck = supabaseAdmin
        .from("emails_enviados").select("id")
        .eq("idempotencia_key", payload.idempotencia_key);
      if (payload.idempotencia_janela_min && payload.idempotencia_janela_min > 0) {
        const desde = new Date(Date.now() - payload.idempotencia_janela_min * 60_000).toISOString();
        dupCheck = dupCheck.gte("criado_em", desde);
      }
      const { data: recente } = await dupCheck
        .order("criado_em", { ascending: false }).limit(1).maybeSingle();
      if (recente) {
        return new Response(JSON.stringify({ ok: true, duplicado: true, id: recente.id }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const retry = await supabaseAdmin
        .from("emails_enviados")
        .insert({ ...logRow, idempotencia_key: `${payload.idempotencia_key}:${Date.now()}-${crypto.randomUUID()}` })
        .select("id").single();
      log = retry.data;
      logErr = retry.error;
    }

    if (logErr || !log) {
      return new Response(JSON.stringify({ error: "falha ao registrar log", details: logErr?.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Injeta pixel de tracking de abertura antes de </body> (ou no fim).
    // ⚠️ Tem que ser a URL PÚBLICA: no self-hosted, SUPABASE_URL é http://kong:8000,
    // que nenhum cliente de e-mail alcança — o pixel apontou pra lá por muito tempo
    // e por isso NENHUMA abertura foi registrada. Mesmo motivo vale pro descadastro.
    const supabaseUrl = Deno.env.get("SUPABASE_PUBLIC_URL") ||
      Deno.env.get("PUBLIC_SUPABASE_URL") ||
      Deno.env.get("SUPABASE_URL")!;
    const pixelTag = `<img src="${supabaseUrl}/functions/v1/email-track-open?id=${log.id}" width="1" height="1" alt="" style="display:none" />`;
    if (/<\/body>/i.test(corpoHtml)) {
      corpoHtml = corpoHtml.replace(/<\/body>/i, `${pixelTag}</body>`);
    } else {
      corpoHtml = `${corpoHtml}\n${pixelTag}`;
    }

    // Descadastro: obrigatório em disparo de massa (Gmail/Yahoo exigem one-click
    // de quem manda volume) e é o que alimenta a lista de supressão.
    const urlDescadastro = provider !== "gmail"
      ? await linkDescadastro(supabaseUrl, payload.destinatario_email)
      : null;
    if (urlDescadastro && ehCampanha) {
      // O link só existe depois de resolvido o remetente, então a variável
      // {{descadastro_url}} é substituída aqui, num segundo passe.
      const usaVariavel = /\{\{\s*descadastro_url\s*\}\}/.test(corpoHtml);
      if (usaVariavel) {
        corpoHtml = corpoHtml.replace(/\{\{\s*descadastro_url\s*\}\}/g, urlDescadastro);
      } else {
        // Se o template não posiciona o link, pendura um rodapé discreto —
        // disparo de massa sem descadastro visível é o caminho curto pro spam.
        const rodape =
          `<div style="margin-top:24px;padding-top:12px;border-top:1px solid #e5e7eb;` +
          `font-size:12px;color:#6b7280;text-align:center">` +
          `<a href="${urlDescadastro}" style="color:#6b7280">Descadastrar deste tipo de e-mail</a>` +
          `</div>`;
        if (/<\/body>/i.test(corpoHtml)) {
          corpoHtml = corpoHtml.replace(/<\/body>/i, `${rodape}</body>`);
        } else {
          corpoHtml = `${corpoHtml}\n${rodape}`;
        }
      }
    }

    // --- Motor SES (e SMTP) --------------------------------------------------------
    // Passa pela mesma abstração EmailProvider; o SMTP entra por aqui quando o
    // remetente não declara provedor e EMAIL_PROVIDER=smtp (caminho de desenvolvimento).
    if (provider === "ses") {
      const cabecalhos: Record<string, string> = {};
      if (urlDescadastro) {
        cabecalhos["List-Unsubscribe"] = `<${urlDescadastro}>`;
        cabecalhos["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
      }

      try {
        const provedor = obterProvedor({ doRemetente: rem.provider });
        const { providerMessageId } = await provedor.send({
          from: formatarFrom(fromName, rem.email_completo),
          to: payload.destinatario_email,
          subject: assunto,
          html: corpoHtml,
          text: corpoTexto ?? undefined,
          replyTo: replyTo ?? undefined,
          headers: Object.keys(cabecalhos).length ? cabecalhos : undefined,
          attachments: payload.anexos?.map((a) => ({
            filename: a.filename,
            content: a.content_base64,
            contentType: a.content_type,
          })),
          tags: [
            { name: "log_id", value: tagSegura(log.id) },
            ...(payload.contexto_tipo ? [{ name: "contexto", value: tagSegura(payload.contexto_tipo) }] : []),
          ],
          // Conjunto de configuração separado por tipo: sem ele o SES não publica os
          // eventos de bounce/complaint no SNS, e a supressão nunca é alimentada.
          configurationSet: ehCampanha
            ? Deno.env.get("SES_CONFIGURATION_SET_MKT")
            : Deno.env.get("SES_CONFIGURATION_SET_TX"),
        });

        await supabaseAdmin.from("emails_enviados").update({
          status: "enviado",
          corpo_html_render: corpoHtml,
          provider_message_id: providerMessageId,
          enviado_em: new Date().toISOString(),
        }).eq("id", log.id);

        return new Response(JSON.stringify({
          ok: true, log_id: log.id, provider: "ses", provider_message_id: providerMessageId,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (e) {
        const erro = e instanceof ErroEnvio ? e : new ErroEnvio(String(e));
        await supabaseAdmin.from("emails_enviados").update({
          status: "falhou", erro_msg: `${erro.codigo ?? "erro"}: ${erro.message}`.slice(0, 500),
        }).eq("id", log.id);

        // Preserva o 429 para o dispatcher pausar a campanha em vez de insistir.
        return new Response(JSON.stringify({
          error: "SES falhou", details: erro.message, codigo: erro.codigo,
          log_id: log.id, rate_limited: erro.rateLimited,
        }), {
          status: erro.rateLimited ? 429 : 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // --- Motor Resend ------------------------------------------------------------
    if (provider === "resend") {
      // Chave de idempotência ESTÁVEL entre tentativas do mesmo envio lógico: se o
      // worker morrer depois do Resend aceitar mas antes de gravarmos o resultado, a
      // repetição não entrega duas vezes. Deriva da entidade (chave do chamador ou
      // contexto+destinatário), nunca de uuid/timestamp novo — que anularia o efeito.
      const idempotencyKey = payload.idempotencia_key
        ? chaveIdempotencia(payload.contexto_tipo ?? "email", payload.idempotencia_key)
        : chaveIdempotencia(
          payload.contexto_tipo ?? "email",
          `${payload.contexto_id ?? templateId ?? remetenteId}:${payload.destinatario_email}`,
        );

      const res = await enviarEmail({
        from: formatarFrom(fromName, rem.email_completo),
        to: payload.destinatario_email,
        subject: assunto,
        html: corpoHtml,
        text: corpoTexto ?? undefined,
        reply_to: replyTo ?? undefined,
        headers: urlDescadastro
          ? {
            "List-Unsubscribe": `<${urlDescadastro}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          }
          : undefined,
        attachments: payload.anexos?.map((a) => ({
          filename: a.filename,
          content: a.content_base64,
          content_type: a.content_type,
        })),
        tags: [
          { name: "log_id", value: tagSegura(log.id) },
          ...(payload.contexto_tipo
            ? [{ name: "contexto", value: tagSegura(payload.contexto_tipo) }]
            : []),
          ...(payload.contexto_id
            ? [{ name: "contexto_id", value: tagSegura(payload.contexto_id) }]
            : []),
        ],
      }, { idempotencyKey });

      if (!res.ok) {
        await supabaseAdmin.from("emails_enviados").update({
          status: "falhou", erro_msg: res.erro ?? "Resend falhou",
        }).eq("id", log.id);
        // Preserva o 429 para o dispatcher pausar a campanha em vez de insistir.
        return new Response(JSON.stringify({
          error: "Resend falhou", details: res.erro, log_id: log.id, rate_limited: res.rateLimited,
        }), {
          status: res.rateLimited ? 429 : 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      await supabaseAdmin.from("emails_enviados").update({
        status: "enviado",
        corpo_html_render: corpoHtml,
        resend_email_id: res.data?.id ?? null,
        enviado_em: new Date().toISOString(),
      }).eq("id", log.id);

      return new Response(JSON.stringify({
        ok: true, log_id: log.id, provider: "resend", resend_id: res.data?.id,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // --- Motor Gmail: monta RFC 2822 e envia (com 1 retry em 429) ----------------
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
      // Backoff CURTO de propósito: o edge-runtime self-hosted mata o worker em
      // ~60s (WorkerRequestCancelled). Um sleep de 60s aqui garantia a morte do
      // worker (e do dispatcher que o chama em lote) → toast "non-2xx". 4s segura
      // o burst de 429 sem estourar o wall-clock; se persistir, devolve o 502 abaixo.
      await new Promise((r) => setTimeout(r, 4_000));
      gmailRes = await callGmail();
    }
    const gmailData = await gmailRes.json();

    if (!gmailRes.ok) {
      await supabaseAdmin.from("emails_enviados").update({
        status: "falhou", erro_msg: JSON.stringify(gmailData),
      }).eq("id", log.id);
      // Preserva o 429 (rate limit) do Gmail p/ o chamador reagir — o
      // email-campaign-dispatcher pausa a campanha quando recebe 429. Demais falhas = 502.
      const rateLimited = gmailRes.status === 429;
      return new Response(
        JSON.stringify({ error: "Gmail API falhou", details: gmailData, log_id: log.id, rate_limited: rateLimited }),
        { status: rateLimited ? 429 : 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
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
