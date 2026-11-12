// eduq-api-bloqueados
// Puxa a consulta 7 da API oficial do EDUQ — "ALUNOS BLOQUEADOS POR INADIMPLÊNCIA" — e grava
// em public.eduq_api_bloqueados, completando o cadastro acadêmico (`eduq_alunos`) de quem
// está devendo. Entrou em 12/11/2026 no lugar dos dois fluxos do n8n que traziam o cadastro
// do aluno (`busca-alunos-ativos-eduq`, chamado pela `sync-alunos-ativos`, e
// `eduq-sync-alunos`), parados desde 08/10/2026. Sem eles, quem se matriculou depois caía na
// fila de cobrança "(curso não identificado)", "sem telefone", e o Vincular não tinha
// telefone/e-mail para sugerir o contato — sobravam os homônimos (relato da Kawane).
//
//   POST /emissao-consulta-personalizada/obter-dados
//   headers: Content-Type + token-auth: <token>
//   body: {"Token": <token>, "ConsultaPersonalizada": {"Id": 7},
//          "Filtros": [{"Chave": "dias_atraso_min_cp", "Valor": "1"}]}
//   colunas (varredura de 05/11/2026): id_aluno, nome_aluno, cpf, contato, curso, turma,
//          dias_em_atraso, quantidade_parcelas_atraso, valor_em_aberto, motivo_bloqueio,
//          data_bloqueio_sugerida
//
// ⚠️ `contato` pode vir mascarado, como na consulta 4 ("(85)*****-***4"). Mascarado nunca vira
//    telefone/e-mail; fica só em `contato_bruto`, para se conferir o que a EDUQ mandou.
// ⚠️ Rate limit: 1 chamada a cada 5 minutos. O cron é :20/:50, longe das outras chamadas à
//    EDUQ (:00/:30 consultas 5 e 11; :10/:40 documentos) e 5 min antes do sync da fila (:25).
//
// Deploy: git push (deploy-edges.yml). NUNCA "Deploy" do Dokploy.
// Envs: EDUQ_API_TOKEN (obrigatória), EDUQ_API_BASE (opcional),
//       EDUQ_CONSULTA_BLOQUEADOS_ID (opcional, default 7).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { exigirAcesso, respostaAcessoNegado } from "../_shared/acesso.ts";
import { type ItemBloqueado, paraItem } from "./mapear.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-webhook-secret, x-trigger",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const EDUQ_BASE = (Deno.env.get("EDUQ_API_BASE") ?? "https://apisistema.eduqtecnologia.com.br").replace(/\/$/, "");
const EDUQ_TOKEN = Deno.env.get("EDUQ_API_TOKEN") ?? "";
const CONSULTA_ID = Number(Deno.env.get("EDUQ_CONSULTA_BLOQUEADOS_ID") ?? "7");

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

async function buscarBloqueados(diasMin: number): Promise<Record<string, unknown>[]> {
  const body = {
    Token: EDUQ_TOKEN,
    ConsultaPersonalizada: { Id: CONSULTA_ID },
    Filtros: [{ Chave: "dias_atraso_min_cp", Valor: String(diasMin) }],
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
  // A consulta 5 devolve o array como STRING; a 11, como lista. Aceitamos os dois.
  if (typeof r === "string") {
    try { r = JSON.parse(r); } catch { throw new Error("resultado veio string e não é JSON"); }
  }
  return Array.isArray(r) ? (r as Record<string, unknown>[]) : [];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Só o sistema (cron eduq-api-bloqueados-30min): a consulta gasta a cota da EDUQ e grava
  // contato de aluno.
  try {
    await exigirAcesso(req, { servico: true });
  } catch (e) {
    return respostaAcessoNegado(e, corsHeaders);
  }

  const t0 = Date.now();
  try {
    if (!EDUQ_TOKEN) throw new Error("EDUQ_API_TOKEN não configurada");
    const corpo = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const diasMin = Number.isFinite(Number(corpo.dias_atraso_min)) ? Number(corpo.dias_atraso_min) : 1;

    const linhas = await buscarBloqueados(diasMin);
    const itens = linhas.map(paraItem).filter((i): i is ItemBloqueado => i !== null);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );
    const { data, error } = await supabase.rpc("eduq_api_bloqueados_upsert", { p_itens: itens });
    if (error) throw new Error(`eduq_api_bloqueados_upsert: ${error.message}`);

    return json({
      ok: true,
      consulta_id: CONSULTA_ID,
      recebidas: linhas.length,
      descartadas: linhas.length - itens.length,
      // Nomes de coluna da 1ª linha: é como se confere, sem ler dado de aluno, se a EDUQ
      // mudou o formato da consulta.
      colunas: linhas.length ? Object.keys(linhas[0]) : [],
      ...(data as Record<string, unknown>),
      duracao_ms: Date.now() - t0,
    });
  } catch (e) {
    return json({ ok: false, erro: e instanceof Error ? e.message : String(e), duracao_ms: Date.now() - t0 }, 500);
  }
});
