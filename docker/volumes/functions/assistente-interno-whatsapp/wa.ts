// Linha WhatsApp dedicada (Uazapi) do assistente. Reusa o adapter provider-agnóstico
// _shared/waProviders.ts. NUNCA passa por crm-whatsapp-send / crm_whatsapp_messages / SAC.
import { getWaProvider } from "../_shared/waProviders.ts";

export interface LinhaWa {
  id: string;
  provider: string;
  server_url: string;
  instancia_externa_id: string | null;
  numero: string | null;
  token: string;
}

/** Carrega a linha ativa + token (segredo em tabela service_role-only). */
export async function carregarLinha(admin: any): Promise<LinhaWa | null> {
  const { data: linha } = await admin
    .from("assistente_wa_linha")
    .select("id, provider, server_url, instancia_externa_id, numero")
    .eq("ativo", true)
    .order("criado_em", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!linha?.server_url) return null;
  const { data: sec } = await admin
    .from("assistente_wa_secrets")
    .select("token")
    .eq("linha_id", linha.id)
    .maybeSingle();
  if (!sec?.token) return null;
  return { ...linha, token: sec.token } as LinhaWa;
}

export async function enviarTexto(linha: LinhaWa, numeroDigits: string, texto: string) {
  const provider = getWaProvider(linha.provider || "uazapi");
  return await provider.sendText(linha.server_url, linha.token, numeroDigits, texto);
}

/** Envia um DOCUMENTO (PDF etc.) por URL pública — a Uazapi baixa da URL e entrega no chat. */
export async function enviarDocumento(
  linha: LinhaWa, numeroDigits: string, url: string, filename: string, caption?: string,
) {
  const provider = getWaProvider(linha.provider || "uazapi");
  return await provider.sendMedia(linha.server_url, linha.token, numeroDigits, {
    tipo: "document", url, filename, caption,
  });
}

export async function baixarAudio(linha: LinhaWa, externalId: string) {
  const provider = getWaProvider(linha.provider || "uazapi");
  // audioMp3:false = baixa o ORIGINAL (ogg/m4a). Forçar transcode p/ MP3 estourava o
  // timeout em áudio longo (AbortError); o Whisper aceita ogg/m4a direto.
  return await provider.downloadMedia(linha.server_url, linha.token, externalId, { audioMp3: false });
}

/** Baixa a imagem e devolve base64 + mime (para o Opus interpretar — visão). */
export async function baixarImagem(
  linha: LinhaWa, externalId: string,
): Promise<{ base64: string; mime: string } | null> {
  const provider = getWaProvider(linha.provider || "uazapi");
  const media = await provider.downloadMedia(linha.server_url, linha.token, externalId, { audioMp3: false });
  const mimeOk = (m: string | null): string => {
    const t = (m || "").toLowerCase();
    if (t.includes("png")) return "image/png";
    if (t.includes("webp")) return "image/webp";
    if (t.includes("gif")) return "image/gif";
    return "image/jpeg";
  };
  if (media.base64) return { base64: media.base64, mime: mimeOk(media.mime) };
  if (!media.url) return null;
  const res = await fetch(media.url);
  if (!res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  const chunk = 0x8000; // fatia p/ não estourar o limite de argumentos do fromCharCode
  for (let i = 0; i < buf.length; i += chunk) bin += String.fromCharCode(...buf.subarray(i, i + chunk));
  return { base64: btoa(bin), mime: mimeOk(media.mime || res.headers.get("content-type")) };
}
