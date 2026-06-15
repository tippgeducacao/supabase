// Edge Function: email-segmento-preview
// Valida regras dinâmicas contra whitelist e retorna { contagem, amostra }.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface Filtro { campo: string; operador: string; valor: unknown }
interface Query { tabela: string; filtros: Filtro[] }

// Whitelist: tabela -> { emailCol, nomeCol, camposFiltraveis: Set }
const WHITELIST: Record<string, { emailCol: string; nomeCol: string; campos: string[] }> = {
  profiles: { emailCol: "email", nomeCol: "nome", campos: ["ativo", "departamento_id", "user_type", "nivel", "setor"] },
  ped_professores: { emailCol: "email", nomeCol: "nome", campos: ["ativo", "status"] },
  alunos: { emailCol: "email", nomeCol: "nome", campos: ["status", "curso_id"] },
  leads: { emailCol: "email", nomeCol: "nome", campos: ["status", "etapa", "origem"] },
};

const OPERADORES = new Set(["eq", "neq", "in", "contains", "gt", "lt", "is_null", "is_not_null"]);

function applyFiltros(query: any, filtros: Filtro[], camposPermitidos: string[]) {
  for (const f of filtros) {
    if (!camposPermitidos.includes(f.campo)) throw new Error(`campo não permitido: ${f.campo}`);
    if (!OPERADORES.has(f.operador)) throw new Error(`operador inválido: ${f.operador}`);
    switch (f.operador) {
      case "eq": query = query.eq(f.campo, f.valor); break;
      case "neq": query = query.neq(f.campo, f.valor); break;
      case "in": query = query.in(f.campo, Array.isArray(f.valor) ? f.valor : [f.valor]); break;
      case "contains": query = query.ilike(f.campo, `%${f.valor}%`); break;
      case "gt": query = query.gt(f.campo, f.valor); break;
      case "lt": query = query.lt(f.campo, f.valor); break;
      case "is_null": query = query.is(f.campo, null); break;
      case "is_not_null": query = query.not(f.campo, "is", null); break;
    }
  }
  return query;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { query } = (await req.json()) as { query: Query };
    if (!query?.tabela || !WHITELIST[query.tabela]) throw new Error("tabela não permitida");
    const cfg = WHITELIST[query.tabela];

    let countQ = supabase.from(query.tabela).select("*", { count: "exact", head: true });
    countQ = applyFiltros(countQ, query.filtros ?? [], cfg.campos);
    const { count, error: cErr } = await countQ;
    if (cErr) throw cErr;

    let sampleQ = supabase.from(query.tabela).select(`${cfg.emailCol}, ${cfg.nomeCol}`).limit(5);
    sampleQ = applyFiltros(sampleQ, query.filtros ?? [], cfg.campos);
    const { data: amostra, error: sErr } = await sampleQ;
    if (sErr) throw sErr;

    return new Response(JSON.stringify({
      contagem: count ?? 0,
      amostra: (amostra ?? []).map((r: any) => ({ email: r[cfg.emailCol], nome: r[cfg.nomeCol] })),
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
