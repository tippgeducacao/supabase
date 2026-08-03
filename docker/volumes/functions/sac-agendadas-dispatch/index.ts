// sac-agendadas-dispatch
// Disparado pelo cron 'sac-mensagens-agendadas-dispatch' (a cada minuto): envia as
// mensagens agendadas do SAC (sac_mensagens_agendadas) cujo enviar_em venceu.
//
// Regra da janela de 24h (API oficial Meta), RECHECADA no horário do envio:
// - janela aberta (contato respondeu há <24h): envia qualquer tipo (texto/áudio/arquivo/template);
// - janela fechada + template: envia normalmente (template é sempre permitido);
// - janela fechada + mensagem livre: BLOQUEIA (status='erro') — o WhatsApp recusaria (131047).
//
// O envio insere em ped_conversas_mensagens; o trigger sac_mirror_from_ped_msg
// espelha a mensagem de volta no chat do SAC automaticamente.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_GRAPH = "https://graph.facebook.com/v21.0";
const JANELA_24H_MS = 24 * 60 * 60 * 1000;

function formatPhone(raw: string): string | null {
  const trimmed = String(raw ?? "").trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  // Número internacional já com DDI (veio com '+', ex.: +1 dos EUA): NÃO force o 55.
  if (trimmed.startsWith("+")) return digits;
  // Já vem com o DDI do Brasil (55 + 10/11 dígitos).
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) return digits;
  // Número brasileiro sem DDI: DDD + 8 dígitos (fixo) ou DDD + 9xxxxxxxx (celular).
  // Celular BR de 11 dígitos SEMPRE tem '9' no 3º dígito — 11 dígitos sem esse 9 é
  // internacional sem DDI (ex.: wa_id dos EUA, 1+10) e NÃO pode ganhar 55.
  if (digits.length === 10 || (digits.length === 11 && digits[2] === "9")) return `55${digits}`;
  // Não reconhecido: devolve os dígitos como estão (não corrompe internacional sem '+').
  return digits;
}

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type Agendada = {
  id: string;
  atendimento_id: string;
  conversa_id: string;
  telefone: string;
  tipo_mensagem: "texto" | "audio" | "arquivo" | "template";
  conteudo: string | null;
  anexo: { tipo?: string; url?: string; mime_type?: string; filename?: string } | null;
  template_name: string | null;
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
      .from("sac_mensagens_agendadas")
      .update({ status: "erro", erro_detalhe: "Envio interrompido (timeout do processamento). Verifique o chat e reagende se necessário." })
      .eq("status", "enviando")
      .lt("enviar_em", new Date(Date.now() - 10 * 60_000).toISOString());

    // Claim atômico: marca 'enviando' antes de processar pra não duplicar envio
    // caso duas execuções do cron se sobreponham.
    const { data: due, error: dueErr } = await admin
      .from("sac_mensagens_agendadas")
      .select("id")
      .eq("status", "agendado")
      .lte("enviar_em", new Date().toISOString())
      .order("enviar_em", { ascending: true })
      .limit(20);
    if (dueErr) throw dueErr;
    if (!due?.length) return jsonResp({ processed: 0 });

    const { data: claimed, error: claimErr } = await admin
      .from("sac_mensagens_agendadas")
      .update({ status: "enviando" })
      .in("id", due.map((d: { id: string }) => d.id))
      .eq("status", "agendado")
      .select("id, atendimento_id, conversa_id, telefone, tipo_mensagem, conteudo, anexo, template_name, template_components");
    if (claimErr) throw claimErr;

    const { data: waRow, error: waErr } = await admin.rpc("get_wa_account_pedagogico");
    if (waErr || !waRow) throw new Error(`WA account: ${waErr?.message ?? "vazio"}`);
    const wa = Array.isArray(waRow) ? waRow[0] : waRow;
    if (!wa?.phone_number_id || !wa?.access_token) throw new Error("WA account incompleto");

    const results: Record<string, string> = {};
    for (const row of (claimed ?? []) as Agendada[]) {
      results[row.id] = await processarUma(admin, wa, row);
    }
    return jsonResp({ processed: Object.keys(results).length, results });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[sac-agendadas-dispatch] fatal:", msg);
    return jsonResp({ error: msg }, 500);
  }
});

