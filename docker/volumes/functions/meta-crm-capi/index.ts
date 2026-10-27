// Leads qualificados do CRM → API de Conversões da Meta (integração de CRM) · 27/10/2026.
//
// Uma vez por dia (pg_cron), manda à Meta as etapas do funil dos leads de origem META:
// crm_lead, crm_reuniao_agendada, crm_reuniao_realizada e crm_matricula. Com isso a Meta
// aprende quem AVANÇA no funil, não só quem preenche o formulário (recomendação da conta
// BM 01: "custo por lead de qualidade 24% menor"). Guia do Gerenciador de Eventos → conjunto
// de dados PPGVET 5865 → integração de CRM. Ver docs/Marketing — Mídia Paga.md.
//
// ⚠️ Os nomes são crm_* de propósito: NUNCA "Lead". O Pixel e a CAPI dos sites já mandam
// "Lead"; um "Lead" vindo daqui contaria de novo nas campanhas que otimizam por Lead.
//
// Quem pode chamar: só quem traz a service role key (o cron, pelo vault). O runtime não valida
// JWT (VERIFY_JWT=false, docs/Infraestrutura e Deploy.md), então a checagem é aqui
// (chamadaInterna, que deixa o PostgREST conferir a assinatura).
//
// Corpo (JSON, tudo opcional):
//   { "dias": 1..7 }          janela (padrão 2; a API aceita evento de até 7 dias)
//   { "simular": true }       monta tudo, NÃO envia e NÃO grava: devolve contagens
//   { "teste": "TEST12345" }  envia com test_event_code (aba "Eventos de teste"), NÃO grava
//
// Token: o da conta "CA 01 I VETERINARIOS" em meta_accounts (a mesma do sync-meta-ads); o
// token não sai do banco.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const PIXEL_ID = "328582603655865";
const API = "https://graph.facebook.com/v26.0";
const CONTA_DO_TOKEN = Deno.env.get("META_CRM_AD_ACCOUNT") || "1187337038878748";
const LOTE = 500;

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });

async function sha256(texto: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Telefone no formato da Meta: só dígitos, com 55. Fora disso, não manda. */
export function telefoneMeta(bruto: string | null): string | null {
  const d = (bruto || "").replace(/\D/g, "").replace(/^0+/, "");
  if (d.length === 10 || d.length === 11) return "55" + d;
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) return d;
  return null;
}

type Pendente = {
  event_id: string;
  lead_id: string;
  etapa: string;
  event_time: string;
  lead_criado_em: string;
  email: string | null;
  telefone: string | null;
  fbclid: string | null;
  leadgen_id: string | null;
};

async function montarEvento(p: Pendente) {
  const user_data: Record<string, unknown> = {};
  if (p.email) user_data.em = [await sha256(p.email.trim().toLowerCase())];
  const tel = telefoneMeta(p.telefone);
  if (tel) user_data.ph = [await sha256(tel)];
  // String, não número: 15-17 dígitos passam do inteiro seguro do JavaScript.
  if (p.leadgen_id && /^\d{15,17}$/.test(p.leadgen_id)) user_data.lead_id = p.leadgen_id;
  if (p.fbclid) user_data.fbc = `fb.1.${new Date(p.lead_criado_em).getTime()}.${p.fbclid}`;
  return {
    event_name: p.etapa,
    event_time: Math.floor(new Date(p.event_time).getTime() / 1000),
    event_id: p.event_id,
    action_source: "system_generated",
    custom_data: { event_source: "crm", lead_event_source: "Sistema PPGVET" },
    user_data,
  };
}

/**
 * Só o sistema chama. O cron manda a chave do VAULT (`_get_service_role_key()`), que NÃO é a
 * service role key válida de hoje: o gateway a recusa (401 medido em 27/10/2026) e ela também
 * difere da env desta function. Ler a claim `role` sem conferir assinatura não serve
 * (VERIFY_JWT=false, um token forjado passaria). Então: aceita a chave da env OU a do vault,
 * lida do banco com a chave da env. A do vault é secreta (só service_role/postgres executam
 * `_get_service_role_key`), então só o próprio banco consegue mandá-la.
 */
