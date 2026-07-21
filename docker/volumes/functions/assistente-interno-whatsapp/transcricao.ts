// Pipeline de TRANSCRIÇÃO + RESUMO DE REUNIÃO (áudio longo) — substitui o Plaud.
// Fila (assistente_transcricoes) + worker chamado por cron. Usa o Gemini File API
// (aguenta áudio de horas; o Whisper tem teto ~25MB e o inline do Gemini ~20MB).
// Roda em BACKGROUND porque a transcrição leva minutos (webhook não pode segurar).
//
// ⚠️ REUNIÃO EM ÁUDIO = DOIS JOBS (mesmo upload no bucket, tipos diferentes):
//   1) tipo='audio'       → RESUMO/ATA estruturada (Contexto, Decisões, Tarefas por responsável…).
//   2) tipo='transcricao' → TRANSCRIÇÃO verbatim (palavra por palavra), entregue em PDF.
// Cada job faz UMA chamada Gemini no seu PRÓPRIO tick de cron → cabe no timeout de 100s
// mesmo em áudio de 1h+ (o resumo chega primeiro, a transcrição completa ~1 min depois).
// Antes era 1 job só, single-shot audio→resumo com maxOutputTokens=8192 → TRUNCAVA no meio
// da frase e o modelo entrava em LOOP de repetição (a "checklist toda repetida"). Corrigido.
import { carregarLinha, enviarTexto, enviarDocumento, type LinhaWa } from "./wa.ts";
import { extDeMime } from "./transcrever.ts";
import { gerarPdf } from "./documento.ts";
import { logMensagem } from "./db.ts";

const BUCKET = "gt-doc-assets";
const PUBLIC_SUPABASE_URL = Deno.env.get("PUBLIC_SUPABASE_URL") || "https://api.ppgeducacao.site";
const toPublicUrl = (u: string) => u.replace(/^https?:\/\/(supabase-)?kong:8000/i, PUBLIC_SUPABASE_URL);
const GEMINI_MODEL = Deno.env.get("ASSIST_GEMINI_MODEL") || "gemini-2.5-flash";

// RESUMO/ATA — o deliverable principal. Estruturado (ATA formal), FIEL e ANTI-REPETIÇÃO.
// ⚠️ O formato é o do WhatsApp (*Seção*, "- bullet", "1. item") porque o MESMO texto vai pro
// chat quando é curto e pro PDF quando é longo — o `documento.ts` traduz isso pro layout de ata.
const PROMPT_RESUMO =
`Você recebeu o ÁUDIO de uma reunião interna da PPGVET Educação (educação/pós-graduação em veterinária).
Produza, em português do Brasil, uma ATA DE REUNIÃO formal, organizada e FIEL ao áudio: quem lê precisa
entender o CONTEXTO, o que foi DECIDIDO, o que ficou EM ABERTO e exatamente o que cada pessoa vai FAZER.

Use *asterisco* nos títulos (negrito no WhatsApp). Estruture EXATAMENTE nesta ordem, com estes nomes:

*Identificação*
Assunto: <título curto e específico da reunião, no máximo 90 caracteres>
Participantes: <nomes citados no áudio, separados por vírgula; se ninguém for nomeado, escreva "não identificados no áudio">
Data citada: <data/dia mencionado na reunião; se não mencionarem, escreva "não citada">
Pauta principal: <em uma linha, o eixo central do que foi tratado>

*Resumo executivo*
3 a 6 linhas corridas (sem bullets) contando a reunião pra quem não estava lá: por que aconteceu,
o que se decidiu no geral e qual é o próximo movimento.

*Pauta e discussões*
Agrupe por TEMA (no MÁXIMO 8 temas). Para cada tema, escreva o nome do tema numa linha em *negrito*
(ex.: *1. Escola de Especialistas*) e, abaixo, de 2 a 5 bullets explicando o que se falou — com contexto,
não só o título. Junte no mesmo tema tudo que for do mesmo assunto, mesmo que tenha sido falado em
momentos diferentes do áudio.

*Decisões*
- Um bullet por decisão FECHADA na reunião. Se nada foi fechado, escreva "- Nada foi fechado nesta reunião.".

*Pendências (em aberto)*
- Um bullet por assunto que ficou sem definição, e (quando der) de quem depende. Se não houver, escreva "- Nada ficou em aberto.".

*Tarefas por responsável*
Agrupe as ações POR PESSOA. Nome da pessoa numa linha em *negrito* e, abaixo, as tarefas dela em lista
NUMERADA (1., 2., 3.), cada uma com o prazo/data QUANDO citado. Exemplo:
*Adriane*
1. <tarefa objetiva> (prazo: <quando>, se houver)
2. <outra tarefa>
Tarefa sem responsável claro vai sob "*A definir responsável*".

*Prazos e datas*
- Datas e eventos com data mencionados (ex.: "05/08 - Dia do Médico Veterinário"). Omita a seção inteira se não houver nenhum.

REGRAS (siga à risca):
- FIDELIDADE: não invente nomes, números, decisões, tarefas nem prazos. Se algo não ficou claro/audível, escreva "(não ficou claro no áudio)".
- SEM REPETIÇÃO: cada ponto, decisão ou tarefa aparece UMA ÚNICA VEZ. Se o assunto voltou várias vezes no
  áudio, CONSOLIDE numa linha só. NUNCA repita a mesma frase/linha. Se a seção acabou, ENCERRE-A e siga pra próxima.
- Se uma pessoa recebeu VÁRIAS sub-tarefas do mesmo tema, agrupe em uma ou poucas linhas inteligentes.
- Escreva frases completas e objetivas. Nada de introdução, despedida ou comentário seu — comece direto em *Identificação*.`;

