import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Source project (Contribuição Financeira)
const SOURCE_URL = "https://iogotqysdouakzthmdqt.supabase.co";
const SOURCE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlvZ290cXlzZG91YWt6dGhtZHF0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTIxNTMyOTQsImV4cCI6MjA2NzcyOTI5NH0.r3BB9EsNz3B1EL4CJsftnuZftdlWswKNl8ULmTJvi_g";

async function fetchAll(client: any, table: string): Promise<any[]> {
  const all: any[] = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await client
      .from(table)
      .select("*")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`fetch ${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...data);
    from += PAGE;
    if (data.length < PAGE) break;
  }
  return all;
}

async function insertBatch(client: any, table: string, rows: any[], batchSize = 500): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await client.from(table).insert(batch);
    if (error) throw new Error(`insert ${table} batch ${Math.floor(i/batchSize)}: ${error.message}`);
    inserted += batch.length;
  }
  return inserted;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const destUrl = Deno.env.get("SUPABASE_URL")!;
    const destKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const source = createClient(SOURCE_URL, SOURCE_ANON_KEY);
    const dest = createClient(destUrl, destKey);

    // Order matters for FK dependencies
    const tables = [
      // Phase 1: no FK deps
      "fin_bancos",
      "fin_fornecedores",
      "fin_plano_contas",
      "fin_colaboradores",
      // Phase 2: depends on colaboradores
      "fin_setores",
      "fin_colaborador_certificados",
      "fin_colaborador_reajustes",
      // Phase 3: depends on bancos, fornecedores, plano_contas
      "fin_lancamentos",
      "fin_alunos",
      // Phase 4: depends on lancamentos
      "fin_lancamento_rateios",
      "fin_lancamentos_excluidos",
      // Phase 5: depends on colaboradores, bancos
      "fin_folha_pagamento",
      "fin_saldos_bancarios",
      // Phase 6: clima
      "fin_clima_ciclos",
      "fin_clima_perguntas",
      "fin_clima_avaliacoes",
      "fin_clima_respostas_colaborador",
      "fin_clima_respostas_lider",
      "fin_clima_diagnosticos",
      // Phase 7: disc
      "fin_disc_respostas",
    ];

    const report: Record<string, { fetched: number; inserted: number; error?: string }> = {};

    for (const table of tables) {
      try {
        const rows = await fetchAll(source, table);
        report[table] = { fetched: rows.length, inserted: 0 };
        
        if (rows.length > 0) {
          // Remove any fields that might cause issues (like auto-generated serials)
          const cleanRows = rows.map((row: any) => {
            const clean = { ...row };
            // For fin_colaboradores, remove the serial 'codigo' if it exists as it will be auto-generated
            // Actually keep it to preserve the original codes
            return clean;
          });
          
          const inserted = await insertBatch(dest, table, cleanRows);
          report[table].inserted = inserted;
        }
      } catch (err) {
        report[table] = { 
          fetched: report[table]?.fetched ?? 0, 
          inserted: report[table]?.inserted ?? 0, 
          error: (err as Error).message 
        };
      }
    }

    const totalFetched = Object.values(report).reduce((s, r) => s + r.fetched, 0);
    const totalInserted = Object.values(report).reduce((s, r) => s + r.inserted, 0);
    const errors = Object.entries(report).filter(([, r]) => r.error).map(([t, r]) => `${t}: ${r.error}`);

    return new Response(
      JSON.stringify({ 
        success: errors.length === 0,
        totalFetched, 
        totalInserted,
        errors,
        report 
      }, null, 2),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
