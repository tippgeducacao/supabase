/**
 * Validação de assinatura de mensagem SNS.
 *
 * Não confiar no corpo é o ponto inteiro: o endpoint do webhook é público (o SNS não
 * manda JWT) e ele alimenta a lista de supressão. Sem verificar assinatura, qualquer
 * um poderia forjar um `Bounce` e bloquear a entrega para um endereço qualquer.
 *
 * O algoritmo é o publicado pela AWS:
 *   1. montar a "string to sign" com os campos canônicos, na ordem definida por tipo;
 *   2. baixar o certificado X.509 apontado por `SigningCertURL`;
 *   3. verificar a assinatura RSA (SHA1 na v1, SHA256 na v2) com a chave pública.
 *
 * `SigningCertURL` é validada contra host da AWS ANTES do fetch — sem isso, um
 * atacante apontaria o certificado para um servidor dele e a verificação passaria.
 */

export interface MensagemSns {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  SubscribeURL?: string;
  Token?: string;
  UnsubscribeURL?: string;
}

/** Campos que entram na assinatura, na ORDEM exigida — trocar a ordem invalida tudo. */
const CAMPOS_NOTIFICACAO = ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"];
const CAMPOS_INSCRICAO = [
  "Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type",
];

export function montarStringParaAssinar(msg: MensagemSns): string {
  const campos = msg.Type === "Notification" ? CAMPOS_NOTIFICACAO : CAMPOS_INSCRICAO;
  const partes: string[] = [];
  for (const campo of campos) {
    const valor = (msg as unknown as Record<string, unknown>)[campo];
    // Campo ausente é PULADO (não vira string vazia) — é assim que a AWS monta.
    if (valor === undefined || valor === null) continue;
    partes.push(campo, String(valor));
  }
  return partes.join("\n") + "\n";
}

/**
 * O certificado tem que vir de um host da AWS. Aceita apenas
 * `sns.<regiao>.amazonaws.com` e o equivalente em `amazonaws.com.cn`.
 */
export function certUrlConfiavel(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  return /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(parsed.hostname);
}

function pemParaBinario(pem: string): Uint8Array {
  const corpo = pem
    .replace(/-----BEGIN CERTIFICATE-----/, "")
    .replace(/-----END CERTIFICATE-----/, "")
    .replace(/\s+/g, "");
  return Uint8Array.from(atob(corpo), (c) => c.charCodeAt(0));
}

/**
 * Extrai a chave pública RSA de um certificado X.509 em DER.
 *
 * Feito à mão porque o WebCrypto não importa X.509 diretamente e trazer uma lib de
 * ASN.1 para a edge function seria peso desproporcional. A busca é pelo OID de
 * rsaEncryption (1.2.840.113549.1.1.1) seguido do BIT STRING com o SubjectPublicKeyInfo.
 */
export function extrairChavePublicaDer(der: Uint8Array): Uint8Array {
  const OID_RSA = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];

  for (let i = 0; i < der.length - OID_RSA.length; i++) {
    let casa = true;
    for (let j = 0; j < OID_RSA.length; j++) {
      if (der[i + j] !== OID_RSA[j]) { casa = false; break; }
    }
    if (!casa) continue;

    // Depois do OID vem NULL (05 00) e então o BIT STRING (03) com a chave.
    let k = i + OID_RSA.length;
    if (der[k] === 0x05 && der[k + 1] === 0x00) k += 2;
    if (der[k] !== 0x03) continue;
    k++;

    // Comprimento em formato DER (curto ou longo).
    let tamanho = der[k];
    if (tamanho & 0x80) {
      const bytes = tamanho & 0x7f;
      tamanho = 0;
      for (let b = 1; b <= bytes; b++) tamanho = (tamanho << 8) | der[k + b];
      k += bytes;
    }
    k++;
    // Primeiro byte do BIT STRING é a contagem de bits não usados; sempre 0 aqui.
    if (der[k] === 0x00) k++;

    // O SubjectPublicKeyInfo que o WebCrypto quer é o SPKI inteiro, do início da
    // SEQUENCE que contém o OID. Recuamos até o começo dessa SEQUENCE.
    const inicioSpki = acharInicioSequencia(der, i);
    if (inicioSpki < 0) continue;
    // ⚠️ NÃO fatiar até o fim do certificado: isso leva junto a assinatura e as
    // extensões. O WebCrypto do Node ignora o excedente, mas o do Deno — que é o que
    // roda em produção — recusa com "ASN.1 error: trailing data at end of DER message:
    // decoded 294 bytes, 361 bytes remaining". Como o `catch` de assinaturaSnsValida
    // engole o erro, TODA mensagem SNS era rejeitada como assinatura inválida, sem log.
    // Os testes não pegaram porque injetam `verificarAssinatura: async () => true` e
    // nunca executam este caminho (04/09/2026).
    return der.slice(inicioSpki, inicioSpki + tamanhoDer(der, inicioSpki));
  }
  throw new Error("chave pública RSA não encontrada no certificado");
}

