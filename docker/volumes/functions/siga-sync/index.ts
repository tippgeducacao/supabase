// siga-sync
// Sincroniza SIGA -> Supabase pela API OFICIAL (docs/SIGA — API Oficial.md).
// Substitui o caminho antigo (siga-auth com Chromium + 2Captcha raspando tela).
//
// Rotas usadas — só as três que ignoram o gate de instituição da nossa chave
// (a chave é da instituição 1; os alunos vivem na 8. Ver docs/Modulo-Siga.md):
//   1) cobrancaConsultarPorPeriodo?tipoData=vencimento -> parcelas + aluno + contrato + curso/turma
//   2) matriculawebConsultarPorPeriodo                 -> ficha cadastral (RG, endereço, filiação...)
// A situação do contrato (matriculaConsultar?cpf=&tb_curso_id=) é 1 chamada por contrato e NÃO
// cabe aqui: fica no backfill, senão estoura o rate limit.
//
// Rate limit: 30 req/min POR CHAVE, contados numa janela compartilhada — backfill, cron e
// chamada manual disputam o mesmo balde ("Máximo: 30 por minuto. Você fez 30 requisições").
// Por isso o gap default é 2.2s (~27/min) e o cron gasta ~7 chamadas por rodada: sobra folga.
// Bloco que leve 429 é apenas registrado, não repetido — a janela incremental (-60d/+90d) se
// sobrepõe entre rodadas, então a rodada seguinte cobre o mesmo período de novo.
//
// Modos:
//   ?modo=incremental (default)  janela de -60d a +90d + fichas dos últimos 30d
//   ?modo=janela&ini=YYYY-MM-DD&fim=YYYY-MM-DD   janela arbitrária (backfill manual)
//   ?tipoData=vencimento|pagamento|cadastro     eixo da janela (default vencimento)
//   ?fichas=0                    pula a etapa de ficha cadastral
//
// Por que tipoData importa: varrendo só por VENCIMENTO, um pagamento feito hoje numa parcela
// que venceu há 6 meses nunca entraria. Por isso existe um cron diário com tipoData=pagamento
// cobrindo os últimos 15 dias — pega a quitação atrasada onde quer que ela esteja no tempo.
//
// Deploy: git push na main (deploy-edges.yml). NUNCA o "Deploy" do painel Dokploy.
// Envs: SIGA_API_KEY (obrigatória), SIGA_API_BASE, SIGA_SYNC_GAP_MS, SIGA_SYNC_BUDGET_MS.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const SIGA_BASE = (Deno.env.get("SIGA_API_BASE") ?? "https://ppg.sistemasiga.net/sigaAPI").replace(/\/$/, "");
const SIGA_KEY = Deno.env.get("SIGA_API_KEY") ?? "";
const GAP_MS = Number(Deno.env.get("SIGA_SYNC_GAP_MS") ?? "2200");
const BUDGET_MS = Number(Deno.env.get("SIGA_SYNC_BUDGET_MS") ?? "110000");

