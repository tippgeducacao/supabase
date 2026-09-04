// wa-uazapi-admin
// ----------------------------------------------------------------------------
// Orquestra o ciclo de vida das linhas de WhatsApp (provider-agnóstico via
// _shared/waProviders). Chamado pelo front na tela "WhatsApp Web (Uazapi)" — por
// QUALQUER usuário ativo (gate pode_gerenciar_wa_conexoes, aberto em 2026-09-04).
// Faz o passo a passo que o usuário pediu: criar instância -> setar
// webhook -> gerar QR -> checar status -> desconectar -> deletar.
//
// SEGREDO: o token da instância é gravado em wa_conexoes_secrets (service_role-
// only) e NUNCA volta pro front. O front recebe só {conexao_id, qrcode, status}.
//
// Envs (Dokploy):
//   UAZAPI_ADMIN_TOKEN        token de admin do servidor Uazapi (cria instâncias)
//   UAZAPI_SERVER_URL         ex.: https://sistemappgvet.uazapi.com
//   WA_WEBHOOK_PUBLIC_BASE    base PÚBLICA das functions (Uazapi precisa alcançar),
//                             ex.: https://api.ppgeducacao.site/functions/v1
// ----------------------------------------------------------------------------
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/cors.ts";
import { getWaProvider } from "../_shared/waProviders.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const UAZAPI_ADMIN_TOKEN = Deno.env.get("UAZAPI_ADMIN_TOKEN") ?? "";
const UAZAPI_SERVER_URL = (Deno.env.get("UAZAPI_SERVER_URL") ?? "").replace(/\/+$/, "");
const WEBHOOK_BASE = (Deno.env.get("WA_WEBHOOK_PUBLIC_BASE") ?? "").replace(/\/+$/, "");
const PROVIDER = "uazapi";
const WEBHOOK_EVENTS = ["messages", "messages_update", "connection"];

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function webhookUrl(conexaoId: string): string {
  return `${WEBHOOK_BASE}/wa-uazapi-webhook?conexao=${encodeURIComponent(conexaoId)}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "use POST" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  // ── Gate: qualquer usuário ATIVO (pode_gerenciar_wa_conexoes) — desativado/anon = 403 ──
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ error: "não autenticado" }, 401);
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  });
  const { data: podeGerenciar, error: gateErr } = await userClient.rpc("pode_gerenciar_wa_conexoes");
  if (gateErr || podeGerenciar !== true) return json({ error: "acesso restrito a usuários ativos do sistema" }, 403);

  const provider = getWaProvider(PROVIDER);
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action ?? "");

  // Resolve o token da instância (segredo) a partir do conexao_id.
  async function tokenDe(conexaoId: string): Promise<{ token: string; server: string } | null> {
    const { data: conex } = await admin.from("wa_conexoes").select("server_url").eq("id", conexaoId).maybeSingle();
    const { data: sec } = await admin.from("wa_conexoes_secrets").select("token").eq("conexao_id", conexaoId).maybeSingle();
    if (!conex || !sec?.token) return null;
    return { token: sec.token, server: conex.server_url };
  }

  try {
    switch (action) {
      // ── criar: instância + webhook + QR, tudo de uma vez ────────────────────
      case "criar": {
        if (!UAZAPI_ADMIN_TOKEN || !UAZAPI_SERVER_URL || !WEBHOOK_BASE) {
          return json({ error: "config ausente: defina UAZAPI_ADMIN_TOKEN, UAZAPI_SERVER_URL e WA_WEBHOOK_PUBLIC_BASE no Dokploy" }, 500);
        }
        const nome = String(body?.nome ?? "").trim();
        if (!nome) return json({ error: "nome da instância é obrigatório" }, 400);

        // 1) cria a instância no servidor Uazapi
        const inst = await provider.createInstance(UAZAPI_SERVER_URL, UAZAPI_ADMIN_TOKEN, nome);
        // 422 (nunca 502/504): o Cloudflare engole 502/504 da origem sem headers CORS.
        if (!inst.token) return json({ error: "Uazapi não retornou token da instância" }, 422);

        // 2) grava conexão (metadata) + segredo (token)
        const { data: userInfo } = await userClient.auth.getUser();
        const criadoPor = userInfo?.user?.id ?? null;
        const { data: conexRow, error: insErr } = await admin.from("wa_conexoes").insert({
          provider: PROVIDER,
          server_url: UAZAPI_SERVER_URL,
          instancia_externa_id: inst.instanceId,
          instancia_nome: nome,
          numero_display: String(body?.numero_display ?? "").trim() || null,
          responsavel_id: body?.responsavel_id ?? null,
          sac_funil_ids: Array.isArray(body?.sac_funil_ids) ? body.sac_funil_ids : [],
          status_conexao: inst.status,
          ultimo_status_em: new Date().toISOString(),
          qrcode: inst.qrcode ?? null,
          paircode: inst.paircode ?? null,
          criado_por: criadoPor,
        }).select("id").single();
        if (insErr || !conexRow) return json({ error: `falha ao salvar conexão: ${insErr?.message}` }, 500);
        const conexaoId = conexRow.id;
        await admin.from("wa_conexoes_secrets").insert({ conexao_id: conexaoId, token: inst.token });

        // 3) configura o webhook desta instância apontando pra cá (?conexao=<id>)
        try {
          await provider.setWebhook(UAZAPI_SERVER_URL, inst.token, webhookUrl(conexaoId), WEBHOOK_EVENTS);
        } catch (e) {
          console.error("[wa-uazapi-admin] setWebhook falhou:", e instanceof Error ? e.message : String(e));
          // não aborta: a conexão existe, o webhook pode ser reconfigurado depois
        }

        // 4) garante o QR (se o create já não trouxe)
        let qrcode = inst.qrcode ?? null;
        let paircode = inst.paircode ?? null;
        let status = inst.status;
        if (!qrcode && status !== "conectado") {
          try {
            const c = await provider.connect(UAZAPI_SERVER_URL, inst.token);
            qrcode = c.qrcode ?? null;
            paircode = c.paircode ?? null;
            status = c.status;
            await admin.from("wa_conexoes").update({
              qrcode, paircode, status_conexao: status, ultimo_status_em: new Date().toISOString(),
            }).eq("id", conexaoId);
          } catch (e) {
            console.error("[wa-uazapi-admin] connect falhou:", e instanceof Error ? e.message : String(e));
          }
        }
        return json({ ok: true, conexao_id: conexaoId, qrcode, paircode, status });
      }

      // ── conectar: (re)gera o QR de uma conexão existente ────────────────────
      case "conectar": {
        const conexaoId = String(body?.conexao_id ?? "");
        const t = await tokenDe(conexaoId);
        if (!t) return json({ error: "conexão não encontrada" }, 404);
        const c = await provider.connect(t.server, t.token);
        await admin.from("wa_conexoes").update({
          qrcode: c.qrcode ?? null, paircode: c.paircode ?? null,
          status_conexao: c.status, ultimo_status_em: new Date().toISOString(),
        }).eq("id", conexaoId);
        return json({ ok: true, conexao_id: conexaoId, qrcode: c.qrcode ?? null, paircode: c.paircode ?? null, status: c.status });
      }

      // ── status: lê e atualiza o status atual ────────────────────────────────
      case "status": {
        const conexaoId = String(body?.conexao_id ?? "");
        const t = await tokenDe(conexaoId);
        if (!t) return json({ error: "conexão não encontrada" }, 404);
        const s = await provider.status(t.server, t.token);
        const patch: Record<string, unknown> = {
          status_conexao: s.status, ultimo_status_em: new Date().toISOString(),
        };
        if (s.numero) patch.numero = s.numero;
        if (s.status === "conectado") { patch.qrcode = null; patch.paircode = null; }
        await admin.from("wa_conexoes").update(patch).eq("id", conexaoId);
        return json({ ok: true, conexao_id: conexaoId, status: s.status, numero: s.numero ?? null });
      }

      // ── desconectar: logout sem deletar ─────────────────────────────────────
      case "desconectar": {
        const conexaoId = String(body?.conexao_id ?? "");
        const t = await tokenDe(conexaoId);
        if (!t) return json({ error: "conexão não encontrada" }, 404);
        await provider.disconnect(t.server, t.token);
        await admin.from("wa_conexoes").update({
          status_conexao: "desconectado", ultimo_status_em: new Date().toISOString(),
        }).eq("id", conexaoId);
        return json({ ok: true, conexao_id: conexaoId, status: "desconectado" });
      }

      // ── deletar: remove a instância no servidor e a conexão local ───────────
      case "deletar": {
        const conexaoId = String(body?.conexao_id ?? "");
        const t = await tokenDe(conexaoId);
        if (t) {
          try { await provider.deleteInstance(t.server, t.token); }
          catch (e) { console.error("[wa-uazapi-admin] deleteInstance falhou:", e instanceof Error ? e.message : String(e)); }
        }
        await admin.from("wa_conexoes").delete().eq("id", conexaoId); // cascade apaga o secret
        return json({ ok: true, conexao_id: conexaoId, deleted: true });
      }

      default:
        return json({ error: `action inválida: '${action}' (use criar|conectar|status|desconectar|deletar)` }, 400);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[wa-uazapi-admin] fatal:", msg);
    return json({ error: msg }, 500);
  }
});
