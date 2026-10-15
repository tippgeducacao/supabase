// Extensão e nome de ARQUIVO de anexo de mensagem (WhatsApp/SAC) — fonte única das edges e do
// front (reexportado em `src/lib/whatsapp/anexoArquivo.ts`). Sem Deno nem DOM: dá para testar no
// vitest e importar dos dois lados.
//
// Por que existe (15/10/2026): o `crm-whatsapp-webhook` só conhecia 8 mimes (áudio, vídeo,
// jpg/png/webp e pdf) e gravava TODO o resto no storage como `inbound-<uuid>.bin` — o
// `wa-uazapi-webhook` e o `whatsapp-send-media` tinham cópias do mesmo mapa. O link do balão abria
// a URL crua e, sem Content-Disposition, o navegador salvava o arquivo com o nome da URL —
// `inbound-<uuid>.bin` —, que o Windows não sabe abrir. Foi assim que a Monique não conseguia
// abrir no SAC os slides que o professor mandou (pptx, card #183168), nem as notas fiscais em XML.
// Em 90 dias, todo docx/pptx/xlsx/zip/xml do SAC estava em .bin; PDF nunca.
//
// Duas pontas, uma regra:
//  - edge  → `extensaoDoArquivo(mime, nome)`: a extensão do caminho no storage;
//  - front → `nomeParaDownload(nome, mime, tipo)`: o nome que vai no `?download=` do link — o que
//    conserta também os .bin antigos sem precisar mexer no storage.

const EXT_POR_MIME: Record<string, string> = {
  // documentos
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-word.document.macroenabled.12": "docm",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel.sheet.macroenabled.12": "xlsm",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow": "ppsx",
  "application/vnd.ms-powerpoint.presentation.macroenabled.12": "pptm",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.oasis.opendocument.presentation": "odp",
  "application/rtf": "rtf",
  "text/rtf": "rtf",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/markdown": "md",
  "text/xml": "xml",
  "application/xml": "xml",
  "text/html": "html",
  "multipart/related": "mht", // página salva do navegador (ex.: currículo Lattes)
  "message/rfc822": "eml",
  "application/vnd.ms-outlook": "msg",
  "text/calendar": "ics",
  "text/vcard": "vcf",
  "text/x-vcard": "vcf",
  "application/json": "json",
  "application/zip": "zip",
  "application/x-zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/vnd.rar": "rar",
  "application/x-rar": "rar",
  "application/x-rar-compressed": "rar",
  "application/x-7z-compressed": "7z",
  "application/x-tar": "tar",
  "application/gzip": "gz",
  "application/epub+zip": "epub",
  // imagem
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/pjpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/bmp": "bmp",
  "image/tiff": "tif",
  "image/svg+xml": "svg",
  // vídeo
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "video/quicktime": "mov",
  "video/webm": "webm",
  // áudio (o resto de audio/* cai nas regras por trecho, abaixo)
  "audio/amr": "amr",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
  "audio/opus": "opus",
};

/**
 * Extensões que EXECUTAM no Windows/Android/macOS. Nunca entram no caminho do objeto (o bucket é
 * público no domínio da API: um `.exe` com cara de `.exe` em URL permanente arrisca a reputação
 * do domínio inteiro) e o link do chat não as renomeia — continuam baixando como `.bin`, como
 * sempre. Em 15/10/2026 havia 2 `.exe` reais no bucket.
 */
const EXTENSOES_EXECUTAVEIS = new Set([
  "exe", "msi", "msp", "mst", "com", "scr", "pif", "cpl", "bat", "cmd", "ps1", "psm1", "vbs",
  "vbe", "vb", "js", "jse", "wsf", "wsh", "wsc", "hta", "jar", "jnlp", "lnk", "url", "reg",
  "dll", "ocx", "sys", "drv", "inf", "scf", "sct", "msc", "msh", "chm", "cab", "xll", "appx",
  "msix", "apk", "xapk", "ipa", "dmg", "pkg", "app", "iso", "img", "vhd", "vhdx", "sh", "ade",
  "adp", "mde", "ins", "isp", "shb", "shs",
]);

