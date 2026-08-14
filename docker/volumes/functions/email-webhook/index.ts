// Edge Function: email-webhook
// Recebe os eventos do Resend (sent, delivered, opened, clicked, bounced, complained).
//
// Faz três coisas:
//   1. VALIDA a assinatura Svix. Sem isso qualquer um poderia postar um "bounced"
//      forjado e derrubar a entrega de um endereço qualquer (a supressão bloqueia
//      envio de verdade). Só roda sem validação se RESEND_WEBHOOK_SECRET não existir,
//      e nesse caso registra aviso.
//   2. Atualiza o log do envio (emails_enviados) e a linha da fila da campanha.
//   3. Alimenta a lista de SUPRESSÃO em bounce duro e marcação de spam.
//
// Configuração: painel do Resend → Webhooks → URL
//   https://api.ppgeducacao.site/functions/v1/email-webhook
// (a função precisa de verify_jwt = false no config.toml — o Resend não manda JWT).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { assinaturaSvixValida } from "../_shared/resend.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, svix-id, svix-timestamp, svix-signature",
};

const TIPO_PARA_STATUS: Record<string, string> = {
  "email.sent": "enviado",
  "email.delivered": "entregue",
  "email.opened": "aberto",
  "email.clicked": "clicado",
  "email.bounced": "bounce",
  "email.complained": "spam",
  "email.failed": "falhou",
  "email.delivery_delayed": "enviado",
};

// Não regride status: um 'clicado' que recebe um 'delivered' atrasado continua clicado.
const PESO_STATUS: Record<string, number> = {
  enfileirado: 0, enviado: 1, entregue: 2, aberto: 3, clicado: 4, bounce: 5, spam: 6, falhou: 5,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // O corpo CRU é o que entra no HMAC — não dá para usar req.json() antes disso.
    const corpoTexto = await req.text();
    const svixId = req.headers.get("svix-id");

    const segredo = Deno.env.get("RESEND_WEBHOOK_SECRET");
    if (!segredo) {
      console.warn("email-webhook: RESEND_WEBHOOK_SECRET ausente — evento aceito SEM validação");
    } else {
      const valida = await assinaturaSvixValida({
        id: svixId,
        timestamp: req.headers.get("svix-timestamp"),
        signature: req.headers.get("svix-signature"),
      }, corpoTexto, segredo);
      if (!valida) {
        return new Response(JSON.stringify({ error: "assinatura inválida" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = JSON.parse(corpoTexto || "{}");

    // Dedupe de REENTREGA: o Resend reenvia o evento quando não recebe 200 rápido.
    // Sem isto, a segunda entrega do mesmo evento incrementaria aberto_count e os
    // contadores da campanha outra vez — a métrica inflava sozinha.
    // O insert é a trava: se a PK já existe, alguém já processou.
    if (svixId) {
      const { error: dup } = await supabase.from("email_webhook_eventos").insert({
        svix_id: svixId,
        tipo: body.type ?? null,
        email_id: body.data?.email_id ?? body.data?.id ?? null,
      });
      if (dup) {
        // 23505 = já processado. Qualquer outro erro não pode engolir o evento.
        if ((dup as { code?: string }).code === "23505") {
          return new Response(JSON.stringify({ ok: true, repetido: true }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        console.error("email-webhook: falha ao registrar evento", dup.message);
      }
    }
    const tipo: string = body.type ?? "";
    const emailId: string | undefined = body.data?.email_id ?? body.data?.id;
    const destinatario: string | undefined = Array.isArray(body.data?.to) ? body.data.to[0] : body.data?.to;

    if (!emailId) {
      return new Response(JSON.stringify({ ok: true, ignorado: "sem email_id" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const novoStatus = TIPO_PARA_STATUS[tipo];
    const agora = new Date().toISOString();

    const { data: log } = await supabase
      .from("emails_enviados")
      .select("id, status, aberto_count, clicado_count, contexto_tipo, contexto_id, destinatario_email")
      .eq("resend_email_id", emailId)
      .maybeSingle();

    // Eventos de e-mail que não saiu por aqui (teste no painel, outro sistema) —
    // ainda assim vale suprimir bounce/spam, então não retornamos cedo.
    if (log) {
      const update: Record<string, unknown> = {};
      if (novoStatus && (PESO_STATUS[novoStatus] ?? 0) >= (PESO_STATUS[log.status] ?? 0)) {
        update.status = novoStatus;
      }
      if (tipo === "email.delivered") update.entregue_em = agora;
      if (tipo === "email.opened") {
        update.aberto_em = agora;
        update.aberto_count = (log.aberto_count ?? 0) + 1;
      }
      if (tipo === "email.clicked") update.clicado_count = (log.clicado_count ?? 0) + 1;
      if (tipo === "email.bounced" || tipo === "email.complained" || tipo === "email.failed") {
        update.erro_msg = body.data?.bounce?.message ?? body.data?.failed?.reason ??
          body.data?.reason ?? tipo;
      }
      if (Object.keys(update).length) {
        await supabase.from("emails_enviados").update(update).eq("id", log.id);
      }

      // Espelha na fila da campanha e nos contadores agregados.
      if (log.contexto_tipo === "campanha" && log.contexto_id) {
        const inc: Record<string, number> = {};
        if (tipo === "email.delivered") inc.p_entregues = 1;
        if (tipo === "email.opened") inc.p_abertos = 1;
        if (tipo === "email.clicked") inc.p_clicados = 1;
        if (tipo === "email.bounced") inc.p_bounces = 1;
        if (Object.keys(inc).length) {
          await supabase.rpc("email_campanha_incrementa", { p_campanha: log.contexto_id, ...inc });
        }
        if (tipo === "email.opened" || tipo === "email.bounced") {
          await supabase
            .from("email_campanhas_envios")
            .update(
              tipo === "email.opened"
                ? { status: "aberto", aberto_em: agora }
                : { status: "bounced", erro: String(body.data?.bounce?.message ?? "bounce") },
            )
            .eq("email_enviado_id", log.id);
        }
      }
    }

    // Supressão: bounce duro e reclamação de spam saem da base para sempre.
    // Bounce transitório (soft/caixa cheia) NÃO suprime — o Resend informa o tipo.
    const subtipo = String(body.data?.bounce?.type ?? "").toLowerCase();
    const bounceDuro = tipo === "email.bounced" && subtipo !== "transient" && subtipo !== "soft";
    const alvo = destinatario ?? log?.destinatario_email;
    if (alvo && (bounceDuro || tipo === "email.complained")) {
      await supabase.from("email_supressoes").upsert({
        email: alvo,
        motivo: tipo === "email.complained" ? "spam" : "bounce",
        detalhe: String(body.data?.bounce?.message ?? tipo).slice(0, 500),
        origem_tipo: log?.contexto_tipo ?? null,
        origem_id: log?.contexto_id ?? null,
      }, { onConflict: "email", ignoreDuplicates: true });
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "erro";
    console.error("email-webhook", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
