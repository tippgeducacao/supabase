// eduq-api-titulos
// Puxa TÍTULOS A RECEBER da API oficial do EDUQ e faz upsert em
// public.eduq_titulos_receber. Substitui o webhook do n8n (`eduq-sync-titulos`), que
// trazia só a categoria "Mensalidade", descartava os títulos de R$ 0,00 e não tinha nem
// o valor com desconto nem a data de pagamento.
//
// A consulta nasceu do ticket #13129: **Id 11 — "Consulta de Títulos a Receber"**.
//   POST /emissao-consulta-personalizada/obter-dados
//   headers: Content-Type + token-auth: <token>
//   body: {"Token": <token>, "ConsultaPersonalizada": {"Id": 11},
//          "Filtros": [{"Chave":"venc_inicio_tr_cp","Valor":"dd/mm/aaaa"},
//                      {"Chave":"venc_fim_tr_cp","Valor":"dd/mm/aaaa"},
//                      {"Chave":"situacoes_tr_cp","Valor":"1,2,3,4,5"}]}
//   resposta: {"sucesso": true, "resultado": [...]} — array JÁ parseado nesta consulta
//             (a 5 devolve STRING; esta devolve lista. Tratamos os dois.)
//
// Situações: 1 Em Aberto · 2 Liquidada (Paga) · 3 Cancelada · 4 Renegociada · 5 Restrita
//
// ⚠️ Rate limit: 1 chamada a cada 5 MINUTOS POR CONSULTA. Antes disso vem HTTP 500. Por
//    isso o backfill fatia por janela e espera entre as fatias.
// ⚠️ Capitalização: o Postman que a EDUQ mandou usa `consultaPersonalizada`/`filtros` em
//    minúsculo, mas a API exige **`ConsultaPersonalizada`/`Filtros`** com maiúscula —
//    mesma pegadinha já documentada em docs/EDUQ — API Oficial.md.
//
// Deploy: git push (deploy-edges.yml). NUNCA "Deploy" do Dokploy.
// Envs: EDUQ_API_TOKEN (obrigatória), EDUQ_API_BASE (opcional),
//       EDUQ_CONSULTA_TITULOS_ID (opcional, default 11).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-webhook-secret, x-trigger",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const EDUQ_BASE = (Deno.env.get("EDUQ_API_BASE") ?? "https://apisistema.eduqtecnologia.com.br").replace(/\/$/, "");
const EDUQ_TOKEN = Deno.env.get("EDUQ_API_TOKEN") ?? "";
const CONSULTA_ID = Number(Deno.env.get("EDUQ_CONSULTA_TITULOS_ID") ?? "11");
/** Todas as situações: sem Cancelada e Renegociada não dá para distinguir reparcelamento. */
const SITUACOES = "1,2,3,4,5";

const isoToBr = (iso: string) => {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
};
/** "2026-10-01T00:00:00" ou "01/10/2026" → "2026-10-01". */
function toIsoDate(v: unknown): string | null {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
const txt = (v: unknown) => {
  const s = v == null ? "" : String(v).trim();
  return s === "" ? null : s;
};

async function buscarTitulos(iniIso: string, fimIso: string): Promise<Record<string, unknown>[]> {
  const body = {
    Token: EDUQ_TOKEN,
    ConsultaPersonalizada: { Id: CONSULTA_ID },
    Filtros: [
      { Chave: "venc_inicio_tr_cp", Valor: isoToBr(iniIso) },
      { Chave: "venc_fim_tr_cp", Valor: isoToBr(fimIso) },
      { Chave: "situacoes_tr_cp", Valor: SITUACOES },
    ],
  };
  const res = await fetch(`${EDUQ_BASE}/emissao-consulta-personalizada/obter-dados`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "token-auth": EDUQ_TOKEN },
    body: JSON.stringify(body),
  });
  const bruto = await res.text();
  if (!res.ok) {
    // 500 aqui é quase sempre o rate limit de 5 min, não um erro de verdade.
    throw new Error(`EDUQ HTTP ${res.status}: ${bruto.slice(0, 300)}`);
  }
  let j: { sucesso?: boolean; resultado?: unknown };
  try {
    j = JSON.parse(bruto);
  } catch {
    throw new Error(`EDUQ devolveu algo que não é JSON: ${bruto.slice(0, 300)}`);
  }
  if (j.sucesso === false) throw new Error(`EDUQ sucesso=false: ${String(j.resultado).slice(0, 300)}`);
  let r: unknown = j.resultado;
  // A consulta 5 devolve o array como STRING; a 11 devolve lista. Aceitamos os dois para
  // não quebrar se a EDUQ padronizar de um lado ou do outro.
  if (typeof r === "string") {
    try { r = JSON.parse(r); } catch { throw new Error("resultado veio string e não é JSON"); }
  }
  return Array.isArray(r) ? (r as Record<string, unknown>[]) : [];
}

