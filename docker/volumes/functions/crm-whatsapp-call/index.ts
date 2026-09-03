// crm-whatsapp-call
// ----------------------------------------------------------------------------
// Sinalização da Calling API do WhatsApp. NÃO passa áudio por aqui.
//
// A mídia é WebRTC direto entre o NAVEGADOR do SDR e os servidores da Meta — edge
// function Deno não faz ICE/DTLS/SRTP, e nem precisa. O que esta função faz é o
// vaivém de SDP:
//
//   browser gera OFFER ─▶ esta função ─▶ POST /{pni}/calls (connect)
//                                              │
//   browser aplica ANSWER ◀─ Realtime ◀─ crm_chamadas ◀─ webhook `calls` da Meta
//
// ⚠️ O ANSWER chega pelo WEBHOOK, não na resposta HTTP do connect. Sem o ramo `calls`
// no crm-whatsapp-webhook + a publicação Realtime em crm_chamadas, a ligação sai,
// toca no aparelho do lead e MORRE MUDA — ninguém ouve ninguém. Os três pedaços só
// funcionam juntos.
//
// ⚠️ Ligação ATIVA exige PERMISSÃO do lead, com cota apertada medida contra a Meta em
// 02/09/2026: 1 pedido de permissão por lead por 24h, 2 por 7 dias. Não existe
// "disparo de permissão em massa" — e ainda bem, foi excesso de disparo que derrubou
// as BMs. Pedido fora da janela de 24h aberta exige TEMPLATE (a Meta devolve 131047).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/cors.ts";
import { telefoneEnviavel, digitosParaEnvio } from "../_shared/telefone.ts";
import { TEXTO_PADRAO_PEDIDO_PERMISSAO, textoPedidoPermissao } from "./pedidoPermissao.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_GRAPH = "https://graph.facebook.com/v23.0";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function erroMeta(resp: any, status: number) {
  const e = resp?.error;
  return {
    error: e?.error_user_msg || e?.message || `Meta ${status}`,
    meta_code: e?.code ?? null,
    meta_subcode: e?.error_subcode ?? null,
  };
}

/** Chave canônica (55 + DDD + 9 + 8) — a mesma do resto do CRM, pro espelho de permissão. */
function canonicalBrPhone(raw: string): string {
  let d = (raw ?? "").replace(/\D/g, "");
  if (d.startsWith("55")) d = d.slice(2);
  if (d.length === 10 && ["6", "7", "8", "9"].includes(d[2])) {
    d = d.slice(0, 2) + "9" + d.slice(2);
  }
  return `55${d}`;
}

