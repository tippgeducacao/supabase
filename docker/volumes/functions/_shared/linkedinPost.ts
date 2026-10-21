// Regras PURAS da publicação no LinkedIn (perfil pessoal). Sem Deno, sem rede: é o que o
// vitest consegue testar daqui, e é onde mora tudo que já foi decidido por medição ou pela
// documentação — o worker (`linkedin-publish`) só chama.
//
// Fonte de cada regra: learn.microsoft.com/linkedin/marketing/community-management/shares/
// (posts-api, images-api, videos-api, multiimage-post-api, little-text-format), versão 2026-10.

/** Teto do texto de post de membro. A RPC `linkedin_agendar_post` recusa acima disso. */
export const LIMITE_TEXTO = 3000;
/** MultiImage: mínimo 2, máximo 20 imagens. Uma só é post de imagem simples. */
export const MAX_IMAGENS = 20;
/** Videos API: MP4 entre 75 KB e 500 MB (organic, não-CTV). */
export const VIDEO_MIN_BYTES = 75 * 1024;
export const VIDEO_MAX_BYTES = 500 * 1024 * 1024;
/** Images API: JPG, GIF e PNG — e só. WebP/HEIC voltam recusados. */
export const TIPOS_DE_IMAGEM = ["image/jpeg", "image/png", "image/gif"] as const;

export type TipoPostLinkedIn = "texto" | "imagem" | "multi_imagem" | "video";

/**
 * Texto do post no formato "little" do LinkedIn.
 *
 * ⚠️ O campo `commentary` NÃO é texto puro: `( ) [ ] { } @ < > | * _ ~ \ #` são caracteres de
 * marcação (menção, hashtag, template). A documentação manda escapar TODOS com barra invertida,
 * "mesmo que não sejam usados num elemento" — e o sintoma de esquecer é conhecido: o post sai
 * CORTADO no primeiro parêntese, sem erro nenhum na resposta. Os posts do Rafael têm parêntese.
 *
 * A exceção é a #hashtag: `#palavra` sem escape vira hashtag clicável, que é o que quem escreve
 * espera. Então o `#` só fica cru quando abre uma palavra (letra logo depois, e nenhuma letra
 * colada antes — "C#" e "nº #3" saem como texto). `@` sempre escapa: menção exige a URN da
 * pessoa, que a tela não tem — sem escape o `@` some ou quebra o texto.
 */
export function escaparTextoLinkedIn(texto: string): string {
  const s = String(texto ?? "");
  let saida = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "#") {
      const antes = i > 0 ? s[i - 1] : "";
      const depois = s[i + 1] ?? "";
      const abreHashtag = /\p{L}/u.test(depois) && !/[\p{L}\p{N}_]/u.test(antes);
      saida += abreHashtag ? "#" : "\\#";
      continue;
    }
    if ("\\|{}@[]()<>*_~".includes(c)) {
      saida += "\\" + c;
      continue;
    }
    saida += c;
  }
  return saida;
}

