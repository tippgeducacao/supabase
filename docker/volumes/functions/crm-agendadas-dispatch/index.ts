// crm-agendadas-dispatch
// Disparado pelo cron 'crm-mensagens-agendadas-dispatch' (a cada minuto): envia as
// mensagens agendadas do CRM Comercial (crm_mensagens_agendadas) cujo enviar_em venceu.
//
// REUSA a edge function crm-whatsapp-send para o envio de fato — assim herda toda a
// lógica já testada: resolução da conta WhatsApp, trava de frequência de template
// (1/24h por número), montagem do payload Meta, persistência em crm_whatsapp_messages
// e mirror para o thread do SAC. Aqui só fazemos o claim atômico e a atualização de
// status do agendamento.
//
// Janela de 24h (Meta): template é sempre permitido; texto livre fora da janela é
// recusado pela própria Meta (131047) e o erro é registrado no agendamento.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type Agendada = {
  id: string;
  wa_account_id: string | null;
  telefone: string;
  lead_id: string | null;
  oportunidade_id: string | null;
  tipo_mensagem: "texto" | "template";
  conteudo: string | null;
  template_name: string | null;
  template_lang: string | null;
  template_components: unknown;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (!req.headers.get("Authorization")?.startsWith("Bearer ")) {
    return jsonResp({ error: "Unauthorized" }, 401);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  try {
    // Higiene: linha presa em 'enviando' há >10min = execução anterior morreu no meio.
    // Não dá pra saber se a Meta chegou a receber, então marca erro em vez de reenviar.
    await admin
      .from("crm_mensagens_agendadas")
      .update({
        status: "erro",
        erro_detalhe: "Envio interrompido (timeout do processamento). Verifique o chat e reagende se necessário.",
      })
      .eq("status", "enviando")
      .lt("enviar_em", new Date(Date.now() - 10 * 60_000).toISOString());

    // Seleciona os vencidos
    const { data: due, error: dueErr } = await admin
      .from("crm_mensagens_agendadas")
      .select("id")
      .eq("status", "agendado")
      .lte("enviar_em", new Date().toISOString())
      .order("enviar_em", { ascending: true })
      .limit(20);
    if (dueErr) throw dueErr;
    if (!due?.length) return jsonResp({ processed: 0 });

    // Claim atômico: marca 'enviando' antes de processar pra não duplicar envio
    // caso duas execuções do cron se sobreponham.
    const { data: claimed, error: claimErr } = await admin
      .from("crm_mensagens_agendadas")
      .update({ status: "enviando" })
      .in("id", due.map((d: { id: string }) => d.id))
      .eq("status", "agendado")
      .select(
        "id, wa_account_id, telefone, lead_id, oportunidade_id, tipo_mensagem, conteudo, template_name, template_lang, template_components",
      );
    if (claimErr) throw claimErr;

    const results: Record<string, string> = {};
    for (const row of (claimed ?? []) as Agendada[]) {
      results[row.id] = await processarUma(admin, row);
    }
    return jsonResp({ processed: Object.keys(results).length, results });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[crm-agendadas-dispatch] fatal:", msg);
    return jsonResp({ error: msg }, 500);
  }
});

async function processarUma(
  admin: ReturnType<typeof createClient>,
  row: Agendada,
): Promise<string> {
  const falhar = async (detalhe: string) => {
    await admin.from("crm_mensagens_agendadas")
      .update({ status: "erro", erro_detalhe: detalhe })
      .eq("id", row.id);
    return `erro: ${detalhe}`;
  };

  try {
    // Monta o corpo para a crm-whatsapp-send conforme o tipo
    const sendBody: Record<string, unknown> = {
      wa_account_id: row.wa_account_id ?? undefined,
      telefone: row.telefone,
      tipo: row.tipo_mensagem === "template" ? "template" : "text",
      lead_id: row.lead_id ?? undefined,
      oportunidade_id: row.oportunidade_id ?? undefined,
    };
    if (row.tipo_mensagem === "template") {
      if (!row.template_name) return await falhar("Template não informado");
      sendBody.template_name = row.template_name;
      sendBody.template_lang = row.template_lang || "pt_BR";
      sendBody.template_components = Array.isArray(row.template_components) ? row.template_components : [];
    } else {
      const texto = String(row.conteudo ?? "").trim();
      if (!texto) return await falhar("Conteúdo vazio");
      sendBody.conteudo = texto;
    }

    console.log("[crm-agendadas-dispatch] ->", row.id, JSON.stringify(sendBody));
    const r = await fetch(`${SUPABASE_URL}/functions/v1/crm-whatsapp-send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_ROLE}`, "Content-Type": "application/json" },
      body: JSON.stringify(sendBody),
    });
    const resp = await r.json().catch(() => ({} as Record<string, unknown>));
    console.log("[crm-agendadas-dispatch] <-", row.id, r.status, JSON.stringify(resp));

    // crm-whatsapp-send pode pular o envio (trava de frequência de template 1/24h)
    if ((resp as any)?.skipped) {
      return await falhar(
        String((resp as any)?.motivo ?? "Envio pulado pela trava de frequência de template (Meta)."),
      );
    }
    if (!r.ok || (resp as any)?.error || !(resp as any)?.success) {
      return await falhar(String((resp as any)?.error ?? `Falha no envio (status ${r.status})`));
    }

    await admin.from("crm_mensagens_agendadas")
      .update({
        status: "enviado",
        enviado_em: (resp as any)?.sent_at ?? new Date().toISOString(),
        wa_message_id: (resp as any)?.wa_message_id ?? null,
        erro_detalhe: null,
      })
      .eq("id", row.id);
    return "enviado";
  } catch (e) {
    return await falhar(e instanceof Error ? e.message : String(e));
  }
}
