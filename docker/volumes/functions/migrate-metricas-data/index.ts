import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const OLD_URL = "https://vegfzogkpgsctbufnuwo.supabase.co";
const OLD_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZlZ2Z6b2drcGdzY3RidWZudXdvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDUzMDIsImV4cCI6MjA5MTMyMTMwMn0.7AGtoRrZxfJShQqACfYBcHUjWDiXCZFISCABTfOLnaY";

const TABLES = [
  "meta_accounts",
  "wa_accounts", 
  "ig_accounts",
  "ai_api_keys",
  "brand_profiles",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    // Auth check - accept service role or user token
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const newSupabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      serviceRoleKey
    );

    const authHeader = req.headers.get("Authorization");
    const apiKey = req.headers.get("apikey");
    
    // If called with service role key via apikey header (internal), allow
    const isServiceRole = apiKey === serviceRoleKey;
    
    let targetUserId: string | null = null;

    if (!isServiceRole) {
      if (!authHeader) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...CORS, "Content-Type": "application/json" } });
      }
      const token = authHeader.replace("Bearer ", "");
      const { data: { user }, error: authError } = await newSupabase.auth.getUser(token);
      if (authError || !user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...CORS, "Content-Type": "application/json" } });
      }
      targetUserId = user.id;
    }

    // Parse request body for target_user_id mapping
    try {
      const body = await req.json();
      if (body.target_user_id) targetUserId = body.target_user_id;
    } catch { /* no body */ }

    // Connect to old DB
    const oldSupabase = createClient(OLD_URL, OLD_KEY);

    const report: Record<string, { found: number; migrated: number; errors: string[] }> = {};

    for (const table of TABLES) {
      report[table] = { found: 0, migrated: 0, errors: [] };

      // Fetch from old
      const { data: oldData, error: fetchErr } = await oldSupabase
        .from(table)
        .select("*");

      if (fetchErr) {
        report[table].errors.push(`Fetch error: ${fetchErr.message}`);
        continue;
      }

      if (!oldData || oldData.length === 0) {
        continue;
      }

      report[table].found = oldData.length;

      // Re-map user_id to target
      const mapped = oldData.map((row: Record<string, any>) => {
        const newRow = { ...row };
        delete newRow.id; // let new DB generate IDs
        if ("user_id" in newRow) {
          newRow.user_id = targetUserId;
        }
        return newRow;
      });

      // Insert into new DB
      const { data: inserted, error: insertErr } = await newSupabase
        .from(table)
        .upsert(mapped, { onConflict: "id", ignoreDuplicates: true })
        .select();

      if (insertErr) {
        // Try one by one
        for (const row of mapped) {
          const { error: singleErr } = await newSupabase.from(table).insert(row);
          if (singleErr) {
            report[table].errors.push(`Insert error: ${singleErr.message}`);
          } else {
            report[table].migrated++;
          }
        }
      } else {
        report[table].migrated = inserted?.length || mapped.length;
      }
    }

    return new Response(JSON.stringify({ success: true, report }), {
      headers: { ...CORS, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
