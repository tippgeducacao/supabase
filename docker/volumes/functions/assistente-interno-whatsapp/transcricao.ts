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

// RESUMO/ATA — o deliverable principal. Estruturado, FIEL e ANTI-REPETIÇÃO (o bug do loop).
const PROMPT_RESUMO =
`Você recebeu o ÁUDIO de uma reunião interna da PPGVET Educação (educação/pós-graduação em veterinária).
Produza, em português do Brasil, uma ATA de reunião clara, bem organizada e FIEL ao áudio — como uma
apresentação executiva: quem lê entende o CONTEXTO, o que foi DECIDIDO e exatamente o que cada um vai FAZER.

Use *asterisco* nos títulos das seções (negrito no WhatsApp). Estruture EXATAMENTE nesta ordem:

*Contexto*
2 a 5 linhas: sobre o que foi a reunião, quem participou (se citado) e o tema central.

*Principais pontos discutidos*
- Um bullet por assunto abordado, com 1 ou 2 frases explicando o que se falou (dê CONTEXTO, não só o título).

*Decisões (o que foi acordado)*
- Um bullet por decisão fechada na reunião. Se nada foi fechado, escreva "- Nada foi fechado nesta reunião.".

*Em aberto (a definir)*
- Um bullet por assunto que ficou pendente de decisão. Se não houver, escreva "- Nada ficou em aberto.".

*Tarefas por responsável*
Agrupe as ações POR PESSOA. Para cada pessoa, escreva o nome em *negrito* e, abaixo, as tarefas dela numa
lista NUMERADA (1., 2., 3.), cada uma com o prazo/data QUANDO citado. Exemplo:
*Adri*
1. <tarefa objetiva> (prazo: <quando>, se houver)
2. <outra tarefa>
Tarefa sem responsável claro vai sob "*A definir responsável*".

*Prazos e datas citados*
- Datas/eventos importantes mencionados (ex.: "05/08 - Dia do Médico Veterinário"). Omita a seção inteira se não houver nenhuma.

REGRAS (siga à risca):
- FIDELIDADE: não invente nomes, números, decisões, tarefas nem prazos. Se algo não ficou claro/audível, escreva "(não ficou claro no áudio)".
- SEM REPETIÇÃO: cada ponto, decisão ou tarefa aparece UMA ÚNICA VEZ. Se o mesmo assunto/tarefa foi repetido
  no áudio, CONSOLIDE numa linha só. NUNCA repita a mesma frase/linha. Se não há mais conteúdo para uma seção, ENCERRE-A.
- Se uma pessoa recebeu VÁRIAS sub-tarefas do mesmo tema (ex.: "várias etapas de um vídeo de disparo"),
  agrupe-as numa ou poucas linhas inteligentes — NÃO repita a mesma tarefa dezenas de vezes.
- Seja objetivo e completo. Não faça introdução nem despedida — comece direto no *Contexto*.`;

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

// generationConfig por tipo. maxOutputTokens ALTO (o antigo 8192 truncava) + temperatura mais
// solta no resumo (quebra o loop greedy) e baixíssima na transcrição (fidelidade verbatim).
const CFG_RESUMO = { temperature: 0.55, topP: 0.9, maxOutputTokens: 24000 };
const CFG_TRANSCRICAO = { temperature: 0.1, topP: 0.5, maxOutputTokens: 32000 };
const CFG_VIDEO = { temperature: 0.4, topP: 0.9, maxOutputTokens: 16000 };

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

