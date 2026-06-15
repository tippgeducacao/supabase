// Edge Function: email-campaign-dispatcher
// Roda a cada 1min via cron. Para cada campanha 'agendada' (com agendada_para <= now())
// ou 'enviando' (continuar), popula envios pendentes, envia em lote com throttle,
// atualiza contadores. Respeita 'pausada' / 'cancelada'.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const WHITELIST: Record<string, { emailCol: string; nomeCol: string; campos: string[] }> = {
  profiles: { emailCol: "email", nomeCol: "nome", campos: ["ativo", "departamento_id", "user_type", "nivel", "setor"] },
  ped_professores: { emailCol: "email", nomeCol: "nome", campos: ["ativo", "status"] },
  alunos: { emailCol: "email", nomeCol: "nome", campos: ["status", "curso_id"] },
  leads: { emailCol: "email", nomeCol: "nome", campos: ["status", "etapa", "origem"] },
};
const OPS = new Set(["eq","neq","in","contains","gt","lt","is_null","is_not_null"]);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function applyFiltros(q: any, filtros: any[], campos: string[]) {
  for (const f of filtros) {
    if (!campos.includes(f.campo) || !OPS.has(f.operador)) continue;
    switch (f.operador) {
      case "eq": q = q.eq(f.campo, f.valor); break;
      case "neq": q = q.neq(f.campo, f.valor); break;
      case "in": q = q.in(f.campo, Array.isArray(f.valor) ? f.valor : [f.valor]); break;
      case "contains": q = q.ilike(f.campo, `%${f.valor}%`); break;
      case "gt": q = q.gt(f.campo, f.valor); break;
      case "lt": q = q.lt(f.campo, f.valor); break;
      case "is_null": q = q.is(f.campo, null); break;
      case "is_not_null": q = q.not(f.campo, "is", null); break;
    }
  }
  return q;
}

async function resolverSegmento(supabase: any, segmento: any): Promise<Array<{ email: string; nome: string | null; metadata: any }>> {
  if (segmento.tipo === "estatico") {
    return (segmento.contatos_estaticos ?? []).map((c: any) => ({
      email: c.email, nome: c.nome ?? null, metadata: c.metadata ?? null,
    })).filter((c: any) => c.email);
  }
  const q = segmento.query_dinamica;
  if (!q?.tabela || !WHITELIST[q.tabela]) return [];
  const cfg = WHITELIST[q.tabela];
  let sb = supabase.from(q.tabela).select(`${cfg.emailCol}, ${cfg.nomeCol}`).limit(10000);
  sb = applyFiltros(sb, q.filtros ?? [], cfg.campos);
  const { data } = await sb;
  return (data ?? [])
    .filter((r: any) => r[cfg.emailCol])
    .map((r: any) => ({ email: r[cfg.emailCol], nome: r[cfg.nomeCol] ?? null, metadata: null }));
}

