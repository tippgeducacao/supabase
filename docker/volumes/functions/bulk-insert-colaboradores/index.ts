import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { colaboradores, reajustes } = await req.json();

  // Delete existing data in correct order
  await supabase.from("fin_colaborador_reajustes").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await supabase.from("fin_colaborador_certificados").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await supabase.from("fin_folha_pagamento").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await supabase.from("fin_colaboradores").delete().neq("id", "00000000-0000-0000-0000-000000000000");

  // Insert colaboradores in batches
  const batchSize = 20;
  const insertedIds: Record<number, string> = {};
  
  for (let i = 0; i < colaboradores.length; i += batchSize) {
    const batch = colaboradores.slice(i, i + batchSize);
    const { data, error } = await supabase.from("fin_colaboradores").insert(batch).select("codigo, id");
    if (error) {
      return new Response(JSON.stringify({ error: error.message, step: "colaboradores", batch: i }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    for (const row of data || []) {
      insertedIds[row.codigo] = row.id;
    }
  }

  // Map reajustes to colaborador IDs and insert
  const mappedReajustes = reajustes
    .filter((r: any) => insertedIds[r.codigo])
    .map((r: any) => ({
      colaborador_id: insertedIds[r.codigo],
      valor: r.valor,
      data_reajuste: r.data_reajuste,
    }));

  if (mappedReajustes.length > 0) {
    const { error } = await supabase.from("fin_colaborador_reajustes").insert(mappedReajustes);
    if (error) {
      return new Response(JSON.stringify({ error: error.message, step: "reajustes" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }

  return new Response(JSON.stringify({ 
    success: true, 
    colaboradores_inserted: Object.keys(insertedIds).length,
    reajustes_inserted: mappedReajustes.length 
  }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
});