// TRANSCRIÇÃO verbatim — palavra por palavra, sem resumir.
const PROMPT_TRANSCRICAO =
`Transcreva o ÁUDIO desta reunião na ÍNTEGRA, em português do Brasil, palavra por palavra — SEM resumir,
SEM comentar e SEM adicionar seções ou títulos.
- Identifique quem fala quando der pra reconhecer pela voz/contexto (ex.: "Rafael:", "Adri:"); se não der, use "Falante 1:", "Falante 2:".
- Quebre em parágrafos por fala/assunto, pra ficar legível.
- Se algum trecho estiver inaudível, marque "[inaudível]". NÃO invente conteúdo.
- NÃO repita frases: transcreva cada fala UMA única vez.
Comece direto pela transcrição.`;

const PROMPT_VIDEO =
`Você recebeu um VÍDEO enviado por um dos donos da PPGVET Educação (educação/pós-graduação em veterinária).
Analise em português do Brasil, de forma clara e FIEL ao que aparece (use *negrito* nos títulos, estilo WhatsApp):

*O que é o vídeo* — 2 a 4 linhas: tipo de vídeo (criativo/anúncio, gravação de reunião/aula, depoimento, clipe…) e o que mostra.
*Conteúdo* — o que acontece: cenas, pessoas, texto na tela, produto. Transcreva as falas relevantes se houver áudio.
*Análise* — se for CRIATIVO/anúncio: avalie gancho, clareza da mensagem, CTA e ritmo, e dê sugestões de melhoria. Se for
reunião/aula/fala: resuma pontos principais, decisões e ações (com responsável/prazo quando citados).

Seja fiel: NÃO invente. Se algo não estiver claro/audível, diga. Sem introdução nem despedida — vá direto às seções.`;

// generationConfig por tipo.
// ⚠️ `thinkingBudget` NÃO é firula: no gemini-2.5-flash o "pensamento" é DINÂMICO por padrão e os
// tokens de pensamento SAEM DO MESMO maxOutputTokens. Em reunião de 1h ele torrava ~22k dos 24k
// pensando e sobrava ~1,2k pro texto → a ata saía CORTADA no meio da frase (o PDF de 21/07) e a
// transcrição verbatim voltava VAZIA (finish=MAX_TOKENS). Com o teto explícito, o orçamento é do texto.
// Menos pensamento também deixa a geração MUITO mais rápida — é o que faz caber no tick de 100s.
const CFG_RESUMO = { temperature: 0.45, topP: 0.9, maxOutputTokens: 16000, thinkingConfig: { thinkingBudget: 2048 } };
const CFG_TRANSCRICAO = { temperature: 0.1, topP: 0.5, maxOutputTokens: 48000, thinkingConfig: { thinkingBudget: 0 } };
const CFG_VIDEO = { temperature: 0.4, topP: 0.9, maxOutputTokens: 12000, thinkingConfig: { thinkingBudget: 1024 } };

