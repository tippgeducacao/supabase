import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const EXT = "https://iogotqysdouakzthmdqt.supabase.co";
const EXT_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlvZ290cXlzZG91YWt6dGhtZHF0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTIxNTMyOTQsImV4cCI6MjA2NzcyOTI5NH0.r3BB9EsNz3B1EL4CJsftnuZftdlWswKNl8ULmTJvi_g";

async function fetchAll(table: string, order = "created_at") {
  const out: any[] = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const r = await fetch(`${EXT}/rest/v1/${table}?select=*&order=${order}.asc`, {
      headers: { apikey: EXT_KEY, Authorization: `Bearer ${EXT_KEY}`, Range: `${from}-${from + PAGE - 1}`, "Range-Unit": "items" },
    });
    const d = await r.json();
    if (!Array.isArray(d) || d.length === 0) break;
    out.push(...d);
    if (d.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const report: Record<string, any> = {};

    const inadIds = new Set<string>();
    {
      const { data } = await supa.from("cob_inadimplentes").select("id");
      for (const r of data ?? []) inadIds.add(r.id);
    }

    for (const [src, dst, order] of [
      ["inadimplentes_parcelas", "cob_inadimplentes_parcelas", "created_at"],
      ["nac_payments", "cob_nac_payments", "id"],
      ["conciliacoes_pendentes", "cob_conciliacoes_pendentes", "created_at"],
    ] as const) {
      const rows = await fetchAll(src, order);
      // For parcelas, drop FK to inadimplente if missing locally
      const cleaned = rows.map((r: any) => {
        if (dst === "cob_inadimplentes_parcelas" && r.inadimplente_id && !inadIds.has(r.inadimplente_id)) {
          return { ...r, inadimplente_id: null };
        }
        return r;
      });
      let inserted = 0;
      const BATCH = 500;
      for (let i = 0; i < cleaned.length; i += BATCH) {
        const batch = cleaned.slice(i, i + BATCH);
        const { error, count } = await supa.from(dst).upsert(batch, { onConflict: "id", count: "exact" });
        if (error) {
          report[dst] = { fetched: rows.length, inserted, error: error.message };
          break;
        }
        inserted += batch.length;
      }
      report[dst] ??= { fetched: rows.length, inserted };
    }

    return new Response(JSON.stringify(report, null, 2), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
