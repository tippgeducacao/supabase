// ============================================================================
// ASSISTENTE INTERNO (WhatsApp dos donos Rafael + Welinton) — edge standalone.
// 100% ISOLADO do comercial/João IA: linha própria (Uazapi), tabelas próprias
// (assistente_*), chave/modelo próprios. NUNCA escreve em crm_whatsapp_messages /
// sac_* / leads, nem chama crm-whatsapp-send. Deploy por git push (deploy-edges.yml).
// ============================================================================
import { getWaProvider } from "../_shared/waProviders.ts";
import {
  makeAdmin, canon, resolverDono, claimInbound, atualizarConteudoInbound, logMensagem, historicoRecente, tel,
  type Ctx,
} from "./db.ts";
import { carregarLinha, enviarTexto, baixarImagem, baixarAudioBytes, type LinhaWa } from "./wa.ts";
import { transcreverBytes } from "./transcrever.ts";
import { enfileirarTranscricao, processarTranscricoes } from "./transcricao.ts";
import { pensar } from "./brain.ts";

// Áudio maior que isto = REUNIÃO → pipeline Gemini em background (Whisper tem teto ~25MB).
const LIMITE_WHISPER = 20 * 1024 * 1024;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-secret",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (o: any, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "content-type": "application/json" } });

/** Hash curto e estável p/ chave de dedup quando a mensagem vem sem id. */
function hashCurto(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  const admin = makeAdmin();

  // Worker do cron: processa 1 job da fila de transcrição de reunião (gated pelo segredo do config).
  if (url.searchParams.get("cron") === "transcricao") {
    const { data: cfg } = await admin.from("assistente_config").select("cron_secret").eq("id", 1).maybeSingle();
    if (!cfg?.cron_secret || req.headers.get("x-assist-cron") !== cfg.cron_secret) return json({ error: "não autorizado" }, 401);
    try { return json({ ok: true, ...(await processarTranscricoes(admin)) }); }
    catch (e) { return json({ ok: false, erro: String(e) }); }
  }

  // Provisionamento da linha (quando o chip do Gustavo chegar). Gated por segredo.
  if (url.searchParams.get("admin")) return await adminAcao(req, url, admin);

  if (req.method === "GET") return new Response("assistente-interno ok · build 20260716b", { headers: cors });

  // Autenticação do webhook (anti-spoofing): se ASSIST_WEBHOOK_SECRET estiver setado, exige ?k igual.
  // O número declarado no payload NÃO é autenticação (quem POSTa controla msg.fromDigits).
  const segredoWebhook = Deno.env.get("ASSIST_WEBHOOK_SECRET");
  if (segredoWebhook && url.searchParams.get("k") !== segredoWebhook) {
    return json({ ok: true }); // silencioso — não revela nada
  }

  let payload: any = {};
  try { payload = await req.json(); } catch { /* tolerante */ }

  // Processa SÍNCRONO (EdgeRuntime.waitUntil é cortado no self-hosted) e sempre responde 200.
  try {
    await processarWebhook(admin, payload);
  } catch (e) {
    console.error("[assistente] webhook erro:", e);
  }
  return json({ ok: true });
});

async function processarWebhook(admin: any, payload: any) {
  const linha = await carregarLinha(admin);
  const provider = getWaProvider(linha?.provider || "uazapi");
  const parsed = provider.parseWebhook(payload);

  if (parsed.evento.includes("connection") && parsed.connection && linha) {
    await admin.from("assistente_wa_linha").update({
      status_conexao: parsed.connection.status,
      numero: parsed.connection.numero ?? linha.numero,
      atualizado_em: new Date().toISOString(),
    }).eq("id", linha.id);
    return;
  }

  for (const msg of parsed.messages) {
    if (msg.fromMe || msg.isGroup) continue;
    await processarMensagem(admin, linha, msg);
  }
}