const MAX_TENTATIVAS = 5;          // upload e geração são passos separados → cabe mais retry
const URI_VALIDA_MS = 40 * 3600e3; // arquivo no Gemini expira em 48h; usamos folga de 40h

// ── Fila ─────────────────────────────────────────────────────────────────────
/** REUNIÃO em áudio: sobe o áudio no bucket UMA vez e cria 2 jobs (resumo + transcrição). */
export async function enfileirarReuniaoAudio(
  admin: any,
  opts: { canon: string; numero: string; linhaId: string | null; bytes: Uint8Array; mime: string },
): Promise<void> {
  const path = `assistente/audio/${opts.canon}/${Date.now()}.${extDeMime(opts.mime)}`;
  const { error } = await admin.storage.from(BUCKET).upload(path, opts.bytes, {
    contentType: opts.mime || "audio/ogg", upsert: true,
  });
  if (error) throw new Error(`upload audio: ${error.message}`);
  const mb = (opts.bytes.length / (1024 * 1024)).toFixed(0);
  const base = {
    canon: opts.canon, numero: opts.numero, linha_id: opts.linhaId,
    storage_path: path, mime: opts.mime, duracao_hint: `${mb} MB`, status: "fila", instrucao: null,
  };
  // Resumo PRIMEIRO (criado_em anterior → o claim [order by criado_em] o entrega antes da transcrição).
  await admin.from("assistente_transcricoes").insert({ ...base, tipo: "audio" });
  await admin.from("assistente_transcricoes").insert({ ...base, tipo: "transcricao" });
}

/** VÍDEO (ou uso genérico): 1 job só. */
export async function enfileirarTranscricao(
  admin: any,
  opts: {
    canon: string; numero: string; linhaId: string | null; bytes: Uint8Array; mime: string;
    tipo?: "audio" | "video" | "transcricao"; instrucao?: string | null;
  },
): Promise<void> {
  const tipo = opts.tipo ?? "audio";
  const path = `assistente/${tipo}/${opts.canon}/${Date.now()}.${extDeMime(opts.mime)}`;
  const { error } = await admin.storage.from(BUCKET).upload(path, opts.bytes, {
    contentType: opts.mime || (tipo === "video" ? "video/mp4" : "audio/ogg"), upsert: true,
  });
  if (error) throw new Error(`upload ${tipo}: ${error.message}`);
  const mb = (opts.bytes.length / (1024 * 1024)).toFixed(0);
  await admin.from("assistente_transcricoes").insert({
    canon: opts.canon, numero: opts.numero, linha_id: opts.linhaId,
    storage_path: path, mime: opts.mime, duracao_hint: `${mb} MB`, status: "fila",
    tipo, instrucao: opts.instrucao ?? null,
  });
}

