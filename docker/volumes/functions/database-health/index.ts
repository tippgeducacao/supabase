// Edge Function: database-health
// Métricas via RPC SQL + endpoint Prometheus do Supabase para host (CPU/RAM/Disco).
// Restrita ao usuário ti@ppg.com.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const ALLOWED_EMAIL = "ti@ppg.com";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ------ Prometheus parsing helpers ------
type Sample = { labels: Record<string, string>; value: number };

function parsePromText(text: string): Map<string, Sample[]> {
  const out = new Map<string, Sample[]>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // metric{labels} value [timestamp]
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([\-0-9.eE+NnAaIifF]+)/);
    if (!m) continue;
    const name = m[1];
    const labelsStr = m[2] || "";
    const value = Number(m[3]);
    if (!Number.isFinite(value)) continue;
    const labels: Record<string, string> = {};
    if (labelsStr) {
      // labels are quoted strings; simple split that handles common cases
      const re = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"((?:\\.|[^"\\])*)"/g;
      let lm: RegExpExecArray | null;
      while ((lm = re.exec(labelsStr)) !== null) {
        labels[lm[1]] = lm[2].replace(/\\(.)/g, "$1");
      }
    }
    const arr = out.get(name) ?? [];
    arr.push({ labels, value });
    out.set(name, arr);
  }
  return out;
}

function sumSamples(samples: Sample[] | undefined, filter?: (l: Record<string, string>) => boolean): number {
  if (!samples) return 0;
  return samples.reduce((acc, s) => acc + ((filter ? filter(s.labels) : true) ? s.value : 0), 0);
}

interface HostMetricsResult {
  available: boolean;
  cpuPercent: number | null;
  memTotalBytes: number | null;
  memUsedBytes: number | null;
  memPercent: number | null;
  diskTotalBytes: number | null;
  diskUsedBytes: number | null;
  diskPercent: number | null;
  error?: string | null;
}

