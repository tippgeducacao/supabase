// siga-api-sync
// Puxa RECEBIMENTOS da API REST oficial do SIGA e enche a fila public.siga_api_recebimentos
// (que vira fin_lancamento ao ser aprovada na tela "Integração SIGA API").
//
// Fluxo:
//   1) GET /sigaAPI/cobrancaConsultarPorPeriodo (tipoData=pagamento, situacao=quitado)
//      -> lista de cobranças quitadas no período (aluno, valor, datas). Janela <= 30 dias.
//   2) upsert BASE imediato (linhas aparecem mesmo se o passo 3 estourar o tempo).
//   3) ENRIQUECE curso/caixa (a API NÃO traz no por-período):
//        cobrancaConsultar/{id}  -> fk_contrato_id + nomeCaixaDestino (caixa)
//        matriculaConsultar/{id} -> tb_curso_id
//        cursoConsultar (cache)  -> id -> nome do curso
//      respeitando o rate limit (30 req/min) e um orçamento de tempo.
//   4) upsert do que enriqueceu.
//
// Decisões: valor BRUTO (a API não devolve taxa/repasse); o lançamento só nasce na APROVAÇÃO.
// Auth: invocada pelo front com o JWT do usuário -> o client é user-scoped, então a RPC
// siga_api_sync_upsert (gate is_financial_user) só roda pra usuário do Financeiro.
//
// Deploy: git push (GitHub Actions deploy-edges.yml). NUNCA o "Deploy" do Dokploy.
// Envs (Dokploy edge-runtime): SIGA_API_KEY (obrigatória), SIGA_API_BASE (opcional),
//   SIGA_API_RATE_PER_MIN (opcional, default 28), SIGA_API_SYNC_BUDGET_MS (opcional, default 110000).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, cache-control, pragma",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SIGA_BASE = (Deno.env.get("SIGA_API_BASE") ?? "https://ppg.sistemasiga.net/sigaAPI").replace(/\/$/, "");
const SIGA_KEY = Deno.env.get("SIGA_API_KEY") ?? "";

// O SIGA fica atrás da Cloudflare (proteção anti-bot): uma chamada "crua" recebe a página
// "Just a moment..." (HTTP 403). Mandar cabeçalhos de navegador costuma passar pelo Bot
// Fight Mode. Se mesmo assim vier 403/desafio, o IP do servidor precisa ser liberado na
// Cloudflare do SIGA (ação do lado deles).
function sigaHeaders(): Record<string, string> {
  return {
    "X-API-Key": SIGA_KEY,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  };
}
/** Detecta a página de desafio da Cloudflare. */
function isCloudflareChallenge(status: number, text: string): boolean {
  return (status === 403 || status === 503 || status === 429) &&
    /just a moment|cf-browser-verification|challenge-platform|cloudflare|attention required/i.test(text);
}
const RATE_PER_MIN = Math.max(1, Number(Deno.env.get("SIGA_API_RATE_PER_MIN") ?? "28"));
const MIN_GAP_MS = Math.ceil(60000 / RATE_PER_MIN);
const BUDGET_MS = Number(Deno.env.get("SIGA_API_SYNC_BUDGET_MS") ?? "110000");

// ---- helpers de data/número ------------------------------------------------
function isoToBr(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}
/** ISO -> "dd-mm-yyyy" (1 segmento de path, formato que o SIGA pede). */
function isoToDash(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso;
}
/** ISO -> "dd/mm/yyyy" (vira 3 segmentos de path). */
function isoToSlashSegs(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}
function brToIso(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);     // já ISO (pode ter hora)
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);             // dd/mm/yyyy
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
function parseNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).replace(/[^\d.,-]/g, "").trim();
  if (!s) return null;
  if (s.includes(".") && s.includes(",")) s = s.replace(/\./g, "").replace(",", "."); // 1.500,00
  else if (s.includes(",")) s = s.replace(",", ".");                                   // 300,00
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// ---- rate limiter (gap mínimo entre chamadas ao SIGA) ----------------------
let lastCallAt = 0;
async function throttle() {
  const wait = lastCallAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

interface SigaResp { ok: boolean; status: number; json: any; text: string }
async function sigaGet(path: string, query?: Record<string, string>): Promise<SigaResp> {
  await throttle();
  const url = new URL(SIGA_BASE + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v != null && v !== "") url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetch(url.toString(), { headers: sigaHeaders() });
  } catch (e) {
    return { ok: false, status: 0, json: null, text: `fetch error: ${e instanceof Error ? e.message : String(e)}` };
  }
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* deixa null */ }
  return { ok: res.ok, status: res.status, json, text };
}

