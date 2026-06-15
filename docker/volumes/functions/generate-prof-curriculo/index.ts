// Edge function: gera mini-bio do professor combinando dados cadastrais,
// cursos vinculados, aulas/ementas e (opcionalmente) scraping do Lattes.
// Modo síncrono (default): roda e devolve { descricao }.
// Modo async ({ async: true }): retorna 202 imediato e processa em background
// atualizando ped_professores.bio_status ('processing' -> 'completed'/'failed').
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Modelo configurável via env; default é Haiku 4.5 (rápido e barato).
const ANTHROPIC_MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-haiku-4-5-20251001";

async function fetchLattesText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; PPGVetBot/1.0; +https://sistemappgvet.lovable.app)",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text.slice(0, 12000);
  } catch (e) {
    console.error("Lattes fetch failed:", e);
    return null;
  }
}

// O PDF do Lattes precisa caber em DOIS limites da Anthropic: máx. 100 páginas E o
// contexto do modelo (200k tokens). Currículos completos de docentes prolíficos estouram
// os dois (já vimos "A maximum of 100 PDF pages" e "prompt is too long: 202507 tokens").
// Formação, titulação e atuação ficam nas PRIMEIRAS páginas; o resto (listão de publicações,
// eventos, orientações) não entra na bio. 40 páginas cobrem o que importa com folga de tokens.
const MAX_PDF_PAGINAS = 40;

// Detecta TEXTO DE RECUSA da IA ("Não é possível gerar…", "Não consigo…"). Usado para:
// (1) NÃO salvar recusa como bio (envenenava bio_gerada_ia e travava os tópicos depois);
// (2) pular bios-recusa ao escolher a fonte do currículo em tópicos.
const RECUSA_RE =
  /^\s*(?:n[ãa]o\s+(?:consigo|é\s+poss[íi]vel|foi\s+poss[íi]vel|posso)|imposs[íi]vel\b)/i;

function uint8ToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** Se o PDF (base64) tiver mais de 100 páginas, devolve um base64 só com as primeiras
 *  MAX_PDF_PAGINAS. Em qualquer erro, devolve o original (a API valida). */
async function limitarPdfPaginas(base64: string): Promise<string> {
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const { PDFDocument } = await import("https://esm.sh/pdf-lib@1.17.1");
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    if (src.getPageCount() <= MAX_PDF_PAGINAS) return base64;
    const out = await PDFDocument.create();
    const idxs = Array.from({ length: MAX_PDF_PAGINAS }, (_, i) => i);
    const pages = await out.copyPages(src, idxs);
    pages.forEach((p) => out.addPage(p));
    return uint8ToBase64(await out.save());
  } catch (e) {
    console.error("limitarPdfPaginas falhou (segue com PDF original):", e);
    return base64;
  }
}

async function getAnthropicKey(sb: any): Promise<string> {
  const { data, error } = await sb
    .from("ai_api_keys")
    .select("api_key")
    .eq("provider", "anthropic")
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("Erro ao ler chave Anthropic: " + error.message);
  if (!data?.api_key) {
    throw new Error("Chave Anthropic ativa não encontrada em ai_api_keys. Configure em /ia-config.");
  }
  return data.api_key as string;
}

