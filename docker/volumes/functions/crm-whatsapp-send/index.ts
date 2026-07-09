// crm-whatsapp-send
// Envia mensagem WhatsApp (texto, template ou documento/PDF) via Meta Cloud API para o CRM Comercial.
// Diferente do whatsapp-send-message (pedagógico) — usa crm_whatsapp_accounts e crm_whatsapp_messages.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { getWaProvider } from "../_shared/waProviders.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_GRAPH = "https://graph.facebook.com/v21.0";

/**
 * Sobe um arquivo de mídia pro endpoint /media da Meta e devolve o media_id.
 * É o que faz o WhatsApp renderizar áudio OGG/Opus como MENSAGEM DE VOZ (forma de
 * onda) em vez de "arquivo de áudio": enviar por `audio.id` (mídia carregada) ⇒ voz;
 * enviar por `audio.link` ⇒ arquivo. Baixa do nosso storage e reenvia como multipart.
 */
async function metaUploadMedia(
  phoneNumberId: string, accessToken: string, fileUrl: string, mime: string, filename: string,
): Promise<string> {
  const fileResp = await fetch(fileUrl);
  if (!fileResp.ok) throw new Error(`download mídia ${fileResp.status}`);
  const bytes = new Uint8Array(await fileResp.arrayBuffer());
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mime);
  form.append("file", new Blob([bytes], { type: mime }), filename);
  const r = await fetch(`${META_GRAPH}/${phoneNumberId}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` }, // sem Content-Type: o FormData define o boundary
    body: form,
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j?.id) throw new Error(j?.error?.message ?? `media upload ${r.status}`);
  return String(j.id);
}

function formatPhone(raw: string): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (!digits) return null;
  return digits.startsWith("55") ? digits : `55${digits}`;
}

