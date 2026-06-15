// send-incident-apology: dispara o template "aviso_teste_sistema" pros professores
// afetados por um disparo indevido (incidente). Marca cada envio em
// ped_incidentes_disparo_indevido.desculpa_enviada_em pra evitar reenvio.
//
// Body: { incidente_codigo: string, dry_run?: boolean }
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_GRAPH = "https://graph.facebook.com/v21.0";
const TEMPLATE_NAME = "aviso_teste_sistema";
const TEMPLATE_LANG = "pt_BR";

function formatPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  return digits.startsWith("55") ? digits : `55${digits}`;
}

function firstName(full: string | null | undefined): string {
  if (!full) return "professor";
  return full.trim().split(/\s+/)[0] ?? "professor";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const incidente_codigo: string = body?.incidente_codigo ?? "";
    const dry_run = Boolean(body?.dry_run);
    if (!incidente_codigo) {
      return new Response(JSON.stringify({ ok: false, error: "incidente_codigo obrigatório" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    // WA account
    const { data: waRow, error: waErr } = await supabase.rpc("get_wa_account_pedagogico");
    if (waErr || !waRow) throw new Error(`WA account: ${waErr?.message ?? "vazio"}`);
    const wa = Array.isArray(waRow) ? waRow[0] : waRow;
    const phoneNumberId = wa?.phone_number_id;
    const accessToken = wa?.access_token;
    if (!phoneNumberId || !accessToken) throw new Error("WA account incompleto");

    // Lista de afetados que ainda não receberam desculpa
    const { data: afetados, error: lErr } = await supabase
      .from("ped_incidentes_disparo_indevido")
      .select("id, prof_id, prof_nome, contato_whatsapp")
      .eq("incidente_codigo", incidente_codigo)
      .is("desculpa_enviada_em", null);
    if (lErr) throw lErr;

    const results: Array<Record<string, unknown>> = [];
    let sent = 0;
    let errors = 0;

    for (const af of afetados ?? []) {
      const to = formatPhone(af.contato_whatsapp);
      if (!to) {
        errors++;
        results.push({ id: af.id, nome: af.prof_nome, status: "telefone_invalido" });
        continue;
      }

      const payload = {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: TEMPLATE_NAME,
          language: { code: TEMPLATE_LANG },
          components: [
            {
              type: "body",
              parameters: [{ type: "text", text: firstName(af.prof_nome) }],
            },
          ],
        },
      };

      if (dry_run) {
        results.push({ id: af.id, nome: af.prof_nome, to, status: "dry_run" });
        continue;
      }

      try {
        const r = await fetch(`${META_GRAPH}/${phoneNumberId}/messages`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        const waResp = await r.json().catch(() => ({}));
        const waMsgId = waResp?.messages?.[0]?.id ?? null;

        if (!r.ok) {
          errors++;
          await supabase
            .from("ped_incidentes_disparo_indevido")
            .update({
              desculpa_erro: { http_status: r.status, body: waResp },
            })
            .eq("id", af.id);
          results.push({ id: af.id, nome: af.prof_nome, to, status: "erro_meta", error: waResp?.error?.message });
          continue;
        }

        sent++;
        await supabase
          .from("ped_incidentes_disparo_indevido")
          .update({
            desculpa_enviada_em: new Date().toISOString(),
            desculpa_wa_message_id: waMsgId,
            desculpa_erro: null,
          })
          .eq("id", af.id);
        results.push({ id: af.id, nome: af.prof_nome, to, status: "enviado", wa_message_id: waMsgId });
      } catch (e) {
        errors++;
        results.push({ id: af.id, nome: af.prof_nome, to, status: "fetch_error", error: (e as Error).message });
      }

      // Pequeno delay pra não atropelar Meta API (rate limit)
      await new Promise((r) => setTimeout(r, 150));
    }

    return new Response(JSON.stringify({
      ok: true,
      incidente_codigo,
      total: afetados?.length ?? 0,
      sent,
      errors,
      dry_run,
      results,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
