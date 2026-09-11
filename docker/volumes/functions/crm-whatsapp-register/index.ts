// crm-whatsapp-register
// ----------------------------------------------------------------------------
// Registra um número na Cloud API da Meta (POST /{phone_number_id}/register com PIN
// de 2FA) — o passo que tira o erro 133010 "Account not registered". Usa o
// access_token JÁ salvo na conta (crm_whatsapp_accounts), então o usuário não precisa
// mexer em token/curl: só informa o PIN na tela de Contas.
//
// Número JÁ registrado (status CONNECTED na CLOUD_API — típico de número que veio de
// outro provedor, ex.: SprintHub via Tech Provider): o registro é por NÚMERO, não por
// app, então NÃO se chama /register de novo — com o PIN antigo desconhecido isso só
// devolve (#133005) "PIN Mismatch". Nesse caso a função troca o PIN por
// POST /{phone_number_id} {pin} (não exige o PIN anterior nem o chip) e devolve
// `ja_registrado: true`. Caso real: "Grupo PPG Educação (3250)", 2026-09-10.
//
// Gate: admin/diretor (gestão de contas WhatsApp).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const META_GRAPH = "https://graph.facebook.com/v21.0";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

/**
 * Nome do system user dono do token (GET /me). Só pra dica de erro — best-effort,
 * nunca derruba a resposta. O token NÃO sai daqui.
 */
async function nomeDoSystemUser(token: string): Promise<string | null> {
  try {
    const r = await fetch(`${META_GRAPH}/me?fields=id,name`, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.id) return null;
    return `"${j.name ?? "?"}" (id ${j.id})`;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "use POST" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  // Gate admin/diretor (gestão de contas Meta).
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ error: "não autenticado" }, 401);
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false },
  });
  const { data: isAdmin } = await userClient.rpc("is_admin_ou_diretor_user");
  if (isAdmin !== true) return json({ error: "acesso restrito a admin/diretor" }, 403);

  const body = await req.json().catch(() => ({}));
  const waAccountId = String(body?.wa_account_id ?? "").trim();
  const pin = String(body?.pin ?? "").trim();
  if (!waAccountId) return json({ error: "wa_account_id obrigatório" }, 400);
  if (!/^\d{6}$/.test(pin)) return json({ error: "PIN deve ter 6 dígitos" }, 400);

  // Resolve phone_number_id + access_token da conta (mesma RPC do envio).
  const { data: waRow, error: waErr } = await admin.rpc("get_crm_wa_account", { p_account_id: waAccountId });
  const wa = Array.isArray(waRow) ? waRow[0] : waRow;
  if (waErr || !wa?.phone_number_id || !wa?.access_token) {
    return json({ error: `conta WhatsApp incompleta: ${waErr?.message ?? "sem phone_number_id/token"}` }, 500);
  }

  const authHeaders = { Authorization: `Bearer ${wa.access_token}`, "Content-Type": "application/json" };

  // Já registrado? (leitura é leniente — funciona mesmo sem atribuição na WABA.)
  const estado = await fetch(
    `${META_GRAPH}/${wa.phone_number_id}?fields=status,platform_type,is_pin_enabled`,
    { headers: authHeaders },
  ).then((x) => x.json()).catch(() => null);
  const jaRegistrado = estado?.status === "CONNECTED" && estado?.platform_type === "CLOUD_API";
  console.log(`[crm-whatsapp-register] phone=${wa.phone_number_id} estado:`, JSON.stringify(estado ?? null));

  if (jaRegistrado) {
    // Troca o PIN (2FA) sem exigir o anterior. Se falhar, o número CONTINUA registrado —
    // o erro aqui é só sobre o PIN.
    const rp = await fetch(`${META_GRAPH}/${wa.phone_number_id}`, {
      method: "POST", headers: authHeaders, body: JSON.stringify({ pin }),
    });
    const rpJson = await rp.json().catch(() => ({}));
    if (!rp.ok || (rpJson as any)?.error) {
      const e = (rpJson as any)?.error;
      return json({
        error: e?.error_user_msg || e?.message || `Meta ${rp.status}`,
        meta_code: e?.code ?? null,
        meta_subcode: e?.error_subcode ?? null,
        ja_registrado: true,
        hint:
          "O número JÁ está registrado na Cloud API (não precisa registrar de novo) — só a troca do PIN " +
          "falhou. Alternativa: WhatsApp Manager → Números de telefone → Configurações → Verificação em " +
          "duas etapas → Alterar PIN (não exige o PIN antigo nem o chip). Depois clique Conectar webhook.",
      }, 422);
    }
    return json({
      ok: true,
      success: true,
      ja_registrado: true,
      pin_alterado: true,
      mensagem:
        "Este número já estava registrado na Cloud API (veio registrado de outro provedor). " +
        "Não registrei de novo — só defini este PIN como o novo 2FA dele. Agora clique Conectar webhook.",
    });
  }

  // Registra na Meta. Só phone_number_id + token — o waba_id da conta NÃO entra aqui.
  const r = await fetch(`${META_GRAPH}/${wa.phone_number_id}/register`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ messaging_product: "whatsapp", pin }),
  });
  const resp = await r.json().catch(() => ({}));
  if (!r.ok || (resp as any)?.error) {
    const e = (resp as any)?.error;
    const metaMsg = String(e?.message ?? "");
    // (#100) "Need either permission on WhatsApp Business Account or owner business" NÃO é
    // PIN: é o system user dono do token sem atribuição no ativo WABA do número (Business
    // Manager → Usuários do sistema → Adicionar ativos → Contas do WhatsApp). Mesma causa
    // raiz do (#100) ao excluir template. Caso real: Administrativo PPG, 2026-08-25.
    const semPermissaoWaba = e?.code === 100 && /permission on .*whatsapp business account/i.test(metaMsg);
    let hint: string | undefined;
    if (semPermissaoWaba) {
      const su = await nomeDoSystemUser(wa.access_token);
      hint =
        `Não é PIN: o system user dono do token desta conta${su ? ` — ${su} —` : ""} não está atribuído à ` +
        `WABA deste número. No Business Manager: Configurações do negócio → Usuários → Usuários do sistema → ` +
        `esse usuário → Adicionar ativos → Contas do WhatsApp → marque a WABA com controle total. ` +
        `Depois clique Registrar de novo e, em seguida, Conectar webhook.`;
    } else if (e?.code === 133005) {
      hint =
        "O PIN não bate com a verificação em duas etapas já definida no número (se ele veio de outro " +
        "provedor, o PIN foi definido lá). Troque o PIN no WhatsApp Manager → Números de telefone → " +
        "Configurações → Verificação em duas etapas → Alterar PIN (não exige o PIN antigo nem o chip) e " +
        "clique Registrar de novo com o PIN novo.";
    } else if (e?.code === 100) {
      hint = "Pode ser PIN antigo (2FA) — troque o PIN do número no WhatsApp Manager (Verificação em duas etapas → Alterar PIN) e tente de novo.";
    } else if (e?.code === 133010) {
      hint = "Número ainda não verificado — verifique (OTP) antes de registrar.";
    }
    return json({
      error: e?.error_user_msg || e?.message || `Meta ${r.status}`,
      meta_code: e?.code ?? null,
      meta_subcode: e?.error_subcode ?? null,
      hint,
      // 422 (nunca 502/504): o Cloudflare engole 502/504 da origem sem headers CORS.
    }, 422);
  }
  return json({ ok: true, success: (resp as any)?.success ?? true });
});
