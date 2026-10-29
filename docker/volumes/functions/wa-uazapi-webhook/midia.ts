// Mídia da linha Web (Uazapi) → bucket `whatsapp-anexos`, sem o arquivo inteiro na memória.
//
// ⚠️ 23/10/2026: o webhook lia o arquivo com `arrayBuffer()` (ou decodificava o base64 com
// `atob`) ANTES de gravar a mensagem. Vídeo de 140–151 MB que a atendente manda do próprio
// celular derrubava o worker (150 MB, dividido pela function inteira) e a mensagem nunca era
// gravada; de 72 a 115 MB entrava sem anexo (bucket em 50 MB). Com o bucket em 100 MB (22/10),
// o que passasse de 50 MB também ia estourar. Mesmo conserto do caminho da Meta
// (`_shared/waMediaInbound.ts`): tamanho checado antes de pedir, download em fluxo, e o que
// falhar vira `motivo` — a mensagem é gravada de qualquer jeito.
import { gravarRespostaNoBucket, LIMITE_MIDIA_INBOUND_BYTES, linkDaMidiaGravada, type MidiaGravada } from "../_shared/waMediaInbound.ts";
import { BUCKET_RECEBIDOS } from "../_shared/midiaRecebida.ts";
import type { WaInboundMessage, WaProvider } from "../_shared/waProviders.ts";

/** base64 decodificado com `atob` ocupa umas 3x o arquivo (texto + binário + bytes): só o pequeno. */
export const LIMITE_BASE64_BYTES = 20 * 1024 * 1024;
/** O arquivo vem do servidor da Uazapi: travado, ele seguraria a requisição até o worker morrer. */
const TIMEOUT_DOWNLOAD_MS = 120_000;
/** O /message/download decifra o arquivo antes de responder — o grande passa dos 20 s padrão. */
const TIMEOUT_DECIFRAR_GRANDE_MS = 60_000;
const DECIFRAR_DEMORA_ACIMA_DE = 20 * 1024 * 1024;

const TIPOS_DE_MIDIA = ["image", "audio", "video", "document", "sticker"];

export interface MidiaPendente {
  id: string | null;
  tipo: string;
  mime_type: string | null;
  filename: string | null;
  motivo: string;
}

export function ehMidia(m: WaInboundMessage): boolean {
  return TIPOS_DE_MIDIA.includes(m.tipo);
}

/** Reentrega (ou o eco de um envio nosso) do que já está gravado: nada de baixar o arquivo de novo. */
export async function mensagemJaGravada(admin: any, externalId: string | null): Promise<boolean> {
  if (!externalId) return false;
  const { data } = await admin.from("crm_whatsapp_messages").select("id").eq("wa_message_id", externalId).limit(1);
  return (data?.length ?? 0) > 0;
}

function b64ToBytes(b64: string): Uint8Array {
  const clean = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64;
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hostDe(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return "?";
  }
}

// Mídia RECEBIDA vai para o bucket PRIVADO desde 29/10/2026: link assinado de 7 dias + bucket/caminho.
async function anexoDe(admin: any, m: WaInboundMessage, gravada: MidiaGravada) {
  const link = await linkDaMidiaGravada(admin, gravada);
  return {
    tipo: m.tipo,
    mime_type: gravada.mime,
    url: link,
    url_storage: link,
    bucket: gravada.bucket,
    caminho: gravada.path,
    filename: m.mediaFilename || `${m.tipo}.${gravada.ext}`,
  };
}

/**
 * Baixa a mídia de UMA mensagem da linha Web e grava no bucket. Nunca lança: o que falhar volta em
 * `pendente.motivo` e a mensagem segue sem o arquivo — perder o arquivo é ruim, perder a mensagem
 * (e o 200 para a Uazapi) é pior.
 */
export async function baixarMidiaUazapi(
  admin: any,
  provider: WaProvider,
  serverUrl: string,
  getToken: () => Promise<string | null>,
  m: WaInboundMessage,
): Promise<{ anexos: any[]; pendente: MidiaPendente | null }> {
  if (!ehMidia(m)) return { anexos: [], pendente: null };
  const pendente = (motivo: string) => ({
    anexos: [],
    pendente: {
      id: m.externalId ?? null,
      tipo: m.tipo,
      mime_type: m.mediaMime ?? null,
      filename: m.mediaFilename ?? null,
      motivo,
    },
  });
  if (m.mediaBytes && m.mediaBytes > LIMITE_MIDIA_INBOUND_BYTES) {
    return pendente(`arquivo_grande: ${m.mediaBytes} bytes`);
  }

  // A Uazapi manda a mídia criptografada (sem URL no webhook): o /message/download decifra e
  // devolve uma URL pública que expira em ~2 dias — por isso o arquivo vem para o NOSSO storage.
  let mediaUrl = m.mediaUrl ?? null;
  let mime = m.mediaMime ?? null;
  let base64 = m.mediaBase64 ?? null;
  if (!mediaUrl && !base64 && m.externalId) {
    try {
      const tok = await getToken();
      if (!tok) return pendente("sem_token");
      const dl = await provider.downloadMedia(serverUrl, tok, m.externalId, {
        audioMp3: m.tipo === "audio",
        ...((m.mediaBytes ?? 0) > DECIFRAR_DEMORA_ACIMA_DE ? { timeoutMs: TIMEOUT_DECIFRAR_GRANDE_MS } : {}),
      });
      mediaUrl = dl.url ?? null;
      mime = mime ?? dl.mime ?? null;
      base64 = dl.base64 ?? null;
    } catch (e) {
      return pendente(`downloadMedia: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const arquivo = { mime: mime || "application/octet-stream", filename: m.mediaFilename };
  const opcoes = { pasta: "crm/", prefixo: "uazapi", bucket: BUCKET_RECEBIDOS };
  let motivo = "sem_url_nem_base64";
  if (mediaUrl) {
    if (provider.isAllowedMediaHost(mediaUrl, serverUrl)) {
      try {
        const res = await fetch(mediaUrl, { signal: AbortSignal.timeout(TIMEOUT_DOWNLOAD_MS) });
        return { anexos: [await anexoDe(admin, m, await gravarRespostaNoBucket(admin, res, arquivo, opcoes))], pendente: null };
      } catch (e) {
        motivo = e instanceof Error ? e.message : String(e);
      }
    } else {
      motivo = `host_nao_permitido: ${hostDe(mediaUrl)}`;
    }
  }
  if (base64) {
    const estimado = Math.floor((base64.length * 3) / 4);
    if (estimado > LIMITE_BASE64_BYTES) return pendente(`base64_grande: ~${estimado} bytes (${motivo})`);
    try {
      const res = new Response(b64ToBytes(base64));
      return { anexos: [await anexoDe(admin, m, await gravarRespostaNoBucket(admin, res, arquivo, opcoes))], pendente: null };
    } catch (e) {
      motivo = e instanceof Error ? e.message : String(e);
    }
  }
  return pendente(motivo);
}