// ---------------------------------------------------------------- helpers de data e número
/** "dd/mm/yyyy" -> "yyyy-mm-dd"; devolve null pro que não for data. */
function brToIso(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s || s.startsWith("0000")) return null;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}
/** Date -> "dd-mm-yyyy", o formato que a API aceita na query string. */
function toApiDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d.getTime());
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}
function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).replace(/[^\d.,-]/g, "").trim();
  if (!s) return null;
  if (s.includes(".") && s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if (s.includes(",")) s = s.replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
function int(v: unknown): number | null {
  const n = parseInt(String(v ?? "").replace(/\D/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}
const txt = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s && s !== "0000-00-00" ? s : null;
};
const soDigitos = (v: unknown): string | null => {
  const s = String(v ?? "").replace(/\D/g, "");
  return s || null;
};
/**
 * ~0,9% das cobranças vêm sem nome E sem CPF: o aluno foi apagado no SIGA e a parcela ficou
 * órfã (13 alunos / 236 parcelas em 20/08/2026). Como as colunas de nome são NOT NULL e o
 * upsert é em lote, uma dessas linhas derrubava as outras 499 junto. Marca explícita para
 * ninguém confundir com cadastro de verdade.
 */
function nomeOuOrfao(c: any): string {
  return txt(c.nomeAluno) ?? txt(c.nomeResponsavelFinanceiro) ??
    `(sem cadastro no SIGA — aluno ${c.tb_aluno_id ?? "?"})`;
}

// ------------------------------------------------------------------------------ rate limit
let ultimaChamada = 0;
async function throttle() {
  const espera = ultimaChamada + GAP_MS - Date.now();
  if (espera > 0) await new Promise((r) => setTimeout(r, espera));
  ultimaChamada = Date.now();
}

interface SigaResp { ok: boolean; status: number; json: any }
async function sigaGet(path: string): Promise<SigaResp> {
  await throttle();
  try {
    const res = await fetch(SIGA_BASE + path, {
      headers: {
        "X-API-Key": SIGA_KEY,
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* deixa null */ }
    return { ok: res.ok, status: res.status, json };
  } catch (e) {
    return { ok: false, status: 0, json: { erro: e instanceof Error ? e.message : String(e) } };
  }
}

/** Janelas de 30 dias inclusivos — o teto que a API aceita por chamada. */
function blocos(ini: Date, fim: Date): Array<[Date, Date]> {
  const out: Array<[Date, Date]> = [];
  let cur = ini;
  while (cur <= fim) {
    const end = addDays(cur, 29) > fim ? fim : addDays(cur, 29);
    out.push([cur, end]);
    cur = addDays(end, 1);
  }
  return out;
}

// ------------------------------------------------------------------------------- mapeadores
function mapTitulo(c: any, agora: string) {
  return {
    siga_titulo_id: int(c.id),
    siga_contrato_id: int(c.tb_contrato_id),
    siga_aluno_id: int(c.tb_aluno_id),
    aluno_nome: nomeOuOrfao(c),
    cpf_aluno: soDigitos(c.cpfAluno),
    celular_aluno: txt(c.celularAluno),
    email_aluno: txt(c.emailAluno),
    siga_curso_id: int(c.tb_curso_id),
    curso_nome: txt(c.nomeCurso),
    siga_turma_id: int(c.tb_turma_id),
    turma_nome: txt(c.nomeTurma),
    categoria: txt(c.categoriaCobranca),
    parcela: int(String(c.numeroParcela ?? "").split("/")[0]),
    mes_referente: txt(c.mesReferente),
    ano_referente: txt(c.anoReferente),
    situacao: txt(c.situacao),
    vencimento: brToIso(c.dataVencimento),
    data_pagamento: brToIso(c.dataPagamento),
    data_recebimento: brToIso(c.dataRecebimento),
    valor: num(c.valorParcela),
    valor_previsto: num(c.valorPrevisto),
    valor_pago: num(c.valorPago),
    valor_tarifa: num(c.valorTarifa),
    forma_pagamento: txt(c.formaPagamento),
    banco_nome: txt(c.nomeBanco),
    caixa_destino: txt(c.nomeCaixaDestino),
    plano_contas: txt(c.nomePlanoContas),
    link_pagamento: txt(c.linkPagamento),
    siga_bolsa_id: int(c.tb_bolsa_id),
    bolsa_nome: txt(c.nomeBolsa),
    valor_bolsa: num(c.valorBolsa),
    resp_nome: txt(c.nomeResponsavelFinanceiro),
    resp_cpf: soDigitos(c.cpfResponsavelFinanceiro),
    resp_celular: txt(c.celularResponsavelFinanceiro),
    raw: c,
    synced_at: agora,
    api_synced_at: agora,
  };
}

function mapTurma(t: any, agora: string) {
  return {
    siga_turma_id: int(t.id),
    curso_id: int(t.id_curso),
    nome: txt(t.nome) ?? `(turma ${t.id})`,
    data_inicio: brToIso(t.data_inicio),
    data_fim: brToIso(t.data_fim),
    dias_semana: txt(t.dias_semana),
    horario_inicio: txt(t.horario_inicio),
    horario_final: txt(t.horario_final),
    turno: txt(t.turno),
    tipo: txt(t.tipo),
    instituicao_id: int(t.tb_instituicao_id),
    sala_id: int(t.tb_sala_id),
    responsavel: txt(t.responsavel),
    arquivada: String(t.arquivada ?? "0") === "1",
    bloquear_matricula: String(t.bloquearMatricula ?? "0") === "1",
    raw: t,
    synced_at: agora,
    updated_at: agora,
  };
}

function mapFicha(f: any, agora: string) {
  return {
    cpf: soDigitos(f.cpf),
    nome: txt(f.nome),
    email: txt(f.email),
    celular: txt(f.celular),
    telefone: txt(f.telefone),
    data_nascimento: brToIso(f.dataNascimento),
    rg: txt(f.rg),
    orgao_expedidor: txt(f.orgao),
    orgao_uf: txt(f.orgaoUF),
    sexo: txt(f.sexo),
    estado_civil: txt(f.estadoCivil),
    profissao: txt(f.profissao),
    escolaridade: txt(f.escolaridade),
    nacionalidade: txt(f.nacionalidade),
    naturalidade: txt(f.naturalidade),
    naturalidade_uf: txt(f.naturalidadeUF),
    cor_raca: txt(f.corRaca),
    deficiencia: txt(f.deficiencia),
    restricoes_medicas: txt(f.restricoesMedicas),
    endereco: txt(f.endereco),
    numero: txt(f.numero),
    complemento: txt(f.complemento),
    bairro: txt(f.bairro),
    cidade: txt(f.cidade),
    estado: txt(f.estado),
    cep: soDigitos(f.cep),
    mae: txt(f.mae),
    pai: txt(f.pai),
    ficha_raw: f,
    api_synced_at: agora,
  };
}

// ------------------------------------------------------------------------------------ main
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const t0 = Date.now();
  const agora = new Date().toISOString();
  const url = new URL(req.url);
  const modo = url.searchParams.get("modo") ?? "incremental";
  const comFichas = url.searchParams.get("fichas") !== "0";
  const disparadoPor = url.searchParams.get("origem") ?? "cron";
  const tipoData = ["vencimento", "pagamento", "cadastro"].includes(url.searchParams.get("tipoData") ?? "")
    ? url.searchParams.get("tipoData")!
    : "vencimento";

  if (!SIGA_KEY) {
    return new Response(JSON.stringify({ erro: "SIGA_API_KEY ausente no ambiente" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  // ---- define a janela de vencimento -------------------------------------------------
  const hoje = new Date();
  let ini: Date, fim: Date;
  if (modo === "janela") {
    const qi = url.searchParams.get("ini"), qf = url.searchParams.get("fim");
    if (!qi || !qf) {
      return new Response(JSON.stringify({ erro: "modo=janela exige ini e fim (YYYY-MM-DD)" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    ini = new Date(qi + "T00:00:00Z");
    fim = new Date(qf + "T00:00:00Z");
  } else {
    ini = addDays(hoje, -Number(url.searchParams.get("dias_atras") ?? "60"));
    fim = addDays(hoje, Number(url.searchParams.get("dias_frente") ?? "90"));
  }

  const { data: logRow } = await supabase.from("siga_sync_log").insert({
    sync_type: `api:${modo}:${tipoData}`, status: "running", triggered_by: disparadoPor, started_at: agora,
  }).select("id").single();

  let recebidas = 0, titulosUp = 0, alunosUp = 0, contratosUp = 0, turmasUp = 0;
  const erros: string[] = [];
  const contratos = new Map<number, any>();
  const alunos = new Map<number, any>();

  try {
    // ---- ETAPA 1: parcelas ------------------------------------------------------------
    for (const [a, b] of blocos(ini, fim)) {
      if (Date.now() - t0 > BUDGET_MS) { erros.push("orçamento de tempo estourado na etapa de parcelas"); break; }
      const r = await sigaGet(
        `/cobrancaConsultarPorPeriodo?tipoData=${tipoData}&dataInicial=${toApiDate(a)}&dataFinal=${toApiDate(b)}`,
      );
      if (!r.json?.sucesso) { erros.push(`${toApiDate(a)}: ${r.json?.erro ?? `HTTP ${r.status}`}`); continue; }

      const linhas: any[] = r.json.dados ?? [];
      recebidas += linhas.length;
      const titulos = linhas.map((c) => mapTitulo(c, agora)).filter((t) => t.siga_titulo_id);

      for (const c of linhas) {
        const cid = int(c.tb_contrato_id), aid = int(c.tb_aluno_id);
        if (cid && !contratos.has(cid)) {
          contratos.set(cid, {
            siga_contrato_id: cid,
            siga_aluno_id: aid,
            aluno_nome: nomeOuOrfao(c),
            cpf: soDigitos(c.cpfAluno),
            curso_id: int(c.tb_curso_id),
            curso_nome: txt(c.nomeCurso),
            turma_id: int(c.tb_turma_id),
            turma_nome: txt(c.nomeTurma),
            siga_bolsa_id: int(c.tb_bolsa_id),
            bolsa_nome: txt(c.nomeBolsa),
            synced_at: agora,
            api_synced_at: agora,
          });
        }
        if (aid && !alunos.has(aid)) {
          alunos.set(aid, {
            siga_aluno_id: aid,
            nome: nomeOuOrfao(c),
            cpf: soDigitos(c.cpfAluno),
            email: txt(c.emailAluno),
            celular: txt(c.celularAluno),
            resp_nome: txt(c.nomeResponsavelFinanceiro),
            resp_cpf: soDigitos(c.cpfResponsavelFinanceiro),
            resp_email: txt(c.emailResponsavelFinanceiro),
            resp_celular: txt(c.celularResponsavelFinanceiro),
            synced_at: agora,
            api_synced_at: agora,
          });
        }
      }

      for (let i = 0; i < titulos.length; i += 500) {
        const { error } = await supabase.from("siga_titulos_receber")
          .upsert(titulos.slice(i, i + 500), { onConflict: "siga_titulo_id" });
        if (error) erros.push(`titulos: ${error.message}`);
        else titulosUp += titulos.slice(i, i + 500).length;
      }
    }

    // ---- ETAPA 2: alunos e contratos vistos nas parcelas -------------------------------
    const alunosArr = [...alunos.values()];
    for (let i = 0; i < alunosArr.length; i += 500) {
      const { error } = await supabase.from("siga_alunos")
        .upsert(alunosArr.slice(i, i + 500), { onConflict: "siga_aluno_id" });
      if (error) erros.push(`alunos: ${error.message}`);
      else alunosUp += alunosArr.slice(i, i + 500).length;
    }
    const contratosArr = [...contratos.values()];
    for (let i = 0; i < contratosArr.length; i += 500) {
      const { error } = await supabase.from("siga_contratos")
        .upsert(contratosArr.slice(i, i + 500), { onConflict: "siga_contrato_id" });
      if (error) erros.push(`contratos: ${error.message}`);
      else contratosUp += contratosArr.slice(i, i + 500).length;
    }

    // ---- ETAPA 2b: catálogo de turmas ---------------------------------------------------
    // 1 requisição só, sem filtro. Traz turma de TODAS as instituições (turmaListar não sofre
    // o gate), inclusive as que não têm parcela nenhuma — que é o que a v_turmas_plataformas,
    // por derivar de movimento financeiro, não consegue ver.
    if (Date.now() - t0 < BUDGET_MS) {
      const rt = await sigaGet("/turmaListar");
      if (rt.json?.sucesso) {
        const turmas = (rt.json.dados ?? []).map((t: any) => mapTurma(t, agora))
          .filter((t: any) => t.siga_turma_id);
        const { error } = await supabase.from("siga_turmas")
          .upsert(turmas, { onConflict: "siga_turma_id" });
        if (error) erros.push(`turmas: ${error.message}`);
        else turmasUp = turmas.length;
      } else {
        erros.push(`turmaListar: ${rt.json?.erro ?? `HTTP ${rt.status}`}`);
      }
    }

    // ---- ETAPA 3: ficha cadastral dos cadastros recentes -------------------------------
    // Casa por CPF: matriculaweb não devolve tb_aluno_id, então o vínculo é pelo documento.
    if (comFichas && Date.now() - t0 < BUDGET_MS) {
      const fIni = modo === "janela" ? ini : addDays(hoje, -30);
      const fFim = modo === "janela" ? (fim > hoje ? hoje : fim) : hoje;
      for (const [a, b] of blocos(fIni, fFim)) {
        if (Date.now() - t0 > BUDGET_MS) { erros.push("orçamento estourado na etapa de fichas"); break; }
        const r = await sigaGet(
          `/matriculawebConsultarPorPeriodo?dataInicial=${toApiDate(a)}&dataFinal=${toApiDate(b)}`,
        );
        if (!r.json?.sucesso) { erros.push(`ficha ${toApiDate(a)}: ${r.json?.erro ?? `HTTP ${r.status}`}`); continue; }
        for (const f of (r.json.dados ?? [])) {
          const cpf = soDigitos(f.cpf);
          if (!cpf) continue;
          const { error } = await supabase.from("siga_alunos")
            .update(mapFicha(f, agora)).eq("cpf", cpf);
          if (error) erros.push(`ficha ${cpf}: ${error.message}`);
        }
      }
    }

    await supabase.from("siga_sync_log").update({
      status: erros.length ? "partial" : "ok",
      rows_received: recebidas,
      alunos_upserted: alunosUp,
      contratos_upserted: contratosUp,
      titulos_upserted: titulosUp,
      finished_at: new Date().toISOString(),
      error_message: erros.length ? erros.slice(0, 10).join(" | ") : null,
    }).eq("id", logRow?.id);

    return new Response(JSON.stringify({
      ok: true, modo,
      janela: { ini: toApiDate(ini), fim: toApiDate(fim) },
      recebidas, titulos: titulosUp, alunos: alunosUp, contratos: contratosUp, turmas: turmasUp,
      erros: erros.slice(0, 10), duracao_ms: Date.now() - t0,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabase.from("siga_sync_log").update({
      status: "error", error_message: msg, finished_at: new Date().toISOString(),
    }).eq("id", logRow?.id);
    return new Response(JSON.stringify({ ok: false, erro: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