/** POST /{pni}/calls — o endpoint único de todas as ações de chamada. */
async function metaCalls(pni: string, token: string, payload: Record<string, unknown>) {
  const r = await fetch(`${META_GRAPH}/${pni}/calls`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
  });
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok && !body?.error, status: r.status, body };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "use POST" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  // Quem está com o headset. Chamada de automação (service_role) fica sem atendente.
  let atendenteId: string | null = null;
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ error: "não autenticado" }, 401);
  if (jwt !== SERVICE_ROLE) {
    try {
      const { data: u } = await admin.auth.getUser(jwt);
      atendenteId = u?.user?.id ?? null;
    } catch { /* token de serviço */ }
    if (!atendenteId) return json({ error: "não autenticado" }, 401);
  }

  const body = await req.json().catch(() => ({}));
  const acao = String(body?.acao ?? "").trim();
  // Toda ação entra no log com quem chamou. Um 4xx devolvido em silêncio custou uma
  // noite de diagnóstico em 03/09: o front chamava, a função respondia erro e nada
  // ficava registrado em lugar nenhum.
  console.log(`[crm-whatsapp-call] acao=${acao} chamada=${body?.chamada_id ?? "—"} atendente=${atendenteId ?? "service"}`);

  // ── Resolve a conta (por wa_account_id direto ou pela chamada existente) ──
  async function contaDe(waAccountId: string) {
    const { data } = await admin
      .from("crm_whatsapp_accounts")
      .select("id, nome, phone_number_id, access_token, calling_status")
      .eq("id", waAccountId)
      .maybeSingle();
    return data;
  }

  async function chamadaDe(chamadaId: string) {
    const { data } = await admin
      .from("crm_chamadas")
      .select("id, wa_account_id, call_id, telefone, status, direcao, atendida_em, atendente_id")
      .eq("id", chamadaId)
      .maybeSingle();
    return data;
  }

  try {
    // ══ Estado da permissão ═══════════════════════════════════════════════
    // Lê da Meta (autoridade) e atualiza o espelho local. É o que a tela consulta
    // antes de habilitar o botão "Ligar".
    if (acao === "permissao_estado") {
      const acc = await contaDe(String(body?.wa_account_id ?? ""));
      if (!acc) return json({ error: "conta não encontrada" }, 404);
      const to = digitosParaEnvio(String(body?.telefone ?? ""));
      if (!to) return json({ error: "telefone inválido" }, 400);

      const r = await fetch(
        `${META_GRAPH}/${acc.phone_number_id}/call_permissions?user_wa_id=${to}`,
        { headers: { Authorization: `Bearer ${acc.access_token}` } },
      );
      const resp = await r.json().catch(() => ({}));
      if (!r.ok || resp?.error) return json(erroMeta(resp, r.status), 422);

      const status = resp?.permission?.status ?? "no_permission";
      const expira = resp?.permission?.expiration_time
        ? new Date(Number(resp.permission.expiration_time) * 1000).toISOString()
        : null;
      const podePedir = (resp?.actions ?? []).find(
        (a: any) => a?.action_name === "send_call_permission_request",
      );
      const podeLigar = (resp?.actions ?? []).find((a: any) => a?.action_name === "start_call");

      await admin.from("crm_call_permissions").upsert({
        wa_account_id: acc.id,
        telefone_canonico: canonicalBrPhone(to),
        status,
        expira_em: expira,
        metadata: resp,
      }, { onConflict: "wa_account_id,telefone_canonico" });

      // Estado LOCAL do pedido — a Meta não tem "pendente". Quem sabe que pedimos é o
      // espelho (`solicitado_em`, gravado no permissao_pedir) e quem sabe que o lead
      // respondeu é o webhook (`respondido_em`/`ultima_resposta`). O painel usa isso
      // para dizer "pedido enviado em X por Fulano, aguardando" em vez de "cota esgotada".
      const { data: local } = await admin
        .from("crm_call_permissions")
        .select("solicitado_em, respondido_em, ultima_resposta, solicitado_por_id")
        .eq("wa_account_id", acc.id)
        .eq("telefone_canonico", canonicalBrPhone(to))
        .maybeSingle();
      let solicitadoPorNome: string | null = null;
      if (local?.solicitado_por_id) {
        const { data: prof } = await admin.from("profiles").select("name").eq("id", local.solicitado_por_id).maybeSingle();
        solicitadoPorNome = (prof?.name ?? "").trim() || null;
      }

      return json({
        ok: true,
        status,
        expira_em: expira,
        pode_pedir_permissao: podePedir?.can_perform_action === true,
        pode_ligar: podeLigar?.can_perform_action === true,
        limites: podePedir?.limits ?? [],
        solicitado_em: local?.solicitado_em ?? null,
        respondido_em: local?.respondido_em ?? null,
        ultima_resposta: local?.ultima_resposta ?? null,
        solicitado_por_nome: solicitadoPorNome,
      });
    }

    // ══ Pedir permissão ════════════════════════════════════════════════════
    // Mensagem interativa nativa. Só funciona com a janela de 24h ABERTA — ou seja,
    // para quem já respondeu. É de propósito: pedir permissão pra base fria por
    // template é repetir, com outro rótulo, o disparo que queimou as BMs.
    if (acao === "permissao_pedir") {
      const acc = await contaDe(String(body?.wa_account_id ?? ""));
      if (!acc) return json({ error: "conta não encontrada" }, 404);
      if (acc.calling_status !== "ENABLED") {
        return json({ error: "calling não está habilitado neste número" }, 422);
      }
      const telefoneRaw = String(body?.telefone ?? "");
      if (!telefoneEnviavel(telefoneRaw)) return json({ error: "telefone_impossivel" }, 422);
      const to = digitosParaEnvio(telefoneRaw);
      if (!to) return json({ error: "telefone inválido" }, 400);

      const texto = String(body?.texto ?? "").trim() || TEXTO_PADRAO_PEDIDO_PERMISSAO;

      const r = await fetch(`${META_GRAPH}/${acc.phone_number_id}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${acc.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "interactive",
          interactive: {
            type: "call_permission_request",
            action: { name: "call_permission_request" },
            body: { text: texto },
          },
        }),
      });
      const resp = await r.json().catch(() => ({}));
      console.log(`[crm-whatsapp-call] permissao_pedir ${acc.nome} -> ${to} status=${r.status}`, JSON.stringify(resp));
      if (!r.ok || resp?.error) return json(erroMeta(resp, r.status), 422);
      const messageId: string | null = resp?.messages?.[0]?.id ?? null;

      await admin.from("crm_call_permissions").upsert({
        wa_account_id: acc.id,
        telefone_canonico: canonicalBrPhone(to),
        solicitado_em: new Date().toISOString(),
        // Quem pediu é quem recebe o aviso no sino quando o lead autorizar (trigger
        // `crm_ligacao_permissao_notificar`). Chamada de serviço fica sem dono.
        solicitado_por_id: atendenteId,
      }, { onConflict: "wa_account_id,telefone_canonico" });

      // O pedido é uma MENSAGEM de verdade (a Meta devolve wamid) e ficava invisível na
      // conversa: o atendente não sabia se tinha saído, se o lead tinha recebido, nem
      // que já gastou o 1 pedido/24h daquele lead (relato 03/09/2026). Gravado como
      // SAÍDA, o espelho leva ao SAC, o webhook de status pinta os tiques (entregue/
      // lida) pelo wamid, e a resposta do lead (inbound `call_permission_reply`) fica
      // logo abaixo. Best-effort: o pedido já saiu; falhar aqui não pode virar 4xx.
      try {
        let enviadoPorNome: string | null = null;
        if (atendenteId) {
          const { data: prof } = await admin.from("profiles").select("name").eq("id", atendenteId).maybeSingle();
          enviadoPorNome = (prof?.name ?? "").trim() || null;
        }
        const { data: leadId } = await admin.rpc("crm_lead_find_by_canon", { p_telefone: to });
        const { error: msgErr } = await admin.from("crm_whatsapp_messages").insert({
          wa_account_id: acc.id,
          lead_id: typeof leadId === "string" ? leadId : null,
          telefone: to,
          direcao: "outbound",
          tipo: "interactive",
          conteudo: textoPedidoPermissao(texto),
          wa_message_id: messageId,
          status_entrega: "sent",
          metadata: {
            interactive_tipo: "call_permission_request",
            origem: atendenteId ? "humano" : "automacao",
            ...(atendenteId ? { enviado_por_id: atendenteId, enviado_por_nome: enviadoPorNome } : {}),
          },
        });
        if (msgErr) console.error("[crm-whatsapp-call] pedido de permissão não gravado na conversa:", msgErr.message);
      } catch (e) {
        console.error(
          "[crm-whatsapp-call] pedido de permissão não gravado na conversa:",
          e instanceof Error ? e.message : String(e),
        );
      }

      return json({ ok: true, message_id: messageId });
    }

    // ══ Ligar (empresa → lead) ═════════════════════════════════════════════
    if (acao === "ligar") {
      const acc = await contaDe(String(body?.wa_account_id ?? ""));
      if (!acc) return json({ error: "conta não encontrada" }, 404);
      if (acc.calling_status !== "ENABLED") {
        return json({ error: "calling não está habilitado neste número" }, 422);
      }
      const telefoneRaw = String(body?.telefone ?? "");
      if (!telefoneEnviavel(telefoneRaw)) return json({ error: "telefone_impossivel" }, 422);
      const to = digitosParaEnvio(telefoneRaw);
      if (!to) return json({ error: "telefone inválido" }, 400);

      const sdp = String(body?.sdp ?? "").trim();
      if (!sdp) return json({ error: "sdp (offer) obrigatório" }, 400);

      // QUAL card do SAC v2 é o desta ligação — o da LINHA de onde ela sai. Mesma coisa
      // que o webhook grava na ligação recebida, e pelo mesmo motivo: é daqui que o
      // painel da chamada monta o botão "Conversa". Só por telefone a v2 abre o card
      // ativo mais recente da pessoa, que pode ser de OUTRO número (03/09/2026).
      let alvoV2: { funil_id: string | null; atendimento_id: string | null } | null = null;
      try {
        const { data } = await admin.rpc("crm_chamada_alvo_v2", {
          p_wa_account_id: acc.id,
          p_telefone: to,
        });
        const linha = Array.isArray(data) ? data[0] : data;
        if (linha?.atendimento_id) alvoV2 = linha;
      } catch (e) {
        // Ligação sem card resolvido continua ligação — o botão é que fica sem atalho.
        console.error("[crm-whatsapp-call] alvo v2 falhou:", e instanceof Error ? e.message : String(e));
      }

      // Linha ANTES do POST: se a Meta responder rápido demais, o webhook `calls` pode
      // chegar antes da nossa resposta HTTP — e sem linha ele não teria onde gravar.
      const { data: chamada, error: insErr } = await admin.from("crm_chamadas").insert({
        wa_account_id: acc.id,
        direcao: "saida",
        telefone: to,
        atendente_id: atendenteId,
        status: "iniciando",
        sdp_offer: sdp,
        sac_contato_id: body?.sac_contato_id ?? null,
        oportunidade_id: body?.oportunidade_id ?? null,
        lead_id: body?.lead_id ?? null,
        sac_v2_funil_id: alvoV2?.funil_id ?? null,
        sac_v2_atendimento_id: alvoV2?.atendimento_id ?? null,
        biz_opaque: body?.biz_opaque ?? null,
      }).select("id").single();
      if (insErr || !chamada) return json({ error: `falha ao registrar chamada: ${insErr?.message}` }, 500);

      const r = await metaCalls(acc.phone_number_id, acc.access_token, {
        to,
        action: "connect",
        session: { sdp_type: "offer", sdp },
        ...(body?.biz_opaque ? { biz_opaque_callback_data: String(body.biz_opaque) } : {}),
      });

      if (!r.ok) {
        const e = erroMeta(r.body, r.status);
        await admin.from("crm_chamadas").update({
          status: "failed",
          erro_codigo: e.meta_code,
          erro_msg: e.error,
          encerrada_em: new Date().toISOString(),
        }).eq("id", chamada.id);
        // 138006 = sem permissão de ligação. É o erro mais comum e tem tratamento
        // próprio na tela (oferece pedir permissão).
        return json({ ...e, chamada_id: chamada.id, sem_permissao: e.meta_code === 138006 }, 422);
      }

      const callId = r.body?.calls?.[0]?.id ?? null;
      await admin.from("crm_chamadas").update({ call_id: callId }).eq("id", chamada.id);
      console.log(`[crm-whatsapp-call] connect ok chamada=${chamada.id} call_id=${callId}`);

      // O SDP answer NÃO vem aqui — chega pelo webhook e o browser pega no Realtime.
      return json({ ok: true, chamada_id: chamada.id, call_id: callId });
    }

    // ══ Atender uma ligação recebida ═══════════════════════════════════════
    // pre_accept primeiro (abre a via de mídia antes do áudio e evita o corte das
    // primeiras palavras), accept em seguida. Há ~30-60s para responder.
    if (acao === "pre_aceitar" || acao === "aceitar") {
      const ch = await chamadaDe(String(body?.chamada_id ?? ""));
      if (!ch?.call_id) {
        console.warn(`[crm-whatsapp-call] ${acao}: chamada ${body?.chamada_id} não encontrada/sem call_id`);
        return json({ error: "chamada não encontrada ou sem call_id" }, 404);
      }
      console.log(`[crm-whatsapp-call] ${acao}: chamada=${ch.id} status=${ch.status} direcao=${ch.direcao} atendente_atual=${ch.atendente_id ?? "—"}`);
      const acc = await contaDe(ch.wa_account_id);
      if (!acc) return json({ error: "conta não encontrada" }, 404);
      const sdp = String(body?.sdp ?? "").trim();
      if (!sdp) return json({ error: "sdp (answer) obrigatório" }, 400);

      // Reivindica ANTES de falar com a Meta. Ligação recebida toca em vários
      // navegadores ao mesmo tempo (dono + plantão); sem esta trava, dois atendentes
      // apertando "Atender" mandariam DOIS SDP answers para a mesma chamada. Quem
      // chegar primeiro leva; o segundo recebe 409 e a tela dele diz que já foi.
      if (ch.direcao === "entrada" && atendenteId) {
        const { data: ganhou } = await admin.rpc("crm_chamada_reivindicar", {
          p_chamada_id: ch.id,
          p_atendente_id: atendenteId,
        });
        if (ganhou !== true) {
          console.warn(`[crm-whatsapp-call] ${acao}: reivindicação perdida (chamada=${ch.id})`);
          return json({ error: "ja_atendida" }, 409);
        }
      }

      const r = await metaCalls(acc.phone_number_id, acc.access_token, {
        call_id: ch.call_id,
        action: acao === "pre_aceitar" ? "pre_accept" : "accept",
        session: { sdp_type: "answer", sdp },
      });
      console.log(`[crm-whatsapp-call] ${acao}: meta status=${r.status} resp=${JSON.stringify(r.body).slice(0, 600)}`);
      if (!r.ok) return json(erroMeta(r.body, r.status), 422);

      if (acao === "aceitar") {
        await admin.from("crm_chamadas").update({
          status: "accepted",
          atendente_id: atendenteId ?? ch.atendente_id ?? null,
          atendida_em: new Date().toISOString(),
          sdp_answer: sdp,
        }).eq("id", ch.id);
      }
      return json({ ok: true });
    }

    // ══ Rejeitar / encerrar ════════════════════════════════════════════════
    if (acao === "rejeitar" || acao === "encerrar") {
      const ch = await chamadaDe(String(body?.chamada_id ?? ""));
      if (!ch) return json({ error: "chamada não encontrada" }, 404);
      const acc = await contaDe(ch.wa_account_id);
      if (!acc) return json({ error: "conta não encontrada" }, 404);

      // Sem call_id a Meta nunca chegou a criar a chamada: encerra só do nosso lado.
      if (!ch.call_id) {
        await admin.from("crm_chamadas").update({
          status: "terminated", encerrada_em: new Date().toISOString(),
        }).eq("id", ch.id);
        return json({ ok: true, local: true });
      }

      const r = await metaCalls(acc.phone_number_id, acc.access_token, {
        call_id: ch.call_id,
        action: acao === "rejeitar" ? "reject" : "terminate",
      });
      // Chamada que já caiu do outro lado devolve erro — e isso não é falha nossa:
      // o estado final chega pelo webhook terminate de qualquer jeito.
      if (!r.ok) {
        console.log(`[crm-whatsapp-call] ${acao} recusado pela Meta (provavelmente já encerrada):`,
          JSON.stringify(r.body));
      }
      await admin.from("crm_chamadas").update({
        status: acao === "rejeitar" ? "rejected" : "terminated",
        encerrada_em: new Date().toISOString(),
      }).eq("id", ch.id).in("status", ["iniciando", "ringing", "accepted"]);

      return json({ ok: true });
    }

    return json({ error: `ação desconhecida: ${acao}` }, 400);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[crm-whatsapp-call] erro:", msg);
    return json({ error: msg }, 500);
  }
});
