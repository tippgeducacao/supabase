// Mídia INBOUND da Cloud API (Meta) → Storage `whatsapp-anexos` → item de `anexos`.
//
// Extraído do caminho principal do `whatsapp-webhook` em 2026-08-28, quando descobrimos que
// o número do PODCAST (que tem `handlePodcastInbound` próprio) NUNCA baixava arquivo: foto,
// áudio, vídeo e documento do convidado viravam o texto cru "[image]" no SAC pedagógico e o
// arquivo se perdia (a Meta guarda a mídia ~30 dias e o media_id não era salvo em lugar
// nenhum ⇒ irrecuperável retroativamente). Ter UM helper evita que o próximo número novo
// repita o buraco.
//
// ⚠️ O token é POR CONTA (`wa_accounts.access_token`): o media_id só é resolvível pelo app
// dono do número que recebeu. Passar o token da conta errada devolve 404/190 e o anexo some.

const PUBLIC_SUPABASE_URL = Deno.env.get("PUBLIC_SUPABASE_URL") || "https://api.ppgeducacao.site";

/** URL interna do Kong → host público (o navegador do atendente não enxerga `kong:8000`). */
export function toPublicUrl(internalUrl: string): string {
  return internalUrl.replace(/^https?:\/\/kong:8000/i, PUBLIC_SUPABASE_URL);
}

export interface MidiaInbound {
  /** 'audio' | 'image' | 'video' | 'document' | 'sticker' — é o `anexos[].tipo` do SAC. */
  tipo: string;
  id: string;
  mime_type?: string;
  filename?: string;
  caption?: string;
}

/**
 * Lê o objeto `messages[]` do webhook e devolve a mídia, ou `null` quando a mensagem não é
 * mídia (texto/botão/reação/localização/contato/desconhecido — tratados pelo chamador).
 */
export function extrairMidiaInbound(msg: any): MidiaInbound | null {
  const t = msg?.type;
  // 'voice' não existe na Cloud API (nota de voz chega como 'audio' com voice:true), mas
  // custa nada aceitar — provedores não-Meta (Uazapi) usam esse nome.
  if (t === "audio" || t === "voice") {
    const a = msg.audio ?? msg.voice;
    return a?.id ? { tipo: "audio", id: a.id, mime_type: a.mime_type } : null;
  }
  if (t === "image") {
    return msg.image?.id
      ? { tipo: "image", id: msg.image.id, mime_type: msg.image.mime_type, caption: msg.image.caption }
      : null;
  }
  if (t === "video") {
    return msg.video?.id
      ? { tipo: "video", id: msg.video.id, mime_type: msg.video.mime_type, caption: msg.video.caption }
      : null;
  }
  if (t === "document") {
    return msg.document?.id
      ? {
          tipo: "document",
          id: msg.document.id,
          mime_type: msg.document.mime_type,
          filename: msg.document.filename,
          caption: msg.document.caption,
        }
      : null;
  }
  if (t === "sticker") {
    return msg.sticker?.id
      ? { tipo: "sticker", id: msg.sticker.id, mime_type: msg.sticker.mime_type || "image/webp" }
      : null;
  }
  return null;
}

const EXT_POR_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "application/pdf": "pdf",
};

/** Extensão do arquivo salvo: o nome que a Meta mandou manda; o mime é o desempate. */
function extensaoDe(mime: string, filename?: string): string {
  const doNome = (filename ?? "").split(".").pop() ?? "";
  if (doNome && doNome.length <= 5 && /^[A-Za-z0-9]+$/.test(doNome)) return doNome.toLowerCase();
  if (EXT_POR_MIME[mime]) return EXT_POR_MIME[mime];
  if (mime.startsWith("audio/")) {
    if (mime.includes("ogg")) return "ogg";
    if (mime.includes("mpeg")) return "mp3";
    if (mime.includes("mp4") || mime.includes("aac")) return "m4a";
  }
  return "bin";
}

/**
 * Baixa a mídia da Meta e sobe no bucket `whatsapp-anexos`. Devolve o array pronto para a
 * coluna `anexos` (1 item), ou `[]` em QUALQUER falha — best-effort de propósito: perder o
 * arquivo é ruim, mas perder a mensagem inteira (e o 200 pro webhook) é pior.
 *
 * @param accessToken token da CONTA que recebeu a mensagem (`wa_accounts.access_token`).
 */
export async function baixarAnexoInbound(
  admin: any,
  media: MidiaInbound,
  accessToken: string | null | undefined,
  tag = "wa-media",
): Promise<any[]> {
  if (!media?.id) return [];
  if (!accessToken) {
    console.log(`[${tag}] sem access_token p/ baixar mídia`, media.id);
    return [];
  }
  try {
    // a) media_id → URL temporária
    const metaUrlRes = await fetch(`https://graph.facebook.com/v21.0/${media.id}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const metaUrlJson: any = await metaUrlRes.json().catch(() => ({}));
    const mediaUrl: string | undefined = metaUrlJson?.url;
    const mime: string = metaUrlJson?.mime_type || media.mime_type || "application/octet-stream";
    if (!mediaUrl) {
      console.log(`[${tag}] mídia inbound sem URL:`, JSON.stringify(metaUrlJson));
      return [];
    }

    // b) bytes (a URL da Meta também exige o Bearer)
    const binRes = await fetch(mediaUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!binRes.ok) {
      console.log(`[${tag}] download mídia HTTP`, binRes.status);
      return [];
    }
    const bin = new Uint8Array(await binRes.arrayBuffer());

    // c) Storage
    const ext = extensaoDe(mime, media.filename);
    const path = `${new Date().toISOString().slice(0, 10)}/inbound-${crypto.randomUUID()}.${ext}`;
    const { error: stErr } = await admin.storage
      .from("whatsapp-anexos")
      .upload(path, bin, { contentType: mime, upsert: false });
    if (stErr) {
      console.log(`[${tag}] storage upload inbound fail:`, stErr.message);
      return [];
    }

    const pub = toPublicUrl(admin.storage.from("whatsapp-anexos").getPublicUrl(path).data.publicUrl);
    return [{
      tipo: media.tipo,
      mime_type: mime,
      meta_media_id: media.id,
      url: pub,
      url_storage: pub,
      filename: media.filename || `${media.tipo}.${ext}`,
    }];
  } catch (e: any) {
    console.log(`[${tag}] erro download mídia inbound:`, e?.message ?? String(e));
    return [];
  }
}
