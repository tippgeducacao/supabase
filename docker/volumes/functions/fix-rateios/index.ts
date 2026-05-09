import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const body = await req.json();

    // Fix classe_id inconsistencies: set classe_id = parent of subclasse
    if (body.fix_classes) {
      // Get all despesa lancamentos with subclasse
      const allLanc: any[] = [];
      let from = 0;
      const PAGE = 1000;
      while (true) {
        const { data, error } = await supabase
          .from("fin_lancamentos")
          .select("id, classe_id, subclasse_id")
          .eq("tipo", "despesa")
          .not("subclasse_id", "is", null)
          .range(from, from + PAGE - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        allLanc.push(...data);
        from += PAGE;
        if (data.length < PAGE) break;
      }

      // Get all plano_contas to build parent map
      const { data: contas, error: cErr } = await supabase
        .from("fin_plano_contas")
        .select("id, parent_id, code, name");
      if (cErr) throw cErr;

      const parentMap = new Map<string, string>();
      for (const c of contas!) {
        if (c.parent_id) parentMap.set(c.id, c.parent_id);
      }

      // Find inconsistent ones
      const toFix: { id: string; correct_classe_id: string }[] = [];
      for (const l of allLanc) {
        const correctParent = parentMap.get(l.subclasse_id);
        if (correctParent && correctParent !== l.classe_id) {
          toFix.push({ id: l.id, correct_classe_id: correctParent });
        }
      }

      // Update in batches grouped by correct_classe_id
      const byClasse = new Map<string, string[]>();
      for (const f of toFix) {
        if (!byClasse.has(f.correct_classe_id)) byClasse.set(f.correct_classe_id, []);
        byClasse.get(f.correct_classe_id)!.push(f.id);
      }

      let fixed = 0;
      const errors: string[] = [];
      for (const [classeId, ids] of byClasse) {
        // Process in sub-batches of 500
        for (let i = 0; i < ids.length; i += 500) {
          const batch = ids.slice(i, i + 500);
          const { error } = await supabase
            .from("fin_lancamentos")
            .update({ classe_id: classeId })
            .in("id", batch);
          if (error) {
            errors.push(`${classeId}: ${error.message}`);
          } else {
            fixed += batch.length;
          }
        }
      }

      return new Response(
        JSON.stringify({ 
          total_checked: allLanc.length, 
          inconsistent: toFix.length, 
          fixed, 
          errors 
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Cleanup mode: delete all rateios and reset all to rateado
    if (body.cleanup) {
      const { error: delErr } = await supabase
        .from("fin_lancamento_rateios")
        .delete()
        .neq("id", "00000000-0000-0000-0000-000000000000");
      
      const { error: upErr } = await supabase
        .from("fin_lancamentos")
        .update({ tipo_rateio: "rateado" })
        .eq("tipo_rateio", "especifico");

      return new Response(
        JSON.stringify({ cleanup: true, delErr: delErr?.message, upErr: upErr?.message }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { matches } = body;

    if (!Array.isArray(matches) || matches.length === 0) {
      return new Response(JSON.stringify({ error: "No matches provided" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const allLancamentos: any[] = [];
    let from2 = 0;
    const PAGE2 = 1000;
    while (true) {
      const { data, error } = await supabase
        .from("fin_lancamentos")
        .select("id, data, descricao, valor")
        .eq("tipo", "despesa")
        .order("data", { ascending: true })
        .range(from2, from2 + PAGE2 - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      allLancamentos.push(...data);
      from2 += PAGE2;
      if (data.length < PAGE2) break;
    }

    const index = new Map<string, string[]>();
    for (const l of allLancamentos) {
      const key = `${l.data}|${l.descricao.toUpperCase().trim()}|${parseFloat(l.valor).toFixed(2)}`;
      if (!index.has(key)) index.set(key, []);
      index.get(key)!.push(l.id);
    }

    const usedIds = new Set<string>();
    let matched = 0;
    let unmatched = 0;
    const unmatchedSamples: string[] = [];
    const updates: { id: string; curso_id: string; valor: number }[] = [];

    for (const m of matches) {
      const key = `${m.data}|${m.descricao.toUpperCase().trim()}|${parseFloat(m.valor).toFixed(2)}`;
      const ids = index.get(key);
      if (ids) {
        const id = ids.find((i: string) => !usedIds.has(i));
        if (id) {
          usedIds.add(id);
          updates.push({ id, curso_id: m.curso_id, valor: m.valor });
          matched++;
        } else {
          unmatched++;
          if (unmatchedSamples.length < 5) unmatchedSamples.push(`DUP: ${key}`);
        }
      } else {
        unmatched++;
        if (unmatchedSamples.length < 10) unmatchedSamples.push(`MISS: ${key}`);
      }
    }

    const BATCH = 500;
    let updatedCount = 0;
    let rateioCount = 0;
    const errors: string[] = [];

    for (let i = 0; i < updates.length; i += BATCH) {
      const batch = updates.slice(i, i + BATCH);
      const ids = batch.map(b => b.id);
      
      const { error: uErr } = await supabase
        .from("fin_lancamentos")
        .update({ tipo_rateio: "especifico" })
        .in("id", ids);
      
      if (uErr) {
        errors.push(`Update batch ${Math.floor(i/BATCH)}: ${uErr.message}`);
      } else {
        updatedCount += ids.length;
      }

      const rateios = batch.map(b => ({
        lancamento_id: b.id,
        curso_id: b.curso_id,
        percentual: 100,
        valor: b.valor,
      }));

      const { error: rErr } = await supabase
        .from("fin_lancamento_rateios")
        .insert(rateios);

      if (rErr) {
        errors.push(`Rateio batch ${Math.floor(i/BATCH)}: ${rErr.message}`);
      } else {
        rateioCount += rateios.length;
      }
    }

    const sampleDbKeys: string[] = [];
    for (let i = 0; i < Math.min(5, allLancamentos.length); i++) {
      const l = allLancamentos[i];
      sampleDbKeys.push(`${l.data}|${l.descricao.toUpperCase().trim()}|${parseFloat(l.valor).toFixed(2)}`);
    }

    return new Response(
      JSON.stringify({ matched, unmatched, updatedCount, rateioCount, errors, totalLancamentos: allLancamentos.length, unmatchedSamples, sampleDbKeys }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
