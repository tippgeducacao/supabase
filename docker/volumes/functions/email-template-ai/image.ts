/** Geração opcional e direta, sem chat, ferramentas ou publicação automática.
 * Modelo/configuração do generate_image existente, conferidos em 12/09/2026:
 * https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-image
 * https://ai.google.dev/gemini-api/docs/generate-content/image-generation
 */
export const MODELO_IMAGEM_EMAIL_IA = "gemini-2.5-flash-image";
const MB = 1024 * 1024;
const MAX_IMAGEM = 8 * MB;
const MAX_RESPOSTA = 12 * MB;
type Objeto = Record<string, unknown>;
export interface ImagemGeradaEmailIA {
  nome: string;
  mime: "image/png" | "image/jpeg" | "image/webp";
  base64: string;
  uso: "referencia";
}
export class ErroImagemEmailIA extends Error {
  constructor(public status: number, public code: string, mensagem: string, public retryAfter?: number) { super(mensagem); }
}
const objeto = (v: unknown): v is Objeto => !!v && typeof v === "object" && !Array.isArray(v);
const invalida = () => new ErroImagemEmailIA(422, "INVALID_IMAGE_OUTPUT", "A IA não retornou uma imagem válida. Ajuste a descrição e tente novamente.");
const excessiva = () => new ErroImagemEmailIA(422, "IMAGE_OUTPUT_TOO_LARGE", "A imagem gerada ficou grande demais. Peça uma composição mais simples.");

export function validarPromptImagemEmailIA(valor: unknown): string {
  if (typeof valor !== "string" || !valor.trim() || valor.length > 2000 || [...valor].some(c => { const n = c.charCodeAt(0); return n === 127 || n < 32 && ![9, 10, 13].includes(n); })) {
    throw new ErroImagemEmailIA(400, "BAD_REQUEST", "Descreva a imagem em até 2000 caracteres.");
  }
  return valor.trim();
}

function conferirDimensoes(largura: number, altura: number): void {
  if (largura < 1 || altura < 1 || largura > 8192 || altura > 8192 || largura * altura > 16 * 1024 * 1024) throw invalida();
}

/** Confere MIME, base64 e estrutura básica do contêiner, além do limite real de
 * bytes. O navegador ainda decodifica e reencoda o raster antes de usar no e-mail. */
export function validarImagemGeradaEmailIA(valor: unknown): ImagemGeradaEmailIA {
  if (!objeto(valor) || typeof valor.data !== "string" || !["image/png", "image/jpeg", "image/webp"].includes(String(valor.mimeType))) throw invalida();
  const base64 = valor.data;
  if (base64.length > Math.ceil(MAX_IMAGEM / 3) * 4) throw excessiva();
  if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw invalida();
  let decodificado: string;
  try { decodificado = atob(base64); } catch { throw invalida(); }
  if (decodificado.length > MAX_IMAGEM) throw excessiva();
  const bytes = Uint8Array.from(decodificado, c => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  if (valor.mimeType === "image/png") {
    if (bytes.length < 57 || !decodificado.startsWith("\x89PNG\r\n\x1a\n") || view.getUint32(8) !== 13 || decodificado.slice(12, 16) !== "IHDR") throw invalida();
    conferirDimensoes(view.getUint32(16), view.getUint32(20));
    let offset = 8; let dados = false; let fim = false;
    while (offset + 12 <= bytes.length) {
      const tamanho = view.getUint32(offset);
      const tipo = decodificado.slice(offset + 4, offset + 8);
      if (tamanho > bytes.length - offset - 12) throw invalida();
      if (tipo === "IDAT" && tamanho > 0) dados = true;
      offset += tamanho + 12;
      if (tipo === "IEND") { if (tamanho !== 0 || offset !== bytes.length) throw invalida(); fim = true; break; }
    }
    if (!dados || !fim) throw invalida();
  } else if (valor.mimeType === "image/jpeg") {
    if (bytes.length < 20 || !decodificado.startsWith("\xff\xd8\xff") || !decodificado.endsWith("\xff\xd9")) throw invalida();
    let offset = 2; let dimensoes = false;
    while (offset + 4 < bytes.length) {
      if (bytes[offset++] !== 0xff) throw invalida();
      while (bytes[offset] === 0xff) offset++;
      const marcador = bytes[offset++];
      if (marcador === 0xda || marcador === 0xd9) break;
      if (offset + 2 > bytes.length) throw invalida();
      const tamanho = view.getUint16(offset);
      if (tamanho < 2 || offset + tamanho > bytes.length) throw invalida();
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marcador)) {
        if (tamanho < 8) throw invalida();
        conferirDimensoes(view.getUint16(offset + 5), view.getUint16(offset + 3)); dimensoes = true;
      }
      offset += tamanho;
    }
    if (!dimensoes) throw invalida();
  } else {
    if (bytes.length < 30 || decodificado.slice(0, 4) !== "RIFF" || decodificado.slice(8, 12) !== "WEBP" || view.getUint32(4, true) + 8 !== bytes.length) throw invalida();
    const tipo = decodificado.slice(12, 16);
    if (view.getUint32(16, true) > bytes.length - 20) throw invalida();
    if (tipo === "VP8X") conferirDimensoes(1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16));
    else if (tipo === "VP8L" && bytes[20] === 0x2f) conferirDimensoes(1 + ((bytes[21] | bytes[22] << 8) & 0x3fff), 1 + ((bytes[22] >> 6 | bytes[23] << 2 | bytes[24] << 10) & 0x3fff));
    else if (tipo === "VP8 " && decodificado.slice(23, 26) === "\x9d\x01\x2a") conferirDimensoes(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
    else throw invalida();
  }
  const mime = valor.mimeType as ImagemGeradaEmailIA["mime"];
  const extensao = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
  return { nome: `Imagem criada com IA.${extensao}`, mime, base64, uso: "referencia" };
}