async function processarCampanha(supabase: any, campanha: any) {
  // Carrega segmento se ainda não populou envios
  const { count: jaTem } = await supabase
    .from("email_campanhas_envios")
    .select("*", { count: "exact", head: true })
    .eq("campanha_id", campanha.id);

  if ((jaTem ?? 0) === 0) {
    const { data: seg } = await supabase.from("email_segmentos").select("*").eq("id", campanha.segmento_id).single();
    const contatos = await resolverSegmento(supabase, seg);
    if (contatos.length === 0) {
      await supabase.from("email_campanhas").update({
        status: "enviada", concluida_em: new Date().toISOString(), total_destinatarios: 0,
      }).eq("id", campanha.id);
      return;
    }
    // dedupe por email
    const seen = new Set<string>();
    const unicos = contatos.filter(c => { if (seen.has(c.email)) return false; seen.add(c.email); return true; });
    const rows = unicos.map(c => ({
      campanha_id: campanha.id, contato_email: c.email, contato_nome: c.nome, contato_metadata: c.metadata, status: "pendente",
    }));
    // insert em chunks de 500
    for (let i = 0; i < rows.length; i += 500) {
      await supabase.from("email_campanhas_envios").insert(rows.slice(i, i + 500));
    }
    await supabase.from("email_campanhas").update({
      total_destinatarios: unicos.length,
      status: "enviando",
      iniciada_em: campanha.iniciada_em ?? new Date().toISOString(),
    }).eq("id", campanha.id);
    campanha.total_destinatarios = unicos.length;
  } else if (campanha.status === "agendada") {
    await supabase.from("email_campanhas").update({
      status: "enviando", iniciada_em: campanha.iniciada_em ?? new Date().toISOString(),
    }).eq("id", campanha.id);
  }

  // Lote de até 50 envios pendentes
  const { data: pendentes } = await supabase
    .from("email_campanhas_envios")
    .select("*")
    .eq("campanha_id", campanha.id)
    .eq("status", "pendente")
    .limit(50);

  if (!pendentes || pendentes.length === 0) {
    // Finaliza
    const { count: rest } = await supabase
      .from("email_campanhas_envios")
      .select("*", { count: "exact", head: true })
      .eq("campanha_id", campanha.id)
      .eq("status", "pendente");
    if ((rest ?? 0) === 0) {
      await supabase.from("email_campanhas").update({
        status: "enviada", concluida_em: new Date().toISOString(),
      }).eq("id", campanha.id);
    }
    return;
  }

  let enviadosBatch = 0; let falhadosBatch = 0;
  for (const envio of pendentes) {
    // Re-check status (pode ter sido pausada/cancelada)
    const { data: cur } = await supabase.from("email_campanhas").select("status").eq("id", campanha.id).single();
    if (!cur || cur.status === "pausada" || cur.status === "cancelada") break;

    try {
      const sendRes = await fetch(`${SUPABASE_URL}/functions/v1/email-send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
        body: JSON.stringify({
          template_id: campanha.template_id,
          remetente_id: campanha.remetente_id,
          destinatario_email: envio.contato_email,
          destinatario_nome: envio.contato_nome,
          variaveis: { nome: envio.contato_nome ?? "", email: envio.contato_email, ...(envio.contato_metadata ?? {}) },
          contexto_tipo: "campanha",
          contexto_id: campanha.id,
        }),
      });
      const j = await sendRes.json();
      if (sendRes.ok && j.ok !== false) {
        await supabase.from("email_campanhas_envios").update({
          status: "enviado", enviado_em: new Date().toISOString(), email_enviado_id: j.log_id ?? null,
        }).eq("id", envio.id);
        enviadosBatch++;
      } else {
        await supabase.from("email_campanhas_envios").update({
          status: "falhou", erro: JSON.stringify(j).slice(0, 500),
        }).eq("id", envio.id);
        falhadosBatch++;
        // Se 429, pausa
        if (sendRes.status === 429) {
          await supabase.from("email_campanhas").update({ status: "pausada", ultimo_erro: "Rate limit Gmail (429)" }).eq("id", campanha.id);
          break;
        }
      }
    } catch (e) {
      await supabase.from("email_campanhas_envios").update({
        status: "falhou", erro: e instanceof Error ? e.message : String(e),
      }).eq("id", envio.id);
      falhadosBatch++;
    }
    await sleep(campanha.throttle_ms ?? 150);
  }

  // Update counters via RPC-like atomic increment
  if (enviadosBatch || falhadosBatch) {
    const { data: cAtual } = await supabase.from("email_campanhas").select("enviados, falhados").eq("id", campanha.id).single();
    await supabase.from("email_campanhas").update({
      enviados: (cAtual?.enviados ?? 0) + enviadosBatch,
      falhados: (cAtual?.falhados ?? 0) + falhadosBatch,
    }).eq("id", campanha.id);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const agora = new Date().toISOString();

    const { data: agendadas } = await supabase
      .from("email_campanhas")
      .select("*")
      .in("status", ["agendada", "enviando"])
      .or(`agendada_para.is.null,agendada_para.lte.${agora}`)
      .limit(5);

    const resultados: any[] = [];
    for (const c of agendadas ?? []) {
      try {
        await processarCampanha(supabase, c);
        resultados.push({ id: c.id, ok: true });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await supabase.from("email_campanhas").update({ ultimo_erro: msg }).eq("id", c.id);
        resultados.push({ id: c.id, ok: false, error: msg });
      }
    }

    return new Response(JSON.stringify({ ok: true, processadas: resultados.length, resultados }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