/**
 * O SIGA pede as datas no PATH (a própria API respondeu: "Use dd-mm-yyyy … em dois
 * segmentos, ou seis segmentos /dia/mês/ano/dia/mês/ano"). tipoData/situacao podem ir
 * como segmento OU query — tentamos as variações até uma devolver `sucesso:true`.
 */
async function fetchPeriodo(iniIso: string, fimIso: string, tipoData: string, situacao: string) {
  const iniD = isoToDash(iniIso), fimD = isoToDash(fimIso);          // dd-mm-yyyy (2 segmentos)
  const iniS = isoToSlashSegs(iniIso), fimS = isoToSlashSegs(fimIso); // dd/mm/yyyy (6 segmentos)
  const tp = encodeURIComponent(tipoData), si = encodeURIComponent(situacao);
  const qs = `?tipoData=${tp}&situacao=${si}`;

  // Formato RECOMENDADO pelo SIGA p/ o nosso ambiente (suporte 2026-06-29): datas em 6
  // segmentos /dia/mês/ano/dia/mês/ano + tipoData/situacao como SEGMENTOS de path (o
  // servidor do SIGA descarta a query string). Os demais ficam como fallback.
  const candidatos: { url: string; form: string }[] = [
    { url: `/cobrancaConsultarPorPeriodo/${iniS}/${fimS}/${tp}/${si}`, form: "path-6seg-seg" },
    { url: `/cobrancaConsultarPorPeriodo/${iniS}/${fimS}${qs}`,        form: "path-6seg-qs" },
    { url: `/cobrancaConsultarPorPeriodo/${iniD}/${fimD}/${tp}/${si}`, form: "path-dash-seg" },
    { url: `/cobrancaConsultarPorPeriodo/${iniD}/${fimD}${qs}`,        form: "path-dash-qs" },
  ];

  const erros: string[] = [];
  for (const c of candidatos) {
    const r = await sigaGet(c.url);
    if (isCloudflareChallenge(r.status, r.text)) {
      throw new Error(
        "O SIGA está protegido por Cloudflare e bloqueou o nosso servidor (página \"Just a moment…\"). " +
        "É preciso LIBERAR o IP do servidor na Cloudflare do SIGA (allowlist / bypass de WAF para /sigaAPI/*).",
      );
    }
    // sucesso = envelope sucesso:true OU HTTP 200 com array em dados
    if ((r.json?.sucesso === true || r.ok) && Array.isArray(r.json?.dados)) {
      return { items: r.json.dados as any[], form: c.form };
    }
    const detalhe = r.json?.erro ?? r.json?.mensagem ?? String(r.text).slice(0, 120);
    erros.push(`${c.form}: HTTP ${r.status} ${detalhe}`);
  }
  throw new Error(`cobrancaConsultarPorPeriodo falhou em todos os formatos — ${erros.join(" | ")}`);
}

async function fetchCursos(): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  const r = await sigaGet("/cursoConsultar");
  if (r.ok && Array.isArray(r.json?.dados)) {
    for (const c of r.json.dados) if (c?.id != null) m.set(String(c.id), String(c.nome ?? ""));
  }
  return m;
}

function normalizeBase(it: any, tipoData: string) {
  // A resposta REAL do período já traz curso, caixa, aluno e contrato — não precisa enriquecer.
  const alunoId = it.tb_aluno_id ?? it.fk_aluno_id;
  const contratoId = it.tb_contrato_id ?? it.fk_contrato_id;
  return {
    siga_cobranca_id: String(it.id),
    fk_aluno_id: alunoId != null ? String(alunoId) : null,
    aluno_nome: it.nomeAluno ?? null,
    fk_contrato_id: contratoId != null ? String(contratoId) : null,
    curso_nome: it.nomeCurso ?? null,
    caixa_nome: it.nomeCaixaDestino ?? null,
    forma_pagamento: it.formaPagamento ?? null,
    situacao: it.situacao ?? null,
    valor_parcela: parseNum(it.valorParcela),
    valor_pago: parseNum(it.valorPago),
    valor_previsto: parseNum(it.valorPrevisto),
    data_vencimento: brToIso(it.dataVencimento),
    data_pagamento: brToIso(it.dataPagamento ?? it.dataPagamentoAntecipado),
    data_recebimento: brToIso(it.dataRecebimento), // data REAL do crédito (PJBank); "" -> null
    tipo_data: tipoData,
    raw: it,
  };
}

