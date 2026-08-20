/**
 * Construtor de mensagem RFC822.
 *
 * Existe porque o MESMO byte precisa ir para dois lugares: o `DATA` do SMTP (enviar)
 * e o `APPEND` do IMAP (aparecer nos Enviados do servidor). Bibliotecas de envio
 * montam o MIME por dentro e não devolvem o cru, então montamos aqui.
 *
 * Puro: sem rede, sem plataforma. `agora` e `idMensagem` são injetáveis para o teste
 * poder afirmar o byte exato.
 */

export interface AnexoParaEnvio {
  filename: string;
  mimeType: string;
  /** base64 puro, sem data-uri. */
  conteudoBase64: string;
}

export interface MensagemParaEnvio {
  de: { email: string; nome?: string };
  para: string[];
  cc?: string[];
  bcc?: string[];
  assunto: string;
  html: string;
  texto?: string;
  emRespostaA?: string;
  referencias?: string;
  anexos?: AnexoParaEnvio[];
}

export interface OpcoesMontagem {
  agora?: Date;
  idMensagem?: string;
  limite?: () => string;
}

const PRECISA_ENCODAR = /[^\x20-\x7E]/;

/** RFC 2047: cabeçalho com acento vira `=?UTF-8?B?...?=` ou o cliente mostra lixo. */
export function codificarCabecalho(valor: string): string {
  if (!valor || !PRECISA_ENCODAR.test(valor)) return valor;
  const bytes = new TextEncoder().encode(valor);
  let bruto = "";
  for (const b of bytes) bruto += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(bruto)}?=`;
}

export function formatarRemetente(email: string, nome?: string): string {
  if (!nome) return email;
  return `${codificarCabecalho(nome)} <${email}>`;
}

/** Base64 quebrado em 76 colunas, como o RFC 2045 exige. */
export function base64EmLinhas(base64: string): string {
  return (base64.match(/.{1,76}/g) ?? []).join("\r\n");
}

export function base64DeTexto(texto: string): string {
  const bytes = new TextEncoder().encode(texto);
  let bruto = "";
  for (const b of bytes) bruto += String.fromCharCode(b);
  return btoa(bruto);
}

const DIAS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MESES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Data no formato do RFC 5322, em UTC. */
export function dataRfc(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${DIAS[d.getUTCDay()]}, ${p(d.getUTCDate())} ${MESES[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`
  );
}

function novoLimite(): string {
  return `=_ppgvet_${crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * Monta a mensagem inteira. A estrutura segue o que qualquer cliente entende:
 *
 *   sem anexo  → multipart/alternative (texto + html)
 *   com anexo  → multipart/mixed [ multipart/alternative, anexo, anexo... ]
 */
export function montarMensagem(
  msg: MensagemParaEnvio,
  opcoes: OpcoesMontagem = {},
): { bruto: Uint8Array; messageId: string } {
  const agora = opcoes.agora ?? new Date();
  const dominio = msg.de.email.split("@")[1] || "localhost";
  const messageId = opcoes.idMensagem ?? `<${crypto.randomUUID()}@${dominio}>`;
  const limite = opcoes.limite ?? novoLimite;

  const texto = msg.texto ?? msg.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const anexos = msg.anexos ?? [];

  const cabecalhos: string[] = [
    `From: ${formatarRemetente(msg.de.email, msg.de.nome)}`,
    `To: ${msg.para.join(", ")}`,
  ];
  if (msg.cc?.length) cabecalhos.push(`Cc: ${msg.cc.join(", ")}`);
  cabecalhos.push(`Subject: ${codificarCabecalho(msg.assunto)}`);
  cabecalhos.push(`Date: ${dataRfc(agora)}`);
  cabecalhos.push(`Message-ID: ${messageId}`);
  if (msg.emRespostaA) cabecalhos.push(`In-Reply-To: ${msg.emRespostaA}`);
  if (msg.referencias) cabecalhos.push(`References: ${msg.referencias}`);
  cabecalhos.push("MIME-Version: 1.0");

  const limiteAlt = limite();
  const corpoAlternativo = [
    `Content-Type: multipart/alternative; boundary="${limiteAlt}"`,
    "",
    `--${limiteAlt}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    "Content-Transfer-Encoding: base64",
    "",
    base64EmLinhas(base64DeTexto(texto)),
    "",
    `--${limiteAlt}`,
    `Content-Type: text/html; charset="UTF-8"`,
    "Content-Transfer-Encoding: base64",
    "",
    base64EmLinhas(base64DeTexto(msg.html)),
    "",
    `--${limiteAlt}--`,
  ];

  let corpo: string[];
  if (!anexos.length) {
    corpo = [...cabecalhos, ...corpoAlternativo];
  } else {
    const limiteMisto = limite();
    corpo = [
      ...cabecalhos,
      `Content-Type: multipart/mixed; boundary="${limiteMisto}"`,
      "",
      `--${limiteMisto}`,
      ...corpoAlternativo,
      "",
    ];
    for (const anexo of anexos) {
      corpo.push(
        `--${limiteMisto}`,
        `Content-Type: ${anexo.mimeType}; name="${anexo.filename}"`,
        `Content-Disposition: attachment; filename="${codificarCabecalho(anexo.filename)}"`,
        "Content-Transfer-Encoding: base64",
        "",
        base64EmLinhas(anexo.conteudoBase64),
        "",
      );
    }
    corpo.push(`--${limiteMisto}--`);
  }

  return { bruto: new TextEncoder().encode(corpo.join("\r\n") + "\r\n"), messageId };
}

/** Todos os destinatários reais do envelope — o Bcc entra aqui e NÃO no cabeçalho. */
export function destinatariosDoEnvelope(msg: MensagemParaEnvio): string[] {
  return [...msg.para, ...(msg.cc ?? []), ...(msg.bcc ?? [])]
    .map((e) => e.trim())
    .filter(Boolean);
}