// Busca o professor + cursos vinculados + aulas/ementas vinculadas.
// Compartilhado entre a geração da bio (parágrafo) e do currículo em tópicos.
async function gatherProfContext(sb: any, professor_id: string) {
  const { data: prof, error: profErr } = await sb
    .from("ped_professores")
    .select("*")
    .eq("id", professor_id)
    .single();
  if (profErr || !prof) throw new Error(profErr?.message || "Professor não encontrado");

  // Cursos vinculados (N:N) — pode estar em ped_professor_cursos com pos_graduacao_id ou curso_id
  const { data: vinc1 } = await sb
    .from("ped_professor_cursos")
    .select("pos_graduacao_id, curso_id")
    .eq("professor_id", professor_id);

  const posIds = (vinc1 || []).map((v: any) => v.pos_graduacao_id).filter(Boolean);
  const cursoIdsLegacy = (vinc1 || []).map((v: any) => v.curso_id).filter(Boolean);

  const cursosNomes: string[] = [];
  if (posIds.length > 0) {
    const { data } = await sb.from("ped_pos_graduacoes").select("nome").in("id", posIds);
    (data || []).forEach((c: any) => c.nome && cursosNomes.push(c.nome));
  }
  if (cursoIdsLegacy.length > 0) {
    const { data } = await sb.from("cursos").select("nome").in("id", cursoIdsLegacy);
    (data || []).forEach((c: any) => c.nome && cursosNomes.push(c.nome));
  }

  // Aulas vinculadas + ementas
  const [aulasMainRes, aulasProfRes] = await Promise.all([
    sb.from("ped_aulas").select("titulo, modulo, ementa").eq("professor_id", professor_id).limit(30),
    sb.from("ped_aulas_professor").select("titulo, modulo").eq("professor_id", professor_id).limit(30),
  ]);

  const aulas: { titulo: string; modulo: string | null; ementa?: string | null }[] = [];
  (aulasMainRes.data || []).forEach((a: any) => aulas.push({ titulo: a.titulo, modulo: a.modulo, ementa: a.ementa }));
  (aulasProfRes.data || []).forEach((a: any) => aulas.push({ titulo: a.titulo, modulo: a.modulo }));

  const aulasResumo = aulas
    .filter((a) => a.titulo)
    .slice(0, 20)
    .map(
      (a) =>
        `- ${a.titulo}${a.modulo ? ` (módulo: ${a.modulo})` : ""}${
          a.ementa ? ` — ementa: ${String(a.ementa).slice(0, 200)}` : ""
        }`,
    )
    .join("\n");

  return { prof, cursosNomes, aulasResumo };
}

// Resumo das experiências profissionais (aceita histórico em array legado ou objeto novo).
function buildHistResumo(histProf: any): string | null {
  if (!histProf) return null;
  const exps = Array.isArray(histProf) ? histProf : histProf.experiencias;
  if (!Array.isArray(exps) || exps.length === 0) return null;
  const lines = exps.slice(0, 10).map((h: any) => {
    if (typeof h === "string") return `- ${h}`;
    const periodo = [h?.periodo_inicio ?? h?.periodo, h?.periodo_fim].filter(Boolean).join("–");
    return `- ${[
      h?.cargo,
      h?.instituicao ? `— ${h.instituicao}` : "",
      periodo ? `(${periodo})` : "",
      h?.descricao ? `— ${h.descricao}` : "",
    ]
      .filter(Boolean)
      .join(" ")
      .trim()}`;
  });
  return lines.join("\n");
}

// Resumo da atuação prática de campo (consultorias, fazendas atendidas, indústria, etc.).
function buildAtuacoesResumo(histProf: any): string | null {
  const atu = histProf && !Array.isArray(histProf) ? histProf.atuacoes : null;
  if (!Array.isArray(atu) || atu.length === 0) return null;
  const lines = atu
    .slice(0, 20)
    .map((a: any) =>
      `- ${[a?.tipo, a?.descricao, a?.escala ? `(${a.escala})` : ""].filter(Boolean).join(" ").trim()}`,
    )
    .filter((l: string) => l.length > 2);
  return lines.length ? lines.join("\n") : null;
}

