/**
 * Miolo do webhook de eventos do SES.
 *
 * Vive fora do `index.ts` porque `Deno.serve` executa no carregamento do módulo — com
 * ele no meio, o handler não é importável pelo vitest e a lógica de dedupe, supressão
 * e resposta HTTP ficaria sem teste. Aqui tudo o que fala com o mundo (banco, fetch,
 * verificação de assinatura) entra por injeção.
 */
import { assinaturaSnsValida, type MensagemSns } from "../_shared/snsVerify.ts";
import { interpretarEventoSes } from "../_shared/sesEventos.ts";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-amz-sns-message-type",
};

const json = (c: unknown, s = 200) =>
  new Response(JSON.stringify(c), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// Não regride status: um 'clicado' que recebe um 'entregue' atrasado continua clicado.
const PESO: Record<string, number> = {
  enfileirado: 0, enviado: 1, entregue: 2, aberto: 3, clicado: 4, bounce: 5, spam: 6, falhou: 5,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClienteSupabase = any;

export interface DepsWebhookSes {
  supabase: ClienteSupabase;
  /** Injetada nos testes; em produção usa a verificação real. */
  verificarAssinatura?: (msg: MensagemSns) => Promise<boolean>;
  /** Injetado nos testes; usado para confirmar a inscrição SNS. */
  buscar?: (url: string) => Promise<{ ok: boolean }>;
  /** Ligar só em desenvolvimento. */
  pularVerificacao?: boolean;
}

export async function tratarEventoSns(req: Request, deps: DepsWebhookSes): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const { supabase } = deps;
  const verificar = deps.verificarAssinatura ?? assinaturaSnsValida;
  const buscar = deps.buscar ?? ((url: string) => fetch(url));

  // O corpo CRU é o que entra na verificação — nada de req.json() antes disso.
  const bruto = await req.text();

  let msg: MensagemSns;
  try {
    msg = JSON.parse(bruto);
  } catch {
    return json({ error: "corpo não é JSON" }, 400);
  }

  if (deps.pularVerificacao) {
    console.warn("webhooks-ses-events: verificação de assinatura DESLIGADA");
  } else if (!(await verificar(msg))) {
    return json({ error: "assinatura SNS inválida" }, 400);
  }

  // --- Confirmação de inscrição ---------------------------------------------------
  if (msg.Type === "SubscriptionConfirmation") {
    if (!msg.SubscribeURL) return json({ error: "sem SubscribeURL" }, 400);

    const res = await buscar(msg.SubscribeURL);
    const ok = !!res?.ok;

    await supabase.from("email_sns_assinaturas").upsert({
      topic_arn: msg.TopicArn,
      subscription_arn: ok ? "confirmada" : null,
      origem_ip: req.headers.get("x-forwarded-for"),
    }, { onConflict: "topic_arn" });

    return json({ ok, confirmada: ok });
  }

  if (msg.Type === "UnsubscribeConfirmation") {
    console.warn("webhooks-ses-events: tópico DESINSCRITO", msg.TopicArn);
    return json({ ok: true });
  }

  if (msg.Type !== "Notification") return json({ ok: true, ignorado: msg.Type });

  // --- Dedupe de reentrega ---------------------------------------------------------
  // O SNS reentrega quando não recebe 200 rápido. Sem esta trava, a segunda entrega do
  // mesmo evento contaria de novo e a métrica inflaria sozinha.
  const { error: dup } = await supabase.from("email_webhook_eventos").insert({
    evento_id: msg.MessageId,
    tipo: "sns",
    provider: "ses",
  });
  if (dup) {
    if ((dup as { code?: string }).code === "23505") return json({ ok: true, repetido: true });
    console.error("webhooks-ses-events: falha ao registrar evento", dup.message);
  }

  // O payload do SES vem como STRING dentro de `Message`.
  let corpoSes: unknown;
  try {
    corpoSes = JSON.parse(msg.Message);
  } catch {
    return json({ error: "campo Message não é JSON" }, 400);
  }

  const evento = interpretarEventoSes(corpoSes);
  const agora = new Date().toISOString();

  // --- Atualiza o log da mensagem --------------------------------------------------
  if (evento.messageId) {
    const { data: log } = await supabase
      .from("emails_enviados")
      .select("id, status, aberto_count, clicado_count, contexto_tipo, contexto_id")
      .eq("provider_message_id", evento.messageId)
      .maybeSingle();

    if (log) {
      const update: Record<string, unknown> = {};
      if (evento.status && (PESO[evento.status] ?? 0) >= (PESO[log.status] ?? 0)) {
        update.status = evento.status;
      }
      if (evento.tipo === "Delivery") update.entregue_em = agora;
      if (evento.tipo === "Open") {
        update.aberto_em = agora;
        update.aberto_count = (log.aberto_count ?? 0) + 1;
      }
      if (evento.tipo === "Click") update.clicado_count = (log.clicado_count ?? 0) + 1;
      if (evento.detalhe) update.erro_msg = evento.detalhe;

      if (Object.keys(update).length) {
        await supabase.from("emails_enviados").update(update).eq("id", log.id);
      }

      if (log.contexto_tipo === "campanha" && log.contexto_id) {
        const inc: Record<string, number> = {};
        if (evento.tipo === "Delivery") inc.p_entregues = 1;
        if (evento.tipo === "Open") inc.p_abertos = 1;
        if (evento.tipo === "Click") inc.p_clicados = 1;
        if (evento.tipo === "Bounce" && evento.suprimir.length) inc.p_bounces = 1;
        if (Object.keys(inc).length) {
          await supabase.rpc("email_campanha_incrementa", { p_campanha: log.contexto_id, ...inc });
        }
      }
    }
  }

  // --- Supressão ---------------------------------------------------------------------
  // Bounce DURO e reclamação saem da base para sempre; transitório não entra.
  for (const s of evento.suprimir) {
    await supabase.from("email_supressoes").upsert({
      email: s.email,
      motivo: s.motivo,
      detalhe: s.detalhe,
      origem_tipo: "ses",
    }, { onConflict: "email", ignoreDuplicates: true });
  }

  return json({ ok: true, tipo: evento.tipo, suprimidos: evento.suprimir.length });
}