// ── Worker (chamado pelo cron, 1 PASSO por tick) ─────────────────────────────
// Máquina de estado de 2 passos, porque download(65MB) + upload(65MB) + geração NÃO cabem juntos
// nos 100s do tick (era isso que fazia o job estourar tentativa e morrer):
//   passo 1 → sobe o áudio pro Gemini e GRAVA a uri (volta pra fila SEM contar tentativa)
//   passo 2 → gera o texto, com o tick inteiro só pra isso
// O job irmão (resumo ↔ transcrição do mesmo áudio) REUSA a uri: só um dos dois sobe o arquivo.
export async function processarTranscricoes(admin: any): Promise<{ processado: number; etapa?: string; erro?: string }> {
  const { data: jobs, error } = await admin.rpc("assistente_transcricao_claim");
  if (error) throw new Error(`claim: ${error.message}`);
  const job = (jobs ?? [])[0];
  if (!job) return { processado: 0 };

  const linha = await carregarLinha(admin);
  const tipo: string = job.tipo || "audio";
  try {
    if ((job.tentativas ?? 1) > MAX_TENTATIVAS) throw new Error("excedeu tentativas");

    const key = await googleKey(admin);
    if (!key) throw new Error("sem chave Google (Gemini)");

    const mime = job.mime || (tipo === "video" ? "video/mp4" : "audio/ogg");

    // ── passo 1: arquivo no Gemini ──
    let uri = uriAindaVale(job) ? job.gemini_file_uri : await uriDoJobIrmao(admin, job);
    if (!uri) {
      uri = await subirParaGemini(admin, key, job, mime);
      await admin.from("assistente_transcricoes").update({
        status: "fila",
        // desconta o claim: subir o arquivo é progresso, não falha.
        tentativas: Math.max(0, (job.tentativas ?? 1) - 1),
        atualizado_em: new Date().toISOString(),
      }).eq("id", job.id);
      return { processado: 0, etapa: "upload" };
    }
    if (uri !== job.gemini_file_uri) {
      await admin.from("assistente_transcricoes")
        .update({ gemini_file_uri: uri, gemini_uri_em: new Date().toISOString() }).eq("id", job.id);
    }

    // ── passo 2: geração ──
    const promptBase = tipo === "video" ? PROMPT_VIDEO : tipo === "transcricao" ? PROMPT_TRANSCRICAO : PROMPT_RESUMO;
    const cfg = tipo === "video" ? CFG_VIDEO : tipo === "transcricao" ? CFG_TRANSCRICAO : CFG_RESUMO;
    // Instrução específica do dono só faz sentido no resumo/vídeo (a transcrição verbatim não "prioriza").
    const prompt = (tipo !== "transcricao") && job.instrucao && String(job.instrucao).trim()
      ? `${promptBase}\n\nO dono pediu especificamente: "${String(job.instrucao).trim()}" — priorize isso na análise.`
      : promptBase;

    const resultado = await gerarComGemini(key, uri, mime, prompt, cfg);

    await admin.from("assistente_transcricoes")
      .update({ status: "pronto", resultado, erro: null, atualizado_em: new Date().toISOString() })
      .eq("id", job.id);

    await entregar(admin, linha, job, resultado);
    return { processado: 1, etapa: "gerado" };
  } catch (e) {
    const msg = String(e);
    // Arquivo sumiu/expirou no Gemini → esquece a uri e a próxima tentativa sobe de novo.
    const patch: Record<string, unknown> = { erro: msg, atualizado_em: new Date().toISOString() };
    if (/\b(403|404)\b|PERMISSION_DENIED|NOT_FOUND|File .* not found/i.test(msg)) {
      patch.gemini_file_uri = null; patch.gemini_uri_em = null;
    }
    const desistir = (job.tentativas ?? 1) >= MAX_TENTATIVAS;
    patch.status = desistir ? "erro" : "fila";
    await admin.from("assistente_transcricoes").update(patch).eq("id", job.id);
    if (desistir && linha && job.numero) {
      await enviarTexto(linha, job.numero, msgErro(tipo)).catch(() => {});
    }
    return { processado: 0, erro: msg };
  }
}

const uriAindaVale = (job: any): boolean =>
  !!job.gemini_file_uri && !!job.gemini_uri_em &&
  (Date.now() - new Date(job.gemini_uri_em).getTime()) < URI_VALIDA_MS;

/** O mesmo áudio gera 2 jobs (resumo + transcrição): o segundo aproveita o upload do primeiro. */
async function uriDoJobIrmao(admin: any, job: any): Promise<string | null> {
  const { data } = await admin.from("assistente_transcricoes")
    .select("gemini_file_uri, gemini_uri_em")
    .eq("storage_path", job.storage_path)
    .not("gemini_file_uri", "is", null)
    .gt("gemini_uri_em", new Date(Date.now() - URI_VALIDA_MS).toISOString())
    .order("gemini_uri_em", { ascending: false })
    .limit(1).maybeSingle();
  return data?.gemini_file_uri ?? null;
}

