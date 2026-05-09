// Edge Function: cob-migrate-data
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const RAW_SOURCE_URL = Deno.env.get("SOURCE_COBRANCA_SUPABASE_URL")!;
// Strip trailing slashes and accidental /rest/v1 / /auth/v1 paths to get the project base URL
const SOURCE_URL = RAW_SOURCE_URL
  .replace(/\/+$/, "")
  .replace(/\/(rest|auth|storage|realtime)\/v1\/?$/, "");
const SOURCE_KEY = Deno.env.get("SOURCE_COBRANCA_SERVICE_ROLE_KEY")!;
const DEST_URL = Deno.env.get("SUPABASE_URL")!;
const DEST_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const TABLES: { src: string; dest: string }[] = [
  { src: "lancamentos_diarios", dest: "cob_lancamentos_diarios" },
  { src: "lancamentos_excluidos", dest: "cob_lancamentos_excluidos" },
  { src: "protestos", dest: "cob_protestos" },
  { src: "controle_acessos", dest: "cob_controle_acessos" },
  { src: "inadimplentes", dest: "cob_inadimplentes" },
  { src: "cancelamentos_historico", dest: "cob_cancelamentos_historico" },
  { src: "cobrancas", dest: "cob_cobrancas" },
  { src: "pautas_melhoria", dest: "cob_pautas_melhoria" },
];

const PAGE = 1000;

// Direct REST fetch instead of SDK to bypass any URL parsing weirdness
async function restFetch(table: string, from: number, to: number) {
  const url = `${SOURCE_URL.replace(/\/$/, "")}/rest/v1/${table}?select=*&offset=${from}&limit=${to - from + 1}`;
  const res = await fetch(url, {
    headers: {
      apikey: SOURCE_KEY,
      Authorization: `Bearer ${SOURCE_KEY}`,
      "Content-Type": "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, body: text.slice(0, 500) };
  }
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, status: res.status, body: text.slice(0, 500) };
  }
}

async function copyTable(
  dest: ReturnType<typeof createClient>,
  src: string,
  destTable: string,
) {
  let from = 0;
  let total = 0;
  const { error: delErr } = await dest.from(destTable).delete().not("id", "is", null);
  if (delErr) {
    return { table: destTable, ok: false, error: `clear: ${delErr.message}`, copied: 0 };
  }
  while (true) {
    const r = await restFetch(src, from, from + PAGE - 1);
    if (!r.ok) {
      return {
        table: destTable,
        ok: false,
        error: `select ${src}: HTTP ${r.status} ${r.body}`,
        copied: total,
      };
    }
    const data = r.data as any[];
    if (!data || data.length === 0) break;
    const { error: insErr } = await dest.from(destTable).insert(data);
    if (insErr) {
      return {
        table: destTable,
        ok: false,
        error: `insert ${destTable}: ${insErr.message} | sample keys: ${Object.keys(data[0] ?? {}).join(",")}`,
        copied: total,
      };
    }
    total += data.length;
    if (data.length < PAGE) break;
    from += PAGE;
  }
  // counts
  const cRes = await fetch(
    `${SOURCE_URL.replace(/\/$/, "")}/rest/v1/${src}?select=id`,
    {
      headers: {
        apikey: SOURCE_KEY,
        Authorization: `Bearer ${SOURCE_KEY}`,
        Prefer: "count=exact",
        Range: "0-0",
      },
    },
  );
  const srcCount = Number(cRes.headers.get("content-range")?.split("/")?.[1] ?? -1);
  const { count: destCount } = await dest
    .from(destTable)
    .select("*", { count: "exact", head: true });
  return {
    table: destTable,
    ok: srcCount === destCount,
    copied: total,
    source_count: srcCount,
    dest_count: destCount ?? null,
  };
}

async function copyStorage(
  source: ReturnType<typeof createClient>,
  dest: ReturnType<typeof createClient>,
  bucket: string,
  destBucket: string,
) {
  const result: any = { bucket: destBucket, copied: 0, errors: [] as string[] };
  async function walk(prefix: string) {
    const { data, error } = await source.storage.from(bucket).list(prefix, { limit: 1000 });
    if (error) {
      result.errors.push(`list ${prefix}: ${error.message}`);
      return;
    }
    for (const item of data ?? []) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (!item.metadata) {
        await walk(path);
        continue;
      }
      const { data: blob, error: dErr } = await source.storage.from(bucket).download(path);
      if (dErr || !blob) {
        result.errors.push(`download ${path}: ${dErr?.message}`);
        continue;
      }
      const { error: uErr } = await dest.storage
        .from(destBucket)
        .upload(path, blob, { upsert: true, contentType: blob.type });
      if (uErr) {
        result.errors.push(`upload ${path}: ${uErr.message}`);
        continue;
      }
      result.copied++;
    }
  }
  await walk("");
  return result;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!SOURCE_URL || !SOURCE_KEY) {
      throw new Error("Missing SOURCE_COBRANCA_SUPABASE_URL or SOURCE_COBRANCA_SERVICE_ROLE_KEY");
    }
    const url = new URL(req.url);
    const onlyStorage = url.searchParams.get("only") === "storage";
    const onlyTables = url.searchParams.get("only") === "tables";
    const debug = url.searchParams.get("debug") === "1";

    if (debug) {
      // ping the source
      const r = await fetch(`${SOURCE_URL.replace(/\/$/, "")}/rest/v1/lancamentos_diarios?select=id&limit=1`, {
        headers: { apikey: SOURCE_KEY, Authorization: `Bearer ${SOURCE_KEY}` },
      });
      const body = await r.text();
      return new Response(
        JSON.stringify({
          source_url: SOURCE_URL,
          source_url_starts_with_https: SOURCE_URL.startsWith("https://"),
          source_key_first10: SOURCE_KEY.slice(0, 10),
          source_key_length: SOURCE_KEY.length,
          ping_status: r.status,
          ping_body: body.slice(0, 800),
        }, null, 2),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const dest = createClient(DEST_URL, DEST_KEY, { auth: { persistSession: false } });
    const source = createClient(SOURCE_URL, SOURCE_KEY, { auth: { persistSession: false } });

    const results: any = { tables: [], storage: null, started_at: new Date().toISOString() };

    if (!onlyStorage) {
      for (const t of TABLES) {
        const r = await copyTable(dest, t.src, t.dest);
        results.tables.push(r);
      }
    }
    if (!onlyTables) {
      results.storage = await copyStorage(source, dest, "protestos", "cob-protestos");
    }
    results.finished_at = new Date().toISOString();
    return new Response(JSON.stringify(results, null, 2), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const err = e as Error;
    return new Response(
      JSON.stringify({ error: err.message, stack: err.stack }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
