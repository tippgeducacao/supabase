// wa-uazapi-webhook
// ----------------------------------------------------------------------------
// Recebe os eventos do provider (Uazapi) para UMA conexão, identificada pela
// query ?conexao=<id> (que o wa-uazapi-admin grava na URL ao configurar o
// webhook) — assim NUNCA dependemos de adivinhar a instância pelo payload.
//
// LOG-FIRST: todo payload é gravado cru em wa_webhook_log antes de qualquer
// parsing. O parser (provider.parseWebhook) é tolerante; o que ele não entender
// fica no log pra refinar sobre dados reais, sem perder mensagem.
//
// Mensagens inbound (e as que o SDR mandar do próprio celular, fromMe=true) são
// inseridas em crm_whatsapp_messages -> o trigger crm_mirror_to_sac espelha pro
// SAC/Omnichat automaticamente. Eventos connection atualizam wa_conexoes.
// ----------------------------------------------------------------------------
// acesso: publico — webhook da Uazapi; confere o token da instância (payload.token) contra wa_conexoes_secrets da ?conexao= antes de gravar qualquer coisa
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { canonTelBr, getWaProvider } from "../_shared/waProviders.ts";
import { atualizarStatusWaConexao } from "../_shared/waConexaoStatus.ts";
import { baixarMidiaUazapi, ehMidia, mensagemJaGravada, type MidiaPendente } from "./midia.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PROVIDER = "uazapi";

/** Comparação em tempo constante (não vaza pelo tempo quanto do token estava certo). */
function tokenIgual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let dif = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) dif |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return dif === 0;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Acorda o agente de RH quando a mensagem chega pela linha Web que o RH atende.
 *
 * A linha Web sempre foi humana: o `docs/WhatsApp Web (Uazapi).md` diz que ela "não passa
 * pelo agente de IA". Isso mudou em 02/09, quando a BM da Meta foi travada
 * ("Business Account locked", 131031) e o número oficial do RH parou de entregar. Só a
 * conexão marcada em `rh_entrevista_config.wa_conexao_id` acorda o agente; as outras
 * linhas Web continuam humanas, como sempre foram.
 *
 * O relay é o mesmo padrão do webhook da Meta: kong INTERNO, nunca a URL pública (o
 * container do edge-runtime não alcança api.ppgeducacao.site por hairpin NAT).
 */