/**
 * Comprimento TOTAL (cabeçalho + conteúdo) da estrutura DER que começa em `inicio`.
 * O byte de tamanho é curto (< 0x80) ou longo (0x80 | nº de bytes do tamanho).
 */
function tamanhoDer(der: Uint8Array, inicio: number): number {
  let k = inicio + 1;
  let tamanho = der[k];
  if (tamanho & 0x80) {
    const bytes = tamanho & 0x7f;
    tamanho = 0;
    for (let b = 1; b <= bytes; b++) tamanho = (tamanho << 8) | der[k + b];
    k += bytes;
  }
  k++;
  return (k - inicio) + tamanho;
}

/** Recua do OID até o cabeçalho da SEQUENCE que abre o SubjectPublicKeyInfo. */
function acharInicioSequencia(der: Uint8Array, posOid: number): number {
  for (let i = posOid; i >= 2; i--) {
    if (der[i] === 0x30 && der[i + 1] === 0x82) return i;
  }
  return -1;
}

export interface OpcoesVerificacao {
  /** Injetado nos testes; em produção usa fetch. */
  baixarCertificado?: (url: string) => Promise<string>;
  /** Janela de tolerância do Timestamp, em minutos. */
  toleranciaMin?: number;
  agoraMs?: number;
}

const cachePem = new Map<string, string>();

async function baixarPem(url: string): Promise<string> {
  const emCache = cachePem.get(url);
  if (emCache) return emCache;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`falha ao baixar certificado (${res.status})`);
  const pem = await res.text();
  cachePem.set(url, pem);
  return pem;
}

export async function assinaturaSnsValida(
  msg: MensagemSns,
  opcoes: OpcoesVerificacao = {},
): Promise<boolean> {
  const { toleranciaMin = 60, agoraMs = Date.now() } = opcoes;

  if (!msg?.Signature || !msg.SigningCertURL || !msg.Type) return false;
  if (!certUrlConfiavel(msg.SigningCertURL)) return false;

  // Janela de tempo: barra replay de uma notificação capturada.
  const t = Date.parse(msg.Timestamp);
  if (!Number.isFinite(t) || Math.abs(agoraMs - t) > toleranciaMin * 60_000) return false;

  const versao = msg.SignatureVersion;
  if (versao !== "1" && versao !== "2") return false;

  try {
    const pem = await (opcoes.baixarCertificado ?? baixarPem)(msg.SigningCertURL);
    const spki = extrairChavePublicaDer(pemParaBinario(pem));
    // v1 assina com SHA-1; v2 com SHA-256. Aceitar as duas é necessário porque tópicos
    // antigos seguem em v1.
    const hash = versao === "2" ? "SHA-256" : "SHA-1";

    const chave = await crypto.subtle.importKey(
      "spki",
      spki,
      { name: "RSASSA-PKCS1-v1_5", hash },
      false,
      ["verify"],
    );

    const assinatura = Uint8Array.from(atob(msg.Signature), (c) => c.charCodeAt(0));
    const dados = new TextEncoder().encode(montarStringParaAssinar(msg));

    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", chave, assinatura, dados);
  } catch {
    // Certificado malformado, chave irreconhecível ou fetch falhou: não valida nada.
    return false;
  }
}
