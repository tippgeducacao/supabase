// crm-whatsapp-send
// Envia mensagem WhatsApp (texto, template ou documento/PDF) via Meta Cloud API para o CRM Comercial.
// Diferente do whatsapp-send-message (pedagógico) — usa crm_whatsapp_accounts e crm_whatsapp_messages.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_GRAPH = "https://graph.facebook.com/v21.0";

function formatPhone(raw: string): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (!digits) return null;
  return digits.startsWith("55") ? digits : `55${digits}`;
}

// Canoniza p/ o formato COM 9º dígito (igual à crm-lead-webhook) — usado no remotejid
// do cliente_ppg_mensagens_sdr pra casar com o lead que o agente busca.
function canonicalBrPhone(raw: string): string {
  let d = (raw ?? "").replace(/\D/g, "");
  if (d.startsWith("55")) d = d.slice(2);
  if (d.length === 10 && ["6", "7", "8", "9"].includes(d[2])) {
    d = d.slice(0, 2) + "9" + d.slice(2);
  }
  return `55${d}`;
}

// Renderiza o corpo do template substituindo {{1}}, {{2}}, ... pelos parâmetros do "body".
function renderTemplate(corpo: string, components: unknown): string {
  const arr = Array.isArray(components) ? components : [];
  const params: any[] = (arr.find((c: any) => c?.type === "body") as any)?.parameters ?? [];
  let texto = corpo;
  params.forEach((p, i) => {
    texto = texto.split(`{{${i + 1}}}`).join(String(p?.text ?? ""));
  });
  return texto;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const {
      wa_account_id,
      telefone,
      tipo = "text",
      conteudo,
      template_name,
      template_lang,
      template_components,
      anexo_url,
      filename,
      mime_type,
      curso,
      lead_id,
      oportunidade_id,
      // Quem disparou: 'humano' (composer/atendente). Ausente = IA/automação (o
      // espelho trata template à parte). Guardado em metadata.origem p/ colorir o chat.
      origem,
      // tipo=reaction: wamid da mensagem alvo (emoji vai em `conteudo`)
      reaction_message_id,
      // tipo=interactive (mensagem de SESSÃO — só dentro da janela de 24h aberta):
      //   interactive_tipo: "button" (até 3 botões de resposta) | "list" (menu de até 10 linhas)
      //   conteudo = corpo; interactive_footer = rodapé opcional
      //   button → interactive_buttons: [{ id, title }]
      //   list   → interactive_list_button (rótulo que abre a lista) + interactive_sections: [{ title?, rows: [{ id, title, description? }] }]
      interactive_tipo,
      interactive_footer,
      interactive_buttons,
      interactive_list_button,
      interactive_sections,
    } = body ?? {};

    if (!telefone || !tipo) {
      return json({ error: "telefone e tipo são obrigatórios" }, 400);
    }
    if (tipo === "text" && !String(conteudo ?? "").trim()) {
      return json({ error: "conteudo vazio para tipo text" }, 400);
    }
    if (tipo === "template" && !template_name) {
      return json({ error: "template_name obrigatório para tipo template" }, 400);
    }
    if (tipo === "document" && !String(anexo_url ?? "").trim() && !String(curso ?? "").trim()) {
      return json({ error: "informe anexo_url ou curso para tipo document" }, 400);
    }
    if ((tipo === "audio" || tipo === "sticker") && !String(anexo_url ?? "").trim()) {
      return json({ error: `anexo_url obrigatório para tipo ${tipo}` }, 400);
    }
    if (tipo === "reaction" && (!String(reaction_message_id ?? "").trim() || !String(conteudo ?? "").trim())) {
      return json({ error: "reaction_message_id e conteudo (emoji) são obrigatórios para tipo reaction" }, 400);
    }
    if (tipo === "interactive") {
      if (!String(conteudo ?? "").trim()) {
        return json({ error: "conteudo (corpo) obrigatório para tipo interactive" }, 400);
      }
      if (interactive_tipo === "button") {
        const btns = Array.isArray(interactive_buttons) ? interactive_buttons : [];
        if (btns.length < 1 || btns.length > 3) {
          return json({ error: "interactive_buttons: informe de 1 a 3 botões" }, 400);
        }
        if (btns.some((b: any) => !String(b?.title ?? "").trim())) {
          return json({ error: "cada botão precisa de um título" }, 400);
        }
      } else if (interactive_tipo === "list") {
        if (!String(interactive_list_button ?? "").trim()) {
          return json({ error: "interactive_list_button (rótulo do menu) obrigatório para lista" }, 400);
        }
        const secs = Array.isArray(interactive_sections) ? interactive_sections : [];
        const totalRows = secs.reduce((n: number, s: any) => n + (Array.isArray(s?.rows) ? s.rows.length : 0), 0);
        if (totalRows < 1 || totalRows > 10) {
          return json({ error: "a lista precisa de 1 a 10 opções no total" }, 400);
        }
        if (secs.some((s: any) => (s?.rows ?? []).some((r: any) => !String(r?.title ?? "").trim()))) {
          return json({ error: "cada opção da lista precisa de um título" }, 400);
        }
      } else {
        return json({ error: "interactive_tipo deve ser 'button' ou 'list'" }, 400);
      }
    }

    const to = formatPhone(telefone);
    if (!to) return json({ error: "telefone inválido" }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false },
    });

    // Origem da mensagem (colore o chat): 'humano' quando a chamada vem de um USUÁRIO
    // logado (atendente no CRM). O agente João e automações chamam com o SERVICE_ROLE
    // (Bearer) — esses NÃO são humano. Detecta pelo JWT do header, então vale pra
    // qualquer atendente mesmo com o front antigo em cache (não depende do composer
    // mandar `origem`). Template é resolvido à parte no espelho (tipo='template').
    let origemFinal: string | null = origem ? String(origem) : null;
    if (!origemFinal) {
      const authToken = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      if (authToken && authToken !== SERVICE_ROLE) {
        try {
          const { data: u } = await admin.auth.getUser(authToken);
          if (u?.user?.id) origemFinal = "humano";
        } catch { /* token não-usuário (anon/serviço): não é humano */ }
      }
    }

    // Trava de FREQUÊNCIA de template (recomendação Meta): no máximo 1 template por
    // número a cada 24h. Vale para TODA origem (composer, automação/fluxo, agente João,
    // disparo em massa) — todas passam por aqui. Fonte da verdade: crm_whatsapp_messages.
    // Bypass explícito por chamada com `forcar_template: true` (ex.: reenvio manual ciente).
    if (tipo === "template" && body?.forcar_template !== true) {
      const { data: jaEnviou } = await admin.rpc("crm_whatsapp_template_enviado_24h", { p_telefone: to });
      if (jaEnviou === true) {
        return json({
          ok: true,
          skipped: "template_24h",
          motivo: "Já houve um template para este número nas últimas 24h (regra de frequência da Meta).",
        });
      }
    }

    // Busca conta WA ativa do CRM
    const { data: waRow, error: waErr } = await admin.rpc("get_crm_wa_account", {
      p_account_id: wa_account_id ?? null,
    });
    if (waErr || !waRow || (Array.isArray(waRow) && waRow.length === 0)) {
      return json({ error: `Conta WhatsApp CRM não encontrada: ${waErr?.message ?? "nenhuma ativa"}` }, 500);
    }
    const wa = Array.isArray(waRow) ? waRow[0] : waRow;
    const { phone_number_id: phoneNumberId, access_token: accessToken, id: accountId } = wa;
    if (!phoneNumberId || !accessToken) {
      return json({ error: "Conta WA incompleta (falta phone_number_id ou access_token)" }, 500);
    }

    // Documento: resolve a URL do material pelo curso quando não veio explícita (IA manda só
    // o nome da pós; operador costuma mandar a URL direta do upload). Material em crm_materiais_pos.
    let docUrl = String(anexo_url ?? "").trim();
    let docFilename = String(filename ?? "").trim();
    if (tipo === "document" && !docUrl && String(curso ?? "").trim()) {
      // Match insensível a acento/caixa/espaço (a IA pode mandar "Sanidade Avícola" etc.).
      const norm = (s: string) =>
        [...s.normalize("NFD")].filter((ch) => { const n = ch.codePointAt(0); return n === undefined || n < 0x300 || n > 0x36f; }).join("").toLowerCase().replace(/\s+/g, " ").trim();
      const alvo = norm(String(curso));
      const { data: mats } = await admin
        .from("crm_materiais_pos")
        .select("curso, url, nome_arquivo")
        .eq("tipo", "cronograma")
        .eq("ativo", true);
      const mat = (mats ?? []).find((m: any) => norm(String(m.curso ?? "")) === alvo);
      if (mat?.url) {
        docUrl = String(mat.url);
        if (!docFilename) docFilename = String(mat.nome_arquivo ?? "");
      }
    }
    if (tipo === "document" && !docUrl) {
      return json({ error: `cronograma não encontrado para o curso '${curso ?? ""}'` }, 404);
    }
    if (!docFilename) {
      docFilename = tipo === "audio" ? "audio" : tipo === "sticker" ? "sticker.webp" : "documento.pdf";
    }

    // Monta payload Meta
    let waPayload: Record<string, unknown>;
    if (tipo === "text") {
      waPayload = {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: String(conteudo).slice(0, 4096), preview_url: true },
      };
    } else if (tipo === "template") {
      waPayload = {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: template_name,
          language: { code: template_lang || "pt_BR" },
          components: Array.isArray(template_components) ? template_components : [],
        },
      };
    } else if (tipo === "document") {
      // PDF/arquivo por URL pública (Storage do Supabase, Drive, site…). caption = conteudo (opcional).
      const caption = String(conteudo ?? "").trim();
      waPayload = {
        messaging_product: "whatsapp",
        to,
        type: "document",
        document: {
          link: docUrl,
          filename: docFilename,
          ...(caption ? { caption: caption.slice(0, 1024) } : {}),
        },
      };
    } else if (tipo === "audio") {
      // Áudio por URL pública. Meta aceita aac/mp4/mpeg/amr/ogg-opus (sem caption).
      waPayload = {
        messaging_product: "whatsapp",
        to,
        type: "audio",
        audio: { link: docUrl },
      };
    } else if (tipo === "sticker") {
      // Figurinha: webp estático (512x512, <100KB) ou animado (<500KB) por URL pública.
      waPayload = {
        messaging_product: "whatsapp",
        to,
        type: "sticker",
        sticker: { link: docUrl },
      };
    } else if (tipo === "reaction") {
      // Reação a uma mensagem existente: emoji em `conteudo`, alvo em reaction_message_id.
      waPayload = {
        messaging_product: "whatsapp",
        to,
        type: "reaction",
        reaction: { message_id: String(reaction_message_id), emoji: String(conteudo) },
      };
    } else if (tipo === "interactive") {
      // Mensagem interativa de SESSÃO (botões de resposta / lista). Só é entregue dentro
      // da janela de 24h aberta — fora dela a Meta recusa (use template). Limites da Meta:
      // botão title ≤ 20; lista: rótulo ≤ 20, título da linha ≤ 24, descrição ≤ 72, até 10 linhas.
      const bodyText = String(conteudo).slice(0, 1024);
      const footerText = String(interactive_footer ?? "").trim();
      const footerObj = footerText ? { footer: { text: footerText.slice(0, 60) } } : {};
      if (interactive_tipo === "button") {
        const buttons = (interactive_buttons as any[]).slice(0, 3).map((b, i) => ({
          type: "reply",
          reply: {
            id: String(b?.id ?? `btn_${i + 1}`).slice(0, 256),
            title: String(b?.title ?? "").slice(0, 20),
          },
        }));
        waPayload = {
          messaging_product: "whatsapp",
          to,
          type: "interactive",
          interactive: { type: "button", body: { text: bodyText }, ...footerObj, action: { buttons } },
        };
      } else {
        const sections = (interactive_sections as any[]).map((s, si) => ({
          ...(String(s?.title ?? "").trim() ? { title: String(s.title).slice(0, 24) } : {}),
          rows: (Array.isArray(s?.rows) ? s.rows : []).map((r: any, ri: number) => ({
            id: String(r?.id ?? `row_${si + 1}_${ri + 1}`).slice(0, 200),
            title: String(r?.title ?? "").slice(0, 24),
            ...(String(r?.description ?? "").trim() ? { description: String(r.description).slice(0, 72) } : {}),
          })),
        }));
        waPayload = {
          messaging_product: "whatsapp",
          to,
          type: "interactive",
          interactive: {
            type: "list",
            body: { text: bodyText },
            ...footerObj,
            action: { button: String(interactive_list_button).slice(0, 20), sections },
          },
        };
      }
    } else {
      return json({ error: `tipo '${tipo}' não suportado (use text, template, document, audio, sticker, reaction ou interactive)` }, 400);
    }

    console.log("[crm-whatsapp-send] -> Meta:", JSON.stringify(waPayload));

    const r = await fetch(`${META_GRAPH}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(waPayload),
    });
    const waResp = await r.json().catch(() => ({}));
    console.log("[crm-whatsapp-send] <- Meta status:", r.status);

    const waMsgId = waResp?.messages?.[0]?.id ?? null;
    const nowIso = new Date().toISOString();

    // Resolve o TEXTO do template p/ aparecer no chat e SEMPRE semear o histórico do agente.
    // Prioridade: (1) template custom do CRM (crm_mensagem_templates); (2) cache dos corpos
    // aprovados da Meta (crm_whatsapp_template_bodies); (3) busca na Meta 1x e cacheia (num
    // disparo, só o 1º envio do template busca; os demais leem do cache). Sem corpo em lugar
    // nenhum -> placeholder "[template] <nome>" no seed.
    let templateTexto: string | null = null;
    if (tipo === "template") {
      let corpo: string | null = null;
      const { data: tpl } = await admin
        .from("crm_mensagem_templates")
        .select("conteudo")
        .eq("nome", template_name)
        .maybeSingle();
      if (tpl?.conteudo) corpo = String(tpl.conteudo);
      if (!corpo) {
        const { data: cache } = await admin
          .from("crm_whatsapp_template_bodies")
          .select("body_text")
          .eq("template_name", template_name)
          .maybeSingle();
        if (cache?.body_text) corpo = String(cache.body_text);
      }
      if (!corpo && wa.waba_id) {
        // Busca o corpo aprovado na Meta (1x) e cacheia para os próximos envios.
        try {
          const tr = await fetch(
            `${META_GRAPH}/${wa.waba_id}/message_templates?name=${encodeURIComponent(String(template_name))}&fields=name,components&limit=5`,
            { headers: { Authorization: `Bearer ${accessToken}` } },
          );
          const tj: any = await tr.json().catch(() => ({}));
          const arr = Array.isArray(tj?.data) ? tj.data : [];
          const match = arr.find((t: any) => t?.name === template_name) ?? arr[0];
          const bodyComp = (Array.isArray(match?.components) ? match.components : [])
            .find((c: any) => String(c?.type ?? "").toUpperCase() === "BODY");
          const bodyText = String(bodyComp?.text ?? "");
          if (bodyText) {
            corpo = bodyText;
            await admin.from("crm_whatsapp_template_bodies")
              .upsert({ template_name, body_text: bodyText }, { onConflict: "template_name" });
          }
        } catch (e: any) {
          console.log("[crm-whatsapp-send] fetch corpo template falhou:", e?.message);
        }
      }
      if (corpo) templateTexto = renderTemplate(corpo, template_components);
    }

    // Conteúdo persistido (texto real do template quando temos o corpo; caption/nome do doc).
    // reaction usa o marcador [reacao]<emoji> — o chat e o preview renderizam como reação.
    let conteudoPersist: string;
    if (tipo === "text") conteudoPersist = String(conteudo);
    else if (tipo === "template") conteudoPersist = templateTexto ?? `[template] ${template_name}`;
    else if (tipo === "audio" || tipo === "sticker") conteudoPersist = "";
    else if (tipo === "reaction") conteudoPersist = `[reacao]${String(conteudo)}`;
    else if (tipo === "interactive") {
      // No thread, mostra o corpo + as opções enviadas (os botões/lista em si só aparecem
      // no WhatsApp do contato), pra o operador ver o que mandou.
      const opcoes =
        interactive_tipo === "button"
          ? (interactive_buttons as any[]).map((b) => `▸ ${String(b?.title ?? "").trim()}`)
          : (interactive_sections as any[]).flatMap((s) =>
              (Array.isArray(s?.rows) ? s.rows : []).map((r: any) => `▸ ${String(r?.title ?? "").trim()}`),
            );
      conteudoPersist = `${String(conteudo).trim()}${opcoes.length ? `\n\n${opcoes.join("\n")}` : ""}`;
    }
    else conteudoPersist = String(conteudo ?? "").trim() || `[documento] ${docFilename}`;

    // Anexo (pra renderizar no chat — o CrmChatPanel lê crm_whatsapp_messages.anexos)
    const anexosPersist =
      tipo === "document"
        ? [{
            tipo: "document",
            mime_type: String(mime_type ?? "application/pdf"),
            url: docUrl,
            filename: docFilename,
          }]
        : tipo === "audio"
        ? [{
            tipo: "audio",
            mime_type: String(mime_type ?? "audio/mp4"),
            url: docUrl,
            filename: docFilename,
          }]
        : tipo === "sticker"
        ? [{
            tipo: "sticker",
            mime_type: String(mime_type ?? "image/webp"),
            url: docUrl,
            filename: docFilename,
          }]
        // text/template/reaction/interactive não têm anexo: [] (default da coluna,
        // jsonb NOT NULL DEFAULT '[]') — nunca null, pra casar com o contrato da tabela.
        : [];

    // Persiste mensagem no CRM
    const { error: msgErr } = await admin.from("crm_whatsapp_messages").insert({
      wa_account_id: accountId,
      lead_id: lead_id ?? null,
      oportunidade_id: oportunidade_id ?? null,
      telefone: to,
      direcao: "outbound",
      tipo,
      conteudo: conteudoPersist,
      anexos: anexosPersist,
      template_name: tipo === "template" ? template_name : null,
      wa_message_id: waMsgId,
      status_entrega: r.ok ? "sent" : "failed",
      erro: r.ok ? null : { status: r.status, meta_response: waResp },
      metadata: { payload_enviado: waPayload, ...(origemFinal ? { origem: origemFinal } : {}) },
    });
    if (msgErr) console.error("[crm-whatsapp-send] insert erro:", msgErr.message);

    // Semeia o histórico do agente com o template enviado (role=assistant) — contexto da IA.
    // SEMPRE que o envio à Meta deu OK: usa o texto real quando temos o corpo (custom/cache/
    // Meta), senão um marcador "[template] <nome>" (a IA ao menos sabe que um template saiu).
    if (tipo === "template" && r.ok) {
      const remoteJid = `${canonicalBrPhone(telefone)}@s.whatsapp.net`;
      const conteudoSeed = templateTexto ?? `[template] ${template_name}`;
      const { error: histErr } = await admin.from("cliente_ppg_mensagens_sdr").insert({
        remotejid: remoteJid,
        conversation_history: { role: "assistant", content: conteudoSeed },
        timestamp: nowIso,
      });
      if (histErr) console.error("[crm-whatsapp-send] hist sdr erro:", histErr.message);
    }

    // NÃO semear histórico do agente em envio de documento: o histórico vira o array
    // de messages da Claude API e um insert assistant aqui + a resposta do próprio
    // agente = dois assistant seguidos -> 400 (roles devem alternar). O contexto do
    // envio já chega ao agente pelo tool_result (cronograma_enviado) e pela própria
    // resposta dele ("te enviei o cronograma"), que o n8n salva normalmente.

    if (!r.ok) {
      const errMsg =
        waResp?.error?.message ||
        waResp?.error?.error_user_msg ||
        `Meta API ${r.status}`;
      console.error("[crm-whatsapp-send] Meta erro:", r.status, JSON.stringify(waResp));
      // meta_code permite ao front traduzir o erro pra uma mensagem específica
      // (190 = token, 131047 = janela 24h, 1 = instabilidade da Meta, etc.)
      return json({
        error: errMsg,
        meta_code: waResp?.error?.code ?? null,
        meta_subcode: waResp?.error?.error_subcode ?? null,
        status: r.status,
      }, 502);
    }

    return json({
      success: true,
      wa_message_id: waMsgId,
      sent_at: nowIso,
      wa_account_id: accountId,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[crm-whatsapp-send] fatal:", msg);
    return json({ error: "erro interno ao enviar mensagem" }, 500);
  }
});
