// Normalização do "WhatsApp completo" (espelho de uma linha Uazapi) — PURA, sem rede.
//
// A tela do diretor mostra TODAS as conversas do número (inclusive grupos e quem nunca virou
// lead), lidas ao vivo da Uazapi. Esta peça transforma o JSON cru do provedor (`/chat/find` e
// `/message/find`) em duas formas pequenas e estáveis para o front — o front não conhece
// "Uazapi" (regra de ouro do domínio: provider é detalhe trocável).
//
// Os nomes de campo variam entre versões da Uazapi (JID/jid, URL/url…); por isso os caminhos
// são listas, como em `extrairReferral` de waProviders.ts.

export type EspelhoTipo =
  | "texto" | "imagem" | "video" | "audio" | "voz" | "documento" | "figurinha"
  | "contato" | "localizacao" | "enquete" | "ligacao" | "reacao" | "apagada" | "link" | "outro";

export interface EspelhoChat {
  id: string;
  nome: string;
  /** Só dígitos; null em grupo. */
  telefone: string | null;
  grupo: boolean;
  foto: string | null;
  naoLidas: number;
  fixada: boolean;
  arquivada: boolean;
  silenciada: boolean;
  /** ms desde 1970; null = sem mensagem. */
  ultimaEm: number | null;
  ultimaTipo: string | null;
  ultimaTexto: string | null;
}

export interface EspelhoMsg {
  id: string;
  deMim: boolean;
  /** ms desde 1970. */
  em: number;
  tipo: EspelhoTipo;
  texto: string;
  /** Quem escreveu (útil em grupo). */
  autor: string | null;
  autorTelefone: string | null;
  /** id da mensagem respondida + um trecho dela, quando a Uazapi traz. */
  citadaId: string | null;
  citadaTexto: string | null;
  /** Reação: id da mensagem que recebeu o emoji (o emoji está em `texto`). */
  reacaoDeId: string | null;
  status: string | null;
  editada: boolean;
  /** Tem arquivo para baixar (pelo `/message/download`). */
  temArquivo: boolean;
  nomeArquivo: string | null;
  mime: string | null;
  segundos: number | null;
  /** Miniatura embutida (data URL) — a imagem/vídeo aparece antes de baixar. */
  miniatura: string | null;
  /** Contato compartilhado (nome do cartão). */
  contatoNome: string | null;
  grupo: boolean;
}

// deno-lint-ignore no-explicit-any
type Any = any;

function pick<T = Any>(obj: Any, paths: string[]): T | undefined {
  for (const p of paths) {
    let cur = obj;
    let ok = true;
    for (const k of p.split(".")) {
      if (cur == null || typeof cur !== "object" || !(k in cur)) { ok = false; break; }
      cur = cur[k];
    }
    if (ok && cur !== undefined && cur !== null && cur !== "") return cur as T;
  }
  return undefined;
}

