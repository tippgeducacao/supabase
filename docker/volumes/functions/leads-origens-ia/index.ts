// leads-origens-ia — "Análise IA" da Gestão de Leads (22/09/2026).
//
// Lê o pacote de números da RPC `leads_v4_analise_origens` COMO O USUÁRIO (o JWT
// dele vai junto, então a RPC barra quem não está logado), pré-calcula as taxas
// e os custos aqui — a IA não faz conta, só lê — e pede ao Claude um diagnóstico
// de marketing estruturado: o que vai bem, o que preocupa, onde pôr (ou tirar)
// verba e o que falta rastrear.
//
// ⚠️ Só números agregados saem daqui para a Anthropic: nenhum nome, telefone ou
// e-mail de lead. A RPC nem devolve dado pessoal.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const MODELOS = ["claude-opus-5-5", "claude-sonnet-5"];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function adminClient() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

async function getAnthropicKey(): Promise<string | null> {
  try {
    const { data } = await adminClient()
      .from("ai_api_keys")
      .select("api_key")
      .eq("provider", "anthropic")
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data?.api_key) return data.api_key as string;
  } catch (_) { /* fallback */ }
  return Deno.env.get("ANTHROPIC_API_KEY") ?? null;
}

// ── nomes legíveis (espelho de lib/leadsV4/painel.ts) ─────────────────────────
const SUB: Record<string, string> = {
  metaads_form: "METAADS › Formulário instantâneo",
  metaads_lp_instagram: "METAADS › Anúncio → LP (Instagram)",
  metaads_lp_facebook: "METAADS › Anúncio → LP (Facebook)",
  metaads_lp_rede: "METAADS › Anúncio → LP (rede não identificada)",
  campanha_direta: "CAMPANHA DIRETA (Click-to-WhatsApp)",
  google_utm: "GOOGLE › Com UTM (Google Ads)",
  google_ref: "GOOGLE › Veio do Google para o site (busca orgânica)",
  tiktok_ads: "TIKTOK › Anúncio",
  tiktok_perfil: "TIKTOK › Perfil/bio",
  tiktok_sem_marca: "TIKTOK › Sem marca de tráfego",
  indicacao: "INDICAÇÃO",
  organico_captacao: "ORGÂNICOS › Captação do time (SDR)",
  organico_declarado: "ORGÂNICOS › Declarado no cadastro",
  sem_utm_pagina: "SEM UTM › Formulário de página sem UTM",
  sem_utm_atendimento: "SEM UTM › Atendimento no WhatsApp",
  sem_utm_manual: "SEM UTM › Cadastro manual",
  sem_utm_form_meta: "SEM UTM › Formulário Meta sem marca",
  sem_utm_compartilhado: "SEM UTM › Contato compartilhado",
  sem_utm_webchat: "SEM UTM › Webchat",
  sem_utm_antigo: "SEM UTM › Base antiga",
  sem_utm_outro: "SEM UTM › Sem rastro nenhum",
};
const nomeSub = (s: string) =>
  SUB[s] ??
  (s.startsWith("link_bio") ? `LINK NA BIO › ${s.replace("link_bio_", "")}` :
   s.startsWith("linkedin") ? `LINKEDIN › ${s.replace("linkedin_", "")}` :
   s.startsWith("whatsapp_") ? `GRUPOS DE WHATSAPP › ${s.replace("whatsapp_", "")}` : s);
const NAT: Record<string, string> = { pago: "MÍDIA PAGA", organico: "ORGÂNICO", sem_rastro: "SEM RASTRO" };

const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(2)}%` : "—");
const brl = (v: number) =>
  `R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const custo = (verba: number, n: number) => (n > 0 ? brl(verba / n) : "—");

interface LinhaSub {
  periodo: "atual" | "anterior";
  natureza: string | null;
  mae: string;
  sub: string;
  leads: number;
  qualificados: number;
  leads_de_curso: number;
  agendaram: number;
  compareceram: number;
  converteram: number;
}