async function lerRespostaImagem(res: Response): Promise<unknown> {
  if (Number(res.headers.get("Content-Length")) > MAX_RESPOSTA) { await res.body?.cancel(); throw excessiva(); }
  const reader = res.body?.getReader();
  if (!reader) throw invalida();
  const partes: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPOSTA) { await reader.cancel(); throw excessiva(); }
      partes.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const parte of partes) { bytes.set(parte, offset); offset += parte.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw invalida(); }
}

export async function gerarImagemEmailIA(opcoes: { prompt: string; chave: string; buscar?: typeof fetch }): Promise<ImagemGeradaEmailIA> {
  const prompt = validarPromptImagemEmailIA(opcoes.prompt);
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 150_000);
  try {
    const res = await (opcoes.buscar ?? fetch)(`https://generativelanguage.googleapis.com/v1beta/models/${MODELO_IMAGEM_EMAIL_IA}:generateContent`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": opcoes.chave }, signal: abort.signal,
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: `Crie uma única imagem para compor um e-mail. Siga a descrição visual abaixo. Não gere uma captura do e-mail inteiro, botões, preços, datas ou promessas que não tenham sido pedidos. A imagem será revisada antes de ser utilizada.\nDescrição: ${prompt}` }] }], generationConfig: { responseModalities: ["TEXT", "IMAGE"] } }),
    });
    if (!res.ok) {
      const retryAfter = Math.min(600, Math.max(1, Number(res.headers.get("Retry-After")) || 60));
      await res.body?.cancel();
      if (res.status === 429) throw new ErroImagemEmailIA(429, "PROVIDER_RATE_LIMIT", "O provedor está com limite de uso. Aguarde para gerar a imagem.", retryAfter);
      throw new ErroImagemEmailIA(422, "IMAGE_PROVIDER_ERROR", "A IA não conseguiu gerar a imagem. Tente novamente.");
    }
    const resultado = await lerRespostaImagem(res);
    if (!objeto(resultado) || !Array.isArray(resultado.candidates)) throw invalida();
    const candidato = resultado.candidates[0];
    if (!objeto(candidato) || candidato.finishReason !== "STOP" || !objeto(candidato.content) || !Array.isArray(candidato.content.parts)) throw invalida();
    const parte = candidato.content.parts.find(p => objeto(p) && p.thought !== true && p.inlineData);
    if (!objeto(parte)) throw invalida();
    return validarImagemGeradaEmailIA(parte.inlineData);
  } catch (e) {
    if (e instanceof ErroImagemEmailIA) throw e;
    throw new ErroImagemEmailIA(503, "IMAGE_PROVIDER_UNAVAILABLE", "A geração da imagem demorou ou está indisponível. Tente novamente.");
  } finally { clearTimeout(timer); }
}