async function subirParaGemini(admin: any, key: string, job: any, mime: string): Promise<string> {
  const { data: file, error } = await admin.storage.from(BUCKET).download(job.storage_path);
  if (error || !file) throw new Error(`download storage: ${error?.message || "vazio"}`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { uri } = await uploadGemini(key, bytes, mime);
  await admin.from("assistente_transcricoes")
    .update({ gemini_file_uri: uri, gemini_uri_em: new Date().toISOString() }).eq("id", job.id);
  return uri;
}

const fmtDataHoraSP = (iso: string | null | undefined): string => {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });
};

function msgErro(tipo: string): string {
  if (tipo === "video") return "Não consegui analisar esse vídeo 😕. O arquivo pode estar grande demais — tenta reenviar, ou me manda mais curto.";
  if (tipo === "transcricao") return "Tive um problema pra gerar a *transcrição completa* dessa reunião 😕. O resumo eu já te mandei; se quiser a transcrição palavra por palavra, é só reenviar o áudio.";
  return "Consegui receber a reunião, mas tropecei pra montar o *resumo* 😕. Reenvia que eu tento de novo (reunião grande também funciona).";
}

/** Entrega o resultado no WhatsApp: resumo/vídeo = texto curto ou PDF; transcrição = sempre PDF. */
async function entregar(admin: any, linha: LinhaWa | null, job: any, resultado: string) {
  const tipo: string = job.tipo || "audio";
  const meta = tipo === "video"
    ? { titulo: "🎬 *Análise do vídeo*", pdfNome: "analise-video", pdfTitulo: "Análise do Vídeo",
        avisoPdf: "🎬 Seu vídeo rendeu bastante — mandei a análise completa em *PDF* aqui em cima. 👆", semprePdf: false, histTipo: "video_analise" }
    : tipo === "transcricao"
    ? { titulo: "📝 *Transcrição completa da reunião*", pdfNome: "transcricao-reuniao", pdfTitulo: "Transcrição Completa da Reunião",
        avisoPdf: "📝 A *transcrição completa* (palavra por palavra) da reunião está no *PDF* aqui em cima. 👆", semprePdf: true, histTipo: "transcricao" }
    : { titulo: "🎙️ *Ata da reunião*", pdfNome: "ata-reuniao", pdfTitulo: "Ata de Reunião",
        avisoPdf: "🎙️ Montei a *ata da reunião* — resumo executivo, decisões, pendências e as tarefas de cada um estão no *PDF* aqui em cima. 👆 A *transcrição* palavra por palavra chega em seguida.", semprePdf: false, histTipo: "transcricao" };

  // Registra no HISTÓRICO da conversa, senão o bot não "lembra" (ex.: dono pede depois "faz um PDF disso").
  // ⚠️ A transcrição VERBATIM é enorme (1h ~15k tokens) → NUNCA vai crua pro histórico (estouraria o
  // contexto do Opus a cada turno). Loga um marcador curto; o texto útil (resumo) já foi logado à parte.
  const histTexto = tipo === "transcricao"
    ? "[Transcrição completa da reunião enviada em PDF]"
    : resultado;
  await logMensagem(admin, job.canon, "outbound", histTexto, meta.histTipo).catch(() => {});
  if (!linha || !job.numero) return;

  if (!meta.semprePdf && resultado.length <= 3500) {
    await enviarTexto(linha, job.numero, `${meta.titulo}\n\n${resultado}`).catch(() => {});
    return;
  }
  // longo (ou transcrição) → PDF
  try {
    const bytes = await gerarPdf(meta.pdfTitulo, resultado, {
      subtitulo: `PPGVET Educacao  ·  registrada em ${fmtDataHoraSP(job.criado_em)}`,
      // O bloco *Identificação* que o modelo escreve (Assunto/Participantes/…) entra logo abaixo destas.
      info: [["Registrada em", fmtDataHoraSP(job.criado_em)], ["Áudio", String(job.duracao_hint || "")]],
    });
    const path = `assistente/${job.canon}/${Date.now()}-${meta.pdfNome}.pdf`;
    await admin.storage.from(BUCKET).upload(path, bytes, { contentType: "application/pdf", upsert: true });
    const { data: pub } = admin.storage.from(BUCKET).getPublicUrl(path);
    await enviarDocumento(linha, job.numero, toPublicUrl(pub?.publicUrl ?? ""), `${meta.pdfNome}.pdf`, meta.pdfTitulo);
    await enviarTexto(linha, job.numero, meta.avisoPdf).catch(() => {});
  } catch {
    await enviarTexto(linha, job.numero, `${meta.titulo}\n\n${resultado.slice(0, 3500)}…`).catch(() => {});
  }
}