// ── Worker (chamado pelo cron, 1 job por tick) ───────────────────────────────
export async function processarTranscricoes(admin: any): Promise<{ processado: number; erro?: string }> {
  const { data: jobs, error } = await admin.rpc("assistente_transcricao_claim");
  if (error) throw new Error(`claim: ${error.message}`);
  const job = (jobs ?? [])[0];
  if (!job) return { processado: 0 };

  const linha = await carregarLinha(admin);
  const tipo: string = job.tipo || "audio";
  try {
    if (job.tentativas > 3) throw new Error("excedeu tentativas");

    const { data: file, error: dErr } = await admin.storage.from(BUCKET).download(job.storage_path);
    if (dErr || !file) throw new Error(`download storage: ${dErr?.message || "vazio"}`);
    const bytes = new Uint8Array(await file.arrayBuffer());

    const key = await googleKey(admin);
    if (!key) throw new Error("sem chave Google (Gemini)");

    const promptBase = tipo === "video" ? PROMPT_VIDEO : tipo === "transcricao" ? PROMPT_TRANSCRICAO : PROMPT_RESUMO;
    const cfg = tipo === "video" ? CFG_VIDEO : tipo === "transcricao" ? CFG_TRANSCRICAO : CFG_RESUMO;
    // Instrução específica do dono só faz sentido no resumo/vídeo (a transcrição verbatim não "prioriza").
    const prompt = (tipo !== "transcricao") && job.instrucao && String(job.instrucao).trim()
      ? `${promptBase}\n\nO dono pediu especificamente: "${String(job.instrucao).trim()}" — priorize isso na análise.`
      : promptBase;

    const mime = job.mime || (tipo === "video" ? "video/mp4" : "audio/ogg");
    const resultado = await analisarGemini(key, bytes, mime, prompt, cfg);

    await admin.from("assistente_transcricoes")
      .update({ status: "pronto", resultado, erro: null, atualizado_em: new Date().toISOString() })
      .eq("id", job.id);

    await entregar(admin, linha, job, resultado);
    return { processado: 1 };
  } catch (e) {
    const msg = String(e);
    const desistir = (job.tentativas ?? 1) >= 3;
    await admin.from("assistente_transcricoes")
      .update({ status: desistir ? "erro" : "fila", erro: msg, atualizado_em: new Date().toISOString() })
      .eq("id", job.id);
    if (desistir && linha && job.numero) {
      await enviarTexto(linha, job.numero, msgErro(tipo)).catch(() => {});
    }
    return { processado: 0, erro: msg };
  }
}

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
    : { titulo: "🎙️ *Resumo da reunião*", pdfNome: "resumo-reuniao", pdfTitulo: "Resumo da Reunião",
        avisoPdf: "🎙️ Sua reunião rendeu — o *resumo* completo (com decisões e tarefas) está no *PDF* aqui em cima. 👆 A *transcrição* palavra por palavra chega em seguida.", semprePdf: false, histTipo: "transcricao" };

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
    const bytes = await gerarPdf(meta.pdfTitulo, resultado);
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

async function analisarGemini(
  key: string, bytes: Uint8Array, mime: string, prompt: string,
  cfg: Record<string, unknown> = CFG_RESUMO,
): Promise<string> {
  const fileUri = await uploadEsperarAtivo(key, bytes, mime);
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
        generationConfig: cfg,
      }),
    },
  );
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`gemini generate ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  const cand = j?.candidates?.[0];
  const txt = (cand?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("").trim();
  // finishReason MAX_TOKENS = cortou por limite. Com 24k-32k não deve acontecer, mas se acontecer
  // devolvemos o que veio (melhor um resumo longo do que erro); o loop antigo é o que sumiu.
  if (!txt) throw new Error(`Gemini não devolveu texto (finish=${cand?.finishReason ?? "?"})`);
  return txt;
}

/** Upload resumable + espera o arquivo virar ACTIVE (o Gemini processa o áudio). */
async function uploadEsperarAtivo(key: string, bytes: Uint8Array, mime: string): Promise<string> {
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
  const name = uj?.file?.name;      // "files/xxxx"
  const uri = uj?.file?.uri;
  let state = uj?.file?.state;
  if (!uri || !name) throw new Error(`Gemini upload falhou (${up.status})`);

  // espera ACTIVE (áudio longo demora a processar)
  for (let i = 0; i < 25 && state !== "ACTIVE"; i++) {
    if (state === "FAILED") throw new Error("Gemini falhou ao processar o áudio");
    await new Promise((r) => setTimeout(r, 2500));
    const g = await fetch(`${base}/v1beta/${name}?key=${key}`);
    state = (await g.json().catch(() => ({})))?.state;
  }
  if (state !== "ACTIVE") throw new Error("Gemini demorou demais processando o áudio");
  return uri;
}
