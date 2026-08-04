// whatsapp-send-message
// Envia mensagem WhatsApp (texto, template, image, video, document, audio) via Meta Cloud API,
// persiste em ped_conversas_mensagens e atualiza ped_conversas_avulsas.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const META_GRAPH = "https://graph.facebook.com/v21.0";

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

const MEDIA_TIPOS = new Set(["image", "video", "document", "audio"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userClient = createClient(SUPABASE_URL, ANON, {
      global: { headers: { Authorization: authHeader } },
    });
    let userId: string | null = null;
    try {
      const { data: userData, error: userErr } = await userClient.auth.getUser();
      if (!userErr && userData?.user?.id) userId = userData.user.id;
    } catch (_) {}
    if (!userId) {
      return new Response(
        JSON.stringify({ error: "Não autenticado. Faça login novamente." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const body = await req.json().catch(() => ({}));
    const {
      conversa_id,
      telefone,
      tipo,
      conteudo,
      template_name,
      template_lang,
      template_components,
      media_url,
      media_filename,
      caption,
      reply_to_wa_message_id,
    } = body ?? {};

    if (!conversa_id || !telefone || !tipo) {
      return new Response(
        JSON.stringify({ error: "conversa_id, telefone e tipo são obrigatórios" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const tipoOk = tipo === "text" || tipo === "template" || MEDIA_TIPOS.has(tipo);
    if (!tipoOk) {
      return new Response(JSON.stringify({ error: "tipo inválido" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (tipo === "text" && !String(conteudo ?? "").trim()) {
      return new Response(JSON.stringify({ error: "conteudo vazio" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (tipo === "template" && !template_name) {
      return new Response(JSON.stringify({ error: "template_name obrigatório" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (MEDIA_TIPOS.has(tipo) && !media_url) {
      return new Response(JSON.stringify({ error: "media_url obrigatório" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const to = formatPhone(telefone);
    if (!to) {
      return new Response(JSON.stringify({ error: "telefone inválido" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    // Template: carrega o cadastro ANTES de resolver a conta — é ele que decide POR QUAL
    // NÚMERO a mensagem sai (ver abaixo) e ainda serve pra renderizar o corpo e guardar os
    // botões. Antes, o SAC gravava só "[template] <nome>" — o atendente não via o texto que
    // o contato recebeu nem quais botões estavam na mensagem.
    let tplCadastro: { corpo: string | null; botoes: unknown; wa_account_id: string | null } | null = null;
    if (tipo === "template" && template_name) {
      const { data: t } = await admin
        .from("ped_wa_templates")
        .select("corpo,botoes,wa_account_id")
        .eq("nome", template_name)
        .maybeSingle();
      tplCadastro = t ?? null;
    }

    const carregarConta = async (accId: string) => {
      const { data: acc } = await admin
        .from("wa_accounts").select("id, phone_number_id, access_token")
        .eq("id", accId).eq("is_active", true).maybeSingle();
      return acc?.phone_number_id && acc?.access_token ? acc : null;
    };

    // Conta que envia. A régua depende de SER TEMPLATE ou não:
    //
    //   TEMPLATE (com cadastro): quem decide é O TEMPLATE, nunca a conversa.
    //     dona definida (wa_account_id) -> essa conta
    //     dona NULL                     -> número pedagógico padrão (é onde o
    //                                      `submit-meta-template` cria os modelos)
    //   Texto / mídia, ou template sem cadastro: conta da CONVERSA
    //     (metadata.wa_account_id, o que `_shared/podcastSac.ts` grava) -> senão padrão.
    //
    // (!) POR QUE o template ignora a conversa: a Meta resolve o nome do modelo DENTRO da WABA
    // do phone_number_id que envia — mandar por outra devolve (#132001) e nada sai. Isso vale
    // NOS DOIS SENTIDOS, e o segundo custou um erro em produção (03/08, relato da Jana):
    //   * modelo de podcast (WABA "Podcast - PPGVET") saindo pelo número pedagógico — o caso
    //     original, 11 falhas em 10 conversas desde 14/07;
    //   * modelo PEDAGÓGICO (`retomada_podcast_jana`, que vive na WABA pedagógica) enviado
    //     DENTRO de uma thread de podcast: a conversa carrega a conta do podcast, o modelo não
    //     existe lá e voltava o MESMO 132001. Herdar a conta da conversa em template é
    //     sempre um palpite — o modelo sabe onde mora, a conversa não.
    // Texto livre e mídia continuam seguindo a conversa de propósito: neles o que manda é a
    // janela de 24h, que é POR NÚMERO (mandar por outro dá 131047).
    //
    // ⚠️ Consequência aceita: um modelo pedagógico numa thread de podcast SAI pelo número
    // pedagógico — o contato o recebe de outro número e responde nele. É isso ou não enviar.
    // Para sair pelo número do podcast, o modelo precisa ser aprovado TAMBÉM naquela WABA.
    let wa: any = null;
    const templateDecideAConta = tipo === "template" && tplCadastro !== null;
    try {
      if (tplCadastro?.wa_account_id) {
        wa = await carregarConta(tplCadastro.wa_account_id);
        // Conta dona inativa/removida (o toggle e a lixeira de contas não pedem confirmação):
        // cai no fallback e o envio falha com 132001 na certa. Sem este log não há como saber
        // POR QUE — o payload logado não carrega o phone_number_id (ele vai na URL).
        if (!wa) {
          console.log(
            `[whatsapp-send-message] conta dona do template "${template_name}" (${tplCadastro.wa_account_id})` +
            ` indisponível (inativa ou removida) — caindo no fallback; o envio deve falhar com 132001`,
          );
        }
      }
      if (!wa && !templateDecideAConta) {
        const { data: convRow } = await admin
          .from("ped_conversas_avulsas").select("metadata").eq("id", conversa_id).maybeSingle();
        const waAccId = (convRow?.metadata as Record<string, unknown> | null)?.wa_account_id as string | undefined;
        if (waAccId) wa = await carregarConta(waAccId);
      }
    } catch (_e) { /* cai no número pedagógico padrão */ }

    if (!wa) {
      const { data: waRow, error: waErr } = await admin.rpc("get_wa_account_pedagogico");
      if (waErr || !waRow) {
        return new Response(JSON.stringify({ error: `WA account: ${waErr?.message ?? "vazio"}` }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      wa = Array.isArray(waRow) ? waRow[0] : waRow;
    }
    const phoneNumberId = wa?.phone_number_id;
    const accessToken = wa?.access_token;
    if (!phoneNumberId || !accessToken) {
      return new Response(JSON.stringify({ error: "WA account incompleto" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let waPayload: Record<string, unknown>;
    if (tipo === "text") {
      waPayload = {
        messaging_product: "whatsapp", to, type: "text",
        text: { body: String(conteudo).slice(0, 4096), preview_url: true },
      };
    } else if (tipo === "template") {
      waPayload = {
        messaging_product: "whatsapp", to, type: "template",
        template: {
          name: template_name,
          language: { code: template_lang || "pt_BR" },
          components: Array.isArray(template_components) ? template_components : [],
        },
      };
    } else {
      // Media: image, video, document, audio
      const mediaObj: Record<string, unknown> = { link: media_url };
      if (tipo === "document" && media_filename) mediaObj.filename = media_filename;
      if ((tipo === "image" || tipo === "video" || tipo === "document") && caption) {
        mediaObj.caption = String(caption).slice(0, 1024);
      }
      waPayload = {
        messaging_product: "whatsapp", to, type: tipo,
        [tipo]: mediaObj,
      };
    }

    if (reply_to_wa_message_id) {
      (waPayload as Record<string, unknown>).context = { message_id: String(reply_to_wa_message_id) };
    }

    if (tipo === "audio") {
      try {
        const head = await fetch(media_url, { method: "HEAD" });
        console.log("[whatsapp-send-message] audio HEAD:", media_url, "status:", head.status, "content-type:", head.headers.get("content-type"), "content-length:", head.headers.get("content-length"));
      } catch (e) {
        console.log("[whatsapp-send-message] audio HEAD failed:", String(e));
      }
    }

    console.log("[whatsapp-send-message] -> Meta payload:", JSON.stringify(waPayload));
    const r = await fetch(`${META_GRAPH}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(waPayload),
    });
    const waResp = await r.json().catch(() => ({}));
    console.log("[whatsapp-send-message] <- Meta status:", r.status, "resp:", JSON.stringify(waResp));
    if (!r.ok) {
      const errMsg = waResp?.error?.message || waResp?.error?.error_user_msg || `Meta API ${r.status}`;
      // Persiste erro detalhado em ped_conversas_mensagens.classificacao_ia
      try {
        await admin.from("ped_conversas_mensagens").insert({
          conversa_id,
          direcao: "outbound",
          conteudo: `[falha ao enviar ${tipo}] ${errMsg}`,
          enviada_em: new Date().toISOString(),
          anexos: tipo !== "text" && tipo !== "template" ? [{ tipo, url: media_url, filename: media_filename ?? null }] : [],
          // phone_number_id no rastro: o payload NÃO o carrega (vai na URL), e sem ele não dá
          // pra saber por qual WABA a mensagem saiu — que é a causa nº 1 do 132001.
          classificacao_ia: { erro_envio: true, status: r.status, meta_response: waResp, payload_enviado: waPayload, phone_number_id: phoneNumberId },
        });
      } catch (logErr) {
        console.log("[whatsapp-send-message] não foi possível salvar mensagem de erro:", (logErr as Error).message);
      }
      // 422 (nunca 502/504): o Cloudflare engole 502/504 da origem sem headers CORS.
      return new Response(JSON.stringify({ error: errMsg, status: r.status, detalhes: waResp }), {
        status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const waMsgId = waResp?.messages?.[0]?.id ?? null;
    const nowIso = new Date().toISOString();

    // Conteúdo legível persistido
    let conteudoPersist: string;
    let anexos: any[] = [];
    if (tipo === "text") {
      conteudoPersist = String(conteudo);
    } else if (tipo === "template") {
      // Renderiza {{1}}, {{2}}... com os parâmetros realmente enviados; sem cadastro
      // do template (ou sem corpo), mantém o rótulo antigo como fallback.
      const params: string[] = (Array.isArray(template_components) ? template_components : [])
        .filter((c: any) => c?.type === "body")
        .flatMap((c: any) => (Array.isArray(c.parameters) ? c.parameters : []))
        .map((p: any) => String(p?.text ?? ""));
      let corpo = String(tplCadastro?.corpo ?? "");
      params.forEach((valor, i) => { corpo = corpo.split(`{{${i + 1}}}`).join(valor); });
      conteudoPersist = corpo.trim() || `[template] ${template_name}`;
    } else {
      conteudoPersist = caption ? String(caption) : `[${tipo}]`;
      anexos = [{ tipo, url: media_url, filename: media_filename ?? null }];
    }

    const { error: msgErr } = await admin.from("ped_conversas_mensagens").insert({
      conversa_id,
      direcao: "outbound",
      conteudo: conteudoPersist,
      template_name: tipo === "template" ? template_name : null,
      template_botoes:
        tipo === "template" && Array.isArray(tplCadastro?.botoes) ? tplCadastro?.botoes : null,
      wa_message_id: waMsgId,
      enviada_em: nowIso,
      anexos,
      reply_to_wa_message_id: reply_to_wa_message_id || null,
    });
    if (msgErr) console.log("[whatsapp-send-message] insert msg erro:", msgErr.message);

    // (!) NÃO carimbar a conta na conversa aqui. Já tentei e é uma armadilha: um template de
    // podcast enviado dentro de uma thread PEDAGÓGICA (o seletor das telas manuais oferece
    // todos os modelos ativos, sem filtro de conta) gravaria `metadata.wa_account_id` = podcast
    // PARA SEMPRE — e daí em diante os ~34 modelos pedagógicos (dona NULL) resolveriam por essa
    // conta e voltariam com o MESMO (#132001), enquanto texto livre e anexo sairiam por um
    // número sem janela de 24h aberta (131047). Não é hipotético: das 10 conversas que falharam
    // com 132001, 2 são threads pedagógicas com histórico de inbound.
    // E o carimbo não entregaria o que prometia: quem roteia a RESPOSTA do convidado é o
    // `whatsapp-webhook`, pelo `phone_number_id` que recebeu — não este metadata. A conversa do
    // motor de podcast já nasce carimbada em `_shared/podcastSac.ts`.

    await admin
      .from("ped_conversas_avulsas")
      .update({ ultima_atividade_em: nowIso, status: "em_conversa" })
      .eq("id", conversa_id);

    return new Response(
      JSON.stringify({ success: true, wa_message_id: waMsgId, sent_at: nowIso }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[whatsapp-send-message] fatal:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
