// _shared/waProviders.ts
// ----------------------------------------------------------------------------
// Camada provider-AGNÓSTICA de WhatsApp. O resto do sistema (edge functions,
// banco, front) NÃO conhece "Uazapi": conhece a interface WaProvider. Trocar de
// API ("WhatsApp-Web-like") = escrever outro objeto que implementa WaProvider e
// registrá-lo em PROVIDERS. Zero mudança de schema, zero mudança de UI.
//
// Hoje só existe o adapter 'uazapi' (uazapiGO V2). Endpoints derivados da doc:
//   POST  /instance/create      header admintoken   body {name}            -> {token, instance:{...}}
//   POST  /instance/connect     header token        body {}                -> {instance:{qrcode,paircode,status}}
//   GET   /instance/status      header token                               -> {instance:{status,...}}
//   POST  /instance/disconnect  header token
//   DELETE /instance            header token
//   POST  /webhook              header token        body {url,events,...}  (modo simples)
//   POST  /send/text            header token        body {number,text}
//   POST  /send/media           header token        body {number,type,file,text?,docName?}
//
// ⚠️ O SHAPE do webhook de mensagem da Uazapi é confirmado via LOG-FIRST
// (wa_webhook_log). parseInboundMessage é tolerante a vários nomes de campo e
// pode ser refinado sobre dados reais sem tocar no resto.
// ----------------------------------------------------------------------------

export type WaStatus = "conectado" | "conectando" | "desconectado";

export interface WaInstanceInfo {
  instanceId: string | null;
  token: string | null;
  status: WaStatus;
  qrcode?: string | null;
  paircode?: string | null;
  numero?: string | null;
}

export interface WaInboundMessage {
  externalId: string | null;
  fromDigits: string; // remetente só com dígitos (sem @s.whatsapp.net)
  fromMe: boolean;
  isGroup: boolean;
  tipo: string; // text|image|audio|video|document|sticker|reaction|location|unknown
  conteudo: string; // texto OU placeholder ([imagem], [áudio]...)
  caption: string;
  mediaUrl?: string | null; // URL da mídia para baixar (se o provider mandar)
  mediaBase64?: string | null; // OU base64 inline (se o provider mandar)
  mediaMime?: string | null;
  mediaFilename?: string | null;
  senderName?: string | null;
  timestamp: number; // epoch seconds
}

export interface WaConnectionEvent {
  status: WaStatus;
  numero?: string | null;
  motivo?: string | null;
}

export interface WaParsedWebhook {
  evento: string; // messages | connection | messages_update | desconhecido
  messages: WaInboundMessage[];
  connection: WaConnectionEvent | null;
}

export interface WaSendResult {
  externalId: string | null;
  ok: boolean;
  raw: unknown;
}

export interface WaProvider {
  readonly name: string;
  /** Cria a instância (precisa do admin token do servidor). */
  createInstance(serverUrl: string, adminToken: string, nome: string): Promise<WaInstanceInfo>;
  /** Configura o webhook da instância (modo simples: 1 webhook por instância). */
  setWebhook(serverUrl: string, token: string, url: string, events: string[]): Promise<void>;
  /** Gera o QR / inicia a conexão. */
  connect(serverUrl: string, token: string): Promise<WaInstanceInfo>;
  /** Lê o status atual da instância. */
  status(serverUrl: string, token: string): Promise<WaInstanceInfo>;
  /** Desconecta (logout) sem deletar a instância. */
  disconnect(serverUrl: string, token: string): Promise<void>;
  /** Deleta a instância no servidor. */
  deleteInstance(serverUrl: string, token: string): Promise<void>;
  /** Envia texto. `numberDigits` = só dígitos com DDI (ex.: 5546...). */
  sendText(serverUrl: string, token: string, numberDigits: string, text: string): Promise<WaSendResult>;
  /** Envia mídia por URL pública. */
  sendMedia(
    serverUrl: string,
    token: string,
    numberDigits: string,
    opts: { tipo: string; url: string; caption?: string; filename?: string; mime?: string },
  ): Promise<WaSendResult>;
  /** Edita o texto de uma mensagem já enviada (prazo do WhatsApp ~15 min). */
  editMessage(serverUrl: string, token: string, externalId: string, text: string): Promise<WaSendResult>;
  /** Apaga uma mensagem PARA TODOS. */
  deleteMessage(serverUrl: string, token: string, externalId: string): Promise<{ ok: boolean; raw: unknown }>;
  /** Reage a uma mensagem (emoji). emoji vazio remove a reação. */
  sendReaction(
    serverUrl: string,
    token: string,
    numberDigits: string,
    targetExternalId: string,
    emoji: string,
  ): Promise<WaSendResult>;
  /** Baixa/decripta a mídia de uma mensagem; devolve URL pública (válida ~2 dias) e/ou base64. */
  downloadMedia(
    serverUrl: string,
    token: string,
    externalId: string,
    opts?: { audioMp3?: boolean },
  ): Promise<{ url: string | null; mime: string | null; base64: string | null }>;
  /** Normaliza um payload de webhook. Sempre tolerante: nunca lança. */
  parseWebhook(payload: any): WaParsedWebhook;
  /** Host(s) de onde é seguro baixar mídia inbound (anti-SSRF). */
  isAllowedMediaHost(url: string, serverUrl: string): boolean;
}

