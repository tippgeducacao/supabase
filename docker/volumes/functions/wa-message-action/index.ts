// wa-message-action
// ----------------------------------------------------------------------------
// Editar / Excluir-para-todos uma mensagem de uma LINHA provider-agnóstica (Uazapi).
// Resolve a mensagem pelo wa_message_id -> conexão (provider + token) e chama o
// adapter. Persiste o resultado no inbox (crm_whatsapp_messages) E no espelho do SAC
// (sac_mensagens) — o mirror normal é só de INSERT, então edit/delete atualizam aqui.
//
// Só mensagens OUTBOUND de uma linha web (wa_conexao_id) — o WhatsApp só deixa editar/
// apagar as próprias mensagens, e dentro do prazo dele (edição ~15 min).
//
// PORTÃO (20/10/2026): até aqui o único teste era o header COMEÇAR com "Bearer " — o runtime
// self-hosted não confere JWT por função, então "Bearer qualquer-coisa" passava e, com o
// wa_message_id de uma mensagem enviada por linha Web, qualquer um editava ou "apagava para
// todos" no WhatsApp do cliente e no CRM. Agora: a sessão é validada no Auth (getUser) e vale
// a MESMA régua da wa-uazapi-admin — usuário ATIVO (`pode_gerenciar_wa_conexoes()`), que é
// também quem vê os botões Editar/Apagar no chat. Único chamador: o chat do CRM/SAC
// (`useWaMessageAction` → `functions.invoke`, com o JWT da sessão). Nenhuma edge, cron ou n8n
// chama esta função, então chave de serviço NÃO é aceita (nem a anon).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/cors.ts";
import { getWaProvider } from "../_shared/waProviders.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const TOMBSTONE = "🚫 Mensagem apagada";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "use POST" }, 405);
  const jwt = (req.headers.get("Authorization") ?? "").match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!jwt) return json({ error: "não autenticado" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  // ── Gate: sessão de verdade + usuário ATIVO, antes de ler qualquer mensagem ou token ──
  // getUser recusa texto qualquer, JWT vencido/forjado e também as chaves anon/serviço
  // (não têm usuário). Falha de rede no Auth = 500 (o Cloudflare repassa; 502/504 não).
  let usuarioId: string;
  try {
    const { data: quem, error: quemErr } = await admin.auth.getUser(jwt);
    if (quemErr || !quem?.user?.id || quem.user.is_anonymous) {
      return json({ error: "sessão inválida — entre de novo no sistema" }, 401);
    }
    usuarioId = quem.user.id;
  } catch {
    return json({ error: "não foi possível verificar sua sessão — tente de novo" }, 500);
  }
  // A régua mora no banco (a mesma da wa-uazapi-admin): chamada COMO o usuário, porque é
  // `auth.uid()` que ela confere.
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  });
  const { data: podeAgir, error: gateErr } = await userClient.rpc("pode_gerenciar_wa_conexoes");
  if (gateErr) return json({ error: "não foi possível verificar sua permissão — tente de novo" }, 500);
  if (podeAgir !== true) return json({ error: "acesso restrito a usuários ativos do sistema" }, 403);

  const body = await req.json().catch(() => ({}));
  const action = String(body?.action ?? "");
  const waMessageId = String(body?.wa_message_id ?? "").trim();
  if (!waMessageId) return json({ error: "wa_message_id obrigatório" }, 400);
  if (action !== "edit" && action !== "delete") return json({ error: "action deve ser 'edit' ou 'delete'" }, 400);

  // Resolve a mensagem -> conexão (só web/outbound).
  const { data: msg } = await admin
    .from("crm_whatsapp_messages")
    .select("id, provider, direcao, wa_conexao_id, wa_message_id")
    .eq("wa_message_id", waMessageId)
    .maybeSingle();
  if (!msg) return json({ error: "mensagem não encontrada" }, 404);
  if (!msg.wa_conexao_id) return json({ error: "editar/apagar só em linhas WhatsApp Web" }, 422);
  if (msg.direcao !== "outbound") return json({ error: "só dá pra editar/apagar mensagens enviadas pela própria linha" }, 422);

  const { data: conex } = await admin
    .from("wa_conexoes").select("server_url, provider").eq("id", msg.wa_conexao_id).maybeSingle();
  const { data: sec } = await admin
    .from("wa_conexoes_secrets").select("token").eq("conexao_id", msg.wa_conexao_id).maybeSingle();
  if (!conex || !sec?.token) return json({ error: "conexão/token ausente" }, 500);

  const provider = getWaProvider(conex.provider ?? msg.provider ?? "uazapi");

  try {
    if (action === "edit") {
      const text = String(body?.text ?? "").trim();
      if (!text) return json({ error: "text obrigatório para editar" }, 400);
      const r = await provider.editMessage(conex.server_url, sec.token, waMessageId, text);
      // 422 (nunca 502/504): o Cloudflare engole 502/504 da origem sem headers CORS.
      if (!r.ok) return json({ error: "provider recusou a edição", provider_response: r.raw }, 422);
      await admin.from("crm_whatsapp_messages").update({ conteudo: text }).eq("wa_message_id", waMessageId);
      await admin.from("sac_mensagens").update({ conteudo: text }).eq("wa_message_id", waMessageId);
      console.log(`[wa-message-action] edit por ${usuarioId} em ${waMessageId}`);
      return json({ ok: true, action, conteudo: text });
    }

    // delete (para todos)
    const r = await provider.deleteMessage(conex.server_url, sec.token, waMessageId);
    if (!r.ok) return json({ error: "provider recusou a exclusão", provider_response: r.raw }, 422);
    await admin.from("crm_whatsapp_messages")
      .update({ conteudo: TOMBSTONE, anexos: [] }).eq("wa_message_id", waMessageId);
    await admin.from("sac_mensagens")
      .update({ conteudo: TOMBSTONE, anexos: [] }).eq("wa_message_id", waMessageId);
    console.log(`[wa-message-action] delete por ${usuarioId} em ${waMessageId}`);
    return json({ ok: true, action, conteudo: TOMBSTONE });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    console.error("[wa-message-action] fatal:", m);
    return json({ error: m }, 500);
  }
});