// Variantes p/ casar a conversa pelo telefone apesar do 9º dígito (Uazapi e Meta
// dropam o 9 no inbound). Gera com/sem DDI 55 e com/sem o 9 do celular.
function phoneVariants(raw: string): string[] {
  let d = (raw ?? "").replace(/\D/g, "");
  if (d.startsWith("55")) d = d.slice(2);
  const ddd = d.slice(0, 2);
  const rest = d.slice(2);
  const set = new Set<string>();
  const add = (x: string) => { set.add(x); set.add(`55${x}`); };
  if (rest) add(ddd + rest);
  if (rest.length === 8) add(`${ddd}9${rest}`);            // sem 9 -> adiciona
  if (rest.length === 9 && rest[0] === "9") add(ddd + rest.slice(1)); // com 9 -> remove
  return [...set];
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

// A Meta REJEITA parâmetro de corpo de template que contenha quebra de linha (\n),
// tab (\t) ou 4+ espaços seguidos — erro 132018 ("issue with the parameters"). Vários
// leads do SprintHub chegam com a variável do curso terminando em "\n" (ex.: "CLÍNICA
// MÉDICA E CIRÚRGICA DE BOVINOS\n"), o que derrubava o 1º template SILENCIOSAMENTE — e
// NÃO aparecia como número inválido (≠ 131026). Normaliza o whitespace de TODO parâmetro
// de body aqui, no ponto ÚNICO por onde passa todo envio de template (webhook,
// reconciliação, broadcast, automações).
function sanitizarComponentsTemplate(components: unknown): any[] {
  if (!Array.isArray(components)) return [];
  return components.map((c: any) => {
    if (c?.type !== "body" || !Array.isArray(c?.parameters)) return c;
    return {
      ...c,
      parameters: c.parameters.map((p: any) =>
        p?.type === "text" && typeof p?.text === "string"
          ? { ...p, text: p.text.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim() }
          : p,
      ),
    };
  });
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

// Envio por uma LINHA provider-agnóstica (wa_conexoes). Resolve o provider + token
// (segredo, só service_role), envia pelo adapter e persiste em crm_whatsapp_messages
// (-> trigger espelha pro SAC). Sem janela 24h/template (regra Meta não se aplica).
async function enviarViaConexao(admin: any, p: {
  conexaoId: string; to: string; tipo: string; conteudo?: string;
  anexo_url?: string; filename?: string; mime_type?: string;
  lead_id?: string | null; oportunidade_id?: string | null; origemFinal: string | null;
  reaction_message_id?: string | null;
  enviadoPorId?: string | null; enviadoPorNome?: string | null;
}): Promise<Response> {
  const { data: conex } = await admin
    .from("wa_conexoes")
    .select("id, provider, server_url, status_conexao")
    .eq("id", p.conexaoId)
    .maybeSingle();
  if (!conex) return json({ error: "conexão não encontrada" }, 404);
  if (conex.status_conexao !== "conectado") {
    return json({ error: "linha desconectada — reconecte o número antes de enviar", status_conexao: conex.status_conexao }, 409);
  }
  const { data: sec } = await admin
    .from("wa_conexoes_secrets").select("token").eq("conexao_id", p.conexaoId).maybeSingle();
  if (!sec?.token) return json({ error: "token da conexão ausente" }, 500);

  const provider = getWaProvider(conex.provider);
  const numberDigits = p.to; // já normalizado (55 + dígitos)

  let result: { externalId: string | null; ok: boolean; raw: unknown };
  let anexosPersist: any[] = [];
  let conteudoPersist = String(p.conteudo ?? "");

  if (p.tipo === "text") {
    if (!conteudoPersist.trim()) return json({ error: "conteudo vazio" }, 400);
    result = await provider.sendText(conex.server_url, sec.token, numberDigits, conteudoPersist.slice(0, 4096));
  } else if (["document", "audio", "image", "sticker", "video"].includes(p.tipo)) {
    const urlMidia = String(p.anexo_url ?? "").trim();
    if (!urlMidia) return json({ error: `anexo_url obrigatório para tipo ${p.tipo}` }, 400);
    const caption = p.tipo === "audio" || p.tipo === "sticker" ? "" : conteudoPersist.trim();
    result = await provider.sendMedia(conex.server_url, sec.token, numberDigits, {
      tipo: p.tipo, url: urlMidia, caption, filename: p.filename, mime: p.mime_type,
    });
    anexosPersist = [{
      tipo: p.tipo,
      mime_type: String(p.mime_type ?? (p.tipo === "audio" ? "audio/mp4" : p.tipo === "image" ? "image/jpeg" : p.tipo === "sticker" ? "image/webp" : "application/octet-stream")),
      url: urlMidia,
      filename: p.filename ?? `${p.tipo}`,
    }];
    if (p.tipo === "audio" || p.tipo === "sticker") conteudoPersist = "";
  } else if (p.tipo === "reaction") {
    const emoji = conteudoPersist.trim();
    if (!emoji || !p.reaction_message_id) return json({ error: "reaction_message_id e conteudo (emoji) obrigatórios" }, 400);
    result = await provider.sendReaction(conex.server_url, sec.token, numberDigits, String(p.reaction_message_id), emoji);
    conteudoPersist = `[reacao]${emoji}`; // marcador renderizado como reação no chat
  } else {
    return json({ error: `tipo '${p.tipo}' não suportado nesta linha (use text, document, audio, image, video, sticker, reaction)` }, 400);
  }

  const nowIso = new Date().toISOString();
  const { error: msgErr } = await admin.from("crm_whatsapp_messages").insert({
    provider: conex.provider,
    wa_conexao_id: p.conexaoId,
    wa_account_id: null,
    lead_id: p.lead_id ?? null,
    oportunidade_id: p.oportunidade_id ?? null,
    telefone: p.to,
    direcao: "outbound",
    tipo: p.tipo,
    conteudo: conteudoPersist,
    anexos: anexosPersist,
    wa_message_id: result.externalId,
    status_entrega: result.ok ? "sent" : "failed",
    erro: result.ok ? null : { provider_response: result.raw },
    metadata: {
      provider: conex.provider,
      ...(p.origemFinal ? { origem: p.origemFinal } : {}),
      ...(p.enviadoPorId ? { enviado_por_id: p.enviadoPorId, enviado_por_nome: p.enviadoPorNome } : {}),
    },
  });
  if (msgErr) console.error("[crm-whatsapp-send] insert (conexao) erro:", msgErr.message);

  if (!result.ok) {
    return json({ error: "provider recusou o envio", provider_response: result.raw }, 502);
  }
  return json({ success: true, wa_message_id: result.externalId, sent_at: nowIso, wa_conexao_id: p.conexaoId });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const {
      wa_account_id,
      // Quando presente, a conversa é de uma LINHA provider-agnóstica (ex.: Uazapi):
      // roteamos pelo adapter do provider, sem janela 24h/template (regras da Meta).
      wa_conexao_id,
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
    if ((tipo === "audio" || tipo === "sticker" || tipo === "image" || tipo === "video") && !String(anexo_url ?? "").trim()) {
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
    // QUEM enviou (humano): resolve SEMPRE o usuário do JWT — também quando o composer já
    // mandou origem='humano' — pra carimbar o nome do atendente na mensagem (balão rosa).
    let enviadoPorId: string | null = null;
    let enviadoPorNome: string | null = null;
    {
      const authToken = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      if (authToken && authToken !== SERVICE_ROLE) {
        try {
          const { data: u } = await admin.auth.getUser(authToken);
          if (u?.user?.id) {
            enviadoPorId = u.user.id;
            if (!origemFinal) origemFinal = "humano";
          }
        } catch { /* token não-usuário (anon/serviço): não é humano */ }
      }
    }
    if (enviadoPorId) {
      try {
        const { data: prof } = await admin.from("profiles").select("name").eq("id", enviadoPorId).maybeSingle();
        enviadoPorNome = (prof?.name ?? "").trim() || null;
      } catch { /* perfil indisponível — segue sem nome */ }
    }

    // ── Rota provider-agnóstica (Uazapi etc.) ────────────────────────────────
    // Roteamento de canal (prioridade): (1) wa_conexao_id explícito → linha web;
    // (2) wa_account_id explícito → conta Meta (ex.: botão "Testar") — NUNCA sobreposto;
    // (3) nenhum → AUTO-DETECTA pela última mensagem (CRM/SAC/Omnichat respondem no canal
    // certo sem passar nada). Conta/linha explícita SEMPRE ganha do auto-detect.
    let conexaoIdRota: string | null = wa_conexao_id ? String(wa_conexao_id) : null;
    if (!conexaoIdRota && !wa_account_id) {
      let q = admin
        .from("crm_whatsapp_messages")
        .select("provider, wa_conexao_id")
        .order("created_at", { ascending: false })
        .limit(1);
      q = lead_id ? q.eq("lead_id", lead_id) : q.in("telefone", phoneVariants(to));
      const { data: lastRows } = await q;
      const last = (lastRows?.[0] ?? null) as { provider?: string; wa_conexao_id?: string } | null;
      if (last?.wa_conexao_id && last.provider && last.provider !== "meta") {
        conexaoIdRota = last.wa_conexao_id;
      }
    }
    if (conexaoIdRota) {
      return await enviarViaConexao(admin, {
        conexaoId: conexaoIdRota, to, tipo, conteudo, anexo_url, filename, mime_type,
        lead_id, oportunidade_id, origemFinal, reaction_message_id, enviadoPorId, enviadoPorNome,
      });
    }

    // (Trava de frequência de template "1 por número a cada 24h" REMOVIDA a pedido do
    // diretor — templates podem ser enviados livremente. O parâmetro `forcar_template`
    // do body fica sem efeito, mantido só por compatibilidade com chamadas antigas.)

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
      docFilename = tipo === "audio" ? "audio" : tipo === "sticker" ? "sticker.webp" : tipo === "image" ? "imagem.jpg" : tipo === "video" ? "video.mp4" : "documento.pdf";
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
      const comps = sanitizarComponentsTemplate(template_components);
      // Template com CABEÇALHO DE MÍDIA (IMAGE/VIDEO/DOCUMENT) EXIGE, em todo envio, o
      // componente de header com a mídia — senão a Meta recusa com 132012 ("header:
      // Format mismatch, expected IMAGE, received UNKNOWN"). O nosso envio só monta o
      // `body`; então injetamos aqui, no ponto ÚNICO, a mídia FIXA configurada por
      // template (crm_whatsapp_template_media) quando o chamador não mandou um header.
      // Cobre composer, automações e fluxos (o dispatcher reusa esta edge).
      const jaTemHeader = comps.some((c: any) => String(c?.type ?? "").toLowerCase() === "header");
      if (!jaTemHeader) {
        const { data: media } = await admin
          .from("crm_whatsapp_template_media")
          .select("header_format, media_url")
          .eq("template_name", template_name)
          .maybeSingle();
        if (media?.media_url && media?.header_format) {
          const fmt = String(media.header_format).toUpperCase();
          const key = fmt === "VIDEO" ? "video" : fmt === "DOCUMENT" ? "document" : "image";
          comps.push({ type: "header", parameters: [{ type: key, [key]: { link: String(media.media_url) } }] });
        }
      }
      waPayload = {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: template_name,
          language: { code: template_lang || "pt_BR" },
          components: comps,
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
    } else if (tipo === "image") {
      // Imagem INLINE (não vira "arquivo"): type=image + caption opcional. Meta aceita
      // jpeg/png por URL pública.
      const caption = String(conteudo ?? "").trim();
      waPayload = {
        messaging_product: "whatsapp",
        to,
        type: "image",
        image: { link: docUrl, ...(caption ? { caption: caption.slice(0, 1024) } : {}) },
      };
    } else if (tipo === "video") {
      // Vídeo INLINE (player no WhatsApp, não "arquivo"): type=video + caption opcional.
      // Meta aceita mp4/3gp por URL pública (codec H.264 + AAC). Sem branch próprio, o
      // vídeo era enviado como `document` e chegava como arquivo pra baixar.
      const caption = String(conteudo ?? "").trim();
      waPayload = {
        messaging_product: "whatsapp",
        to,
        type: "video",
        video: { link: docUrl, ...(caption ? { caption: caption.slice(0, 1024) } : {}) },
      };
    } else if (tipo === "audio") {
      // OGG/Opus → MENSAGEM DE VOZ (forma de onda) só se enviado por `audio.id` (mídia
      // carregada no /media); por `audio.link` a Meta renderiza como "arquivo de áudio".
      // Sobe o OGG e manda por id; qualquer falha cai no link (vira arquivo, mas envia).
      // `voice: true` é o flag OFICIAL da Cloud API que faz o áudio virar NOTA DE VOZ
      // (forma de onda) em vez de "arquivo de áudio". Exige OGG/Opus e mídia carregada
      // (audio.id). Ver doc Meta "Audio messages".
      const ehOgg = /audio\/ogg/i.test(String(mime_type ?? "")) || /\.ogg(\?|$)/i.test(docUrl);
      let audioObj: Record<string, unknown> = { link: docUrl };
      if (ehOgg) {
        try {
          const mediaId = await metaUploadMedia(phoneNumberId, accessToken, docUrl, "audio/ogg", docFilename || "audio.ogg");
          audioObj = { id: mediaId, voice: true };
        } catch (e) {
          console.warn("[crm-whatsapp-send] upload OGG /media falhou, usando link:", e instanceof Error ? e.message : e);
          audioObj = { link: docUrl, voice: true };
        }
      }
      waPayload = {
        messaging_product: "whatsapp",
        to,
        type: "audio",
        audio: audioObj,
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
      return json({ error: `tipo '${tipo}' não suportado (use text, template, document, image, video, audio, sticker, reaction ou interactive)` }, 400);
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
      // Renderiza com os componentes JÁ saneados, p/ o texto persistido bater com o enviado.
      if (corpo) templateTexto = renderTemplate(corpo, sanitizarComponentsTemplate(template_components));
    }

    // Conteúdo persistido (texto real do template quando temos o corpo; caption/nome do doc).
    // reaction usa o marcador [reacao]<emoji> — o chat e o preview renderizam como reação.
    let conteudoPersist: string;
    if (tipo === "text") conteudoPersist = String(conteudo);
    else if (tipo === "template") conteudoPersist = templateTexto ?? `[template] ${template_name}`;
    else if (tipo === "audio" || tipo === "sticker") conteudoPersist = "";
    else if (tipo === "image" || tipo === "video") conteudoPersist = String(conteudo ?? "").trim(); // legenda (ou vazio)
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
        : tipo === "image"
        ? [{
            tipo: "image",
            mime_type: String(mime_type ?? "image/jpeg"),
            url: docUrl,
            filename: docFilename,
          }]
        : tipo === "video"
        ? [{
            tipo: "video",
            mime_type: String(mime_type ?? "video/mp4"),
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
      metadata: {
        payload_enviado: waPayload,
        ...(origemFinal ? { origem: origemFinal } : {}),
        ...(enviadoPorId ? { enviado_por_id: enviadoPorId, enviado_por_nome: enviadoPorNome } : {}),
      },
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

    // Documento enviado por HUMANO (SDR no chat) → semeia o histórico do agente com um
    // marcador (role=assistant), pra IA saber que o material JÁ FOI enviado e não
    // reenviar/prometer de novo quando despausarem (pedido 2026-07-03: "eles pausam pra
    // mandar o cronograma e a IA não fica sabendo"). Turnos assistant consecutivos são
    // FUNDIDOS pelos sanitizadores do agente (limparParaRouter/sanitizarHistorico), então
    // o marcador não quebra a alternância de roles da Claude API. Documento enviado pela
    // PRÓPRIA IA (tool envia_informacoes) NÃO semeia aqui — o contexto já chega pelo
    // tool_result (cronograma_enviado), semear de novo duplicaria.
    if (tipo === "document" && r.ok && origemFinal === "humano") {
      const remoteJid = `${canonicalBrPhone(telefone)}@s.whatsapp.net`;
      const nomeDoc = docFilename || "documento";
      const quem = enviadoPorNome ? `O atendente humano ${enviadoPorNome}` : "Um atendente humano";
      const { error: histErr } = await admin.from("cliente_ppg_mensagens_sdr").insert({
        remotejid: remoteJid,
        conversation_history: {
          role: "assistant",
          content: `[${quem} enviou o documento "${nomeDoc}" ao lead pelo WhatsApp — material já entregue, não reenvie nem prometa enviar de novo]`,
        },
        timestamp: nowIso,
      });
      if (histErr) console.error("[crm-whatsapp-send] hist sdr (doc humano) erro:", histErr.message);
    }

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