// ── helpers ─────────────────────────────────────────────────────────────────
function trimSlash(u: string): string {
  return (u ?? "").replace(/\/+$/, "");
}

function onlyDigits(raw: unknown): string {
  return String(raw ?? "").replace(/\D/g, "");
}

/** "5546...@s.whatsapp.net" / "...@g.us" -> só os dígitos. */
function jidToDigits(jid: unknown): string {
  const s = String(jid ?? "");
  const at = s.indexOf("@");
  return onlyDigits(at >= 0 ? s.slice(0, at) : s);
}

function isGroupJid(jid: unknown): boolean {
  return String(jid ?? "").includes("@g.us") || String(jid ?? "").includes("-");
}

function pick<T = any>(obj: any, paths: string[]): T | undefined {
  for (const p of paths) {
    const parts = p.split(".");
    let cur = obj;
    let ok = true;
    for (const k of parts) {
      if (cur == null || typeof cur !== "object" || !(k in cur)) { ok = false; break; }
      cur = cur[k];
    }
    if (ok && cur !== undefined && cur !== null) return cur as T;
  }
  return undefined;
}

function mapUazapiStatus(raw: unknown): WaStatus {
  const s = String(raw ?? "").toLowerCase();
  if (s === "connected" || s === "open" || s === "conectado") return "conectado";
  if (s === "connecting" || s === "conectando" || s === "qr" || s === "pairing") return "conectando";
  return "desconectado";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function uazFetch(
  serverUrl: string,
  path: string,
  method: string,
  headers: Record<string, string>,
  body?: unknown,
  opts?: { timeoutMs?: number; retries?: number },
): Promise<{ ok: boolean; status: number; json: any }> {
  const timeoutMs = opts?.timeoutMs ?? 20000;
  const retries = Math.max(0, opts?.retries ?? 0);
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${trimSlash(serverUrl)}${path}`, {
        method,
        headers: { Accept: "application/json", "Content-Type": "application/json", ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      // Resposta HTTP recebida (mesmo 4xx/5xx) → retorna. NÃO faz retry aqui: o servidor
      // recebeu a requisição, então reenviar poderia DUPLICAR a mensagem.
      const json = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, json };
    } catch (e) {
      // Só cai aqui em erro de REDE/timeout (sem resposta) — provável que o envio não
      // completou; retry é seguro. Backoff curto e crescente.
      lastErr = e;
      if (attempt < retries) { await sleep(700 * (attempt + 1)); continue; }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr; // inalcançável, satisfaz o tipo
}

// ── Adapter Uazapi (uazapiGO V2) ──────────────────────────────────────────────
const uazapi: WaProvider = {
  name: "uazapi",

  async createInstance(serverUrl, adminToken, nome) {
    const r = await uazFetch(serverUrl, "/instance/create", "POST", { admintoken: adminToken }, { name: nome });
    if (!r.ok) throw new Error(`uazapi create falhou (${r.status}): ${JSON.stringify(r.json).slice(0, 300)}`);
    const inst = r.json?.instance ?? r.json ?? {};
    return {
      instanceId: pick<string>(r.json, ["instance.id", "id"]) ?? null,
      // a doc devolve token no topo E em instance.token; preferimos o de instance (da instância criada)
      token: pick<string>(r.json, ["instance.token", "token"]) ?? null,
      status: mapUazapiStatus(inst?.status),
      qrcode: inst?.qrcode ?? null,
      paircode: inst?.paircode ?? null,
      numero: pick<string>(inst, ["owner"]) ? onlyDigits(inst.owner) : null,
    };
  },

  async setWebhook(serverUrl, token, url, events) {
    const r = await uazFetch(serverUrl, "/webhook", "POST", { token }, {
      enabled: true,
      url,
      events,
      // wasSentByApi: não receber de volta as próprias mensagens enviadas pela API (loop).
      // isGroupYes: linhas pessoais de SDR atendem 1:1 — grupos só poluiriam o inbox.
      excludeMessages: ["wasSentByApi", "isGroupYes"],
    });
    if (!r.ok) throw new Error(`uazapi webhook falhou (${r.status}): ${JSON.stringify(r.json).slice(0, 300)}`);
  },

  async connect(serverUrl, token) {
    const r = await uazFetch(serverUrl, "/instance/connect", "POST", { token }, {});
    if (!r.ok) throw new Error(`uazapi connect falhou (${r.status}): ${JSON.stringify(r.json).slice(0, 300)}`);
    const inst = r.json?.instance ?? r.json ?? {};
    return {
      instanceId: pick<string>(r.json, ["instance.id", "id"]) ?? null,
      token: pick<string>(r.json, ["instance.token", "token"]) ?? token,
      status: mapUazapiStatus(inst?.status),
      qrcode: inst?.qrcode ?? r.json?.qrcode ?? null,
      paircode: inst?.paircode ?? r.json?.paircode ?? null,
      numero: inst?.owner ? onlyDigits(inst.owner) : null,
    };
  },

  async status(serverUrl, token) {
    const r = await uazFetch(serverUrl, "/instance/status", "GET", { token });
    const inst = r.json?.instance ?? r.json ?? {};
    return {
      instanceId: pick<string>(r.json, ["instance.id", "id"]) ?? null,
      token,
      status: mapUazapiStatus(inst?.status),
      qrcode: inst?.qrcode ?? null,
      paircode: inst?.paircode ?? null,
      numero: inst?.owner ? onlyDigits(inst.owner) : null,
    };
  },

  async disconnect(serverUrl, token) {
    await uazFetch(serverUrl, "/instance/disconnect", "POST", { token }, {});
  },

  async deleteInstance(serverUrl, token) {
    await uazFetch(serverUrl, "/instance", "DELETE", { token });
  },

  async sendText(serverUrl, token, numberDigits, text) {
    const r = await uazFetch(serverUrl, "/send/text", "POST", { token }, { number: numberDigits, text }, { timeoutMs: 12000, retries: 1 });
    return {
      externalId: pick<string>(r.json, ["messageid", "id", "key.id", "message.key.id", "message.id"]) ?? null,
      ok: r.ok,
      raw: r.json,
    };
  },

  async sendMedia(serverUrl, token, numberDigits, opts) {
    // uazapiGO: type aceita image|video|audio|ptt|document|myfile. Mapeamos a partir do nosso tipo.
    const typeMap: Record<string, string> = {
      image: "image",
      video: "video",
      audio: "audio",
      document: "document",
      sticker: "image",
    };
    const r = await uazFetch(serverUrl, "/send/media", "POST", { token }, {
      number: numberDigits,
      type: typeMap[opts.tipo] ?? "document",
      file: opts.url,
      ...(opts.caption ? { text: opts.caption } : {}),
      ...(opts.filename ? { docName: opts.filename } : {}),
    }, { timeoutMs: 20000, retries: 1 });
    return {
      externalId: pick<string>(r.json, ["messageid", "id", "key.id", "message.key.id", "message.id"]) ?? null,
      ok: r.ok,
      raw: r.json,
    };
  },

  async editMessage(serverUrl, token, externalId, text) {
    const r = await uazFetch(serverUrl, "/message/edit", "POST", { token }, { id: externalId, text });
    return { externalId: pick<string>(r.json, ["messageid", "id"]) ?? externalId, ok: r.ok, raw: r.json };
  },

  async deleteMessage(serverUrl, token, externalId) {
    const r = await uazFetch(serverUrl, "/message/delete", "POST", { token }, { id: externalId });
    return { ok: r.ok, raw: r.json };
  },

  async sendReaction(serverUrl, token, numberDigits, targetExternalId, emoji) {
    const r = await uazFetch(serverUrl, "/message/react", "POST", { token }, {
      number: numberDigits,
      text: emoji, // string vazia remove a reação
      id: targetExternalId,
    }, { timeoutMs: 12000, retries: 1 });
    return {
      externalId: pick<string>(r.json, ["messageid", "id", "reaction.id"]) ?? null,
      ok: r.ok,
      raw: r.json,
    };
  },

  async downloadMedia(serverUrl, token, externalId, opts) {
    // /message/download decripta a mídia (Uazapi guarda ~2 dias) e devolve fileURL público.
    const r = await uazFetch(serverUrl, "/message/download", "POST", { token }, {
      id: externalId,
      return_link: true,
      return_base64: false,
      generate_mp3: opts?.audioMp3 ?? true,
      transcribe: false,
    });
    return {
      url: pick<string>(r.json, ["fileURL", "url", "link"]) ?? null,
      mime: pick<string>(r.json, ["mimetype", "mime_type"]) ?? null,
      base64: pick<string>(r.json, ["base64Data", "base64"]) ?? null,
    };
  },

  parseWebhook(payload: any): WaParsedWebhook {
    const evento = String(
      pick<string>(payload, ["event", "EventType", "type"]) ?? "desconhecido",
    ).toLowerCase();

    const out: WaParsedWebhook = { evento, messages: [], connection: null };

    // ── connection ──────────────────────────────────────────────────────────
    if (evento.includes("connection")) {
      const st = pick(payload, [
        "status",
        "instance.status",
        "connection",
        "data.status",
        "state",
      ]);
      out.connection = {
        status: mapUazapiStatus(st),
        numero: (() => {
          const owner = pick<string>(payload, ["instance.owner", "owner", "data.owner"]);
          return owner ? onlyDigits(owner) : null;
        })(),
        motivo: pick<string>(payload, ["instance.lastDisconnectReason", "reason", "data.reason"]) ?? null,
      };
      return out;
    }

    // ── messages (1 mensagem por evento, no formato uazapiGO) ──────────────────
    // Tolerante: a mensagem pode vir em `message`, `data`, `messages[0]` ou na raiz.
    const m =
      pick<any>(payload, ["message", "data.message", "data"]) ??
      (Array.isArray(payload?.messages) ? payload.messages[0] : null) ??
      payload;

    if (m && typeof m === "object") {
      const chatJid = pick(m, ["chatid", "chatId", "key.remoteJid", "remoteJid", "jid", "from", "sender"]);
      const fromMe = Boolean(pick(m, ["fromMe", "key.fromMe", "from_me"]));
      const tipoRaw = String(pick(m, ["messageType", "type", "mediaType"]) ?? "").toLowerCase();
      const parsed = normalizeUazapiMessageType(m, tipoRaw);
      out.messages.push({
        externalId: pick<string>(m, ["messageid", "id", "key.id", "message.key.id"]) ?? null,
        // fromDigits = CONTATO da conversa (chatid). Em 1:1 é a outra ponta nas
        // duas direções; no fromMe o `sender` é o PRÓPRIO número do SDR — usá-lo
        // bagunçaria a thread. Grupos são descartados (isGroup) no webhook.
        // sender_pn = telefone real (em grupo o `sender` é um @lid, não telefone).
        fromDigits: jidToDigits(chatJid ?? pick(m, ["sender_pn", "sender", "senderJid", "from"])),
        fromMe,
        isGroup: isGroupJid(chatJid),
        tipo: parsed.tipo,
        conteudo: parsed.conteudo,
        caption: parsed.caption,
        mediaUrl: parsed.mediaUrl,
        mediaBase64: parsed.mediaBase64,
        mediaMime: parsed.mediaMime,
        mediaFilename: parsed.mediaFilename,
        senderName: pick<string>(m, ["senderName", "pushName", "notifyName", "verifiedName"]) ?? null,
        timestamp: Number(pick(m, ["messageTimestamp", "timestamp", "t"])) || Math.floor(Date.now() / 1000),
      });
    }
    return out;
  },

  isAllowedMediaHost(url: string, serverUrl: string): boolean {
    try {
      const h = new URL(url).hostname.toLowerCase();
      const server = new URL(serverUrl).hostname.toLowerCase();
      // mídia da própria Uazapi (mesmo host do servidor) ou subdomínios uazapi
      return h === server || h.endsWith(".uazapi.com") || h.endsWith("uazapi.com");
    } catch {
      return false;
    }
  },
};

/** Deriva tipo + conteúdo/placeholder + mídia de uma mensagem uazapiGO (tolerante a campos). */
function normalizeUazapiMessageType(m: any, tipoRaw: string): {
  tipo: string; conteudo: string; caption: string;
  mediaUrl: string | null; mediaBase64: string | null; mediaMime: string | null; mediaFilename: string | null;
} {
  // NÃO incluir "content" aqui: em mídia, message.content é o OBJETO da mídia
  // (não texto). O texto da Uazapi vive em message.text.
  const text =
    pick<string>(m, ["text", "body", "conversation", "message.conversation", "message.extendedTextMessage.text"]) ?? "";
  const caption = pick<string>(m, ["caption", "content.caption", "message.imageMessage.caption", "message.videoMessage.caption"]) ?? "";
  // ⚠️ Uazapi manda mídia criptografada (content.directPath + mediaKey); content.URL
  // é stub ("https://a.whatsapp.net"). Baixar de verdade exige o endpoint de download
  // da Uazapi (follow-up). Por ora só nome/mime p/ o placeholder.
  const mediaUrl = pick<string>(m, ["file", "fileURL", "url", "mediaUrl", "downloadUrl"]) ?? null;
  const mediaBase64 = pick<string>(m, ["fileBase64", "base64", "media"]) ?? null;
  const mediaMime = pick<string>(m, ["mimetype", "mimeType", "mime_type", "content.mimetype"]) ?? null;
  const mediaFilename = pick<string>(m, ["fileName", "filename", "docName", "content.fileName", "content.title"]) ?? null;

  const has = (...needles: string[]) => needles.some((n) => tipoRaw.includes(n)) ||
    (mediaMime ? needles.some((n) => mediaMime!.toLowerCase().includes(n)) : false);

  if (has("image", "imagemessage")) return { tipo: "image", conteudo: caption || "[imagem]", caption, mediaUrl, mediaBase64, mediaMime, mediaFilename };
  if (has("video", "videomessage")) return { tipo: "video", conteudo: caption || "[vídeo]", caption, mediaUrl, mediaBase64, mediaMime, mediaFilename };
  if (has("audio", "ptt", "audiomessage")) return { tipo: "audio", conteudo: "[áudio]", caption: "", mediaUrl, mediaBase64, mediaMime, mediaFilename };
  if (has("document", "documentmessage")) return { tipo: "document", conteudo: mediaFilename || "[documento]", caption, mediaUrl, mediaBase64, mediaMime, mediaFilename };
  if (has("sticker", "stickermessage")) return { tipo: "sticker", conteudo: "[sticker]", caption: "", mediaUrl, mediaBase64, mediaMime: mediaMime || "image/webp", mediaFilename };
  if (tipoRaw.includes("location")) {
    const lat = pick(m, ["latitude", "message.locationMessage.degreesLatitude"]);
    const lng = pick(m, ["longitude", "message.locationMessage.degreesLongitude"]);
    return { tipo: "location", conteudo: `[localização: ${lat}, ${lng}]`, caption: "", mediaUrl: null, mediaBase64: null, mediaMime: null, mediaFilename: null };
  }
  if (tipoRaw.includes("reaction")) {
    const emoji = pick<string>(m, ["reaction", "text", "message.reactionMessage.text"]) ?? "";
    return { tipo: "reaction", conteudo: `[reacao]${emoji}`, caption: "", mediaUrl: null, mediaBase64: null, mediaMime: null, mediaFilename: null };
  }
  // default: texto
  return { tipo: "text", conteudo: text || "", caption: "", mediaUrl: null, mediaBase64: null, mediaMime: null, mediaFilename: null };
}

const PROVIDERS: Record<string, WaProvider> = { uazapi };

export function getWaProvider(name: string): WaProvider {
  const p = PROVIDERS[String(name ?? "").toLowerCase()];
  if (!p) throw new Error(`provider de WhatsApp desconhecido: ${name}`);
  return p;
}

export { onlyDigits, jidToDigits };
