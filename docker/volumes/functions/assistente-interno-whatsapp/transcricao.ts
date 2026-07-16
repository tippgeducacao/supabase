// Pipeline de TRANSCRIÇÃO DE REUNIÃO (áudio longo) — substitui o Plaud.
// Fila (assistente_transcricoes) + worker chamado por cron. Usa o Gemini File API
// (aguenta áudio de horas; o Whisper tem teto ~25MB e o inline do Gemini ~20MB).
// Roda em BACKGROUND porque a transcrição leva minutos (webhook não pode segurar).
import { carregarLinha, enviarTexto, enviarDocumento, type LinhaWa } from "./wa.ts";
import { extDeMime } from "./transcrever.ts";
import { gerarPdf } from "./documento.ts";

const BUCKET = "gt-doc-assets";
const PUBLIC_SUPABASE_URL = Deno.env.get("PUBLIC_SUPABASE_URL") || "https://api.ppgeducacao.site";
const toPublicUrl = (u: string) => u.replace(/^https?:\/\/(supabase-)?kong:8000/i, PUBLIC_SUPABASE_URL);
const GEMINI_MODEL = Deno.env.get("ASSIST_GEMINI_MODEL") || "gemini-2.5-flash";

const PROMPT_REUNIAO =
`Você recebeu o ÁUDIO de uma reunião interna da PPGVET Educação (educação/pós-graduação em veterinária).
Gere, em português do Brasil, um documento claro e FIEL ao áudio, com estas seções (use *negrito* nos títulos, estilo WhatsApp):

*Resumo* — 3 a 6 linhas do que foi tratado.
*Decisões* — o que ficou decidido (cada item numa linha com "- ").
*Pontos de ação* — o que fazer, com responsável e prazo QUANDO citados (linhas "- ").
*Tópicos discutidos* — principais assuntos (linhas "- ").
*Pendências / em aberto* — o que ficou sem resolver (linhas "- ").

Seja fiel: NÃO invente nomes, números ou decisões que não estão no áudio. Se algo não ficou audível/claro, diga.
Não faça introdução nem despedida — vá direto às seções.`;

// ── Fila ─────────────────────────────────────────────────────────────────────
export async function enfileirarTranscricao(
  admin: any,
  opts: { canon: string; numero: string; linhaId: string | null; bytes: Uint8Array; mime: string },
): Promise<void> {
  const path = `assistente/transcricao/${opts.canon}/${Date.now()}.${extDeMime(opts.mime)}`;
  const { error } = await admin.storage.from(BUCKET).upload(path, opts.bytes, {
    contentType: opts.mime || "audio/ogg", upsert: true,
  });
  if (error) throw new Error(`upload áudio: ${error.message}`);
  const mb = (opts.bytes.length / (1024 * 1024)).toFixed(0);
  await admin.from("assistente_transcricoes").insert({
    canon: opts.canon, numero: opts.numero, linha_id: opts.linhaId,
    storage_path: path, mime: opts.mime, duracao_hint: `${mb} MB`, status: "fila",
  });
}

// ── Worker (chamado pelo cron) ───────────────────────────────────────────────
export async function processarTranscricoes(admin: any): Promise<{ processado: number; erro?: string }> {
  const { data: jobs, error } = await admin.rpc("assistente_transcricao_claim");
  if (error) throw new Error(`claim: ${error.message}`);
  const job = (jobs ?? [])[0];
  if (!job) return { processado: 0 };

  const linha = await carregarLinha(admin);
  try {
    if (job.tentativas > 3) throw new Error("excedeu tentativas");

    const { data: file, error: dErr } = await admin.storage.from(BUCKET).download(job.storage_path);
    if (dErr || !file) throw new Error(`download storage: ${dErr?.message || "vazio"}`);
    const bytes = new Uint8Array(await file.arrayBuffer());

    const key = await googleKey(admin);
    if (!key) throw new Error("sem chave Google (Gemini)");
    const resultado = await transcreverReuniaoGemini(key, bytes, job.mime || "audio/ogg");

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
      await enviarTexto(linha, job.numero,
        "Não consegui transcrever essa reunião 😕. O áudio pode estar corrompido ou grande demais — tenta reenviar, ou me manda em partes.").catch(() => {});
    }
    return { processado: 0, erro: msg };
  }
}

/** Entrega o resultado: texto curto no chat; longo vira PDF. */
async function entregar(admin: any, linha: LinhaWa | null, job: any, resultado: string) {
  if (!linha || !job.numero) return;
  if (resultado.length <= 3500) {
    await enviarTexto(linha, job.numero, `🎙️ *Transcrição da reunião*\n\n${resultado}`).catch(() => {});
    return;
  }
  // longo → PDF
  try {
    const bytes = await gerarPdf("Transcrição da Reunião", resultado);
    const path = `assistente/${job.canon}/${Date.now()}-transcricao-reuniao.pdf`;
    await admin.storage.from(BUCKET).upload(path, bytes, { contentType: "application/pdf", upsert: true });
    const { data: pub } = admin.storage.from(BUCKET).getPublicUrl(path);
    await enviarDocumento(linha, job.numero, toPublicUrl(pub?.publicUrl ?? ""), "transcricao-reuniao.pdf", "Transcrição da reunião");
    await enviarTexto(linha, job.numero, "🎙️ Sua reunião ficou longa — mandei a transcrição completa em *PDF* aqui em cima. 👆").catch(() => {});
  } catch {
    // se o PDF falhar, manda o texto mesmo (fatiado)
    await enviarTexto(linha, job.numero, `🎙️ *Transcrição da reunião*\n\n${resultado.slice(0, 3500)}…`).catch(() => {});
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

async function transcreverReuniaoGemini(key: string, bytes: Uint8Array, mime: string): Promise<string> {
  const fileUri = await uploadEsperarAtivo(key, bytes, mime);
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [
          { file_data: { file_uri: fileUri, mime_type: mime } },
          { text: PROMPT_REUNIAO },
        ] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
      }),
    },
  );
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`gemini generate ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  const txt = (j?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("").trim();
  if (!txt) throw new Error("Gemini não devolveu texto");
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