// Extrai um array de tópicos { titulo, texto } da resposta da IA, tolerando cercas de código.
function parseTopicos(raw: string): { titulo: string; texto: string }[] {
  let txt = raw.trim();
  txt = txt.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = txt.indexOf("[");
  const end = txt.lastIndexOf("]");
  if (start >= 0 && end > start) txt = txt.slice(start, end + 1);
  let parsed: any;
  try {
    parsed = JSON.parse(txt);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((t: any) => ({
      titulo: String(t?.titulo ?? "").trim(),
      texto: String(t?.texto ?? "").trim(),
    }))
    .filter((t) => t.titulo && t.texto)
    .slice(0, 6);
}

async function generateBio(
  professor_id: string,
  pdfBase64?: string | null,
  pdfMediaType?: string | null,
) {
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  await sb
    .from("ped_professores")
    .update({ bio_status: "processing", bio_error: null })
    .eq("id", professor_id);

  try {
    const ANTHROPIC_API_KEY = await getAnthropicKey(sb);
    const { prof, cursosNomes, aulasResumo } = await gatherProfContext(sb, professor_id);

    // Lattes via scraping só é tentado como fallback quando NÃO há PDF anexado.
    // O scraping do cnpq normalmente falha (CAPTCHA / conteúdo via JS), por isso
    // o fluxo principal é o atendente anexar o PDF do currículo na geração.
    const lattesUrl: string | null =
      (prof as any).lattes_url || (prof as any).curriculo_lattes || null;
    let lattesText: string | null = null;
    if (!pdfBase64 && lattesUrl && /^https?:\/\//i.test(lattesUrl)) {
      lattesText = await fetchLattesText(lattesUrl);
    }

    const especialidades: string[] = Array.isArray((prof as any).especialidades)
      ? (prof as any).especialidades
      : [];

    const histProf = (prof as any).historico_profissional;
    const histResumo = buildHistResumo(histProf);
    const atuacoesResumo = buildAtuacoesResumo(histProf);
    // Bio escrita/ajustada MANUALMENTE no cadastro ("Bio final"): fonte válida (e principal
    // na ausência de PDF/Lattes) — permite gerar/regerar a bio sem anexar o Lattes.
    const bioManualRaw: string | null = (prof as any).bio_curta || null;
    const bioManual = bioManualRaw && !RECUSA_RE.test(bioManualRaw) ? bioManualRaw : null;

    const systemPrompt = `Você escreve mini-bios COMERCIAIS de professores de cursos de pós-graduação, módulos práticos e cursos livres na área de ciências agrárias e da saúde animal (medicina veterinária, zootecnia, agronomia, biologia, nutrição, produção animal, saúde pública e afins) para landing pages e materiais de divulgação. O objetivo é ENCANTAR e gerar autoridade, deixando claro o CALIBRE do docente e o que ele agrega ao curso onde leciona.

IMPORTANTE — NUNCA RECUSE: os professores têm formações VARIADAS (Médico Veterinário, Bióloga, Zootecnista, Engenheiro Agrônomo, Nutricionista, Farmacêutico, Médico, etc.) e NÃO precisam ser médicos veterinários — muitas disciplinas são ministradas por profissionais de outras áreas e isso é totalmente normal. Sua tarefa é SEMPRE escrever a melhor bio possível com os dados disponíveis, qualquer que seja a formação. NÃO julgue se o professor é "qualificado o suficiente", NÃO questione o cadastro, NÃO peça mais dados e NUNCA responda com recusa, ressalva, aviso ou explicação do porquê "não é possível". Sua resposta deve ser SEMPRE e APENAS o texto da bio. Se faltar informação, escreva uma bio mais curta com o que existe.

REGRAS OBRIGATÓRIAS:
- Tamanho: 3 a 4 frases, parágrafo único, cerca de 90 a 120 palavras. Denso e informativo, sem encher linguiça.
- ESTRUTURA OBRIGATÓRIA — siga EXATAMENTE esta ordem. Omita um item APENAS se a informação não existir em nenhuma fonte; NUNCA invente:
  1) FORMAÇÃO (profissão de formação), capitalizada, qualquer que seja. Ex.: "Médica Veterinária", "Bióloga", "Zootecnista", "Engenheiro Agrônomo", "Nutricionista".
  2) TITULAÇÃO ACADÊMICA mais alta (Doutorado > Mestrado > Especialização), com área e instituição. Ex.: "Doutor em Bem-Estar Animal pela Universidade de Cambridge". É o item mais importante — nunca omita se existir. Titulação EM ANDAMENTO também conta e deve ser citada como tal ("Mestranda em Saúde Única e Zoonoses", "Doutorando em Reprodução Animal").
  3) EXPERIÊNCIA INTERNACIONAL, acadêmica OU de trabalho, se houver (pós-doutorado, cátedra, projeto/programa no exterior, atuação em instituição estrangeira). Cite 1 a 2 das mais fortes.
  4) CARGO ATUAL e empresa/instituição, se houver.
  5) CORRELAÇÃO com a ementa/aulas vinculadas e a pós-graduação onde leciona: o que ele DOMINA e o que TRAZ para os alunos da pós. Integre de forma fluida, não liste.
- ABERTURA: comece SEMPRE por FORMAÇÃO + " e " + TITULAÇÃO. Ex.: "Médico Veterinário e Doutor em Bem-Estar Animal pela Universidade de Cambridge, ..." ou "Bióloga e Mestranda em Saúde Única e Zoonoses pela UNOCHAPECÓ, ...". A titulação (mesmo em andamento) nunca pode ser omitida se existir em qualquer fonte.
- FONTE para extrair os dados (ordem de prioridade):
  1) DOCUMENTO PDF DO CURRÍCULO LATTES anexado a esta requisição (quando houver): é a fonte PRINCIPAL e mais completa. Extraia dele formação, titulação (título MAIS ALTO, concluído OU em andamento) com instituição, experiência internacional, cargos, projetos, prêmios e publicações relevantes.
  2) Bloco "CONTEÚDO BRUTO DO CURRÍCULO LATTES" (texto), quando presente.
  3) Campos GRADUAÇÃO + CARGO ATUAL do cadastro.
  4) HISTÓRICO PROFISSIONAL como fallback.
- Se NÃO houver titulação identificável em nenhuma fonte, abra apenas com a profissão de formação. Se também não houver profissão de formação, abra com a credencial profissional mais alta conhecida. NUNCA invente formação, titulação, instituição, marco ou prêmio.
- Use flexão de gênero correta com base no NOME do(a) professor(a): "Médica Veterinária, Doutora ..." / "Médico Veterinário, Doutor ..." / "Bióloga, Mestranda ...".
- Capitalize as credenciais e a profissão de formação na abertura ("Médico Veterinário", "Bióloga", "Doutor", "Mestre", "Mestranda", "Professor Titular").
- Cite no máximo 2 instituições-âncora ADICIONAIS (além da da titulação), e só se forem muito fortes (USP, UFRGS, Cambridge, etc.). Pule instituições secundárias.
- Tom: confiante, técnico, sofisticado, em português do Brasil. Frases ativas. Evite clichês como "vasta experiência", "amplo conhecimento", "renomado".
- Sem markdown, sem bullets, sem emojis, sem quebras de linha, sem aspas envolvendo o texto.
- NUNCA cite o NOME do(a) professor(a) no texto. A bio sempre é exibida ao lado da foto e do nome, então repetir o nome polui e fica redundante. Use apenas pronomes/sujeito implícito ou referências profissionais ("o pesquisador", "a docente") quando indispensável.
- Nunca cite nomes de turmas. Nunca invente dados — se faltar, omita.

Exemplo do tom e da ORDEM esperados (1-formação, 2-titulação, 3-experiência internacional, 4-cargo atual, 5-correlação com aulas/pós; nome NÃO aparece):
Médico Veterinário e Doutor em Bem-Estar Animal pela Universidade de Cambridge, com pós-doutorado na Ludwig-Maximilians-Universität München e cátedra na Norwegian School of Veterinary Science. Atualmente professor titular na FMVZ/USP, domina comportamento e bem-estar de suínos, ambiência e neurobiologia do estresse, integrando enriquecimento ambiental e manejo a ganhos reais de desempenho zootécnico. Traz para a pós uma leitura crítica das dimensões éticas, legais e de mercado do bem-estar animal, conectando legislação e percepção do consumidor às práticas em sistemas intensivos.

Segundo exemplo — formação NÃO veterinária e titulação EM ANDAMENTO (mostra que é totalmente válido e que você NUNCA deve recusar por isso):
Bióloga e Mestranda em Saúde Única e Zoonoses pela UNOCHAPECÓ, com especialização em Ciências Naturais e experiência na coordenação de departamento de zoonoses em órgão estadual. Atuou na implantação de medidas de controle integrando as saúdes ambiental, animal e humana, dominando vigilância epidemiológica e manejo de zoonoses. Traz para a pós uma visão prática de campo sobre prevenção e controle de doenças de interesse coletivo, conectando saúde pública e produção animal.`;

    const userPrompt = `Gere a mini-biografia do(a) professor(a) abaixo. ${
      pdfBase64
        ? "A fonte PRINCIPAL é o DOCUMENTO PDF do currículo Lattes anexado a esta mensagem — extraia dele titulação, instituições e marcos acadêmicos. Complemente com os dados do cadastro abaixo."
        : bioManual
        ? "Nenhum PDF foi anexado; a fonte PRINCIPAL é a BIO ATUAL DO CADASTRO abaixo (escrita manualmente) — extraia dela formação, titulação, instituições, cargos e marcos, complementando com os demais dados. Não invente nada além do que está nas fontes."
        : "Nenhum PDF de currículo Lattes foi anexado nesta geração; use apenas os dados do cadastro abaixo e não invente titulação/instituições."
    }

NOME: ${(prof as any).nome}
CARGO ATUAL: ${(prof as any).cargo_atual || (prof as any).titulacao || "—"}
GRADUAÇÃO: ${(prof as any).graduacao || "—"}
ÁREA DE EXPERTISE: ${(prof as any).area_expertise || "—"}
ESPECIALIDADES: ${especialidades.length ? especialidades.join(", ") : "—"}
ANOS DE PRÁTICA: ${(prof as any).anos_pratica ?? "—"}
ANOS DE DOCÊNCIA: ${(prof as any).anos_docencia ?? "—"}
PÓS-GRADUAÇÕES ONDE LECIONA: ${cursosNomes.length ? cursosNomes.join(", ") : "—"}

AULAS / EMENTAS VINCULADAS:
${aulasResumo || "—"}

${
      bioManual
        ? `BIO ATUAL DO CADASTRO (escrita/ajustada manualmente — fonte principal quando não há PDF):\n"""${bioManual}"""\n\n`
        : ""
    }${histResumo ? `HISTÓRICO PROFISSIONAL:\n${histResumo}\n` : ""}${
      atuacoesResumo ? `\nATUAÇÃO PRÁTICA DE CAMPO (consultorias, fazendas/indústrias atendidas):\n${atuacoesResumo}\n` : ""
    }${
      (prof as any).anotacoes_internas
        ? `\nANOTAÇÕES INTERNAS (use apenas para enriquecer contexto, não cite literalmente):\n${(
            prof as any
          ).anotacoes_internas}\n`
        : ""
    }${
      lattesText
        ? `\nCONTEÚDO BRUTO DO CURRÍCULO LATTES (extraia formação, instituições, linhas de pesquisa, publicações relevantes):\n"""${lattesText}"""\n`
        : "\nObs: Currículo Lattes não disponível.\n"
    }`;

    // Quando há PDF, enviamos como bloco "document" (Claude lê PDF nativamente).
    // Corta para ≤100 páginas (limite da Anthropic) antes de enviar.
    const pdfParaApi = pdfBase64 ? await limitarPdfPaginas(pdfBase64) : pdfBase64;
    const userContent: unknown = pdfParaApi
      ? [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: pdfMediaType || "application/pdf",
              data: pdfParaApi,
            },
          },
          { type: "text", text: userPrompt },
        ]
      : userPrompt;

    const aiResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      }),
    });

    if (!aiResp.ok) {
      const t = await aiResp.text();
      console.error("Anthropic error", aiResp.status, t);
      if (aiResp.status === 401) throw new Error("Chave Anthropic inválida. Atualize em /ia-config.");
      if (aiResp.status === 429) throw new Error("Limite de uso da Anthropic atingido. Tente novamente em alguns minutos.");
      if (aiResp.status === 400 && (/PDF pages/i.test(t) || /prompt is too long/i.test(t)))
        throw new Error("O PDF do Lattes é grande demais para a IA. Anexe o currículo RESUMIDO do Lattes.");
      if (aiResp.status === 400) throw new Error("Requisição inválida: " + t.slice(0, 200));
      throw new Error("Anthropic error " + aiResp.status + ": " + t.slice(0, 200));
    }

    const aiJson = await aiResp.json();
    const descricao: string = (aiJson.content?.[0]?.text ?? "").trim();
    if (!descricao) throw new Error("Resposta vazia da IA");
    // Recusa NUNCA vira bio: salvar "Não é possível gerar…" envenenava o cadastro e
    // derrubava a geração do currículo em tópicos na sequência.
    if (RECUSA_RE.test(descricao))
      throw new Error(
        "A IA não encontrou dados suficientes. Preencha a Bio final/Anotações ou anexe o PDF do Lattes e gere novamente.",
      );

    const nowIso = new Date().toISOString();
    await sb
      .from("ped_professores")
      .update({
        bio_gerada_ia: descricao,
        bio_gerada_em: nowIso,
        bio_status: "completed",
        bio_error: null,
        descricao_ia: descricao, // espelho legado
        descricao_ia_atualizada_em: nowIso,
      })
      .eq("id", professor_id);

    return { descricao, lattes_used: !!lattesText, pdf_used: !!pdfBase64 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("generate-prof-curriculo failed:", msg);
    await sb
      .from("ped_professores")
      .update({ bio_status: "failed", bio_error: msg })
      .eq("id", professor_id);
    throw e;
  }
}

