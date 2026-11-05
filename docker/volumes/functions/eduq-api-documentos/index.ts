// eduq-api-documentos
// Puxa os DOCUMENTOS DOS ALUNOS da API oficial da EDUQ e faz upsert em
// public.eduq_aluno_documentos (05/11/2026). É o que leva ao Portal da IES o documento a documento
// (RG, diploma, histórico…) que o aluno sobe em "Meus Documentos" no portal do aluno da EDUQ.
//
// ⚠️ DORMENTE até a EDUQ criar a consulta. Ela foi pedida (texto em docs/EDUQ — API Oficial.md ›
//    "Documentos dos alunos"). Para LIGAR, basta gravar o Id que a EDUQ devolver — sem deploy:
//      insert into public.eduq_api_config (chave, valor) values ('consulta_documentos_id', '<Id>')
//      on conflict (chave) do update set valor = excluded.valor, atualizado_em = now();
//    Se a consulta exigir filtros com outros nomes, grave-os em 'consulta_documentos_filtros' como
//    JSON {"chave_cp": "valor"} (filtro sem uso vai como "", nunca omitido — ver o doc da API).
//
// Mesmo endpoint e mesmas pegadinhas da consulta 11 (eduq-api-titulos):
//   POST /emissao-consulta-personalizada/obter-dados, token no header `token-auth` E no corpo,
//   `ConsultaPersonalizada`/`Filtros` com maiúscula, `resultado` como lista OU string com JSON.
// ⚠️ Rate limit: 1 chamada a cada 5 MINUTOS POR CONSULTA (vem HTTP 500). O cron roda de 30 em 30.
//
// Deploy: git push (deploy-edges.yml). NUNCA "Deploy" do Dokploy.
// Envs: EDUQ_API_TOKEN (obrigatória), EDUQ_API_BASE (opcional).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { exigirAcesso, respostaAcessoNegado } from "../_shared/acesso.ts";
import { linhasDoEnvelope, paraDocumento, semRepetir } from "./mapear.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const EDUQ_BASE = (Deno.env.get("EDUQ_API_BASE") ?? "https://apisistema.eduqtecnologia.com.br").replace(/\/$/, "");
const EDUQ_TOKEN = Deno.env.get("EDUQ_API_TOKEN") ?? "";

/** Os filtros pedidos no chamado. Vazio = sem filtro = base inteira. */
const FILTROS_PADRAO: Record<string, string> = {
  curso_ids_cp: "",
  turma_montada_ids_cp: "",
  cpf_cp: "",
  data_atualizacao_inicio_cp: "",
  data_atualizacao_fim_cp: "",
};

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function buscar(consultaId: number, filtros: Record<string, string>) {
  const res = await fetch(`${EDUQ_BASE}/emissao-consulta-personalizada/obter-dados`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "token-auth": EDUQ_TOKEN },
    body: JSON.stringify({
      Token: EDUQ_TOKEN,
      ConsultaPersonalizada: { Id: consultaId },
      Filtros: Object.entries(filtros).map(([Chave, Valor]) => ({ Chave, Valor: Valor ?? "" })),
    }),
  });
  const bruto = await res.text();
  // 500 aqui é quase sempre o rate limit de 5 min (ou filtro faltando), não queda da EDUQ.
  if (!res.ok) throw new Error(`EDUQ HTTP ${res.status}: ${bruto.slice(0, 300)}`);
  try {
    return linhasDoEnvelope(JSON.parse(bruto));
  } catch (e) {
    if (e instanceof SyntaxError) throw new Error(`EDUQ devolveu algo que não é JSON: ${bruto.slice(0, 300)}`);
    throw e;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Só o sistema (cron eduq-api-documentos-30min): cada chamada gasta a janela de 5 min da consulta.
  try {
    await exigirAcesso(req, { servico: true });
  } catch (e) {
    return respostaAcessoNegado(e, corsHeaders);
  }

  const t0 = Date.now();
  const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
  const registrar = (resultado: Record<string, unknown>) =>
    supabase.from("eduq_api_config").upsert({
      chave: "documentos_ultima_execucao",
      valor: JSON.stringify({ ...resultado, em: new Date().toISOString() }),
      atualizado_em: new Date().toISOString(),
    }, { onConflict: "chave" });

  try {
    const { data: cfg, error: errCfg } = await supabase
      .from("eduq_api_config")
      .select("chave, valor")
      .in("chave", ["consulta_documentos_id", "consulta_documentos_filtros"]);
    if (errCfg) throw new Error(`config: ${errCfg.message}`);
    const valor = (k: string) => cfg?.find((c) => c.chave === k)?.valor ?? null;

    const consultaId = Number(valor("consulta_documentos_id"));
    if (!Number.isInteger(consultaId) || consultaId <= 0) {
      return json({ ok: true, dormente: true, motivo: "consulta da EDUQ ainda não configurada (eduq_api_config.consulta_documentos_id)" });
    }
    if (!EDUQ_TOKEN) throw new Error("EDUQ_API_TOKEN não configurada");

    let filtros = FILTROS_PADRAO;
    const filtrosCfg = valor("consulta_documentos_filtros");
    if (filtrosCfg) {
      try { filtros = JSON.parse(filtrosCfg); } catch { throw new Error("consulta_documentos_filtros não é JSON"); }
    }
    const completa = Object.values(filtros).every((v) => !v);

    const linhas = await buscar(consultaId, filtros);
    const validos = linhas.map(paraDocumento).filter((d): d is NonNullable<typeof d> => d !== null);
    const docs = semRepetir(validos);
    const agora = new Date().toISOString();

    let gravados = 0;
    const LOTE = 500;
    for (let i = 0; i < docs.length; i += LOTE) {
      const lote = docs.slice(i, i + LOTE).map((d) => ({ ...d, visto_em: agora, ausente_desde: null }));
      const { error } = await supabase.from("eduq_aluno_documentos").upsert(lote, { onConflict: "chave" });
      if (error) throw new Error(`upsert falhou no lote ${i / LOTE}: ${error.message}`);
      gravados += lote.length;
    }

    // Sumiu da EDUQ: marca, não apaga (deixa rastro). Só numa busca COMPLETA e que trouxe linhas —
    // resposta vazia por instabilidade não pode zerar a base.
    let ausentes = 0;
    if (completa && docs.length > 0) {
      const { data } = await supabase
        .from("eduq_aluno_documentos")
        .update({ ausente_desde: agora })
        .lt("visto_em", new Date(t0).toISOString())
        .is("ausente_desde", null)
        .select("chave");
      ausentes = (data ?? []).length;
    }

    const resultado = {
      ok: true, consulta_id: consultaId, recebidas: linhas.length, gravados,
      descartadas_sem_cpf_ou_tipo: linhas.length - validos.length,
      repetidas: validos.length - docs.length,
      ausentes_marcados: ausentes, duracao_ms: Date.now() - t0,
    };
    await registrar(resultado);
    return json(resultado);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await registrar({ ok: false, erro: msg, duracao_ms: Date.now() - t0 });
    return json({ ok: false, erro: msg, duracao_ms: Date.now() - t0 }, 500);
  }
});
