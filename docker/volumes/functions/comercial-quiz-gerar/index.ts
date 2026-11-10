// comercial-quiz-gerar — quiz dos Materiais de Venda gerado sozinho para pós nova (10/11/2026).
//
// Pedido do usuário: "quando uma pós nova é postada o quiz seja feito e apareça lá".
// Cada chamada roda UM lote numa pós:
//   1. escolhe a pós (card ativo em comercial_cursos + ficha em comercial_programa_data + sem
//      quiz feito à mão) — regras em _shared/comercialQuizGeracao.ts;
//   2. monta o material: a ficha de venda, o script (se houver) e, do Pedagógico, as aulas e os
//      professores da pós. Ficha curta demais = "sem_conteudo" (a IA inventaria) e espera;
//   3. a IA escreve até 20 perguntas de múltipla escolha SÓ com o que está no material;
//   4. conferência ÀS CEGAS: outra chamada responde cada pergunta sem o gabarito, só com o
//      material; fica só a que ela acertou (método que mais achou erro na Academy, 05/10);
//   5. grava (gerada_por_ia = true); com 40 a aba "Quiz" liga; para em 100.
//
// Portas: cron de 10 em 10 min (segredo do Vault no cabeçalho x-comercial-quiz-cron-secret —
// a chave de serviço do banco NÃO é a do runtime, ver docs/SECURITY.md 14/10) ou admin
// comercial logado (is_comercial_admin), que pode mandar { program_id } para forçar uma pós.
// Nunca mexe em quiz de origem 'manual' (os 16 de 28/09).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/cors.ts";
import { exigirAcesso, respostaAcessoNegado } from "../_shared/acesso.ts";
import {
  CATEGORIAS, MAX_LOTES, MIN_FICHA_CHARS, TRAVA_MINUTOS,
  aprovadasNaCega, escolherPrograma, estadoDepoisDoLote, fichaSemVisual, motivoParaPular,
  normalizarQuestoes, tamanhoDoLote,
  type Candidato, type ConfigQuiz, type QuestaoIA, type QuestaoPronta,
} from "../_shared/comercialQuizGeracao.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODELO = Deno.env.get("COMERCIAL_QUIZ_MODEL") ?? "claude-opus-5-5";
const MAX_MATERIAL_CHARS = 150_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function embaralhar<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// deno-lint-ignore no-explicit-any
type Db = any;

async function chaveAnthropic(db: Db): Promise<string> {
  const { data, error } = await db
    .from("ai_api_keys")
    .select("api_key")
    .eq("provider", "anthropic")
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("Erro ao ler a chave da Anthropic: " + error.message);
  if (!data?.api_key) throw new Error("Nenhuma chave Anthropic ativa em ai_api_keys (/ia-config).");
  return data.api_key as string;
}