function montarContexto(d: any): string {
  const subs: LinhaSub[] = d.por_sub ?? [];
  const atual = subs.filter((s) => s.periodo === "atual");
  const ant = subs.filter((s) => s.periodo === "anterior");
  const mat: { sub: string; natureza: string | null; n: number }[] = d.matriculas_assinadas_por_sub ?? [];
  const matDe = (f: (s: string) => boolean) => mat.filter((m) => f(m.sub)).reduce((a, m) => a + m.n, 0);
  const v = d.verba ?? {};

  const soma = (ls: LinhaSub[], k: keyof LinhaSub) => ls.reduce((a, l) => a + Number(l[k] ?? 0), 0);
  const linhas: string[] = [];

  // 1) naturezas
  linhas.push("## 1. Por natureza (leads que CHEGARAM no período; reunião/venda deles a qualquer tempo)");
  linhas.push("natureza | leads | período anterior | qualificados | agendaram | compareceram | venderam (safra) | matrículas assinadas no período");
  for (const nat of ["pago", "organico", "sem_rastro"]) {
    const a = atual.filter((l) => l.natureza === nat);
    const p = ant.filter((l) => l.natureza === nat);
    linhas.push(
      `${NAT[nat]} | ${soma(a, "leads")} | ${soma(p, "leads")} | ${pct(soma(a, "qualificados"), soma(a, "leads"))} | ` +
      `${soma(a, "agendaram")} (${pct(soma(a, "agendaram"), soma(a, "leads"))}) | ${soma(a, "compareceram")} | ` +
      `${soma(a, "converteram")} | ${mat.filter((m) => m.natureza === nat).reduce((x, m) => x + m.n, 0)}`,
    );
  }

  // 2) sub-origens
  linhas.push("\n## 2. Por sub-origem (período atual; entre parênteses, leads do período anterior)");
  linhas.push("sub-origem | natureza | leads (ant.) | % qualificados | % leads de curso (resto é isca/RH/aquecimento) | agendaram | taxa lead→reunião | compareceram | venderam (safra) | matrículas assinadas no período");
  const chaves = [...new Set(subs.map((s) => s.sub))];
  const tabela = chaves.map((k) => {
    const a = atual.find((l) => l.sub === k);
    const p = ant.find((l) => l.sub === k);
    return { k, a, p };
  }).sort((x, y) => (y.a?.leads ?? 0) - (x.a?.leads ?? 0));
  for (const { k, a, p } of tabela) {
    const n = a?.leads ?? 0;
    linhas.push(
      `${nomeSub(k)} | ${NAT[a?.natureza ?? p?.natureza ?? ""] ?? "?"} | ${n} (${p?.leads ?? 0}) | ` +
      `${pct(a?.qualificados ?? 0, n)} | ${pct(a?.leads_de_curso ?? 0, n)} | ${a?.agendaram ?? 0} | ` +
      `${pct(a?.agendaram ?? 0, n)} | ${a?.compareceram ?? 0} | ${a?.converteram ?? 0} | ${matDe((s) => s === k)}`,
    );
  }

  // 3) dinheiro
  const leadsMeta = atual.filter((l) => l.mae === "metaads" || l.mae === "campanha_direta");
  const leadsGoogle = atual.filter((l) => l.sub === "google_utm");
  const matMeta = matDe((s) => s.startsWith("metaads") || s === "campanha_direta");
  const matGoogle = matDe((s) => s === "google_utm");
  const vm = Number(v.meta ?? 0), vg = Number(v.google ?? 0);
  linhas.push("\n## 3. Verba e custo (verba do período ÷ resultado do período)");
  linhas.push("plataforma | verba | verba período anterior | leads | CPL | reuniões agendadas | custo por reunião | matrículas assinadas | CAC");
  linhas.push(
    `Meta (inclui campanha direta) | ${brl(vm)} | ${brl(Number(v.meta_anterior ?? 0))} | ${soma(leadsMeta, "leads")} | ` +
    `${custo(vm, soma(leadsMeta, "leads"))} | ${soma(leadsMeta, "agendaram")} | ${custo(vm, soma(leadsMeta, "agendaram"))} | ${matMeta} | ${custo(vm, matMeta)}`,
  );
  linhas.push(
    `Google Ads | ${brl(vg)} | ${brl(Number(v.google_anterior ?? 0))} | ${soma(leadsGoogle, "leads")} | ` +
    `${custo(vg, soma(leadsGoogle, "leads"))} | ${soma(leadsGoogle, "agendaram")} | ${custo(vg, soma(leadsGoogle, "agendaram"))} | ${matGoogle} | ${custo(vg, matGoogle)}`,
  );
  linhas.push(`TikTok Ads | verba NÃO ingerida no sistema | — | ${soma(atual.filter((l) => l.sub === "tiktok_ads"), "leads")} | — | — | — | ${matDe((s) => s === "tiktok_ads")} | —`);

  // 4) tipo de cadastro
  linhas.push("\n## 4. Tipo de cadastro dentro dos 'leads' (heurística pelo nome do webhook/página)");
  linhas.push("natureza | tipo | leads | agendaram | venderam");
  for (const t of d.por_tipo ?? []) {
    linhas.push(`${NAT[t.natureza] ?? t.natureza} | ${t.tipo} | ${t.leads} | ${t.agendaram} | ${t.converteram}`);
  }
  linhas.push("(lead_curso = pediu informação de pós/curso; isca = aula gratuita, e-book, cronograma, acesso à escola; rh_candidato = candidato a vaga; aquecimento = cadastro para aquecer número de WhatsApp; nao_e_lead = cobrança/migração)");

  return linhas.join("\n");
}

