// academy-gerar-questoes
// Gera RASCUNHOS de questões de múltipla escolha para o quiz final de um curso da
// PPGVet Academy, a partir do conteúdo do curso (títulos, descrições e transcrições
// das aulas) + material colado e/ou PDF (apostila, slides) enviado pelo admin.
//
// Nada é gravado aqui: o admin revisa, marca as que quer e só então elas entram no
// banco de questões (pelo front, com a RLS de admin). Quem pode chamar: o mesmo
// público do AdminGate da Academy (RPC academy_pode_administrar).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODELO = Deno.env.get("ACADEMY_QUIZ_MODEL") ?? "claude-opus-5";

const MAX_QUESTOES = 20;
const MAX_MATERIAL_CHARS = 150_000;
const MAX_PDF_BASE64 = 12 * 1024 * 1024; // ~9MB de PDF
// Abaixo disso o "conteúdo" é só título/descrição curta — a IA inventaria.
const MIN_CONTEUDO_CHARS = 1_500;
// O Cloudflare derruba a origem em ~100s; melhor devolver um erro legível antes.
const TIMEOUT_MS = 95_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// deno-lint-ignore no-explicit-any
async function chaveAnthropic(db: any): Promise<string> {
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

const SCHEMA = {
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
          aula: { type: "string" },
        },
        required: ["pergunta", "opcoes", "correta", "explicacao", "aula"],
        additionalProperties: false,
      },
    },
  },
  required: ["questoes"],
  additionalProperties: false,
};

const SISTEMA =
  "Você elabora a avaliação final de cursos de treinamento interno de uma empresa de " +
  "educação (PPGVet). Quem faz a prova são colaboradores da empresa; passar gera o " +
  "certificado do curso.\n\n" +
  "Regras das questões:\n" +
  "- Português do Brasil, linguagem clara e direta.\n" +
  "- Cada questão tem exatamente 4 alternativas e uma única correta.\n" +
  "- Pergunte sobre o que o CONTEÚDO fornecido ensina: conceitos, procedimentos, " +
  "decisões e aplicação prática. Não pergunte nada que não esteja no conteúdo.\n" +
  "- Prefira questões de aplicação ('numa situação X, o que fazer?') a decoreba de " +
  "detalhes irrelevantes (datas, nomes de slides, números soltos).\n" +
  "- Alternativas erradas plausíveis, do mesmo tamanho e tom da correta. Nada de " +
  "'todas as anteriores', 'nenhuma das anteriores' ou pegadinhas de negação dupla.\n" +
  "- A explicação diz em 1 ou 2 frases por que a correta está certa, citando o conteúdo.\n" +
  "- No campo 'aula', informe o título da aula (ou 'Material de apoio') de onde saiu.\n" +
  "- Cubra o curso inteiro de forma equilibrada, sem repetir o mesmo ponto.\n" +
  "- Não repita nem reescreva questões que já existem no banco (listadas no pedido).";

type Aula = { title: string; description: string | null; transcript: string | null; display_order: number };
type Modulo = { title: string; display_order: number; academy_lessons: Aula[] };

