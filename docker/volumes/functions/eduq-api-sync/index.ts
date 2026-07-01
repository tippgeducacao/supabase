// eduq-api-sync
// Puxa PAGAMENTOS RECEBIDOS da API oficial do EDUQ (Consulta Personalizada) e enche a fila
// public.eduq_api_recebimentos (que vira fin_lancamento ao ser aprovada na tela "Integração
// EDUQ API"). Espelha a siga-api-sync.
//
// API do EDUQ: POST /emissao-consulta-personalizada/obter-dados
//   headers: Content-Type + token-auth: <token>
//   body: {"Token": <token>, "ConsultaPersonalizada": {"Id": 5},
//          "Filtros": [{"Chave":"data_inicio_cp","Valor":"dd/mm/aaaa"}, ...]}
//   resposta: {"sucesso": true, "resultado": "<array JSON como STRING>"}
// ⚠️ Rate limit: 1 chamada a cada 5 MINUTOS por consulta (erro 500 se antes).
// ⚠️ O EDUQ NÃO devolve caixa nem data de repasse (o banco é resolvido na aprovação:
//    default SICOOB + override).
//
// Deploy: git push (deploy-edges.yml). NUNCA "Deploy" do Dokploy.
// Envs (Dokploy edge-runtime): EDUQ_API_TOKEN (obrigatória), EDUQ_API_BASE (opcional),
//   EDUQ_CONSULTA_PAGAMENTOS_ID (opcional, default 5).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, cache-control, pragma",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const EDUQ_BASE = (Deno.env.get("EDUQ_API_BASE") ?? "https://apisistema.eduqtecnologia.com.br").replace(/\/$/, "");
const EDUQ_TOKEN = Deno.env.get("EDUQ_API_TOKEN") ?? "";
const CONSULTA_PAGAMENTOS_ID = Number(Deno.env.get("EDUQ_CONSULTA_PAGAMENTOS_ID") ?? "5");

function isoToBr(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}
/** "2026-05-01T00:00:00" ou "01/05/2026" -> "2026-05-01" (ISO date) */
function toIsoDate(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

async function fetchPagamentos(iniIso: string, fimIso: string) {
  const body = {
    Token: EDUQ_TOKEN,
    ConsultaPersonalizada: { Id: CONSULTA_PAGAMENTOS_ID },
    Filtros: [
      { Chave: "data_inicio_cp", Valor: isoToBr(iniIso) },
      { Chave: "data_fim_cp", Valor: isoToBr(fimIso) },
      { Chave: "curso_ids_cp", Valor: "" },
      { Chave: "aluno_id_cp", Valor: "" },
      { Chave: "formas_pagamento_cp", Valor: "" },
    ],
  };
  let res: Response;
  try {
    res = await fetch(EDUQ_BASE + "/emissao-consulta-personalizada/obter-dados", {
      method: "POST",
      headers: { "Content-Type": "application/json", "token-auth": EDUQ_TOKEN },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`fetch EDUQ falhou: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  let j: any = null;
  try { j = JSON.parse(text); } catch { /* deixa null */ }
  if (!res.ok || !j?.sucesso) {
    const msg = j?.inconsistencia ?? j?.mensagem ?? String(text).slice(0, 200);
    if (/5 minutos/i.test(String(msg))) {
      throw new Error("O EDUQ limita esta consulta a 1 chamada a cada 5 minutos. Aguarde e tente de novo.");
    }
    throw new Error(`EDUQ retornou erro: HTTP ${res.status} — ${msg}`);
  }
  // resultado vem como STRING contendo o array JSON
  let arr: any[] = [];
  const rr = j.resultado;
  if (Array.isArray(rr)) arr = rr;
  else if (typeof rr === "string" && rr.trim()) arr = JSON.parse(rr);
  return arr;
}

function normalize(it: any) {
  const ref = `${it.id_fatura ?? ""}-${it.id_pagamento ?? ""}`;
  return {
    eduq_ref: ref,
    id_pagamento: it.id_pagamento != null ? String(it.id_pagamento) : null,
    id_fatura: it.id_fatura != null ? String(it.id_fatura) : null,
    id_aluno: it.id_aluno != null ? String(it.id_aluno) : null,
    aluno_nome: it.nome_aluno ?? null,
    curso_nome: it.curso ?? null,
    turma_nome: it.turma ?? null,
    forma_pagamento: it.forma_pagamento ?? null,
    valor_original: num(it.valor_original),
    valor_pago: num(it.valor_pago),
    juros_multa: num(it.juros_multa),
    desconto_aplicado: num(it.desconto_aplicado),
    parcela_referente: it.parcela_referente != null ? Number(it.parcela_referente) : null,
    data_vencimento: toIsoDate(it.data_vencimento),
    data_pagamento: toIsoDate(it.data_pagamento),
    raw: it,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!EDUQ_TOKEN) return json({ success: false, error: "EDUQ_API_TOKEN não configurada no edge-runtime (Dokploy)." }, 400);
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return json({ success: false, error: "Não autenticado." }, 401);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  try {
    const body = await req.json().catch(() => ({}));
    const inicio: string = body.inicio, fim: string = body.fim;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(inicio ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(fim ?? "")) {
      return json({ success: false, error: "Informe 'inicio' e 'fim' em ISO (YYYY-MM-DD)." }, 400);
    }

    const items = await fetchPagamentos(inicio, fim);
    // dedup por eduq_ref (último vence)
    const map = new Map<string, ReturnType<typeof normalize>>();
    for (const it of items) {
      const n = normalize(it);
      if (n.eduq_ref && n.eduq_ref !== "-") map.set(n.eduq_ref, n);
    }
    const rows = Array.from(map.values());

    if (rows.length > 0) {
      const { error } = await supabase.rpc("eduq_api_sync_upsert", {
        p_items: rows, p_periodo_inicio: inicio, p_periodo_fim: fim,
      });
      if (error) throw new Error(`eduq_api_sync_upsert: ${error.message}`);
    }
    return json({ success: true, total: rows.length, periodo: { inicio, fim } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[eduq-api-sync]", message);
    return json({ success: false, error: message }, 500);
  }
});