async function processarMensagem(admin: any, linha: LinhaWa | null, msg: any) {
  // 1) GATE de allowlist — número fora dos donos é IGNORADO em silêncio (não responde, não grava).
  const c = canon(msg.fromDigits);
  if (!c) return;
  const dono = await resolverDono(admin, c);
  if (!dono) return;

  // 2) CLAIM (dedup robusto): grava a marca ANTES do processamento pesado; reentrega = ignora.
  const tipoIn = msg.tipo === "text" ? "texto" : String(msg.tipo || "texto");
  const msgKey = msg.externalId || `syn:${msg.fromDigits}:${msg.timestamp}:${hashCurto(msg.conteudo || "")}`;
  const claim = await claimInbound(admin, c, msgKey, tipoIn, msg.conteudo || "");
  if (claim.dup) return;

  const rodada = crypto.randomUUID();
  let texto: string = msg.conteudo || "";
  let tipo = tipoIn;
  let imagem: { base64: string; mime: string } | null = null;

  if (msg.tipo === "audio") {
    if (!linha) return;
    try {
      const { bytes, mime } = await baixarAudioBytes(linha, msg.externalId);
      if (bytes.length > 120 * 1024 * 1024) {
        await enviar(admin, linha, msg.fromDigits, c, "Esse áudio é grande demais (mais de ~2h) 😅. Me manda em partes que eu transcrevo cada uma.");
        return;
      }
      if (bytes.length > LIMITE_WHISPER) {
        // REUNIÃO (áudio longo) → transcrição em background (Gemini). Não segue pro cérebro.
        await enfileirarTranscricao(admin, { canon: c, numero: msg.fromDigits, linhaId: linha.id ?? null, bytes, mime });
        await atualizarConteudoInbound(admin, claim.id, "[áudio de reunião — transcrevendo]", "audio");
        await enviar(admin, linha, msg.fromDigits, c,
          "🎙️ Recebi seu áudio de reunião! Tô transcrevendo e resumindo (decisões + pontos de ação) — te devolvo aqui em alguns minutos. Pode seguir usando normal enquanto isso. 👍");
        return;
      }
      texto = await transcreverBytes(bytes, mime);
      tipo = "audio";
      await atualizarConteudoInbound(admin, claim.id, texto, "audio");
    } catch (e) {
      await tel(admin, c, rodada, "erro_transcricao", null, null, String(e));
      await enviar(admin, linha, msg.fromDigits, c,
        "Tive um problema pra processar esse áudio agora 😕. Pode reenviar? (Áudio de reunião grande TAMBÉM funciona — é só tentar de novo; ou me manda por texto.)");
      return;
    }
  } else if (msg.tipo === "image") {
    if (!linha) return;
    try {
      imagem = await baixarImagem(linha, msg.externalId);
      if (!imagem) throw new Error("download vazio");
      texto = (msg.conteudo || "").trim() || "(imagem sem legenda)";
      tipo = "image";
      await atualizarConteudoInbound(admin, claim.id, msg.conteudo?.trim() ? msg.conteudo : "[imagem]", "image");
    } catch (e) {
      await tel(admin, c, rodada, "erro_imagem", null, null, String(e));
      await enviar(admin, linha, msg.fromDigits, c, "Não consegui abrir essa imagem 😕. Pode reenviar?");
      return;
    }
  } else if (msg.tipo === "document") {
    // Documento/PDF (planejamento e reunião) = Fase 2. Imagem já funciona.
    await enviar(admin, linha, msg.fromDigits, c,
      "Recebi seu documento! 📎 Por enquanto leio texto, áudio e IMAGEM; documento/PDF (planejamento e reunião) chega na próxima fase.");
    return;
  } else if (msg.tipo !== "text") {
    return; // reaction/location/etc.
  }

  if (!texto.trim()) return;

  // linha/numero entram no ctx p/ as ferramentas que ENVIAM arquivo (ex.: gerar_pdf).
  const ctx: Ctx = { admin, dono, canon: c, rodada_id: rodada, linha, numero: msg.fromDigits };
  let resposta: string;
  const t0 = Date.now();
  try {
    const historico = await historicoRecente(admin, c);
    resposta = await pensar(ctx, historico, imagem);
    await tel(admin, c, rodada, "resposta", { chars: resposta.length }, Date.now() - t0, null);
  } catch (e) {
    await tel(admin, c, rodada, "erro", null, Date.now() - t0, String(e));
    resposta = "Tive um problema pra processar agora 😕. Pode tentar de novo?";
  }
  await enviar(admin, linha, msg.fromDigits, c, resposta);
}

