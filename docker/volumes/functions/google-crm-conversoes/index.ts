// Etapas do CRM → Google Ads (conversões offline pela Data Manager API) · 27/10/2026.
//
// Uma vez por dia (pg_cron), manda ao Google Ads as etapas dos leads de origem GOOGLE que têm
// gclid: crm_reuniao_agendada, crm_reuniao_realizada e crm_matricula. Cada etapa vai para a sua
// ação de conversão na conta 974-490-0197 ("CRM - Reunião agendada/realizada/Matrícula"), todas
// SECUNDÁRIAS: aparecem nos relatórios por campanha/palavra-chave e não mexem no lance.
// Irmã da meta-crm-capi (mesma régua de etapas); ver docs/Marketing — Mídia Paga.md.
//
// Por que Data Manager e não a Google Ads API: UploadClickConversions está fechada para
// integração nova desde 15/06/2026.
//
// Quem pode chamar: só quem traz a service role key (o cron, pelo vault) — mesma checagem da
// meta-crm-capi (VERIFY_JWT=false no runtime).
//
// Corpo (JSON, tudo opcional):
//   { "dias": 1..90 }      janela (padrão 7; a ação de conversão aceita até 90 dias do clique)
//   { "simular": true }    monta tudo, NÃO envia e NÃO grava: devolve contagens
//   { "validar": true }    envia com validateOnly (o Google confere e não grava); NÃO grava aqui
//
// Credencial: chave da conta de serviço no vault ('google_datamanager_sa'), lida por
// _get_google_datamanager_sa(). A conta precisa ser usuária da conta do Google Ads.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const CONTA_GOOGLE_ADS = "9744900197";
const ACAO_POR_ETAPA: Record<string, string> = {
  crm_reuniao_agendada: "7876604123",
  crm_reuniao_realizada: "7876604126",
  crm_matricula: "7876604129",
};
const INGEST = "https://datamanager.googleapis.com/v1/events:ingest";
const ESCOPO = "https://www.googleapis.com/auth/datamanager";
const LOTE = 2000;

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function sha256(texto: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Normalização do Google: minúsculo; gmail/googlemail sem pontos antes do @. */
export function emailGoogle(bruto: string): string {
  const e = bruto.trim().toLowerCase();
  const [local, dominio] = e.split("@");
  if (dominio === "gmail.com" || dominio === "googlemail.com") return `${local.replace(/\./g, "")}@${dominio}`;
  return e;
}

/** Telefone em E.164 (+55…). Fora disso, não manda. */
export function telefoneGoogle(bruto: string | null): string | null {
  const d = (bruto || "").replace(/\D/g, "").replace(/^0+/, "");
  if (d.length === 10 || d.length === 11) return "+55" + d;
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) return "+" + d;
  return null;
}