/**
 * Caracteres invisíveis que enganam a leitura do nome: os de DIREÇÃO de texto (o RLO faz
 * "Contrato\u202Efdp.exe" aparecer como "Contratoexe.pdf"), os de largura zero e o BOM. Chegam de
 * verdade: os vCards do WhatsApp vêm com U+200E no nome.
 */
const INVISIVEIS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** `audio/ogg; codecs=opus` → `audio/ogg`. */
function mimeBase(mime?: string | null): string {
  return (mime ?? "").split(";")[0].trim().toLowerCase();
}

/**
 * Nome sem caractere de controle, sem invisível, sem barra (que viraria pasta) e sem ponto ou
 * espaço no FIM — o Windows os descarta ao gravar, então "fatura.exe." viraria um .exe que a
 * regra não enxergou.
 */
function limparNome(nome?: string | null): string {
  return (nome ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, "")
    .replace(INVISIVEIS, "")
    .replace(/[\\/]+/g, "_")
    .replace(/[.\s]+$/, "")
    .trim();
}

/**
 * Extensão de verdade no fim do nome: 1–5 letras/dígitos com ao menos uma letra, depois de um
 * ponto que não é o 1º caractere. `.bin` não conta — é o que nós mesmos gravávamos.
 * ⚠️ Nome SEM ponto não tem extensão: "Aula1" não pode virar `.aula1` (o helper antigo do
 * `waMediaInbound` fazia isso, porque `split(".").pop()` devolve o nome inteiro).
 */
export function extensaoDoNome(nome?: string | null): string | null {
  const n = limparNome(nome);
  const i = n.lastIndexOf(".");
  if (i <= 0 || i === n.length - 1) return null;
  const ext = n.slice(i + 1).toLowerCase();
  if (ext === "bin" || !/^(?=.*[a-z])[a-z0-9]{1,5}$/.test(ext)) return null;
  return ext;
}

/** Extensão pelo tipo do arquivo, ou null quando o tipo não diz nada (octet-stream, vazio). */
export function extensaoDoMime(mime?: string | null): string | null {
  const m = mimeBase(mime);
  if (!m) return null;
  if (EXT_POR_MIME[m]) return EXT_POR_MIME[m];
  if (m.startsWith("audio/")) {
    if (m.includes("ogg")) return "ogg";
    if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
    if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  }
  return null;
}

/** O arquivo executa ao ser aberto (ver EXTENSOES_EXECUTAVEIS)? */
export function ehExecutavel(nome?: string | null): boolean {
  const ext = extensaoDoNome(nome);
  return !!ext && EXTENSOES_EXECUTAVEIS.has(ext);
}

/**
 * Extensão do caminho no storage: o nome original manda (a Meta manda o nome em documento), o
 * mime desempata e `bin` sobra quando os dois calam — ou quando o arquivo é executável.
 */
export function extensaoDoArquivo(mime?: string | null, nome?: string | null): string {
  const doNome = extensaoDoNome(nome);
  if (doNome) return EXTENSOES_EXECUTAVEIS.has(doNome) ? "bin" : doNome;
  return extensaoDoMime(mime) ?? "bin";
}

/**
 * Nome com que o arquivo deve ser BAIXADO (e que o link mostra). Mantém o nome original quando
 * ele já tem extensão; senão completa pelo mime ("Contrato" + docx → "Contrato.docx"; o
 * "document.bin" que gravávamos sem nome → "document.docx"; o vCard "Fulano e outros 64
 * contatos" → ".vcf"). Tira só o que engana ou quebra (controle, invisíveis, barras) — o resto o
 * próprio navegador saneia.
 */
export function nomeParaDownload(nome?: string | null, mime?: string | null, tipo?: string | null): string {
  const n = limparNome(nome);
  if (extensaoDoNome(n)) return n;
  const ext = extensaoDoMime(mime);
  if (!ext) return n || "arquivo";
  const base = n.replace(/\.bin$/i, "").trim() || limparNome(tipo) || "arquivo";
  return `${base}.${ext}`;
}