function embaralhar<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ error: "não autorizado" }, 401);
    const asUser = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    const { data: userData } = await asUser.auth.getUser();
    if (!userData?.user) return json({ error: "não autorizado" }, 401);

    const { data: podeAdministrar } = await asUser.rpc("academy_pode_administrar");
    if (!podeAdministrar) {
      return json({ error: "Só administradores da Academy podem gerar questões." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const courseId = typeof body?.course_id === "string" ? body.course_id : "";
    const quantidade = Math.min(MAX_QUESTOES, Math.max(3, Number(body?.quantidade) || 10));
    const material = typeof body?.material === "string" ? body.material.trim() : "";
    const instrucoes = typeof body?.instrucoes === "string" ? body.instrucoes.trim().slice(0, 2_000) : "";
    const pdfBase64 = typeof body?.pdf_base64 === "string" ? body.pdf_base64 : "";
    const pdfNome = typeof body?.pdf_nome === "string" ? body.pdf_nome.slice(0, 200) : "material.pdf";

    if (!courseId) return json({ error: "course_id é obrigatório" }, 400);
    if (material.length > MAX_MATERIAL_CHARS) {
      return json({ error: `Material muito longo (máx. ${MAX_MATERIAL_CHARS} caracteres).` }, 413);
    }
    if (pdfBase64.length > MAX_PDF_BASE64) {
      return json({ error: "PDF muito grande (máx. ~9 MB)." }, 413);
    }

    const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    const { data: curso, error: cursoErr } = await db
      .from("academy_courses")
      .select("id, title, description, academy_modules(title, display_order, academy_lessons(title, description, transcript, display_order))")
      .eq("id", courseId)
      .maybeSingle();
    if (cursoErr) throw cursoErr;
    if (!curso) return json({ error: "Curso não encontrado." }, 404);

    const modulos = ((curso.academy_modules ?? []) as Modulo[])
      .sort((a, b) => a.display_order - b.display_order);

    let aulasComTranscricao = 0;
    let charsConteudo = 0;
    const partes: string[] = [];
    for (const m of modulos) {
      partes.push(`## Módulo: ${m.title}`);
      for (const l of (m.academy_lessons ?? []).sort((a, b) => a.display_order - b.display_order)) {
        partes.push(`### Aula: ${l.title}`);
        if (l.description?.trim()) partes.push(l.description.trim());
        if (l.transcript?.trim()) {
          aulasComTranscricao++;
          charsConteudo += l.transcript.trim().length;
          partes.push(`Transcrição:\n${l.transcript.trim()}`);
        }
      }
    }
    charsConteudo += material.length;

    if (!pdfBase64 && charsConteudo < MIN_CONTEUDO_CHARS) {
      return json({
        error:
          `Conteúdo insuficiente para gerar questões confiáveis (${aulasComTranscricao} aula(s) ` +
          "com transcrição). Cole a transcrição ou o roteiro das aulas, ou envie a apostila em PDF.",
        codigo: "sem_conteudo",
      }, 422);
    }

    // Questões que já existem — para a IA não repetir.
    const { data: quiz } = await db
      .from("academy_quizzes").select("id").eq("course_id", courseId).maybeSingle();
    let existentes: string[] = [];
    if (quiz?.id) {
      const { data: qs } = await db
        .from("academy_quiz_questions").select("question_text").eq("quiz_id", quiz.id);
      existentes = (qs ?? []).map((q: { question_text: string }) => q.question_text);
    }

    const pedido =
      `Curso: ${curso.title}\n` +
      (curso.description ? `Descrição do curso: ${curso.description}\n` : "") +
      `\n# Conteúdo do curso\n${partes.join("\n\n")}\n` +
      (material ? `\n# Material de apoio (enviado pelo admin)\n${material}\n` : "") +
      (pdfBase64 ? `\n(O PDF anexado "${pdfNome}" também é material de apoio do curso.)\n` : "") +
      (existentes.length
        ? `\n# Questões que JÁ existem no banco (não repita)\n${existentes.map((t) => `- ${t}`).join("\n")}\n`
        : "") +
      (instrucoes ? `\n# Orientações do admin\n${instrucoes}\n` : "") +
      `\nElabore ${quantidade} questões novas.`;

    const conteudoUsuario: unknown[] = [];
    if (pdfBase64) {
      conteudoUsuario.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: pdfBase64 },
        title: pdfNome,
      });
    }
    conteudoUsuario.push({ type: "text", text: pedido });

    const apiKey = await chaveAnthropic(db);
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const chamar = (comReserva: boolean) =>
      fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal,
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          // Se o modelo recusar por política, a API refaz no modelo de reserva.
          ...(comReserva ? { "anthropic-beta": "server-side-fallback-2026-07-01" } : {}),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: MODELO,
          max_tokens: 16000,
          ...(comReserva ? { fallbacks: "default" } : {}),
          output_config: {
            effort: "medium",
            format: { type: "json_schema", schema: SCHEMA },
          },
          system: SISTEMA,
          messages: [{ role: "user", content: conteudoUsuario }],
        }),
      });

    let res = await chamar(true);
    if (res.status === 400) {
      // O fallback é beta: se a conta não aceitar, segue sem ele em vez de quebrar.
      const txt = await res.clone().text();
      if (/fallback/i.test(txt)) res = await chamar(false);
    }

    if (!res.ok) {
      const txt = await res.text();
      console.error("anthropic error", res.status, txt.slice(0, 500));
      // 422 (nunca 502/504): o Cloudflare engole 502/504 da origem sem CORS.
      return json({ error: `Erro da IA (${res.status}): ${txt.slice(0, 200)}` }, 422);
    }

    const msg = await res.json();
    if (msg.stop_reason === "refusal") {
      return json({ error: "A IA recusou gerar questões para este conteúdo." }, 422);
    }
    if (msg.stop_reason === "max_tokens") {
      return json({ error: "A resposta da IA foi cortada. Peça menos questões por vez." }, 422);
    }
    const texto = (msg.content ?? [])
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("");
    const parsed = JSON.parse(texto) as {
      questoes: Array<{ pergunta: string; opcoes: string[]; correta: number; explicacao: string; aula: string }>;
    };

    // Valida e embaralha as alternativas (modelos tendem a pôr a correta sempre
    // na mesma posição).
    const questoes = (parsed.questoes ?? [])
      .map((q) => {
        const opcoes = (q.opcoes ?? []).map((o) => String(o).trim()).filter(Boolean);
        if (!q.pergunta?.trim() || opcoes.length < 2 || opcoes.length > 6) return null;
        if (!Number.isInteger(q.correta) || q.correta < 0 || q.correta >= opcoes.length) return null;
        if (new Set(opcoes.map((o) => o.toLowerCase())).size !== opcoes.length) return null;
        const correta = opcoes[q.correta];
        const mistura = embaralhar(opcoes);
        return {
          question_text: q.pergunta.trim(),
          options: mistura,
          correct_option_index: mistura.indexOf(correta),
          explanation: q.explicacao?.trim() || null,
          aula: q.aula?.trim() || null,
        };
      })
      .filter(Boolean);

    return json({
      questoes,
      fonte: {
        aulas_com_transcricao: aulasComTranscricao,
        material_chars: material.length,
        pdf: !!pdfBase64,
      },
    });
  } catch (e) {
    const err = e as Error;
    console.error("academy-gerar-questoes", err);
    const timeout = err?.name === "TimeoutError" || err?.name === "AbortError";
    return json({
      error: timeout
        ? "A IA demorou demais. Tente pedir menos questões ou um material menor."
        : err?.message || "Erro desconhecido",
    }, timeout ? 422 : 500);
  }
});
