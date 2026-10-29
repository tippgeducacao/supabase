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
//
// ⚠️ O arquivo vai do provedor para o Storage EM FLUXO (`gravarRespostaNoBucket`, que a linha
// Web também usa), nunca inteiro na memória. O worker do edge-runtime tem 150 MB e é dividido por todas as chamadas da função:
// em 21-22/10/2026 o PDF de 95 MB de uma professora (BM 08) era lido com `arrayBuffer()`, o
// bucket (então 50 MB) recusava e a 2ª tentativa estourava a memória ANTES de a mensagem ser
// gravada — o arquivo nunca aparecia no SAC, a Meta reentregava (40 estouros num dia) e cada
// estouro derrubava junto o que mais estivesse em processamento. Ver docs/CRM Comercial.md.

// Extensão do arquivo salvo: regra única em `extensaoArquivo.ts` (o nome que a Meta mandou manda;
// o mime desempata). A cópia que morava aqui transformava nome SEM ponto em extensão
// ("Aula1" → `.aula1`) e só conhecia 6 mimes — o resto virava `.bin` (15/10/2026).
import { extensaoDoArquivo as extensaoDe } from "./extensaoArquivo.ts";
import { BUCKET_RECEBIDOS, VALIDADE_LINK_GRAVADO_S } from "./midiaRecebida.ts";

const PUBLIC_SUPABASE_URL = Deno.env.get("PUBLIC_SUPABASE_URL") || "https://api.ppgeducacao.site";

/** URL interna do Kong → host público (o navegador do atendente não enxerga `kong:8000`). */
export function toPublicUrl(internalUrl: string): string {
  return internalUrl.replace(/^https?:\/\/(?:supabase-)?kong:8000/i, PUBLIC_SUPABASE_URL);
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

/**
 * Teto de um arquivo inbound: o `file_size_limit` do bucket `whatsapp-anexos` (migration
 * 20261022193954). É o limite de documento da Cloud API. Mude os dois juntos.
 */
export const LIMITE_MIDIA_INBOUND_BYTES = 100 * 1024 * 1024;

/**
 * Falha que se repete IGUAL na próxima tentativa (arquivo acima do teto, media_id que a Meta não
 * resolve mais, URL fora da Meta). Repetir só baixaria o arquivo inteiro de novo — foi a 2ª
 * tentativa que estourou a memória do worker em 22/10/2026.
 */
export class FalhaDefinitivaMidia extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = "FalhaDefinitivaMidia";
  }
}

/** Só baixa de hosts da Meta (anti-SSRF): a URL vem do JSON da Meta e é buscada com o token. */
export function ehHostDeMidiaDaMeta(u: string): boolean {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h === "lookaside.fbsbx.com"
      || h === "graph.facebook.com"
      || h.endsWith(".fbcdn.net")
      || h.endsWith(".facebook.com");
  } catch {
    return false;
  }
}

export interface MidiaGravada {
  /** Caminho no bucket — o link sai de `linkDaMidiaGravada`. */
  path: string;
  /** `whatsapp-anexos` (público, legado) ou `whatsapp-recebidos` (privado, mídia recebida do CRM desde 29/10/2026). */
  bucket: string;
  mime: string;
  ext: string;
  bytes: number;
}

/**
 * UMA tentativa de levar a mídia da Meta para o bucket `whatsapp-anexos`, em fluxo: os bytes do
 * download entram direto no upload, sem `arrayBuffer()`. Erro `FalhaDefinitivaMidia` = não
 * adianta repetir; qualquer outro erro é transitório (Graph fora, lookaside, Storage).
 *
 * @param accessToken token da CONTA que recebeu a mensagem.
 * @param opcoes.pasta prefixo do caminho no bucket, com a barra no fim (o CRM usa "crm/").
 */