async function fetchPromText(url: string, auth: string): Promise<string> {
  const res = await fetch(url, { headers: { Authorization: auth } });
  if (!res.ok) {
    throw new Error(`Prometheus HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.text();
}

async function collectHostMetrics(projectRef: string, serviceKey: string): Promise<HostMetricsResult> {
  const empty: HostMetricsResult = {
    available: false,
    cpuPercent: null,
    memTotalBytes: null,
    memUsedBytes: null,
    memPercent: null,
    diskTotalBytes: null,
    diskUsedBytes: null,
    diskPercent: null,
    error: null,
  };
  try {
    const url = `https://${projectRef}.supabase.co/customer/v1/privileged/metrics`;
    const auth = "Basic " + btoa(`service_role:${serviceKey}`);

    // Duas amostras para calcular CPU% por delta de idle.
    const t1 = await fetchPromText(url, auth);
    await new Promise((r) => setTimeout(r, 1000));
    const t2 = await fetchPromText(url, auth);
    const m1 = parsePromText(t1);
    const m2 = parsePromText(t2);

    // CPU: usa node_cpu_seconds_total. cpu% = 1 - (idleΔ / totalΔ)
    const cpu1 = m1.get("node_cpu_seconds_total");
    const cpu2 = m2.get("node_cpu_seconds_total");
    let cpuPercent: number | null = null;
    if (cpu1 && cpu2) {
      const total1 = sumSamples(cpu1);
      const total2 = sumSamples(cpu2);
      const idle1 = sumSamples(cpu1, (l) => l.mode === "idle");
      const idle2 = sumSamples(cpu2, (l) => l.mode === "idle");
      const totalDelta = total2 - total1;
      const idleDelta = idle2 - idle1;
      if (totalDelta > 0) {
        cpuPercent = Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
      }
    }

    // RAM
    const memTotal = m2.get("node_memory_MemTotal_bytes")?.[0]?.value ?? null;
    const memAvail = m2.get("node_memory_MemAvailable_bytes")?.[0]?.value ?? null;
    let memUsed: number | null = null;
    let memPercent: number | null = null;
    if (memTotal != null && memAvail != null) {
      memUsed = memTotal - memAvail;
      memPercent = Math.max(0, Math.min(100, (memUsed / memTotal) * 100));
    }

    // Disco: agrega node_filesystem_* preferindo mountpoint root ou data
    const dsize = m2.get("node_filesystem_size_bytes") || [];
    const davail = m2.get("node_filesystem_avail_bytes") || [];
    const pickFs = (samples: Sample[]) => {
      // Tenta mountpoints típicos de data; senão pega o maior (root)
      const preferred = samples.find((s) => /\/(data|var\/lib\/postgresql)/.test(s.labels.mountpoint || ""));
      if (preferred) return preferred;
      return samples.reduce<Sample | null>((best, s) => {
        if (!best || s.value > best.value) return s;
        return best;
      }, null);
    };
    const fsSize = pickFs(dsize);
    const fsAvail = davail.find((s) => s.labels.mountpoint === fsSize?.labels.mountpoint) ?? null;
    let diskTotalBytes: number | null = null;
    let diskUsedBytes: number | null = null;
    let diskPercent: number | null = null;
    if (fsSize && fsAvail) {
      diskTotalBytes = fsSize.value;
      diskUsedBytes = fsSize.value - fsAvail.value;
      diskPercent = diskTotalBytes > 0 ? Math.max(0, Math.min(100, (diskUsedBytes / diskTotalBytes) * 100)) : null;
    }

    return {
      available: true,
      cpuPercent,
      memTotalBytes: memTotal,
      memUsedBytes: memUsed,
      memPercent,
      diskTotalBytes,
      diskUsedBytes,
      diskPercent,
      error: null,
    };
  } catch (e) {
    return { ...empty, error: (e as Error).message };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");

    if (!supabaseUrl || !serviceKey || !anonKey) {
      return jsonResponse({ error: "Edge function sem variáveis de ambiente Supabase." }, 500);
    }

    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader) return jsonResponse({ error: "Sem header Authorization" }, 401);

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) {
      return jsonResponse({ error: "Token JWT inválido ou expirado" }, 401);
    }

    const authEmail = (user.email || "").toLowerCase();
    let allowed = authEmail === ALLOWED_EMAIL;

    const adminClient = createClient(supabaseUrl, serviceKey);

    if (!allowed) {
      const { data: profile } = await adminClient
        .from("profiles").select("email").eq("id", user.id).maybeSingle();
      const profileEmail = (profile?.email || "").toLowerCase();
      if (profileEmail === ALLOWED_EMAIL) allowed = true;
    }

    if (!allowed) {
      return jsonResponse(
        { error: `Acesso restrito ao usuário ${ALLOWED_EMAIL}. Seu email: ${authEmail || "(?)"}` },
        403,
      );
    }

    // Project ref: extraído do SUPABASE_URL (https://<ref>.supabase.co)
    const projectRef = (supabaseUrl.match(/https?:\/\/([^.]+)\.supabase\.co/i)?.[1]) || "";

    // Coleta em paralelo: métricas DB (RPC), top queries (RPC) e métricas host (Prometheus)
    const [metricsRes, topQueriesRes, hostRes] = await Promise.allSettled([
      adminClient.rpc("get_db_health_metrics", { _request_user_id: user.id }),
      adminClient.rpc("get_top_slow_queries", { p_limit: 10, _request_user_id: user.id }),
      projectRef ? collectHostMetrics(projectRef, serviceKey) : Promise.resolve<HostMetricsResult>({
        available: false, cpuPercent: null, memTotalBytes: null, memUsedBytes: null, memPercent: null,
        diskTotalBytes: null, diskUsedBytes: null, diskPercent: null, error: "Project ref não detectado",
      }),
    ]);

    const metricsData = metricsRes.status === "fulfilled" ? (metricsRes.value.data ?? {}) : {};
    const metricsErr = metricsRes.status === "fulfilled" ? metricsRes.value.error : (metricsRes.reason as Error);
    if (metricsErr) console.error("[database-health] get_db_health_metrics error", metricsErr);
    const m = metricsData as Record<string, number | null>;

    let topQueries: Array<Record<string, unknown>> = [];
    let topQueriesError: string | null = null;
    if (topQueriesRes.status === "fulfilled") {
      const { data, error } = topQueriesRes.value;
      if (error) topQueriesError = error.message;
      else if (Array.isArray(data)) topQueries = data;
    } else {
      topQueriesError = (topQueriesRes.reason as Error)?.message || "Erro desconhecido";
    }

    const host: HostMetricsResult = hostRes.status === "fulfilled"
      ? hostRes.value
      : { available: false, cpuPercent: null, memTotalBytes: null, memUsedBytes: null, memPercent: null,
          diskTotalBytes: null, diskUsedBytes: null, diskPercent: null, error: (hostRes.reason as Error)?.message ?? "Erro" };

    return jsonResponse({
      timestamp: new Date().toISOString(),
      metrics: {
        connections: m.connections ?? null,
        maxConnections: m.maxConnections ?? null,
        connectionsPercent: m.connectionsPercent ?? null,
        cacheHitRatio: m.cacheHitRatio ?? null,
        dbSizeBytes: m.dbSizeBytes ?? null,
        dbSizeGB: m.dbSizeGB ?? null,
        transactionsPerSec: m.transactionsPerSec ?? null,
        deadlocks: m.deadlocks ?? null,
        // Host (CPU/RAM/Disco) via endpoint Prometheus do Supabase
        hostMetricsAvailable: host.available,
        cpuPercent: host.cpuPercent,
        memTotalBytes: host.memTotalBytes,
        memUsedBytes: host.memUsedBytes,
        memPercent: host.memPercent,
        diskTotalBytes: host.diskTotalBytes,
        diskUsedBytes: host.diskUsedBytes,
        diskPercent: host.diskPercent,
        hostMetricsError: host.error ?? null,
        metricsError: (metricsErr as Error)?.message ?? null,
      },
      topQueries,
      topQueriesError,
    });
  } catch (e) {
    console.error("[database-health] unhandled", e);
    return jsonResponse({ error: `Erro inesperado: ${(e as Error).message}` }, 500);
  }
});