async function enrich(siga_id: string, cursoMap: Map<string, string>): Promise<{ fk_contrato_id: string | null; caixa_nome: string | null; curso_nome: string | null }> {
  const out = { fk_contrato_id: null as string | null, caixa_nome: null as string | null, curso_nome: null as string | null };
  const u = await sigaGet(`/cobrancaConsultar/${encodeURIComponent(siga_id)}`);
  const d = u.json?.dados ?? {};
  if (d.fk_contrato_id != null) out.fk_contrato_id = String(d.fk_contrato_id);
  if (d.nomeCaixaDestino) out.caixa_nome = String(d.nomeCaixaDestino);
  if (out.fk_contrato_id) {
    const m = await sigaGet(`/matriculaConsultar/${encodeURIComponent(out.fk_contrato_id)}`);
    const tbCurso = m.json?.dados?.tb_curso_id;
    if (tbCurso != null) out.curso_nome = cursoMap.get(String(tbCurso)) ?? null;
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const startedAt = Date.now();
  const timeLeft = () => BUDGET_MS - (Date.now() - startedAt);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  if (!SIGA_KEY) {
    return json({ success: false, error: "SIGA_API_KEY não configurada no edge-runtime (Dokploy). Defina a env e recrie o serviço functions." }, 400);
  }

  // Client com o JWT do usuário -> a RPC (gate is_financial_user) roda no contexto dele.
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return json({ success: false, error: "Não autenticado." }, 401);
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  try {
    const body = await req.json().catch(() => ({}));
    const inicio: string = body.inicio;
    const fim: string = body.fim;
    const tipoData: string = body.tipoData ?? "pagamento";
    const situacao: string = body.situacao ?? "quitado";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(inicio ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(fim ?? "")) {
      return json({ success: false, error: "Informe 'inicio' e 'fim' em ISO (YYYY-MM-DD)." }, 400);
    }

    // 1) lista do período
    const { items, form } = await fetchPeriodo(inicio, fim, tipoData, situacao);

    // dedup local por id (último vence)
    const baseMap = new Map<string, ReturnType<typeof normalizeBase>>();
    for (const it of items) {
      if (it?.id == null) continue;
      baseMap.set(String(it.id), normalizeBase(it, tipoData));
    }
    const baseItems = Array.from(baseMap.values());

    // 2) upsert base imediato (resiliência: linhas aparecem mesmo se o passo 3 cortar)
    if (baseItems.length > 0) {
      const { error } = await supabase.rpc("siga_api_sync_upsert", {
        p_items: baseItems, p_periodo_inicio: inicio, p_periodo_fim: fim,
      });
      if (error) throw new Error(`siga_api_sync_upsert (base): ${error.message}`);
    }

    // 3) enriquecimento (curso/caixa) dentro do orçamento de tempo
    let cursoMap = new Map<string, string>();
    if (baseItems.length > 0 && timeLeft() > MIN_GAP_MS * 3) {
      cursoMap = await fetchCursos();
    }
    const enriquecidos: ReturnType<typeof normalizeBase>[] = [];
    let pulados = 0;
    for (const item of baseItems) {
      // precisa de curso (sempre) e/ou caixa (se não veio na base)
      const faltaCaixa = !item.caixa_nome;
      if (!faltaCaixa && item.curso_nome) continue; // já completo (raro)
      if (timeLeft() < MIN_GAP_MS * 2) { pulados++; continue; }
      try {
        const e = await enrich(item.siga_cobranca_id, cursoMap);
        if (e.fk_contrato_id) item.fk_contrato_id = e.fk_contrato_id;
        if (e.caixa_nome) item.caixa_nome = e.caixa_nome;
        if (e.curso_nome) item.curso_nome = e.curso_nome;
        enriquecidos.push(item);
      } catch {
        pulados++;
      }
    }

    // 4) upsert dos enriquecidos (item COMPLETO — não pode mandar parcial, senão zera colunas)
    if (enriquecidos.length > 0) {
      const { error } = await supabase.rpc("siga_api_sync_upsert", {
        p_items: enriquecidos, p_periodo_inicio: inicio, p_periodo_fim: fim,
      });
      if (error) throw new Error(`siga_api_sync_upsert (enriquecido): ${error.message}`);
    }

    return json({
      success: true,
      total: baseItems.length,
      enriquecidos: enriquecidos.length,
      pulados,
      periodo: { inicio, fim, tipoData, situacao },
      path_form: form,
      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[siga-api-sync]", message);
    return json({ success: false, error: message }, 500);
  }
});