async function processarUma(
  admin: ReturnType<typeof createClient>,
  wa: { phone_number_id: string; access_token: string },
  row: Agendada,
): Promise<string> {
  const falhar = async (detalhe: string) => {
    await admin.from("sac_mensagens_agendadas")
      .update({ status: "erro", erro_detalhe: detalhe })
      .eq("id", row.id);
    return `erro: ${detalhe}`;
  };

  try {
    // Recheca a janela de 24h AGORA (pode ter reaberto ou fechado desde o agendamento)
    const { data: lastIn } = await admin
      .from("sac_mensagens")
      .select("criado_em")
      .eq("atendimento_id", row.atendimento_id)
      .eq("direcao", "inbound")
      .order("criado_em", { ascending: false })
      .limit(1)
      .maybeSingle();
    const janelaAberta = !!lastIn?.criado_em &&
      Date.now() - new Date(lastIn.criado_em as string).getTime() < JANELA_24H_MS;

    if (row.tipo_mensagem !== "template" && !janelaAberta) {
      return await falhar(
        "Fora da janela de 24h no horário do envio. Mensagem livre bloqueada — reagende usando um template aprovado pela Meta.",
      );
    }

    const to = formatPhone(row.telefone);
    if (!to) return await falhar("Telefone inválido");

    // Monta o payload da Meta conforme o tipo
    let waPayload: Record<string, unknown>;
    let conteudoPersist: string;
    let anexos: unknown[] = [];
    if (row.tipo_mensagem === "texto") {
      const texto = String(row.conteudo ?? "").trim();
      if (!texto) return await falhar("Conteúdo vazio");
      waPayload = {
        messaging_product: "whatsapp", to, type: "text",
        text: { body: texto.slice(0, 4096), preview_url: true },
      };
      conteudoPersist = texto;
    } else if (row.tipo_mensagem === "template") {
      if (!row.template_name) return await falhar("Template não informado");
      waPayload = {
        messaging_product: "whatsapp", to, type: "template",
        template: {
          name: row.template_name,
          language: { code: "pt_BR" },
          components: Array.isArray(row.template_components) ? row.template_components : [],
        },
      };
      // Persiste o corpo renderizado (salvo no agendamento) pra conversa ficar legível
      conteudoPersist = row.conteudo?.trim() || `[template] ${row.template_name}`;
    } else {
      // audio / arquivo: mídia por link (upload feito no agendamento)
      const ax = row.anexo ?? {};
      const tipoMidia = row.tipo_mensagem === "audio" ? "audio" : (ax.tipo ?? "document");
      if (!ax.url) return await falhar("Anexo sem URL");
      const mediaObj: Record<string, unknown> = { link: ax.url };
      if (tipoMidia === "document" && ax.filename) mediaObj.filename = ax.filename;
      if (tipoMidia !== "audio" && row.conteudo?.trim()) {
        mediaObj.caption = row.conteudo.trim().slice(0, 1024);
      }
      waPayload = { messaging_product: "whatsapp", to, type: tipoMidia, [tipoMidia]: mediaObj };
      conteudoPersist = row.conteudo?.trim() || `[${tipoMidia}]`;
      anexos = [{ tipo: tipoMidia, url: ax.url, mime_type: ax.mime_type ?? null, filename: ax.filename ?? null }];
    }

    // Conta que envia: o TEMPLATE manda na conta. A Meta resolve o nome do modelo DENTRO da
    // WABA do phone_number_id que envia — mandar por outra devolve (#132001) e a mensagem não
    // sai. A conta padrão é resolvida uma vez fora do laço, mas um template com dona própria
    // (ex.: os de podcast, na WABA "Podcast - PPGVET") tem que sair por ela.
    // Mesma régua do `whatsapp-send-message` — mudou lá, mude aqui.
    let waEnvio = wa;
    try {
      const carregar = async (accId: string) => {
        const { data: acc } = await admin
          .from("wa_accounts").select("phone_number_id, access_token")
          .eq("id", accId).eq("is_active", true).maybeSingle();
        const a = acc as { phone_number_id: string; access_token: string } | null;
        return a?.phone_number_id && a?.access_token ? a : null;
      };

      if (row.tipo_mensagem === "template" && row.template_name) {
        const { data: tpl } = await admin
          .from("ped_wa_templates").select("wa_account_id")
          .eq("nome", row.template_name).maybeSingle();
        const accId = (tpl as { wa_account_id: string | null } | null)?.wa_account_id;
        if (accId) waEnvio = (await carregar(accId)) ?? waEnvio;
      }

      // Sem conta pelo template (texto, áudio, arquivo — ou template sem dona): segue a
      // CONVERSA, como o `whatsapp-send-message` faz. Sem isto, um texto agendado numa
      // conversa de podcast sairia pelo número pedagógico e partiria a thread.
      if (waEnvio === wa && row.conversa_id) {
        const { data: conv } = await admin
          .from("ped_conversas_avulsas").select("metadata").eq("id", row.conversa_id).maybeSingle();
        const accId = ((conv as { metadata: Record<string, unknown> | null } | null)?.metadata
          ?.wa_account_id) as string | undefined;
        if (accId) waEnvio = (await carregar(accId)) ?? waEnvio;
      }
    } catch (_e) { /* mantém a conta padrão */ }

    console.log("[sac-agendadas-dispatch] ->", row.id, JSON.stringify(waPayload));
    const r = await fetch(`${META_GRAPH}/${waEnvio.phone_number_id}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${waEnvio.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify(waPayload),
    });
    const waResp = await r.json().catch(() => ({}));
    console.log("[sac-agendadas-dispatch] <-", row.id, r.status, JSON.stringify(waResp));
    if (!r.ok) {
      const errMsg = waResp?.error?.message || waResp?.error?.error_user_msg || `Meta API ${r.status}`;
      return await falhar(errMsg);
    }

    const waMsgId = waResp?.messages?.[0]?.id ?? null;
    const nowIso = new Date().toISOString();

    // Espelha no chat: insert em ped_conversas_mensagens dispara o mirror p/ sac_mensagens
    const { error: msgErr } = await admin.from("ped_conversas_mensagens").insert({
      conversa_id: row.conversa_id,
      direcao: "outbound",
      conteudo: conteudoPersist,
      template_name: row.tipo_mensagem === "template" ? row.template_name : null,
      wa_message_id: waMsgId,
      enviada_em: nowIso,
      anexos,
    });
    if (msgErr) console.log("[sac-agendadas-dispatch] insert msg erro:", msgErr.message);

    await admin.from("ped_conversas_avulsas")
      .update({ ultima_atividade_em: nowIso, status: "em_conversa" })
      .eq("id", row.conversa_id);

    await admin.from("sac_mensagens_agendadas")
      .update({ status: "enviado", enviado_em: nowIso, wa_message_id: waMsgId, erro_detalhe: null })
      .eq("id", row.id);
    return "enviado";
  } catch (e) {
    return await falhar(e instanceof Error ? e.message : String(e));
  }
}