const SISTEMA = `Você é o(a) analista sênior de marketing de performance da PPGVET Educação — pós-graduação e cursos para médicos-veterinários e zootecnistas (bovinos, aves, suínos, qualidade de alimentos/POA, saúde única, pets). A venda é consultiva: o lead agenda uma reunião com um vendedor, comparece e depois assina a matrícula (mediana de ~19 dias da reunião à assinatura).

Você escreve para o DIRETOR, que não acompanha jargão técnico: fale pelo efeito no negócio (quanto custa uma matrícula, onde o dinheiro rende, onde está vazando). Termos como CPL/CAC podem aparecer, mas sempre com o significado em palavras na primeira vez.

Regras de leitura dos dados (obrigatórias):
- "venderam (safra)" do período atual é IMATURO: leads recentes ainda não tiveram tempo de fechar. Para comparar origens use a taxa lead→reunião e o comparecimento, e para dinheiro use "matrículas assinadas no período".
- MÍDIA PAGA, ORGÂNICO e SEM RASTRO são a natureza da origem. SEM RASTRO não é orgânico: boa parte é anúncio que perdeu a UTM no caminho (principalmente "Formulário de página sem UTM").
- Isca (aula, e-book, cronograma) e candidato de RH NÃO são demanda de curso; se inflarem uma origem, diga.
- Não invente número. Use apenas os números fornecidos; ao citar percentual ou valor em R$, use SEMPRE 2 casas decimais (ex.: 12,50%, R$ 1.788,37). Contagens ficam inteiras.
- Seja concreto: cada recomendação diz O QUE fazer, com qual origem/canal, e por quê (com o número que sustenta).
- Português do Brasil.`;