async function chamarIA(
  apiKey: string,
  sistema: string,
  pedido: string,
  schema: Record<string, unknown>,
  esforco: "low" | "medium",
  maxTokens: number,
  timeoutMs: number,
): Promise<unknown> {
  const signal = AbortSignal.timeout(timeoutMs);
  const chamar = (comReserva: boolean) =>
    fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        ...(comReserva ? { "anthropic-beta": "server-side-fallback-2026-07-01" } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: maxTokens,
        ...(comReserva ? { fallbacks: "default" } : {}),
        output_config: { effort: esforco, format: { type: "json_schema", schema } },
        system: sistema,
        messages: [{ role: "user", content: pedido }],
      }),
    });
  let res = await chamar(true);
  if (res.status === 400) {
    const txt = await res.clone().text();
    if (/fallback/i.test(txt)) res = await chamar(false);
  }
  if (!res.ok) throw new Error(`IA ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const msg = await res.json();
  if (msg.stop_reason === "refusal") throw new Error("A IA recusou o pedido.");
  if (msg.stop_reason === "max_tokens") throw new Error("A resposta da IA foi cortada (max_tokens).");
  const texto = (msg.content ?? [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("");
  return JSON.parse(texto);
}

const SCHEMA_GERAR = {
  type: "object",
  properties: {
    questoes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          pergunta: { type: "string" },
          opcoes: { type: "array", items: { type: "string" } },
          correta: { type: "integer" },
          explicacao: { type: "string" },
          categoria: { type: "string", enum: [...CATEGORIAS] },
        },
        required: ["pergunta", "opcoes", "correta", "explicacao", "categoria"],
        additionalProperties: false,
      },
    },
  },
  required: ["questoes"],
  additionalProperties: false,
};

const SCHEMA_CEGA = {
  type: "object",
  properties: {
    respostas: {
      type: "array",
      items: {
        type: "object",
        properties: { n: { type: "integer" }, alternativa: { type: "string", enum: ["a", "b", "c", "d", "nenhuma"] } },
        required: ["n", "alternativa"],
        additionalProperties: false,
      },
    },
  },
  required: ["respostas"],
  additionalProperties: false,
};

const SISTEMA_GERAR =
  "Você escreve o quiz de treinamento dos VENDEDORES (SDRs e closers) da PPGVet, empresa de " +
  "pós-graduação para médicos-veterinários, zootecnistas, agrônomos e profissionais do agro. " +
  "O quiz prova que o vendedor domina o produto que vai vender: o que a pós é, para quem é, " +
  "módulos e conteúdo, professores, dores do público, perguntas da abordagem (SPIN) e argumentos " +
  "de fechamento/objeções.\n\n" +
  "Regras:\n" +
  "- Português do Brasil, claro e direto.\n" +
  "- Exatamente 4 alternativas e UMA única correta.\n" +
  "- Use SÓ fatos que estão no MATERIAL. Nunca invente número, preço, duração, nome, título ou " +
  "instituição. Se o material não diz, não pergunte.\n" +
  "- A alternativa certa não repete afirmação exagerada nem conduta antiética com o lead " +
  "(pressão, escassez encenada, esconder informação). Prefira a conduta consultiva.\n" +
  "- Prefira aplicação ('o lead diz X; qual o melhor argumento?') a decoreba solta.\n" +
  "- Alternativas erradas plausíveis, do MESMO tamanho e tom da certa (a certa não pode ser a " +
  "mais longa nem a mais detalhada de propósito). Nada de 'todas/nenhuma das anteriores' nem " +
  "negação dupla.\n" +
  "- 'explicacao': 1 ou 2 frases dizendo por que a certa está certa, com base no material.\n" +
  "- 'categoria': Produto (o que é, para quem, formato), Módulos (conteúdo), Professores, " +
  "Dores (público e problemas), Script (abordagem/SPIN), Fechamento (objeções, argumentos). " +
  "Use Script/Fechamento só se o material tiver abordagem, SPIN, objeções ou argumentos.\n" +
  "- Cubra o material inteiro, sem repetir ponto nem reescrever pergunta que já existe.";

const SISTEMA_CEGA =
  "Você é um vendedor recém-contratado fazendo uma prova sobre o produto. Responda cada " +
  "pergunta usando SOMENTE o MATERIAL fornecido (não use conhecimento de fora). Para cada uma, " +
  "devolva a letra da alternativa correta. Devolva 'nenhuma' quando o material não sustentar " +
  "nenhuma alternativa OU quando mais de uma alternativa for defensável pelo material.";

type Professor = {
  nome: string;
  titulacao: string | null;
  cargo_atual: string | null;
  mini_curriculo: string | null;
  bio_curta: string | null;
};

async function montarMaterial(
  db: Db,
  nome: string,
  cursoId: string | null,
  program: Record<string, unknown>,
  script: unknown,
): Promise<{ texto: string; fichaChars: number }> {
  const ficha = fichaSemVisual(program);
  const fichaTxt = JSON.stringify(ficha, null, 1);
  const partes = [`# Pós-graduação: ${nome}`, `## Ficha de venda (Materiais de Venda)\n${fichaTxt}`];
  let fichaChars = fichaTxt.length;
  if (script && typeof script === "object" && Object.keys(script as object).length) {
    const s = JSON.stringify(script, null, 1);
    fichaChars += s.length;
    partes.push(`## Script de venda\n${s}`);
  }

  if (cursoId) {
    const { data: pos } = await db.from("ped_pos_graduacoes").select("id").eq("curso_comercial_id", cursoId);
    const posIds = (pos ?? []).map((p: { id: string }) => p.id);
    if (posIds.length) {
      const { data: aulas } = await db
        .from("ped_aulas")
        .select("titulo, modulo, ementa, tipo_aula, cancelada")
        .in("pos_graduacao_id", posIds)
        .limit(400);
      const vistas = new Set<string>();
      const linhas: string[] = [];
      for (const a of aulas ?? []) {
        if (a.cancelada || !a.titulo || /pr[eé]-?abertura/i.test(a.titulo)) continue;
        const chave = String(a.titulo).toLowerCase().trim();
        if (vistas.has(chave)) continue;
        vistas.add(chave);
        const ementa = a.ementa ? ` — ${String(a.ementa).slice(0, 400)}` : "";
        linhas.push(`- [${a.modulo ?? "Aula"}] ${a.titulo}${ementa}`);
      }
      if (linhas.length) partes.push(`## Aulas cadastradas no Pedagógico\n${linhas.join("\n")}`);

      const { data: vinc } = await db.from("ped_professor_cursos").select("professor_id").in("pos_graduacao_id", posIds);
      const profIds = [...new Set((vinc ?? []).map((v: { professor_id: string }) => v.professor_id))];
      if (profIds.length) {
        const { data: profs } = await db
          .from("ped_professores")
          .select("nome, titulacao, cargo_atual, mini_curriculo, bio_curta, ativo")
          .in("id", profIds);
        const ps = ((profs ?? []) as (Professor & { ativo: boolean | null })[])
          .filter((p) => p.ativo !== false && p.nome)
          .map((p) => {
            const bio = (p.mini_curriculo || p.bio_curta || "").slice(0, 600);
            return `- ${p.nome}${p.titulacao ? ` (${p.titulacao})` : ""}${p.cargo_atual ? ` — ${p.cargo_atual}` : ""}${bio ? `: ${bio}` : ""}`;
          });
        if (ps.length) partes.push(`## Professores da pós (cadastro do Pedagógico)\n${ps.join("\n")}`);
      }
    }
  }
  return { texto: partes.join("\n\n").slice(0, MAX_MATERIAL_CHARS), fichaChars };
}