function paraLinha(t: Record<string, unknown>) {
  const venc = toIsoDate(t.data_vencimento);
  return {
    eduq_fatura_id: Number(t.id_fatura),
    eduq_aluno_id: t.id_aluno == null ? null : Number(t.id_aluno),
    aluno_nome: String(t.nome_aluno ?? "").trim(),
    cpf: txt(t.cpf),
    curso_nome: txt(t.curso),
    turma_nome: txt(t.turma),
    parcela: t.parcela == null ? null : Number(t.parcela),
    total_parcelas: t.total_parcelas == null ? null : Number(t.total_parcelas),
    vencimento: venc,
    data_geracao: toIsoDate(t.data_geracao),
    data_pagamento: toIsoDate(t.data_pagamento),
    situacao: txt(t.situacao),
    categoria: txt(t.categoria),
    forma_pagamento_realizada: txt(t.forma_pagamento),
    valor: num(t.valor) ?? 0,
    // O campo que motivou o ticket: é ELE que vira projeção de recebimento.
    valor_melhor_desconto: num(t.valor_fatura_com_melhor_desconto),
    fonte: "api",
    raw: t,
    synced_at: new Date().toISOString(),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const t0 = Date.now();
  try {
    if (!EDUQ_TOKEN) throw new Error("EDUQ_API_TOKEN não configurada");

    const corpo = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const hoje = new Date();
    const dias = (n: number) => {
      const d = new Date(hoje);
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    // Janela padrão: 90 dias para trás e 180 para a frente. Cobre o que vence no mês
    // corrente e o que já venceu e ainda está sendo cobrado, sem puxar a base inteira
    // a cada hora.
    const ini: string = corpo.inicio ?? dias(-90);
    const fim: string = corpo.fim ?? dias(180);

    const titulos = await buscarTitulos(ini, fim);
    const linhas = titulos
      .map(paraLinha)
      .filter((l) => Number.isFinite(l.eduq_fatura_id) && l.vencimento && l.aluno_nome);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    // Em lotes: um upsert de milhares de linhas estoura o payload do PostgREST.
    let gravadas = 0;
    const LOTE = 500;
    for (let i = 0; i < linhas.length; i += LOTE) {
      const { error } = await supabase
        .from("eduq_titulos_receber")
        .upsert(linhas.slice(i, i + LOTE), { onConflict: "eduq_fatura_id" });
      if (error) throw new Error(`upsert falhou no lote ${i / LOTE}: ${error.message}`);
      gravadas += Math.min(LOTE, linhas.length - i);
    }

    // ── Fantasmas ────────────────────────────────────────────────────────────
    // Título que ESTAVA na nossa base, está dentro da janela que acabamos de pedir e
    // NÃO voltou: foi apagado na EDUQ. Em 09/10/2026 havia 7 assim, todos "Em Aberto",
    // somando R$ 13.418,32 e colocando 5 pessoas na fila de cobrança por dívida que não
    // existe mais. Como pedimos TODAS as cinco situações, ausência aqui é ausência lá.
    //
    // Marcamos em vez de apagar: `situacao = 'Ausente na EDUQ'` sai da conta pelo
    // predicado e deixa rastro de que a linha existiu — apagar esconderia o motivo.
    const { data: sumidos } = await supabase
      .from("eduq_titulos_receber")
      .update({ situacao: "Ausente na EDUQ", synced_at: new Date().toISOString() })
      .gte("vencimento", ini).lte("vencimento", fim)
      .lt("synced_at", new Date(t0).toISOString())
      .neq("situacao", "Ausente na EDUQ")
      .select("eduq_fatura_id");

    return new Response(JSON.stringify({
      ok: true, janela: { inicio: ini, fim: fim },
      ausentes_na_eduq: (sumidos ?? []).length,
      recebidos: titulos.length, gravados: gravadas,
      descartados: titulos.length - linhas.length,
      com_melhor_desconto: linhas.filter((l) => l.valor_melhor_desconto != null).length,
      duracao_ms: Date.now() - t0,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ ok: false, erro: msg, duracao_ms: Date.now() - t0 }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