/** Access token da conta de serviço (JWT assinado RS256 → oauth2 token). */
export async function tokenDaContaDeServico(sa: { client_email: string; private_key: string; token_uri?: string }) {
  const agora = Math.floor(Date.now() / 1000);
  const aud = sa.token_uri || "https://oauth2.googleapis.com/token";
  const enc = new TextEncoder();
  const cab = b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const carga = b64url(enc.encode(JSON.stringify({ iss: sa.client_email, scope: ESCOPO, aud, iat: agora, exp: agora + 3600 })));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const chave = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const assinatura = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", chave, enc.encode(`${cab}.${carga}`)));
  const resp = await fetch(aud, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${cab}.${carga}.${b64url(assinatura)}`,
    }),
  });
  const r = await resp.json().catch(() => ({}));
  if (!resp.ok || !r.access_token) throw new Error(`token Google: HTTP ${resp.status} ${r.error_description || r.error || ""}`);
  return r.access_token as string;
}

type Pendente = {
  event_id: string;
  lead_id: string;
  etapa: string;
  event_time: string;
  gclid: string;
  email: string | null;
  telefone: string | null;
};

export async function montarEvento(p: Pendente) {
  const ids: Record<string, string>[] = [];
  if (p.email) ids.push({ emailAddress: await sha256(emailGoogle(p.email)) });
  const tel = telefoneGoogle(p.telefone);
  if (tel) ids.push({ phoneNumber: await sha256(tel) });
  return {
    adIdentifiers: { gclid: p.gclid },
    eventTimestamp: new Date(p.event_time).toISOString(),
    transactionId: p.event_id,
    eventSource: "OTHER",
    ...(ids.length ? { userData: { userIdentifiers: ids } } : {}),
  };
}

/** Igual à meta-crm-capi: aceita a service role key da env OU a do vault (a que o cron manda). */
async function chamadaInterna(authHeader: string, serviceKey: string, lerChaveDoVault: () => Promise<unknown>) {
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

  let corpo: { dias?: number; simular?: boolean; validar?: boolean } = {};
  try {
    corpo = await req.json();
  } catch {
    corpo = {};
  }
  const dias = Math.min(Math.max(Number(corpo.dias) || 7, 1), 90);
  const validar = corpo.validar === true;

  try {
    const { data: pendentes, error } = await supabase.rpc("google_crm_eventos_pendentes", { p_dias: dias, p_limite: 5000 });
    if (error) throw error;
    const lista = ((pendentes || []) as Pendente[]).filter((p) => ACAO_POR_ETAPA[p.etapa]);
    const porEtapa = lista.reduce<Record<string, number>>((acc, p) => ((acc[p.etapa] = (acc[p.etapa] || 0) + 1), acc), {});

    if (corpo.simular) return json({ ok: true, modo: "simular", dias, total: lista.length, porEtapa });
    if (!lista.length) return json({ ok: true, modo: validar ? "validar" : "envio", dias, total: 0 });

    const { data: saTexto, error: errSa } = await supabase.rpc("_get_google_datamanager_sa");
    if (errSa) throw errSa;
    if (typeof saTexto !== "string" || !saTexto) return json({ ok: false, erro: "Sem a chave 'google_datamanager_sa' no vault" }, 500);
    const token = await tokenDaContaDeServico(JSON.parse(saTexto));

    let aceitos = 0;
    const falhas: string[] = [];
    const avisos: string[] = [];

    // Uma requisição por etapa: o destino (ação de conversão) vale para todos os eventos dela.
    for (const [etapa, acao] of Object.entries(ACAO_POR_ETAPA)) {
      const daEtapa = lista.filter((p) => p.etapa === etapa);
      for (let i = 0; i < daEtapa.length; i += LOTE) {
        const lote = daEtapa.slice(i, i + LOTE);
        const resp = await fetch(INGEST, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            destinations: [{ operatingAccount: { accountType: "GOOGLE_ADS", accountId: CONTA_GOOGLE_ADS }, productDestinationId: acao }],
            encoding: "HEX",
            events: await Promise.all(lote.map(montarEvento)),
            validateOnly: validar,
          }),
        });
        const r = await resp.json().catch(() => ({}));
        const ok = resp.ok;
        if (ok) aceitos += lote.length;
        else falhas.push(`${etapa}: HTTP ${resp.status}: ${String(r?.error?.message || "sem mensagem").slice(0, 200)}`);
        for (const w of (r?.fieldWarnings || []).slice(0, 5)) avisos.push(`${etapa}: ${JSON.stringify(w).slice(0, 200)}`);

        if (!validar) {
          const registros = lote.map((p) => ({
            event_id: p.event_id,
            lead_id: p.lead_id,
            etapa: p.etapa,
            event_time: p.event_time,
            status: ok ? "ok" : "erro",
            http_status: resp.status,
            erro: ok ? null : String(r?.error?.message || "").slice(0, 500) || null,
            enviado_em: new Date().toISOString(),
          }));
          const { error: errLog } = await supabase.from("google_crm_envios").upsert(registros, { onConflict: "event_id" });
          if (errLog) falhas.push(`registro: ${errLog.message}`);
        }
      }
    }

    return json(
      { ok: falhas.length === 0, modo: validar ? "validar" : "envio", dias, total: lista.length, aceitos, porEtapa, falhas, avisos },
      falhas.length ? 207 : 200,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : (err as { message?: string })?.message ?? JSON.stringify(err);
    console.error("google-crm-conversoes:", msg);
    return json({ ok: false, erro: msg.slice(0, 300) }, 500);
  }
});