async function enviar(admin: any, linha: LinhaWa | null, numeroDigits: string, canonDono: string, texto: string) {
  if (linha) {
    try { await enviarTexto(linha, numeroDigits, texto); }
    catch (e) { console.error("[assistente] envio falhou:", e); }
  }
  await logMensagem(admin, canonDono, "outbound", texto, "texto");
}

// ── Admin: provisionar a linha dedicada quando o número chegar ────────────────
async function adminAcao(req: Request, url: URL, admin: any): Promise<Response> {
  const segredo = Deno.env.get("ASSIST_ADMIN_SECRET");
  const dado = req.headers.get("x-admin-secret") || url.searchParams.get("secret");
  if (!segredo || dado !== segredo) return json({ error: "não autorizado" }, 401);

  const acao = url.searchParams.get("admin");
  const provider = getWaProvider("uazapi");
  const server = Deno.env.get("UAZAPI_SERVER_URL") || "";
  const adminToken = Deno.env.get("UAZAPI_ADMIN_TOKEN") || "";
  const webhookBase = Deno.env.get("WA_WEBHOOK_PUBLIC_BASE") || "https://api.ppgeducacao.site/functions/v1";

  try {
    if (acao === "criar_linha") {
      const inst = await provider.createInstance(server, adminToken, "assistente-interno");
      const { data: linha } = await admin.from("assistente_wa_linha").insert({
        provider: "uazapi", server_url: server, instancia_externa_id: inst.instanceId,
        instancia_nome: "assistente-interno", status_conexao: "desconectado",
      }).select().single();
      await admin.from("assistente_wa_secrets").insert({ linha_id: linha.id, token: inst.token });
      const k = Deno.env.get("ASSIST_WEBHOOK_SECRET");
      const webhookUrl = `${webhookBase}/assistente-interno-whatsapp?linha=${linha.id}${k ? `&k=${encodeURIComponent(k)}` : ""}`;
      await provider.setWebhook(server, inst.token!, webhookUrl, ["messages", "connection"]);
      return json({ ok: true, linha_id: linha.id, webhook: webhookUrl });
    }
    if (acao === "conectar") {
      const linha = await carregarLinha(admin);
      if (!linha) return json({ error: "linha não criada (rode admin=criar_linha antes)" }, 400);
      const r = await provider.connect(linha.server_url, linha.token);
      await admin.from("assistente_wa_linha").update({
        status_conexao: r.status, qrcode: r.qrcode, atualizado_em: new Date().toISOString(),
      }).eq("id", linha.id);
      return json({ ok: true, status: r.status, qrcode: r.qrcode, paircode: r.paircode });
    }
    if (acao === "status") {
      const linha = await carregarLinha(admin);
      if (!linha) return json({ error: "linha não criada" }, 400);
      const r = await provider.status(linha.server_url, linha.token);
      await admin.from("assistente_wa_linha").update({
        status_conexao: r.status, numero: r.numero ?? linha.numero, atualizado_em: new Date().toISOString(),
      }).eq("id", linha.id);
      return json({ ok: true, status: r.status, numero: r.numero });
    }
    return json({ error: "ação admin desconhecida (criar_linha|conectar|status)" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message });
  }
}