// ── Gemini File API ──────────────────────────────────────────────────────────
async function googleKey(admin: any): Promise<string | null> {
  const env = Deno.env.get("ASSIST_GEMINI_KEY") || Deno.env.get("GOOGLE_API_KEY");
  if (env) return env;
  const { data } = await admin.from("ai_api_keys").select("api_key")
    .eq("provider", "google").eq("is_active", true).limit(1).maybeSingle();
  return data?.api_key ?? null;
}

/** Gera o texto a partir de um arquivo JÁ enviado ao Gemini (passo 2 do worker). */
async function gerarComGemini(
  key: string, fileUri: string, mime: string, prompt: string,
  cfg: Record<string, unknown>,
): Promise<string> {
  await esperarAtivo(key, fileUri, 40_000);

  const chamar = async (generationConfig: Record<string, unknown>) => {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [
            { file_data: { file_uri: fileUri, mime_type: mime } },
            { text: prompt },
          ] }],
          generationConfig,
        }),
      },
    );
    const j = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, j };
  };

  let { ok, status, j } = await chamar(cfg);
  // Modelo sem suporte a "thinking" (se trocarem o ASSIST_GEMINI_MODEL) devolve 400 → repete sem o campo.
  if (!ok && status === 400 && "thinkingConfig" in cfg && /thinking/i.test(JSON.stringify(j))) {
    const { thinkingConfig: _drop, ...semThinking } = cfg as Record<string, unknown>;
    ({ ok, status, j } = await chamar(semThinking));
  }
  if (!ok) throw new Error(`gemini generate ${status}: ${JSON.stringify(j).slice(0, 200)}`);

  const cand = j?.candidates?.[0];
  const txt = (cand?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("").trim();
  // Vazio + MAX_TOKENS = o orçamento foi todo pro "pensamento" (era o bug da transcrição).
  // Melhor estourar e retentar do que entregar nada.
  if (!txt) throw new Error(`Gemini não devolveu texto (finish=${cand?.finishReason ?? "?"})`);
  return txt;
}

/** Upload resumable. Espera ACTIVE só um pouco: se demorar, o próximo tick espera o resto. */
async function uploadGemini(key: string, bytes: Uint8Array, mime: string): Promise<{ uri: string }> {
  const base = "https://generativelanguage.googleapis.com";
  const start = await fetch(`${base}/upload/v1beta/files?key=${key}`, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.length),
      "X-Goog-Upload-Header-Content-Type": mime,
      "content-type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: "reuniao" } }),
  });
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error(`Gemini upload start falhou (${start.status})`);

  const up = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Length": String(bytes.length), "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
    body: bytes,
  });
  const uj = await up.json().catch(() => ({}));
  const uri = uj?.file?.uri;
  if (!uri) throw new Error(`Gemini upload falhou (${up.status})`);
  await esperarAtivo(key, uri, 20_000).catch(() => {}); // best-effort; quem cobra é o passo 2
  return { uri };
}

/** O Gemini processa o áudio antes de liberar (state PROCESSING → ACTIVE). */
async function esperarAtivo(key: string, fileUri: string, limiteMs: number): Promise<void> {
  const ate = Date.now() + limiteMs;
  let state = "";
  while (Date.now() < ate) {
    const g = await fetch(`${fileUri}?key=${key}`);
    state = (await g.json().catch(() => ({})))?.state ?? "";
    if (state === "ACTIVE") return;
    if (state === "FAILED") throw new Error("Gemini falhou ao processar o arquivo");
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error(`Gemini ainda processando o arquivo (state=${state || "?"})`);
}