const FERRAMENTA = {
  name: "entregar_analise",
  description: "Entrega a análise de marketing das origens de leads.",
  input_schema: {
    type: "object",
    properties: {
      resumo: { type: "string", description: "3 a 4 frases: o retrato do período para o diretor." },
      indo_bem: {
        type: "array",
        items: {
          type: "object",
          properties: { titulo: { type: "string" }, detalhe: { type: "string" } },
          required: ["titulo", "detalhe"],
        },
        description: "2 a 4 origens/canais que estão rendendo, com o número que prova.",
      },
      atencao: {
        type: "array",
        items: {
          type: "object",
          properties: { titulo: { type: "string" }, detalhe: { type: "string" } },
          required: ["titulo", "detalhe"],
        },
        description: "2 a 5 pontos preocupantes (verba sem retorno, queda, lead ruim).",
      },
      investimento: {
        type: "array",
        items: {
          type: "object",
          properties: {
            acao: { type: "string", description: "o que fazer, no imperativo" },
            porque: { type: "string" },
            prioridade: { type: "string", enum: ["alta", "media", "baixa"] },
          },
          required: ["acao", "porque", "prioridade"],
        },
        description: "3 a 6 dicas de investimento: onde aumentar, manter, reduzir ou testar verba.",
      },
      rastreamento: {
        type: "array",
        items: {
          type: "object",
          properties: { problema: { type: "string" }, como_corrigir: { type: "string" } },
          required: ["problema", "como_corrigir"],
        },
        description: "O que está mal medido e atrapalha a decisão (UTM faltando, verba não ingerida, cadastro que não é lead).",
      },
      falta_analisar: {
        type: "array",
        items: { type: "string" },
        description: "2 a 4 perguntas que os dados ainda não respondem e valeria medir.",
      },
    },
    required: ["resumo", "indo_bem", "atencao", "investimento", "rastreamento", "falta_analisar"],
  },
};

async function chamarClaude(apiKey: string, contexto: string, periodo: any) {
  let ultimoErro = "";
  for (const model of MODELOS) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 120_000);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 4000,
          system: SISTEMA,
          tools: [FERRAMENTA],
          tool_choice: { type: "tool", name: "entregar_analise" },
          messages: [{
            role: "user",
            content:
              `Período analisado: ${periodo.de} a ${periodo.ate} (${periodo.dias} dias). ` +
              `Período anterior de comparação: ${periodo.anterior_de} a ${periodo.anterior_ate}.\n\n${contexto}`,
          }],
        }),
      });
      if (!res.ok) {
        ultimoErro = `${model}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`;
        // modelo indisponível → tenta o próximo; erro de chave/limite não adianta repetir
        if (res.status === 404 || res.status === 400) continue;
        throw new Error(ultimoErro);
      }
      const body = await res.json();
      const uso = body.content?.find((c: any) => c.type === "tool_use");
      if (!uso?.input) throw new Error(`${model}: resposta sem análise estruturada`);
      return { analise: uso.input, modelo: model };
    } finally {
      clearTimeout(t);
    }
  }
  throw new Error(ultimoErro || "nenhum modelo respondeu");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ ok: false, error: "Não autenticado" }, 401);

    // cliente COMO O USUÁRIO: a RPC checa auth.uid() e roda com as permissões dele
    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    const { data: u } = await supa.auth.getUser();
    if (!u?.user) return json({ ok: false, error: "Não autenticado" }, 401);

    const { de, ate } = await req.json().catch(() => ({}));
    const ok = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
    if (!ok(de) || !ok(ate)) return json({ ok: false, error: "Período inválido" }, 400);

    const { data, error } = await supa.rpc("leads_v4_analise_origens", { p_de: de, p_ate: ate });
    if (error) return json({ ok: false, error: `Falha ao ler os números: ${error.message}` }, 500);

    const apiKey = await getAnthropicKey();
    if (!apiKey) return json({ ok: false, error: "Chave da Anthropic não configurada" }, 500);

    const contexto = montarContexto(data);
    const { analise, modelo } = await chamarClaude(apiKey, contexto, data.periodo);
    return json({ ok: true, periodo: data.periodo, analise, modelo, gerado_em: new Date().toISOString() });
  } catch (e) {
    console.error("[leads-origens-ia]", e);
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
