// Etapas do CRM → GA4 (Measurement Protocol) · 16/11/2026, ponte GA4 ↔ CRM.
//
// Uma vez por dia (pg_cron), manda ao GA4 (G-4548Y6L079) as etapas dos leads que têm
// ga_client_id (o número do visitante no cookie _ga, mandado pelos sites no formulário):
// crm_reuniao_agendada, crm_reuniao_realizada e a matrícula como `purchase` (17/11/2026: valor em
// BRL, a pós em items e transaction_id = event_id; é o evento-chave padrão do GA4 e entra na receita).
// O site já manda generate_lead; com estas três o GA4 mostra o funil inteiro até a matrícula.
// Irmã da google-crm-conversoes (mesma régua de etapas); ver docs/Marketing — Mídia Paga.md.
//
// O GA4 aceita evento datado de até 72 h atrás (doc: developers.google.com/analytics/devguides/
// collection/protocol/ga4/sending-events). Mais velho que isso vai SEM data: o GA4 grava na
// chegada, em vez de a etapa registrada com atraso no CRM se perder.
//
// Quem pode chamar: só a chave de serviço exata (o cron, pelo vault) — exigirAcesso.
//
// Corpo (JSON, tudo opcional):
//   { "dias": 1..30 }      janela (padrão 7)
//   { "simular": true }    monta tudo, NÃO envia e NÃO grava: devolve contagens
//   { "validar": true }    manda ao servidor de validação do GA4 (/debug/mp/collect); NÃO grava

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { exigirAcesso, respostaAcessoNegado } from "../_shared/acesso.ts";

const MEASUREMENT_ID = "G-4548Y6L079";
const ETAPAS = new Set(["crm_reuniao_agendada", "crm_reuniao_realizada", "crm_matricula"]);
const LIMITE_DATA_MS = 71 * 3600 * 1000; // 1 h de folga sobre as 72 h do GA4

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });

export type Pendente = {
  event_id: string;
  lead_id: string;
  etapa: string;
  event_time: string;
  ga_client_id: string;
  valor: number | string | null; // só na matrícula, em BRL
  curso_id?: string | null; // só na matrícula
  curso_nome?: string | null;
};

/** Corpo do Measurement Protocol para UMA etapa de UM lead. */
export function montarEvento(p: Pendente, agora = Date.now()) {
  const t = new Date(p.event_time).getTime();
  const valor = Number(p.valor);
  return {
    client_id: p.ga_client_id,
    ...(Number.isFinite(t) && agora - t <= LIMITE_DATA_MS && t <= agora ? { timestamp_micros: t * 1000 } : {}),
    events: [p.etapa === "crm_matricula"
      ? {
        // purchase exige transaction_id e items com item_id ou item_name (doc: developers.google.com/
        // analytics/devguides/collection/protocol/ga4/reference/events#purchase).
        name: "purchase",
        params: {
          transaction_id: p.event_id,
          ...(valor > 0 ? { value: valor, currency: "BRL" } : {}),
          items: [{
            ...(p.curso_id ? { item_id: p.curso_id } : {}),
            item_name: p.curso_nome || "Matrícula",
            ...(valor > 0 ? { price: valor } : {}),
            quantity: 1,
          }],
        },
      }
      : { name: p.etapa, params: valor > 0 ? { value: valor, currency: "BRL" } : {} }],
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, erro: "Método não permitido" }, 405);

  try { await exigirAcesso(req, { servico: true }); }
  catch (e) { return respostaAcessoNegado(e); }
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let corpo: { dias?: number; simular?: boolean; validar?: boolean } = {};
  try {
    corpo = await req.json();
  } catch {
    corpo = {};
  }
  const dias = Math.min(Math.max(Number(corpo.dias) || 7, 1), 30);
  const validar = corpo.validar === true;

  try {
    const { data: pendentes, error } = await supabase.rpc("ga4_crm_eventos_pendentes", { p_dias: dias, p_limite: 5000 });
    if (error) throw error;
    const lista = ((pendentes || []) as Pendente[]).filter((p) => ETAPAS.has(p.etapa));
    const porEtapa = lista.reduce<Record<string, number>>((acc, p) => ((acc[p.etapa] = (acc[p.etapa] || 0) + 1), acc), {});

    if (corpo.simular) return json({ ok: true, modo: "simular", dias, total: lista.length, porEtapa });
    if (!lista.length) return json({ ok: true, modo: validar ? "validar" : "envio", dias, total: 0 });

    const { data: segredo, error: errSeg } = await supabase.rpc("_get_ga4_mp_secret");
    if (errSeg) throw errSeg;
    if (typeof segredo !== "string" || !segredo) return json({ ok: false, erro: "Sem 'ga4_mp_api_secret' no vault" }, 500);

    const base = validar ? "https://www.google-analytics.com/debug/mp/collect" : "https://www.google-analytics.com/mp/collect";
    const url = `${base}?measurement_id=${MEASUREMENT_ID}&api_secret=${encodeURIComponent(segredo)}`;

    let aceitos = 0;
    const falhas: string[] = [];
    const avisos: string[] = [];

    // Um pedido por etapa: cada uma tem a sua data, e o volume é pequeno (só lead com _ga).
    for (const p of lista) {
      const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(montarEvento(p)) });
      const texto = await resp.text().catch(() => "");
      // O /mp/collect responde 2xx mesmo com evento inválido: quem diz o que está errado é o /debug.
      let ok = resp.ok;
      if (validar) {
        const msgs = (() => { try { return JSON.parse(texto)?.validationMessages ?? []; } catch { return []; } })();
        if (msgs.length) { ok = false; avisos.push(`${p.event_id}: ${JSON.stringify(msgs).slice(0, 200)}`); }
      }
      if (ok) aceitos++;
      else falhas.push(`${p.event_id}: HTTP ${resp.status} ${texto.slice(0, 150)}`);
      if (validar) continue;
      // Grava logo depois de cada envio: se a gravação falhasse só no fim, a etapa já enviada
      // ficaria sem registro e sairia de novo no dia seguinte (contando em dobro no GA4).
      const { error: errLog } = await supabase.from("ga4_crm_envios").upsert({
        event_id: p.event_id,
        lead_id: p.lead_id,
        etapa: p.etapa,
        event_time: p.event_time,
        status: ok ? "ok" : "erro",
        http_status: resp.status,
        erro: ok ? null : texto.slice(0, 500) || null,
        enviado_em: new Date().toISOString(),
      }, { onConflict: "event_id" });
      if (errLog) falhas.push(`registro ${p.event_id}: ${errLog.message}`);
    }

    return json(
      { ok: falhas.length === 0, modo: validar ? "validar" : "envio", dias, total: lista.length, aceitos, porEtapa, falhas: falhas.slice(0, 20), avisos: avisos.slice(0, 20) },
      falhas.length ? 207 : 200,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : (err as { message?: string })?.message ?? JSON.stringify(err);
    console.error("ga4-crm-eventos:", msg);
    return json({ ok: false, erro: msg.slice(0, 300) }, 500);
  }
});