// Gera o "currículo profissional em tópicos" — 5 a 6 bullets curtos usados no
// comercial / cronograma para criar conexão com o lead e mostrar o calibre do
// professor e o que ele agrega às aulas. Não usa PDF; só dados do cadastro,
// histórico profissional (incl. atuação prática) e aulas/ementas vinculadas.
// Resultado salvo em ped_professores.historico_profissional.curriculo_topicos.
async function generateTopicos(professor_id: string) {
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const ANTHROPIC_API_KEY = await getAnthropicKey(sb);
  const { prof, cursosNomes, aulasResumo } = await gatherProfContext(sb, professor_id);

  const especialidades: string[] = Array.isArray((prof as any).especialidades)
    ? (prof as any).especialidades
    : [];
  const histProf = (prof as any).historico_profissional;
  const histResumo = buildHistResumo(histProf);
  const atuacoesResumo = buildAtuacoesResumo(histProf);
  // Bio formal (gerada OU escrita manualmente no campo "Bio final") — fonte para os tópicos.
  // Recusas de gerações antigas ("Não é possível…") são puladas POR CANDIDATO: se a bio
  // gerada é uma recusa mas a bio manual (bio_curta) é válida, a manual é usada — assim os
  // tópicos saem só com o que estiver na Bio final, sem precisar do PDF do Lattes.
  const bioFormal: string | null =
    [
      (prof as any).bio_gerada_ia,
      (prof as any).bio_curta,
      (prof as any).descricao_ia,
    ].find((b: unknown): b is string => typeof b === "string" && !!b.trim() && !RECUSA_RE.test(b)) ?? null;
  const anotacoes: string | null = (prof as any).anotacoes_internas || null;

  const systemPrompt = `Você cria o "CURRÍCULO PROFISSIONAL EM TÓPICOS" de um(a) professor(a) de cursos da área de ciências agrárias e da saúde animal (medicina veterinária, zootecnia, agronomia, biologia, nutrição, produção animal, saúde pública e afins). Esse currículo é usado em CRONOGRAMAS e na APRESENTAÇÃO COMERCIAL para um lead interessado no curso: o objetivo é gerar AUTORIDADE, criar CONEXÃO e deixar claro COMO o professor vai ajudar o aluno nas aulas.

IMPORTANTE — NUNCA RECUSE: os professores têm formações VARIADAS (Médico Veterinário, Bióloga, Zootecnista, Engenheiro Agrônomo, Nutricionista, etc.) e NÃO precisam ser médicos veterinários. Sempre gere os tópicos com os dados disponíveis, qualquer que seja a formação; NÃO julgue se o professor é qualificado, NÃO questione o cadastro e NUNCA responda com recusa ou ressalva — apenas o array JSON.

FORMATO DE SAÍDA (OBRIGATÓRIO):
- Responda APENAS com um array JSON válido, sem markdown, sem cercas de código, sem texto antes ou depois.
- Cada item é um objeto { "titulo": string, "texto": string }.
- Gere de 5 a 6 tópicos, na ordem de prioridade abaixo. NUNCA invente dados: se uma informação não existir nas fontes, simplesmente pule o tópico correspondente.
- "titulo": 1 a 3 palavras, capitalizado (ex.: "Formação", "Titulação", "Experiência", "Atuação em campo", "Nas aulas").
- "texto": MUITO SUCINTO — no máximo ~18 palavras, uma única ideia por tópico. Português do Brasil, tom técnico e confiante. SEM clichês ("vasta experiência", "amplo conhecimento", "renomado"), sem encher linguiça.

CONTEÚDO DOS TÓPICOS (use os que tiverem dado real, nesta ordem):
1) FORMAÇÃO — profissão de formação capitalizada, qualquer que seja (ex.: "Médico Veterinário", "Bióloga", "Zootecnista", "Engenheiro Agrônomo").
2) TITULAÇÃO — título acadêmico mais alto, com área e instituição se houver (ex.: "Doutor em Reprodução Animal pela UFRGS"). Titulação em andamento conta e deve ser citada como tal (ex.: "Mestranda em Saúde Única e Zoonoses"). É o mais importante; nunca omita se existir.
3) EXPERIÊNCIA — anos de prática e/ou docência (ex.: "10 anos de prática a campo e 5 como docente").
4) ATUAÇÃO EM CAMPO — destaque prático: consultorias, número de fazendas/granjas atendidas, indústria onde atua (ex.: "Consultor de nutrição, atende mais de 100 fazendas leiteiras").
5) NAS AULAS — conecte EXATAMENTE o que o professor domina e vai ENSINAR nas aulas vinculadas com a experiência prática dele. Mostre por que a autoridade dele torna a aula valiosa para o aluno.
6) (opcional) DIFERENCIAL — um marco, especialidade ou experiência internacional que reforça a autoridade.

OBJETIVO: cada tópico deve CONECTAR autoridade + experiência prática + o que será dito na aula. A formação, a titulação (doutor/mestre/especialista) e os anos de experiência são âncoras de autoridade — deixe-as explícitas.

REGRAS:
- Use flexão de gênero correta com base no NOME (Médico/Médica, Doutor/Doutora, Mestrando/Mestranda, Biólogo/Bióloga).
- Números devem ser EXATOS, exatamente como informados nas fontes. Nunca arredonde nem invente quantidades.
- NUNCA cite o NOME do(a) professor(a) nem nomes de turmas.
- Não use markdown dentro dos textos.`;

  const userPrompt = `Gere o currículo profissional em tópicos do(a) professor(a) abaixo. Use somente os dados fornecidos; não invente.
${
  bioFormal
    ? `\nBIO FORMAL JÁ GERADA (fonte PRINCIPAL — extraia dela formação, titulação, instituições e marcos; resuma em tópicos, não copie frases inteiras):\n"""${bioFormal}"""\n`
    : "\n(Bio formal ainda não gerada — use apenas os dados de cadastro, histórico e aulas abaixo.)\n"
}
NOME (apenas para flexão de gênero, não citar): ${(prof as any).nome}
CARGO ATUAL: ${(prof as any).cargo_atual || "—"}
GRADUAÇÃO / FORMAÇÃO: ${(prof as any).graduacao || "—"}
TITULAÇÃO: ${(prof as any).titulacao || "—"}
ÁREA DE EXPERTISE: ${(prof as any).area_expertise || "—"}
ESPECIALIDADES: ${especialidades.length ? especialidades.join(", ") : "—"}
ANOS DE PRÁTICA: ${(prof as any).anos_pratica ?? "—"}
ANOS DE DOCÊNCIA: ${(prof as any).anos_docencia ?? "—"}
PÓS-GRADUAÇÕES ONDE LECIONA: ${cursosNomes.length ? cursosNomes.join(", ") : "—"}

ATUAÇÃO PRÁTICA DE CAMPO (consultorias, fazendas/indústrias atendidas):
${atuacoesResumo || "—"}

EXPERIÊNCIAS PROFISSIONAIS:
${histResumo || "—"}
${anotacoes ? `\nANOTAÇÕES INTERNAS (contexto adicional confiável; não citar literalmente):\n${anotacoes}\n` : ""}
AULAS / EMENTAS VINCULADAS (conecte o que ele vai ENSINAR aqui com a experiência prática):
${aulasResumo || "—"}`;

  const aiResp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!aiResp.ok) {
    const t = await aiResp.text();
    console.error("Anthropic error (topicos)", aiResp.status, t);
    if (aiResp.status === 401) throw new Error("Chave Anthropic inválida. Atualize em /ia-config.");
    if (aiResp.status === 429) throw new Error("Limite de uso da Anthropic atingido. Tente novamente em alguns minutos.");
    throw new Error("Anthropic error " + aiResp.status + ": " + t.slice(0, 200));
  }

  const aiJson = await aiResp.json();
  const raw: string = aiJson.content?.[0]?.text ?? "";
  const topicos = parseTopicos(raw);
  if (topicos.length === 0) throw new Error("A IA não retornou tópicos válidos. Tente novamente.");

  const nowIso = new Date().toISOString();
  const { error: upErr } = await sb
    .from("ped_professores")
    .update({
      curriculo_topicos: topicos,
      curriculo_topicos_em: nowIso,
    })
    .eq("id", professor_id);
  if (upErr) throw new Error("Erro ao salvar tópicos: " + upErr.message);

  return { topicos, curriculo_topicos_em: nowIso };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const {
      professor_id,
      async: runAsync,
      pdf_base64,
      pdf_media_type,
      mode,
    } = await req.json();
    if (!professor_id) {
      return new Response(JSON.stringify({ error: "professor_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Modo "topicos": gera o currículo profissional em tópicos (síncrono).
    if (mode === "topicos") {
      const result = await generateTopicos(professor_id);
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (runAsync) {
      // @ts-ignore EdgeRuntime global presente em runtime do Supabase
      (globalThis as any).EdgeRuntime?.waitUntil
        ? // @ts-ignore
          (globalThis as any).EdgeRuntime.waitUntil(
            generateBio(professor_id, pdf_base64, pdf_media_type).catch(() => {})
          )
        : generateBio(professor_id, pdf_base64, pdf_media_type).catch(() => {});
      return new Response(JSON.stringify({ ok: true, status: "processing" }), {
        status: 202,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const result = await generateBio(professor_id, pdf_base64, pdf_media_type);
    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