async function contarAtivas(db: Db, programId: string): Promise<number> {
  const { count, error } = await db
    .from("comercial_quiz_perguntas")
    .select("id", { count: "exact", head: true })
    .eq("program_id", programId)
    .eq("ativa", true);
  if (error) throw error;
  return count ?? 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // Porta 1: o cron (segredo do Vault). Porta 2: admin comercial logado.
  let porCron = false;
  const segredo = req.headers.get("x-comercial-quiz-cron-secret");
  if (segredo) {
    const { data: ok } = await db.rpc("comercial_quiz_validar_cron", { p_segredo: segredo });
    porCron = ok === true;
  }
  if (!porCron) {
    try {
      await exigirAcesso(req, { usuario: true, rpcPermissao: "is_comercial_admin" });
    } catch (e) {
      return respostaAcessoNegado(e, corsHeaders);
    }
  }

  const body = await req.json().catch(() => ({}));
  const pedido = typeof body?.program_id === "string" ? body.program_id.trim() : "";
  const agora = new Date();
  let travado: string | null = null;

  try {
    // 1. Candidatas: card ativo + ficha com program.id.
    const { data: cursos, error: eCursos } = await db
      .from("comercial_cursos").select("slug, nome, curso_id").eq("ativo", true);
    if (eCursos) throw eCursos;
    const porSlug = new Map((cursos ?? []).map((c: { slug: string; nome: string; curso_id: string | null }) => [c.slug, c]));
    const { data: fichas, error: eFichas } = await db
      .from("comercial_programa_data").select("slug, program, script, updated_at")
      .in("slug", [...porSlug.keys()]);
    if (eFichas) throw eFichas;
    const { data: configs, error: eCfg } = await db.from("comercial_quiz_config").select("*");
    if (eCfg) throw eCfg;
    const cfgPorId = new Map((configs ?? []).map((c: ConfigQuiz & { program_id: string }) => [c.program_id, c]));

    // deno-lint-ignore no-explicit-any
    const fichaPorId = new Map<string, any>();
    const cands: Candidato[] = [];
    for (const f of fichas ?? []) {
      const pid = typeof f.program?.id === "string" ? f.program.id.trim() : "";
      if (!pid || fichaPorId.has(pid)) continue;
      fichaPorId.set(pid, f);
      cands.push({
        programId: pid,
        slug: f.slug,
        nome: porSlug.get(f.slug)?.nome ?? f.slug,
        fichaAtualizadaEm: f.updated_at,
        config: (cfgPorId.get(pid) as ConfigQuiz | undefined) ?? null,
      });
    }

    let alvo: Candidato | null;
    if (pedido) {
      alvo = cands.find((c) => c.programId === pedido || c.slug === pedido) ?? null;
      if (!alvo) return json({ ok: false, error: "Pós não encontrada (card ativo com ficha de venda)." }, 404);
      const motivo = motivoParaPular(alvo, agora, true);
      if (motivo) return json({ ok: true, pulado: motivo, program_id: alvo.programId });
    } else {
      alvo = escolherPrograma(cands, agora);
      if (!alvo) return json({ ok: true, nada_a_fazer: true });
    }

    // 2. Trava (cria a config na 1ª vez, desligada; a aba só liga com 40).
    const pid = alvo.programId;
    const ficha = fichaPorId.get(pid);
    const agoraIso = agora.toISOString();
    if (!alvo.config) {
      const { error } = await db.from("comercial_quiz_config").insert({
        program_id: pid,
        title: `Quiz — ${alvo.nome}`,
        description:
          `Avaliação de domínio do produto, público, módulos, professores e argumentos de venda da ${alvo.nome}. ` +
          "Perguntas escritas pela IA a partir da ficha de venda e conferidas automaticamente.",
        ativo: false,
        origem: "automatico",
        geracao_status: "gerando",
        geracao_tentada_em: agoraIso,
      });
      if (error) throw error;
    } else {
      const limite = new Date(agora.getTime() - TRAVA_MINUTOS * 60_000).toISOString();
      const zerarLotes = alvo.config.geracao_lotes >= MAX_LOTES;
      const { data: pegou, error } = await db
        .from("comercial_quiz_config")
        .update({
          geracao_status: "gerando",
          geracao_tentada_em: agoraIso,
          ...(zerarLotes ? { geracao_lotes: 0 } : {}),
        })
        .eq("program_id", pid)
        .eq("origem", "automatico")
        .or(`geracao_status.neq.gerando,geracao_tentada_em.lt.${limite}`)
        .select("program_id");
      if (error) throw error;
      if (!pegou?.length) return json({ ok: true, pulado: "outra rodada pegou esta pós", program_id: pid });
      if (zerarLotes) alvo.config.geracao_lotes = 0;
    }
    travado = pid;

    // 3. Material.
    const { texto: material, fichaChars } = await montarMaterial(
      db, alvo.nome, porSlug.get(alvo.slug)?.curso_id ?? null, ficha.program, ficha.script,
    );
    if (fichaChars < MIN_FICHA_CHARS) {
      await db.from("comercial_quiz_config").update({
        geracao_status: "sem_conteudo",
        geracao_erro: `Ficha de venda com ${fichaChars} caracteres (mínimo ${MIN_FICHA_CHARS}). ` +
          "Preencha módulos, público, dores e argumentos na ficha; a geração volta sozinha quando a ficha mudar.",
      }).eq("program_id", pid);
      travado = null;
      return json({ ok: true, program_id: pid, status: "sem_conteudo", ficha_chars: fichaChars });
    }

    // 4. Perguntas que já existem (ativas ou não) — para não repetir.
    const { data: exist, error: eExist } = await db
      .from("comercial_quiz_perguntas").select("question, category, ordem, ativa").eq("program_id", pid);
    if (eExist) throw eExist;
    const existentes = (exist ?? []) as { question: string; category: string; ordem: number; ativa: boolean }[];
    const ativasAntes = existentes.filter((e) => e.ativa).length;
    const porCategoria: Record<string, number> = {};
    for (const e of existentes) if (e.ativa) porCategoria[e.category] = (porCategoria[e.category] ?? 0) + 1;
    const quantas = tamanhoDoLote(ativasAntes);

    const apiKey = await chaveAnthropic(db);
    const pedidoGerar =
      `# MATERIAL\n${material}\n\n` +
      (existentes.length
        ? `# Perguntas que JÁ existem (não repita nem reescreva)\n${existentes.map((e) => `- ${e.question}`).join("\n")}\n\n` +
          `Já há por categoria: ${JSON.stringify(porCategoria)}. Equilibre puxando para as categorias com menos.\n\n`
        : "") +
      `Escreva ${quantas} perguntas novas.`;
    const gerado = (await chamarIA(apiKey, SISTEMA_GERAR, pedidoGerar, SCHEMA_GERAR, "medium", 16000, 170_000)) as {
      questoes: QuestaoIA[];
    };
    const novas: QuestaoPronta[] = normalizarQuestoes(gerado?.questoes ?? [], existentes.map((e) => e.question), embaralhar);

    // 5. Conferência às cegas.
    let aprovadas: QuestaoPronta[] = [];
    let reprovadas = 0;
    if (novas.length) {
      const prova = novas
        .map((q, i) => `${i + 1}. ${q.question}\n${q.options.map((o) => `   ${o.id}) ${o.text}`).join("\n")}`)
        .join("\n\n");
      const cega = (await chamarIA(
        apiKey, SISTEMA_CEGA, `# MATERIAL\n${material}\n\n# PROVA\n${prova}`, SCHEMA_CEGA, "low", 4000, 90_000,
      )) as { respostas: { n: number; alternativa: string }[] };
      ({ aprovadas, reprovadas } = aprovadasNaCega(novas, cega?.respostas ?? []));
    }

    // 6. Grava (sem passar de 100).
    const cabem = Math.max(0, 100 - ativasAntes);
    const gravar = aprovadas.slice(0, cabem);
    let ordem = existentes.reduce((m, e) => Math.max(m, e.ordem ?? 0), 0);
    if (gravar.length) {
      const { error } = await db.from("comercial_quiz_perguntas").insert(
        gravar.map((q) => ({
          program_id: pid,
          type: "multiple-choice",
          question: q.question,
          category: q.category,
          options: q.options,
          correct_option_id: q.correct_option_id,
          explanation: q.explanation || null,
          ativa: true,
          ordem: ++ordem,
          gerada_por_ia: true,
        })),
      );
      if (error) throw error;
    }

    // 7. Estado novo (liga a aba com 40).
    const ativas = await contarAtivas(db, pid);
    const lotes = (alvo.config?.geracao_lotes ?? 0) + 1;
    const est = estadoDepoisDoLote(ativas, lotes, alvo.config?.ativado_auto_em ?? null);
    const { error: eFim } = await db.from("comercial_quiz_config").update({
      geracao_status: est.status,
      geracao_erro: est.erro,
      geracao_lotes: lotes,
      ...(est.ligar ? { ativo: true, ativado_auto_em: new Date().toISOString() } : {}),
    }).eq("program_id", pid);
    if (eFim) throw eFim;
    travado = null;

    return json({
      ok: true,
      program_id: pid,
      pedidas: quantas,
      validas: novas.length,
      reprovadas_na_cega: reprovadas,
      gravadas: gravar.length,
      ativas,
      status: est.status,
      aba_ligada_agora: est.ligar,
    });
  } catch (e) {
    const err = e as Error & { message?: string };
    const msg = err?.message || String(e);
    console.error("comercial-quiz-gerar", msg);
    if (travado) {
      await db.from("comercial_quiz_config")
        .update({ geracao_status: "erro", geracao_erro: msg.slice(0, 500) })
        .eq("program_id", travado);
    }
    // 503 (nunca 502/504: o Cloudflare troca a resposta e some com a mensagem).
    return json({ ok: false, error: msg }, 503);
  }
});