async function chamadaInterna(
  authHeader: string,
  serviceKey: string,
  lerChaveDoVault: () => Promise<unknown>,
): Promise<boolean> {
  if (!authHeader.startsWith("Bearer ")) return false;
  if (authHeader === `Bearer ${serviceKey}`) return true;
  const chave = await lerChaveDoVault();
  return typeof chave === "string" && chave.length > 20 && authHeader === `Bearer ${chave}`;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, erro: "Método não permitido" }, 405);

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
  const lerChaveDoVault = async () => {
    const { data, error } = await supabase.rpc("_get_service_role_key");
    return error ? null : data;
  };
  if (!(await chamadaInterna(req.headers.get("Authorization") ?? "", serviceKey, lerChaveDoVault))) {
    return json({ ok: false, erro: "Não autorizado" }, 401);
  }

  let corpo: { dias?: number; simular?: boolean; teste?: string } = {};
  try {
    corpo = await req.json();
  } catch {
    corpo = {};
  }
  const dias = Math.min(Math.max(Number(corpo.dias) || 2, 1), 7);
  const teste = typeof corpo.teste === "string" && /^TEST\w+$/i.test(corpo.teste) ? corpo.teste : null;

  try {
    const { data: pendentes, error } = await supabase.rpc("meta_crm_eventos_pendentes", { p_dias: dias, p_limite: 5000 });
    if (error) throw error;
    const lista = (pendentes || []) as Pendente[];
    const leadDoEvento = new Map(lista.map((p) => [p.event_id, p.lead_id]));
    const eventos = await Promise.all(lista.map(montarEvento));
    const porEtapa = lista.reduce<Record<string, number>>((acc, p) => ((acc[p.etapa] = (acc[p.etapa] || 0) + 1), acc), {});

    if (corpo.simular) {
      const amostra = eventos[0] ? { ...eventos[0], user_data: Object.keys(eventos[0].user_data) } : null;
      return json({ ok: true, modo: "simular", dias, total: eventos.length, porEtapa, amostra });
    }
    if (!eventos.length) return json({ ok: true, modo: teste ? "teste" : "envio", dias, total: 0 });

    const { data: conta, error: errConta } = await supabase
      .from("meta_accounts")
      .select("access_token")
      .eq("ad_account_id", CONTA_DO_TOKEN)
      .eq("is_active", true)
      .maybeSingle();
    if (errConta) throw errConta;
    if (!conta?.access_token) return json({ ok: false, erro: `Sem token ativo da conta ${CONTA_DO_TOKEN}` }, 500);

    // No teste, um lote pequeno basta para a Meta confirmar o formato.
    const aEnviar = teste ? eventos.slice(0, 5) : eventos;
    let recebidos = 0;
    const falhas: string[] = [];

    for (let i = 0; i < aEnviar.length; i += LOTE) {
      const lote = aEnviar.slice(i, i + LOTE);
      const resp = await fetch(`${API}/${PIXEL_ID}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data: lote,
          access_token: conta.access_token,
          ...(teste ? { test_event_code: teste } : {}),
        }),
      });
      const r = await resp.json().catch(() => ({}));
      const ok = resp.ok && typeof r.events_received === "number";
      if (ok) recebidos += r.events_received;
      else falhas.push(`HTTP ${resp.status}: ${String(r?.error?.message || "sem mensagem").slice(0, 200)}`);

      if (!teste) {
        const registros = lote.map((e) => ({
          event_id: e.event_id,
          lead_id: leadDoEvento.get(e.event_id),
          etapa: e.event_name,
          event_time: new Date(e.event_time * 1000).toISOString(),
          status: ok ? "ok" : "erro",
          http_status: resp.status,
          erro: ok ? null : String(r?.error?.message || "").slice(0, 500) || null,
          enviado_em: new Date().toISOString(),
        }));
        const { error: errLog } = await supabase.from("meta_crm_envios").upsert(registros, { onConflict: "event_id" });
        if (errLog) falhas.push(`registro: ${errLog.message}`);
      }
    }

    return json({
      ok: falhas.length === 0,
      modo: teste ? "teste" : "envio",
      dias,
      total: aEnviar.length,
      recebidos,
      porEtapa,
      falhas,
    }, falhas.length ? 207 : 200);
  } catch (err) {
    // Erro do supabase-js não é instanceof Error: tem .message solto no objeto.
    const msg = err instanceof Error ? err.message : (err as { message?: string })?.message ?? JSON.stringify(err);
    console.error("meta-crm-capi:", msg);
    return json({ ok: false, erro: msg.slice(0, 300) }, 500);
  }
});
