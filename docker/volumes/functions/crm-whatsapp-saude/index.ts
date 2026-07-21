// crm-whatsapp-saude
// Saúde AO VIVO das contas WhatsApp Cloud API (Meta) para a tela do WhatsApp API.
//
// A aba "Saúde da conta" já mostrava os ALERTAS que a Meta empurra por webhook
// (crm_whatsapp_alertas) — mas alerta só chega DEPOIS do problema. Aqui é o estado
// atual, lido da Graph API na hora:
//   · qualidade do número (GREEN/YELLOW/RED) — cai antes de a Meta bloquear
//   · tier de envio (250 / 1k / 10k / 100k / ilimitado) — teto de conversas iniciadas por dia
//   · status do número (CONNECTED / FLAGGED / RESTRICTED …) e do nome de exibição
//   · status de revisão e verificação de negócio da WABA
//
// Uma chamada por conta ativa, em paralelo. Falha de uma conta não derruba as outras:
// cada item volta com `erro` e a tela mostra o que deu.
//
// ⚠️ Chamada pelo NAVEGADOR → nunca devolver 502/504 (o Cloudflare troca por página
// de erro sem CORS e o front só vê "Failed to send a request"). Recusa = 422.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const META_GRAPH = "https://graph.facebook.com/v21.0";
const TIMEOUT_MS = 12_000;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** GET na Graph com timeout próprio — conta lenta não pendura a tela inteira. */
async function graph(url: string, token: string): Promise<any> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: abort.signal,
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(body?.error?.error_user_msg || body?.error?.message || `Meta API ${r.status}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // Gate: precisa de usuário logado (a tela é interna de gestão do CRM).
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ error: "não autorizado" }, 401);
    const asUser = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    const { data: userData } = await asUser.auth.getUser();
    if (!userData?.user) return json({ error: "não autorizado" }, 401);

    const body = await req.json().catch(() => ({}));
    const soConta: string | null = body?.wa_account_id ?? null;

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
    let q = admin
      .from("crm_whatsapp_accounts")
      .select("id, nome, numero_display, waba_id, phone_number_id, access_token, cor")
      .eq("ativo", true);
    if (soConta) q = q.eq("id", soConta);
    const { data: contas, error: contasErr } = await q;
    if (contasErr) return json({ error: `Falha ao ler contas: ${contasErr.message}` }, 422);

    const itens = await Promise.all(
      (contas ?? []).map(async (c: any) => {
        const base = {
          id: c.id,
          nome: c.nome,
          numero_display: c.numero_display,
          cor: c.cor ?? null,
        };
        if (!c.waba_id || !c.access_token) {
          return { ...base, erro: "Conta sem waba_id ou access_token cadastrado" };
        }
        try {
          // Número (qualidade/tier/status) + WABA (revisão/verificação) em paralelo.
          const [fones, waba] = await Promise.all([
            graph(
              `${META_GRAPH}/${c.waba_id}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,messaging_limit_tier,status,name_status`,
              c.access_token,
            ),
            graph(
              `${META_GRAPH}/${c.waba_id}?fields=name,account_review_status,business_verification_status`,
              c.access_token,
            ).catch(() => null), // WABA é complemento: se falhar, mostra só o número
          ]);
          const lista = Array.isArray(fones?.data) ? fones.data : [];
          // O número da conta é o phone_number_id cadastrado; sem match, usa o 1º.
          const fone = lista.find((f: any) => String(f?.id) === String(c.phone_number_id)) ?? lista[0] ?? null;
          return {
            ...base,
            qualidade: fone?.quality_rating ?? null,          // GREEN | YELLOW | RED | UNKNOWN
            tier: fone?.messaging_limit_tier ?? null,          // TIER_250 | TIER_1K | ...
            status_numero: fone?.status ?? null,               // CONNECTED | FLAGGED | RESTRICTED ...
            status_nome: fone?.name_status ?? null,            // APPROVED | PENDING_REVIEW ...
            nome_verificado: fone?.verified_name ?? null,
            numero_meta: fone?.display_phone_number ?? null,
            waba_nome: waba?.name ?? null,
            waba_revisao: waba?.account_review_status ?? null, // APPROVED | PENDING | REJECTED
            waba_verificacao: waba?.business_verification_status ?? null,
            erro: null as string | null,
          };
        } catch (e) {
          return { ...base, erro: e instanceof Error ? e.message : String(e) };
        }
      }),
    );

    return json({ contas: itens, consultado_em: new Date().toISOString() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[crm-whatsapp-saude] fatal:", msg);
    return json({ error: "erro interno ao consultar a saúde das contas" }, 500);
  }
});
