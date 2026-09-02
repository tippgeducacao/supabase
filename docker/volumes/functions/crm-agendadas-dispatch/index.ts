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
//
// tipo_mensagem = 'texto' | 'template' | 'midia'. A MÍDIA é enfileirada pela ação "Enviar
// texto livre" do FLUXO no modo "mensagens separadas" (o texto sai na hora por net.http_post
// e a mídia vem por aqui) — é o que garante que o vídeo chegue DEPOIS do texto, já que o
// pg_net dispara as requisições em paralelo, sem ordem.
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
  // Linha de WhatsApp Web (wa_conexoes). Quando presente, o envio sai pelo adapter do
  // provider (Uazapi) em vez da Meta — sem janela de 24h e sem template.
  wa_conexao_id: string | null;
  telefone: string;
  lead_id: string | null;
  oportunidade_id: string | null;
  tipo_mensagem: "texto" | "template" | "midia";
  conteudo: string | null;
  template_name: string | null;
  template_lang: string | null;
  template_components: unknown;
  automacao_id: string | null;
  anexo_url: string | null;
  filename: string | null;
  mime_type: string | null;
};

// Tipo Meta da mídia: do mime_type e, na falta dele, da extensão do arquivo.
function tipoDaMidia(mime: string | null, url: string, filename: string | null): string {
  const m = (mime ?? "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  const ext = (filename || url).toLowerCase().split("?")[0].split(".").pop() ?? "";
  if (["jpg", "jpeg", "png", "webp", "gif"].includes(ext)) return "image";
  if (["mp4", "3gp", "mov"].includes(ext)) return "video";
  if (["ogg", "opus", "mp3", "m4a"].includes(ext)) return "audio";
  return "document";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (!req.headers.get("Authorization")?.startsWith("Bearer ")) {
    return jsonResp({ error: "Unauthorized" }, 401);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  try {
    // Higiene de órfãos: linha presa em 'enviando' há >5min = execução anterior morreu
    // no meio (não chegou a enviar). Auto-cura:
    //  • TEMPLATE → volta pra 'agendado' (re-enfileira). É seguro porque a crm-whatsapp-send
    //    tem trava de 1 template/24h por número: se a Meta JÁ recebeu, o reenvio é PULADO
    //    (não duplica). Sem isso, um disparo em massa perdia milhares de órfãos como erro.
    //  • TEXTO LIVRE → 'erro' (sem trava 24h, reenviar duplicaria a mensagem).
    const presoDesde = new Date(Date.now() - 5 * 60_000).toISOString();
    await admin
      .from("crm_mensagens_agendadas")
      .update({ status: "agendado", enviar_em: new Date().toISOString(), erro_detalhe: null })
      .eq("status", "enviando").eq("tipo_mensagem", "template")
      .lt("enviar_em", presoDesde);
    await admin
      .from("crm_mensagens_agendadas")
      .update({ status: "erro", erro_detalhe: "Envio interrompido (timeout). Reagende se necessário." })
      .eq("status", "enviando").neq("tipo_mensagem", "template")
      .lt("enviar_em", presoDesde);

    // Claim atômico via RPC: marca 'enviando' e devolve as linhas, num único UPDATE
    // server-side (FOR UPDATE SKIP LOCKED). Evita o `.in([ids])` na URL — que com
    // lote grande (800) estoura o limite de tamanho da request e derruba o dispatcher.
    // ⚠️ LOTE precisa caber no TEMPO DE VIDA de UMA execução da edge. LOTE=8000 quebrou:
    // a edge agarra 8000 (marca 'enviando') mas morre antes de enviar tudo, deixando
    // milhares órfãos em 'enviando'. Com CONC=40 (~20 envios/s), ~1000 saem em ~50s —
    // dentro de um ciclo de cron (60s), então cada execução TERMINA o que agarrou (zero
    // órfão). Vazão ~1000/min. Não aumentar sem medir o tempo real de envio da edge.
    const LOTE = 1000;
    const { data: claimed, error: claimErr } = await admin.rpc("crm_agendadas_claim", { p_limit: LOTE });
    if (claimErr) throw claimErr;
    if (!claimed?.length) return jsonResp({ processed: 0 });

    // Processa em LOTES PARALELOS (CONC por vez) — CONC controla a concorrência contra a Meta.
    const rows = (claimed ?? []) as Agendada[];
    const results: Record<string, string> = {};
    const CONC = 40;
    for (let i = 0; i < rows.length; i += CONC) {
      const chunk = rows.slice(i, i + CONC);
      const settled = await Promise.all(
        chunk.map((row) => processarUma(admin, row).then((res) => [row.id, res] as const)),
      );
      for (const [id, res] of settled) results[id] = res;
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
      // Linha web manda no roteamento: a crm-whatsapp-send, ao ver wa_conexao_id, envia
      // pelo provider da linha (Uazapi) e ignora conta Meta/janela/template.
      wa_conexao_id: row.wa_conexao_id ?? undefined,
      telefone: row.telefone,
      tipo: row.tipo_mensagem === "template" ? "template" : "text",
      lead_id: row.lead_id ?? undefined,
      oportunidade_id: row.oportunidade_id ?? undefined,
      // Disparo de automação → carimba origem 'automacao' (balão roxo no chat). Template
      // segue como 'template' no espelho (o mirror checa template antes da origem).
      ...(row.automacao_id ? { origem: "automacao" } : {}),
    };
    if (row.tipo_mensagem === "template") {
      if (!row.template_name) return await falhar("Template não informado");
      sendBody.template_name = row.template_name;
      sendBody.template_lang = row.template_lang || "pt_BR";
      sendBody.template_components = Array.isArray(row.template_components) ? row.template_components : [];
    } else if (row.tipo_mensagem === "midia") {
      // MÍDIA (imagem/vídeo/documento). Quem enfileira hoje é a ação "Enviar texto livre" do
      // FLUXO no modo "mensagens separadas": o texto já saiu por net.http_post e a mídia vem
      // pela fila — é o que garante a ORDEM (o pg_net envia em paralelo, sem ordem).
      const url = String(row.anexo_url ?? "").trim();
      if (!url) return await falhar("Mídia sem URL");
      sendBody.tipo = tipoDaMidia(row.mime_type, url, row.filename);
      sendBody.anexo_url = url;
      if (row.filename) sendBody.filename = row.filename;
      if (row.mime_type) sendBody.mime_type = row.mime_type;
      const legenda = String(row.conteudo ?? "").trim();
      if (legenda) sendBody.conteudo = legenda;
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