async function relayAgenteRh(
  admin: any,
  conexaoId: string | null,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    if (!conexaoId) return;
    const { data: conexaoDoRh } = await admin.rpc("rh_conexao_web");
    if (!conexaoDoRh || String(conexaoDoRh) !== String(conexaoId)) return;

    const base = Deno.env.get("SUPABASE_URL") ?? "";
    if (!base) return;
    await fetch(`${base}/functions/v1/crm-agente-rh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    // O agente não pode derrubar a entrada: mensagem gravada é o que importa, e sem isso
    // o webhook devolveria 500 e a Uazapi reentregaria em laço.
    console.error("[wa-uazapi-webhook] relay do agente falhou:", e instanceof Error ? e.message : String(e));
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  // Alguns provedores validam o webhook com um GET; respondemos 200.
  if (req.method === "GET") return new Response("ok", { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "método não suportado" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
  const url = new URL(req.url);
  const conexaoId = url.searchParams.get("conexao");

  let payload: any = null;
  try { payload = await req.json(); } catch { payload = null; }

  // ── ORIGEM (29/10/2026): só a Uazapi da PRÓPRIA conexão passa daqui ─────────
  // Antes qualquer POST era logado e processado: enchia o wa_webhook_log (disco da VPS) e,
  // com o UUID de uma linha, injetava mensagem falsa no SAC, forjava status de conexão e
  // acordava o agente de RH. A Uazapi manda em TODO evento o `token` da instância no corpo
  // (conferido em 29/10/2026: 27.122 de 27.122 eventos em 7 dias batiam com
  // wa_conexoes_secrets.token da conexão da URL). Sem ?conexao=, sem token ou com token de
  // outra instância: recusa SEM gravar nada, nem o log.
  if (!payload || typeof payload !== "object") return json({ ok: true, skipped: "payload vazio" });
  if (!conexaoId) {
    console.warn("[wa-uazapi-webhook] sem ?conexao= na URL; recusado sem log");
    return json({ ok: true, skipped: "sem conexao" });
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conexaoId)) {
    return json({ error: "origem não autorizada" }, 401);
  }
  {
    const { data: segredoConexao, error: segredoErr } = await admin
      .from("wa_conexoes_secrets").select("token").eq("conexao_id", conexaoId).maybeSingle();
    if (segredoErr) {
      console.error("[wa-uazapi-webhook] não deu para conferir o token da conexão:", segredoErr.message);
      return json({ ok: false, erro: "conferência de origem indisponível" }, 503);
    }
    const esperado = String(segredoConexao?.token ?? "");
    const recebido = typeof payload.token === "string" ? payload.token : "";
    if (!tokenIgual(recebido, esperado)) {
      console.warn("[wa-uazapi-webhook] token da instância ausente/divergente — recusado sem log:", conexaoId);
      return json({ error: "origem não autorizada" }, 401);
    }
  }

  // ── LOG-FIRST: grava o cru antes de tudo ────────────────────────────────────
  let evento = "desconhecido";
  try {
    const provider = getWaProvider(PROVIDER);
    const parsedPeek = payload ? provider.parseWebhook(payload) : null;
    evento = parsedPeek?.evento ?? "desconhecido";
  } catch { /* ignore */ }
  try {
    await admin.from("wa_webhook_log").insert({
      provider: PROVIDER,
      conexao_id: conexaoId ?? null,
      evento,
      payload: payload ?? {},
    });
  } catch (e) {
    console.error("[wa-uazapi-webhook] falha ao logar payload:", e instanceof Error ? e.message : String(e));
  }

  // Resolve a conexão (server_url p/ baixar mídia + secret token).
  const { data: conex } = await admin
    .from("wa_conexoes")
    .select("id, server_url, provider")
    .eq("id", conexaoId)
    .maybeSingle();
  if (!conex) {
    console.warn("[wa-uazapi-webhook] conexao não encontrada:", conexaoId);
    return json({ ok: true, skipped: "conexao inexistente" });
  }

  const provider = getWaProvider(conex.provider ?? PROVIDER);
  const parsed = provider.parseWebhook(payload);

  try {
    // ── connection: atualiza o status da linha ────────────────────────────────
    if (parsed.connection) {
      await atualizarStatusWaConexao(
        admin, conexaoId, parsed.connection.status,
        parsed.connection.numero ? { numero: parsed.connection.numero } : {},
      );
      console.log(`[wa-uazapi-webhook] conexao ${conexaoId} -> ${parsed.connection.status}`);
      return json({ ok: true, connection: parsed.connection.status });
    }

    // ── messages ──────────────────────────────────────────────────────────────
    let processed = 0;
    // Inbound que não conseguiu ser gravado. Com >0 devolvemos erro pro provider
    // reentregar — 200 aqui é mensagem de lead perdida em silêncio.
    let falhasPersistencia = 0;
    // resolve token 1x (só se precisar baixar mídia)
    let instToken: string | null = null;
    const getToken = async (): Promise<string | null> => {
      if (instToken) return instToken;
      const { data: sec } = await admin.from("wa_conexoes_secrets").select("token").eq("conexao_id", conexaoId).maybeSingle();
      instToken = sec?.token ?? null;
      return instToken;
    };

    // Foto de perfil do CONTATO: a Uazapi a envia em `chat.imagePreview` (96x96) /
    // `chat.image` (URL pps.whatsapp.net). A Meta NÃO fornece isso — por isso só a
    // linha Web popula a foto. A URL expira; cada mensagem traz uma nova e o front
    // cai nas iniciais quando vence. Gravamos em metadata.contato_foto_url; o trigger
    // `crm_mirror_to_sac` a escreve em sac_contatos.foto_url (lido pelas RPCs Omnichat).
    const chatFoto: string | null = (() => {
      const ch = (payload as { chat?: { imagePreview?: unknown; image?: unknown } })?.chat;
      const u = ch?.imagePreview || ch?.image || null;
      return typeof u === "string" && u.startsWith("http") ? u : null;
    })();

    // ── Linha-bot (wa_bot_comandos, 16/10/2026) ───────────────────────────────
    // Mensagem PRIVADA recebida de quem está no grupo autorizado da linha é COMANDO do bot
    // "Monitor": vai para wa_bot_comandos_fila (o assistente-interno-whatsapp responde) e NÃO entra
    // no CRM. Quem não é do grupo segue o fluxo normal. Qualquer falha aqui também segue o fluxo
    // normal: o pior caso é uma mensagem interna virar atendimento, nunca uma mensagem perdida.
    let botGrupo: string | null = null;
    try {
      const { data: bot } = await admin.from("wa_bot_comandos")
        .select("grupo_autorizado_jid").eq("wa_conexao_id", conexaoId).eq("ativo", true).maybeSingle();
      botGrupo = bot?.grupo_autorizado_jid ?? null;
    } catch { botGrupo = null; }
    let membrosBot: Set<string> | null = null; // lido da Uazapi 1x por chamada: entrou/saiu do grupo, vale na hora
    const ehComandoDoBot = async (m: (typeof parsed.messages)[number], telefone: string): Promise<boolean> => {
      if (!botGrupo || m.fromMe) return false;
      try {
        if (!membrosBot) {
          const tok = await getToken();
          if (!tok) return false;
          const fones = await provider.listGroupParticipantPhones(conex.server_url, tok, botGrupo);
          membrosBot = new Set(fones.map(canonTelBr).filter((c): c is string => !!c));
        }
        const c = canonTelBr(telefone);
        if (!c || !membrosBot.has(c)) return false;
        const { error } = await admin.from("wa_bot_comandos_fila").insert({
          wa_conexao_id: conexaoId,
          external_id: m.externalId || `syn:${telefone}:${(m.conteudo ?? "").slice(0, 60)}`,
          de_telefone: telefone,
          texto: m.tipo === "text" ? (m.conteudo ?? "") : null,
          tipo: m.tipo,
        });
        if (error && error.code !== "23505") throw new Error(error.message); // 23505 = reentrega, já está na fila
        return true;
      } catch (e) {
        console.error("[wa-uazapi-webhook] bot de comandos falhou; segue para o CRM:", e instanceof Error ? e.message : String(e));
        return false;
      }
    };

    for (const m of parsed.messages) {
      if (m.isGroup) continue; // grupos fora do escopo
      const telefone = m.fromDigits;
      if (!telefone) continue;
      if (await ehComandoDoBot(m, telefone)) { processed++; continue; }

      // baixa mídia -> storage, em fluxo e antes do insert (ver midia.ts). Falhou = a mensagem
      // entra sem o arquivo e o motivo fica em metadata.midia_pendente. O que já está gravado
      // (reentrega, ou o eco de um envio nosso) não é baixado de novo.
      let anexos: any[] = [];
      let midiaPendente: MidiaPendente | null = null;
      if (ehMidia(m) && !(await mensagemJaGravada(admin, m.externalId))) {
        ({ anexos, pendente: midiaPendente } = await baixarMidiaUazapi(admin, provider, conex.server_url, getToken, m));
        if (midiaPendente) {
          console.log(`[wa-uazapi-webhook] mídia sem arquivo (${m.externalId}):`, midiaPendente.motivo);
        }
      }

      /* ── CLIQUE-PARA-WHATSAPP: o anúncio que abriu a conversa ─────────────
         ⚠️ ESTE BLOCO ERA DESCARTADO aqui também. A campanha de WhatsApp não
         deixa UTM, não passa por landing page e não tem formulário: o
         `externalAdReply` é a ÚNICA marca de origem que ela produz.

         ⚠️ Só na PRIMEIRA mensagem, e sem reenvio. Best-effort de propósito:
         falhar a atribuição NUNCA pode derrubar a gravação do inbound. */
      if (!m.fromMe && m.referral) {
        try {
          await admin.rpc("crm_whatsapp_referral_registrar", {
            p_telefone: telefone,
            p_ad_id: m.referral.sourceId,
            p_ctwa_clid: m.referral.ctwaClid,
            p_source_type: m.referral.sourceType,
            p_source_url: m.referral.sourceUrl,
            p_headline: m.referral.headline,
            p_corpo: m.referral.body,
            p_wa_account_id: null, // Uazapi não tem conta Meta
            p_wa_message_id: m.externalId ?? null,
          });
        } catch (refErr) {
          console.error(
            "[wa-uazapi-webhook] referral do anúncio não gravado:",
            (refErr as Error)?.message,
          );
        }
      }

      // Mesma fonte única do webhook Meta: DDI, pontuação e ±9º dígito precisam
      // resolver para a mesma pessoa. A comparação exata antiga criava mensagens
      // órfãs quando o provedor devolvia o telefone em outra representação válida.
      const { data: leadIdResolvido, error: leadResolveErr } = await admin.rpc(
        "crm_lead_find_by_canon",
        { p_telefone: telefone },
      );
      if (leadResolveErr) {
        console.error("[wa-uazapi-webhook] resolver lead por telefone:", leadResolveErr.message);
      }
      const leadId = typeof leadIdResolvido === "string" ? leadIdResolvido : null;
      let oportunidadeId: string | null = null;
      if (leadId) {
        const { data: opRows } = await admin
          .from("lead_oportunidades").select("id")
          .eq("lead_id", leadId).eq("status", "ativo")
          .order("created_at", { ascending: false }).limit(1);
        oportunidadeId = opRows?.[0]?.id ?? null;
      }

      const direcao = m.fromMe ? "outbound" : "inbound";
      const { error: insErr } = await admin.from("crm_whatsapp_messages").insert({
        provider: PROVIDER,
        wa_conexao_id: conexaoId,
        wa_account_id: null, // Uazapi não tem conta Meta
        lead_id: leadId,
        oportunidade_id: oportunidadeId,
        telefone,
        direcao,
        tipo: m.tipo,
        conteudo: m.conteudo,
        anexos,
        wa_message_id: m.externalId,
        status_entrega: direcao === "inbound" ? "delivered" : "sent",
        metadata: {
          provider: PROVIDER,
          profile_name: m.senderName ?? null,
          original_type: m.tipo,
          timestamp: m.timestamp,
          // Foto de perfil do contato (chat.imagePreview) -> sac_contatos.foto_url no trigger.
          ...(chatFoto ? { contato_foto_url: chatFoto } : {}),
          // fromMe = SDR respondeu pelo próprio celular -> conta como 'humano' no espelho
          ...(m.fromMe ? { origem: "humano" } : {}),
          // Backup cru do anúncio; a atribuição de verdade é crm_whatsapp_referral.
          ...(m.referral ? { referral: m.referral } : {}),
          ...(midiaPendente ? { midia_pendente: midiaPendente } : {}),
        },
      });
      if (insErr) {
        // 23505 só é reentrega benigna se o externalId JÁ ESTIVER gravado. Qualquer outra
        // violação é perda de mensagem — foi assim que o espelho do SAC (card arquivado
        // colidindo em uq_sac_atend_contato_funil_linha) sumiu com inbound por semanas.
        const code = (insErr as { code?: string }).code ?? "";
        let retryBenigno = false;
        if (code === "23505" && m.externalId) {
          const { data: jaGravada } = await admin
            .from("crm_whatsapp_messages")
            .select("id")
            .eq("wa_message_id", m.externalId)
            .limit(1);
          retryBenigno = (jaGravada?.length ?? 0) > 0;
        }
        if (retryBenigno) {
          console.log("[wa-uazapi-webhook] msg duplicada, ignorada:", m.externalId);
        } else {
          falhasPersistencia++;
          console.error(
            `[wa-uazapi-webhook] FALHA AO GRAVAR MENSAGEM (externalId=${m.externalId}, code=${code}): ${insErr.message}`,
          );
        }
      } else {
        processed++;
        // Só o que a PESSOA mandou; `fromMe` é a própria Marisa escrevendo.
        if (direcao === "inbound") {
          await relayAgenteRh(admin, conexaoId, {
            telefone,
            id: m.externalId,
            conteudo: m.conteudo,
            direcao: "inbound",
            from_me: false,
            wa_conexao_id: conexaoId,
            provider: PROVIDER,
          });
        }
      }
    }

    // marca o log como processado
    if (falhasPersistencia > 0) {
      return json({ ok: false, erro: "falha ao persistir mensagem", falhas: falhasPersistencia, messages: processed }, 503);
    }
    return json({ ok: true, messages: processed });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[wa-uazapi-webhook] erro:", msg);
    // Antes era 200 sempre (pra não suspender o webhook), mas isso vira perda silenciosa
    // de mensagem. Erro é erro: 500 e o provider reentrega (idempotente pelo externalId).
    return json({ ok: false, processed: false, erro: msg }, 500);
  }
});