/** Imagem, vídeo ou desconhecido — pela extensão do caminho (a URL é do nosso Storage). */
export function tipoDaMidiaPelaUrl(url: string): "imagem" | "video" | "desconhecido" {
  const caminho = String(url || "").split(/[?#]/)[0].toLowerCase();
  if (/\.(mp4|m4v)$/.test(caminho)) return "video";
  if (/\.(jpe?g|png|gif)$/.test(caminho)) return "imagem";
  return "desconhecido";
}

/**
 * Formato REAL do arquivo, pelos primeiros bytes — não pela extensão.
 * ⚠️ Arquivo de celular salvo como ".jpg" que na verdade é WebP/HEIC é comum, e o LinkedIn o
 * recusa sem explicar. Olhar a assinatura é o que deixa a mensagem dizer o que fazer.
 */
export function formatoPelaAssinatura(b: Uint8Array): "image/jpeg" | "image/png" | "image/gif" | "video/mp4" | "image/webp" | null {
  if (!b || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  // MP4/M4V/MOV: caixa `ftyp` nos bytes 4–7. O "brand" `qt  ` é QuickTime (.mov), que o
  // LinkedIn não lista — esse fica de fora de propósito.
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const marca = String.fromCharCode(b[8], b[9], b[10], b[11]);
    return marca === "qt  " ? null : "video/mp4";
  }
  return null;
}

/**
 * Qual tipo de post do LinkedIn sai destas mídias — ou o motivo de não sair nenhum.
 * O LinkedIn não mistura foto e vídeo, aceita UM vídeo, e de 2 a 20 fotos.
 */
export function tipoDoPost(urls: string[]): { tipo: TipoPostLinkedIn } | { erro: string } {
  const lista = (urls || []).filter(Boolean);
  if (!lista.length) return { tipo: "texto" };
  const tipos = lista.map(tipoDaMidiaPelaUrl);
  const ruim = lista.find((_, i) => tipos[i] === "desconhecido");
  if (ruim) {
    return { erro: `Formato que o LinkedIn não aceita: ${ruim.split("/").pop()}. Imagem em JPG, PNG ou GIF; vídeo em MP4.` };
  }
  const videos = tipos.filter((t) => t === "video").length;
  if (videos && videos !== lista.length) return { erro: "O LinkedIn não mistura foto e vídeo no mesmo post." };
  if (videos > 1) return { erro: "O LinkedIn aceita um vídeo por post." };
  if (videos === 1) return { tipo: "video" };
  if (lista.length > MAX_IMAGENS) return { erro: `O LinkedIn aceita até ${MAX_IMAGENS} imagens por post.` };
  return { tipo: lista.length === 1 ? "imagem" : "multi_imagem" };
}

/** Mensagem legível do corpo de erro do LinkedIn (`{message, status, serviceErrorCode, code}`). */
export function mensagemDoLinkedIn(corpo: unknown): string {
  if (!corpo || typeof corpo !== "object") return typeof corpo === "string" && corpo ? corpo.slice(0, 300) : "";
  const c = corpo as Record<string, unknown>;
  const partes = [c.message, c.error_description, c.error, c.code]
    .filter((v) => typeof v === "string" && v.trim())
    .map((v) => String(v).trim());
  return [...new Set(partes)].join(" · ").slice(0, 400);
}

/**
 * O que a resposta do POST /rest/posts diz sobre o post. É a decisão mais cara do worker:
 *
 * - **4xx** = o LinkedIn RECUSOU e disse que recusou ⇒ o post NÃO existe. Pode tentar de novo
 *   sem medo de duplicar (o carimbo `enviado_em` é limpo). Entre os 4xx, uns valem tentar de novo
 *   (429 limite, 409 conflito, mídia ainda processando) e outros não (token, permissão, texto).
 * - **5xx, ou sem resposta** (rede, timeout) = NÃO SE SABE. O LinkedIn pode ter criado o post
 *   antes de cair. Fica para revisão humana ("confira no perfil antes de reenviar"), porque
 *   publicar duas vezes no perfil pessoal do diretor é pior do que não publicar.
 */
export type DesfechoDoPost =
  | { situacao: "publicado"; urn: string }
  | { situacao: "recusado"; definitivo: boolean; mensagem: string }
  | { situacao: "incerto"; mensagem: string };

export function desfechoDoPost(status: number | null, urn: string | null, corpo: unknown): DesfechoDoPost {
  if (status === 201 || (status !== null && status >= 200 && status < 300)) {
    if (urn) return { situacao: "publicado", urn };
    // 2xx sem a URN: o post existe, só não sabemos o endereço. Não é falha — e reenviar duplicaria.
    return { situacao: "publicado", urn: "" };
  }
  const msg = mensagemDoLinkedIn(corpo);
  if (status === null) {
    return { situacao: "incerto", mensagem: `Sem resposta do LinkedIn${msg ? ` (${msg})` : ""} — confira no perfil antes de reenviar, o post pode ter saído.` };
  }
  if (status >= 500) {
    return { situacao: "incerto", mensagem: `O LinkedIn respondeu ${status}${msg ? ` (${msg})` : ""} — confira no perfil antes de reenviar, o post pode ter saído.` };
  }
  if (status === 401) {
    return { situacao: "recusado", definitivo: true, mensagem: `O LinkedIn recusou o acesso (401${msg ? `: ${msg}` : ""}). O acesso venceu ou foi revogado — reconecte a conta.` };
  }
  if (status === 403) {
    return { situacao: "recusado", definitivo: true, mensagem: `O LinkedIn negou a permissão de publicar (403${msg ? `: ${msg}` : ""}). Reconecte a conta e confira se o app tem o produto "Share on LinkedIn".` };
  }
  // ⚠️ PROCESSING_FAILED antes do PROCESSING genérico: vídeo que o LinkedIn não conseguiu
  // processar não melhora com a espera — o arquivo é que precisa mudar.
  if (/PROCESSING_FAILED/i.test(msg)) {
    return { situacao: "recusado", definitivo: true, mensagem: `O LinkedIn não conseguiu processar o vídeo (${msg}). Exporte de novo em MP4 (H.264) e reagende.` };
  }
  if (status === 429 || status === 409 || /PROCESSING|WAITING_UPLOAD/i.test(msg)) {
    return { situacao: "recusado", definitivo: false, mensagem: `O LinkedIn pediu para tentar depois (${status}${msg ? `: ${msg}` : ""}).` };
  }
  return { situacao: "recusado", definitivo: true, mensagem: `O LinkedIn recusou o post (${status}${msg ? `: ${msg}` : ""}).` };
}

/**
 * Confere as instruções de envio do vídeo antes de mandar um byte: partes em ordem, contíguas,
 * cobrindo o arquivo inteiro. Instrução torta mandaria um vídeo truncado que o LinkedIn aceita
 * no finalize e só falha no processamento, sem dizer por quê.
 */
export interface InstrucaoDeParte { firstByte: number; lastByte: number; uploadUrl: string }

export function conferirPartes(instrucoes: InstrucaoDeParte[], tamanho: number): string | null {
  if (!Array.isArray(instrucoes) || !instrucoes.length) return "o LinkedIn não devolveu as partes do envio do vídeo";
  let esperado = 0;
  for (const p of instrucoes) {
    if (!p || typeof p.uploadUrl !== "string" || !p.uploadUrl) return "parte do vídeo sem endereço de envio";
    if (p.firstByte !== esperado) return `parte do vídeo fora de ordem (começa em ${p.firstByte}, esperado ${esperado})`;
    if (!(p.lastByte >= p.firstByte)) return "parte do vídeo com intervalo inválido";
    esperado = p.lastByte + 1;
  }
  if (esperado !== tamanho) return `as partes cobrem ${esperado} bytes e o vídeo tem ${tamanho}`;
  return null;
}

/** Data e hora de Brasília para mensagem (o time lê em horário local). */
export function dataHoraBr(iso: string | number | Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

/** Endereço público do post no LinkedIn a partir da URN devolvida no `x-restli-id`. */
export function linkDoPost(urn: string | null | undefined): string | null {
  if (!urn || !/^urn:li:(share|ugcPost|activity):/.test(urn)) return null;
  return `https://www.linkedin.com/feed/update/${urn}/`;
}