function txt(v: unknown): string { return typeof v === "string" ? v : v == null ? "" : String(v); }
function numero(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Timestamp da Uazapi: ms (1794490094000) ou segundos (1794490094). Devolve sempre ms. */
export function paraMs(v: unknown): number {
  const n = numero(v);
  if (!n) return 0;
  return n < 1e11 ? n * 1000 : n;
}

export function digitosDoJid(jid: string): string {
  return jid.split("@")[0].replace(/\D/g, "");
}

export function ehJidDeGrupo(jid: string): boolean {
  return jid.endsWith("@g.us");
}

// Miniatura vem em base64 dentro do content. Limite: um chat com 50 imagens não pode virar
// resposta de megabytes — acima disso a miniatura é descartada e o front baixa o arquivo.
const MINIATURA_MAX_CHARS = 60_000;

function miniaturaDe(content: Any): string | null {
  const raw = pick<string>(content, ["JPEGThumbnail", "jpegThumbnail", "thumbnail"]);
  if (typeof raw !== "string" || raw.length < 20 || raw.length > MINIATURA_MAX_CHARS) return null;
  if (raw.startsWith("data:")) return raw;
  // base64 puro (JPEG começa com /9j/)
  if (/^[A-Za-z0-9+/=\s]+$/.test(raw)) return `data:image/jpeg;base64,${raw.replace(/\s+/g, "")}`;
  return null;
}

export function tipoDaMensagem(m: Any): EspelhoTipo {
  const mt = txt(pick(m, ["messageType", "type"])).toLowerCase();
  const md = txt(pick(m, ["mediaType"])).toLowerCase();
  if (txt(m?.type).toLowerCase() === "reaction" || mt.includes("reaction")) return "reacao";
  if (mt.includes("protocol") || mt.includes("revoke") || mt.includes("deleted")) return "apagada";
  if (mt === "call" || mt.includes("call")) return "ligacao";
  if (md === "ptt" || (mt.includes("audio") && pick(m, ["content.PTT", "content.ptt"]) === true)) return "voz";
  if (md === "audio" || mt.includes("audio")) return "audio";
  if (md === "image" || mt.includes("image")) return "imagem";
  if (md === "video" || mt.includes("video")) return "video";
  if (md === "document" || mt.includes("document")) return "documento";
  if (md === "sticker" || mt.includes("sticker")) return "figurinha";
  if (md === "vcard" || mt.includes("contact")) return "contato";
  if (mt.includes("location")) return "localizacao";
  if (mt.includes("poll")) return "enquete";
  if (md === "url") return "link";
  if (mt === "conversation" || mt === "extendedtextmessage" || mt === "text" || mt === "") return "texto";
  return "outro";
}

/** Texto visível: `text` quando a Uazapi preenche, senão o que estiver dentro do `content`. */
function textoDe(m: Any, tipo: EspelhoTipo): string {
  const direto = txt(m?.text);
  if (direto) return direto;
  const c = m?.content;
  if (typeof c === "string") return c;
  if (c && typeof c === "object") {
    return txt(pick(c, ["text", "caption", "Caption", "conversation", "title", "displayName"]));
  }
  return tipo === "texto" ? "" : "";
}

function citadaTextoDe(m: Any): string | null {
  const q = pick<Any>(m, ["content.contextInfo.quotedMessage", "content.ContextInfo.QuotedMessage"]);
  if (!q || typeof q !== "object") return null;
  const t = pick<string>(q, [
    "conversation", "Conversation", "extendedTextMessage.text", "ExtendedTextMessage.text",
    "imageMessage.caption", "ImageMessage.caption", "videoMessage.caption", "documentMessage.fileName",
  ]);
  if (t) return t.length > 160 ? `${t.slice(0, 160)}…` : t;
  if ("imageMessage" in q || "ImageMessage" in q) return "📷 Foto";
  if ("audioMessage" in q || "AudioMessage" in q) return "🎤 Áudio";
  if ("videoMessage" in q || "VideoMessage" in q) return "🎬 Vídeo";
  if ("documentMessage" in q || "DocumentMessage" in q) return "📄 Documento";
  if ("stickerMessage" in q || "StickerMessage" in q) return "Figurinha";
  return null;
}

export function normalizarMensagem(m: Any): EspelhoMsg | null {
  if (!m || typeof m !== "object") return null;
  const id = txt(pick(m, ["messageid", "id", "key.id"]));
  if (!id) return null;
  const tipo = tipoDaMensagem(m);
  const content = m.content && typeof m.content === "object" ? m.content : null;
  const temArquivo = ["imagem", "video", "audio", "voz", "documento", "figurinha"].includes(tipo);
  const reacaoDe = tipo === "reacao"
    ? (txt(pick(m, ["reaction", "content.key.ID", "content.key.id"])) || null)
    : null;
  const senderPn = txt(pick(m, ["sender_pn", "senderPn"]));
  const nomeArq = temArquivo && content ? txt(pick(content, ["fileName", "FileName", "title"])) : "";
  return {
    id,
    deMim: m.fromMe === true,
    em: paraMs(pick(m, ["messageTimestamp", "timestamp", "t"])),
    tipo,
    texto: textoDe(m, tipo),
    autor: txt(m.senderName) || null,
    autorTelefone: senderPn ? digitosDoJid(senderPn) || null : null,
    citadaId: txt(m.quoted) || null,
    citadaTexto: citadaTextoDe(m),
    reacaoDeId: reacaoDe,
    status: txt(m.status) || null,
    editada: txt(m.edited) !== "",
    temArquivo,
    nomeArquivo: nomeArq || null,
    mime: content ? (txt(pick(content, ["mimetype", "mimeType"])) || null) : null,
    segundos: content ? (numero(pick(content, ["seconds", "Seconds"])) || null) : null,
    miniatura: content && (tipo === "imagem" || tipo === "video" || tipo === "documento" || tipo === "link")
      ? miniaturaDe(content)
      : null,
    contatoNome: tipo === "contato" && content ? (txt(pick(content, ["displayName"])) || null) : null,
    grupo: m.isGroup === true,
  };
}

/** `/message/find` devolve `{messages:[...]}` (ou o array direto), do mais novo ao mais antigo. */
export function normalizarMensagens(json: Any): { mensagens: EspelhoMsg[]; temMais: boolean; proximoOffset: number } {
  const lista: Any[] = Array.isArray(json) ? json : Array.isArray(json?.messages) ? json.messages : [];
  const ms = lista.map(normalizarMensagem).filter((x): x is EspelhoMsg => x !== null);
  // Ordem cronológica (antigo → novo) para o chat; sem timestamp vai ao fim, estável.
  ms.sort((a, b) => a.em - b.em);
  const pag = json?.pagination ?? {};
  const temMais = typeof pag.hasMore === "boolean" ? pag.hasMore : false;
  const proximoOffset = numero(pag.nextOffset);
  return { mensagens: ms, temMais, proximoOffset };
}

function previewDoChat(c: Any): string | null {
  const t = txt(pick(c, ["wa_lastMessageTextVote", "wa_lastMessageText", "lastMessageText"]));
  if (t) return t.length > 120 ? `${t.slice(0, 120)}…` : t;
  const tipo = txt(c?.wa_lastMessageType).toLowerCase();
  if (!tipo) return null;
  if (tipo.includes("image")) return "📷 Foto";
  if (tipo.includes("audio") || tipo.includes("ptt")) return "🎤 Áudio";
  if (tipo.includes("video")) return "🎬 Vídeo";
  if (tipo.includes("document")) return "📄 Documento";
  if (tipo.includes("sticker")) return "Figurinha";
  if (tipo.includes("contact")) return "👤 Contato";
  if (tipo.includes("location")) return "📍 Localização";
  return null;
}

export function normalizarChat(c: Any): EspelhoChat | null {
  if (!c || typeof c !== "object") return null;
  const id = txt(pick(c, ["wa_chatid", "chatid", "id"]));
  if (!id || id === "status@broadcast" || id.endsWith("@newsletter")) return null;
  const grupo = c.wa_isGroup === true || ehJidDeGrupo(id);
  const fone = grupo ? null : (digitosDoJid(txt(pick(c, ["phone"])) || id) || null);
  const nome = txt(pick(c, ["wa_contactName", "name", "wa_name", "lead_name"])) ||
    (fone ?? id.split("@")[0]);
  const foto = txt(pick(c, ["image", "imagePreview"])) || null;
  const muteFim = numero(c.wa_muteEndTime);
  return {
    id,
    nome,
    telefone: fone,
    grupo,
    foto: foto && /^https?:\/\//.test(foto) ? foto : null,
    naoLidas: Math.max(0, numero(c.wa_unreadCount)),
    fixada: c.wa_isPinned === true,
    arquivada: c.wa_archived === true,
    silenciada: muteFim !== 0,
    ultimaEm: paraMs(c.wa_lastMsgTimestamp) || null,
    ultimaTipo: txt(c.wa_lastMessageType) || null,
    ultimaTexto: previewDoChat(c),
  };
}

export function normalizarChats(json: Any): { chats: EspelhoChat[]; temMais: boolean; proximoOffset: number; total: number } {
  const lista: Any[] = Array.isArray(json) ? json : Array.isArray(json?.chats) ? json.chats : [];
  const chats = lista.map(normalizarChat).filter((x): x is EspelhoChat => x !== null);
  const pag = json?.pagination ?? {};
  return {
    chats,
    temMais: pag.hasMore === true,
    proximoOffset: numero(pag.nextOffset),
    total: numero(pag.totalRecords) || chats.length,
  };
}

/**
 * Destino do envio: grupo vai pelo JID inteiro; conversa individual vai só pelos dígitos
 * (o mesmo que o CRM manda hoje). Recusa qualquer coisa que não seja chat de pessoa ou grupo
 * (status, canal, lista de transmissão) — o espelho não é porta para falar com eles.
 */
export function destinoDeEnvio(chatId: string): string | null {
  const id = chatId.trim();
  if (ehJidDeGrupo(id) && /^[0-9-]+@g\.us$/.test(id)) return id;
  if (/^\d{8,20}@s\.whatsapp\.net$/.test(id)) return digitosDoJid(id);
  return null;
}