export async function gravarMidiaInbound(
  admin: any,
  media: MidiaInbound,
  accessToken: string,
  opcoes: { pasta?: string; limiteBytes?: number; bucket?: string } = {},
): Promise<MidiaGravada> {
  const limite = opcoes.limiteBytes ?? LIMITE_MIDIA_INBOUND_BYTES;

  // a) media_id → URL temporária. O Graph já diz o tamanho (`file_size`): arquivo acima do teto
  //    nem começa a baixar.
  const metaRes = await fetch(`https://graph.facebook.com/v21.0/${media.id}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const meta: any = await metaRes.json().catch(() => ({}));
  const mediaUrl: string | undefined = meta?.url;
  if (!mediaUrl) {
    const motivo = `sem URL (HTTP ${metaRes.status}): ${JSON.stringify(meta).slice(0, 200)}`;
    // 4xx = id expirado/inválido ou token de outra conta; 429 e 5xx passam numa nova tentativa.
    const definitiva = metaRes.status >= 400 && metaRes.status < 500 && metaRes.status !== 429;
    throw definitiva ? new FalhaDefinitivaMidia(motivo) : new Error(motivo);
  }
  if (!ehHostDeMidiaDaMeta(mediaUrl)) {
    throw new FalhaDefinitivaMidia(`host_nao_permitido: ${new URL(mediaUrl).hostname}`);
  }
  const tamanhoNoGraph = Number(meta?.file_size);
  if (tamanhoNoGraph > limite) throw new FalhaDefinitivaMidia(`arquivo_grande: ${tamanhoNoGraph} bytes`);
  const mime: string = meta?.mime_type || media.mime_type || "application/octet-stream";

  // b) bytes (a URL da Meta também exige o Bearer) → c) Storage, em fluxo
  const binRes = await fetch(mediaUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  return await gravarRespostaNoBucket(admin, binRes, { mime, filename: media.filename }, {
    pasta: opcoes.pasta,
    limiteBytes: limite,
    bucket: opcoes.bucket,
  });
}

/**
 * Leva o corpo de uma resposta HTTP (o download da mídia) para o bucket `whatsapp-anexos` EM
 * FLUXO — o arquivo nunca fica inteiro na memória. Usada pela Meta (`gravarMidiaInbound`) e pela
 * linha Web (`wa-uazapi-webhook/midia.ts`). Erro `FalhaDefinitivaMidia` = não adianta repetir.
 *
 * @param opcoes.pasta prefixo do caminho no bucket, com a barra no fim (o CRM usa "crm/").
 * @param opcoes.prefixo começo do nome do objeto: "inbound" (Meta) ou "uazapi" (linha Web).
 */
export async function gravarRespostaNoBucket(
  admin: any,
  resposta: Response,
  arquivo: { mime: string; filename?: string | null },
  opcoes: { pasta?: string; prefixo?: string; limiteBytes?: number; bucket?: string } = {},
): Promise<MidiaGravada> {
  const limite = opcoes.limiteBytes ?? LIMITE_MIDIA_INBOUND_BYTES;
  const bucket = opcoes.bucket ?? "whatsapp-anexos";
  if (!resposta.ok || !resposta.body) {
    // Sem isso o corpo de erro do provedor subia pro Storage como se fosse o arquivo.
    await resposta.body?.cancel().catch(() => {});
    throw new Error(`download HTTP ${resposta.status}`);
  }
  const tamanhoNoDownload = resposta.headers.get("content-length");
  if (tamanhoNoDownload === "0") {
    await resposta.body.cancel().catch(() => {});
    throw new Error("download vazio");
  }
  if (Number(tamanhoNoDownload) > limite) {
    await resposta.body.cancel().catch(() => {});
    throw new FalhaDefinitivaMidia(`arquivo_grande: ${tamanhoNoDownload} bytes`);
  }

  // O contador dá o tamanho (o upload não devolve) e corta o que passar do teto quando ninguém
  // informou tamanho nenhum.
  let bytes = 0;
  let passouDoTeto = false;
  const contador = new TransformStream<Uint8Array, Uint8Array>({
    transform(pedaco, ctrl) {
      bytes += pedaco.byteLength;
      if (bytes > limite) {
        passouDoTeto = true;
        ctrl.error(new FalhaDefinitivaMidia(`arquivo_grande: mais de ${limite} bytes`));
        return;
      }
      ctrl.enqueue(pedaco);
    },
  });
  const ext = extensaoDe(arquivo.mime, arquivo.filename);
  const dia = new Date().toISOString().slice(0, 10);
  const path = `${opcoes.pasta ?? ""}${dia}/${opcoes.prefixo ?? "inbound"}-${crypto.randomUUID()}.${ext}`;
  let erroUpload: string | null = null;
  try {
    const { error } = await admin.storage.from(bucket).upload(path, resposta.body.pipeThrough(contador), {
      contentType: arquivo.mime,
      upsert: false,
      duplex: "half", // corpo em fluxo
    });
    if (error) erroUpload = error.message ?? String(error);
  } catch (e) {
    erroUpload = e instanceof Error ? e.message : String(e);
  }
  if (passouDoTeto) throw new FalhaDefinitivaMidia(`arquivo_grande: mais de ${limite} bytes`);
  if (erroUpload !== null) {
    const motivo = `storage upload: ${erroUpload}`;
    // "The object exceeded the maximum allowed size" = `file_size_limit` do bucket: repetir dá o mesmo.
    throw /maximum allowed size/i.test(erroUpload) ? new FalhaDefinitivaMidia(motivo) : new Error(motivo);
  }
  if (bytes === 0) {
    await admin.storage.from(bucket).remove([path]).catch(() => {});
    throw new Error("download vazio");
  }
  return { path, bucket, mime: arquivo.mime, ext, bytes };
}

/**
 * Link que vai gravado em `anexos[].url`. Bucket público (legado): o link público de sempre.
 * Bucket privado `whatsapp-recebidos`: link ASSINADO de 7 dias — quem usa a mídia em minutos
 * (João, transcrição) segue funcionando; depois disso a tela renova pela edge
 * `midia-recebida-renovar` e as edges por `urlBaixavel` (_shared/midiaRecebida.ts).
 */
export async function linkDaMidiaGravada(admin: any, gravada: MidiaGravada): Promise<string> {
  if (gravada.bucket !== BUCKET_RECEBIDOS) {
    return toPublicUrl(admin.storage.from(gravada.bucket).getPublicUrl(gravada.path).data.publicUrl);
  }
  const { data, error } = await admin.storage.from(gravada.bucket).createSignedUrl(gravada.path, VALIDADE_LINK_GRAVADO_S);
  if (error || !data?.signedUrl) throw new Error(`assinar mídia recebida: ${error?.message ?? "sem signedUrl"}`);
  return toPublicUrl(data.signedUrl);
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
    const gravada = await gravarMidiaInbound(admin, media, accessToken);
    const pub = toPublicUrl(admin.storage.from("whatsapp-anexos").getPublicUrl(gravada.path).data.publicUrl);
    return [{
      tipo: media.tipo,
      mime_type: gravada.mime,
      meta_media_id: media.id,
      url: pub,
      url_storage: pub,
      filename: media.filename || `${media.tipo}.${gravada.ext}`,
    }];
  } catch (e: any) {
    console.log(`[${tag}] erro download mídia inbound (${media.id}):`, e?.message ?? String(e));
    return [];
  }
}
