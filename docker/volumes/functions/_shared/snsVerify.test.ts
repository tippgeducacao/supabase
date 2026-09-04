/**
 * Testes da verificação de assinatura SNS.
 *
 * ⚠️ Este arquivo existe por causa de um incidente: a verificação NUNCA tinha sido
 * testada de verdade. `handler.test.ts` injeta `verificarAssinatura: async () => true`
 * e as fixtures trazem `"Signature": "ASSINATURA_FALSA_PARA_TESTE"` — ou seja, o
 * download do certificado, o parse do X.509, o `importKey` e o `verify` nunca rodaram.
 * O defeito só apareceu na PRIMEIRA mensagem SNS real (04/09/2026), quando toda
 * confirmação de inscrição passou a ser recusada em silêncio.
 *
 * O bug: `extrairChavePublicaDer` devolvia `der.slice(inicioSpki)` — do início do SPKI
 * até o FIM do certificado, carregando assinatura e extensões junto. O WebCrypto do
 * Node ignora esse excedente; o do Deno (que roda em produção) recusa com
 * "ASN.1 error: trailing data at end of DER message".
 *
 * Como o vitest roda em Node, um teste de `importKey` NÃO pegaria a regressão. Por isso
 * o teste-guarda abaixo checa o INVARIANTE — o SPKI não pode ter byte sobrando — em vez
 * do comportamento do runtime.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";
import { join } from "node:path";
import {
  extrairChavePublicaDer,
  certUrlConfiavel,
  montarStringParaAssinar,
  assinaturaSnsValida,
  type MensagemSns,
} from "./snsVerify.ts";

const DIR = join(process.cwd(), "tests/fixtures/sns");
const CERT = readFileSync(join(DIR, "cert-teste.pem"), "utf8");
const CHAVE = readFileSync(join(DIR, "cert-teste.key.pem"), "utf8");

function derDoPem(pem: string): Uint8Array {
  const corpo = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(Buffer.from(corpo, "base64"));
}

/** Comprimento total declarado no cabeçalho DER da estrutura que começa em 0. */
function tamanhoDeclarado(der: Uint8Array): number {
  let k = 1;
  let tamanho = der[k];
  if (tamanho & 0x80) {
    const bytes = tamanho & 0x7f;
    tamanho = 0;
    for (let b = 1; b <= bytes; b++) tamanho = (tamanho << 8) | der[k + b];
    k += bytes;
  }
  k++;
  return k + tamanho;
}

function mensagemAssinada(versao: "1" | "2"): MensagemSns {
  const msg: MensagemSns = {
    Type: "SubscriptionConfirmation",
    MessageId: "abc-123",
    Token: "tok-456",
    TopicArn: "arn:aws:sns:sa-east-1:110379261517:ppgvet-ses-eventos",
    Message: "You have chosen to subscribe to the topic ...",
    SubscribeURL: "https://sns.sa-east-1.amazonaws.com/?Action=ConfirmSubscription",
    Timestamp: new Date().toISOString(),
    SignatureVersion: versao,
    Signature: "",
    SigningCertURL: "https://sns.sa-east-1.amazonaws.com/SimpleNotificationService-x.pem",
  };
  const alg = versao === "2" ? "RSA-SHA256" : "RSA-SHA1";
  msg.Signature = createSign(alg).update(montarStringParaAssinar(msg)).sign(CHAVE, "base64");
  return msg;
}

const baixaFixture = { baixarCertificado: async () => CERT };

describe("extrairChavePublicaDer", () => {
  it("devolve o SPKI EXATO, sem bytes sobrando (regressão 04/09/2026)", () => {
    const spki = extrairChavePublicaDer(derDoPem(CERT));
    // Se voltar a fatiar até o fim do certificado, isto quebra: o array fica bem maior
    // que o comprimento que o próprio cabeçalho DER declara.
    expect(spki.length).toBe(tamanhoDeclarado(spki));
  });

  it("o SPKI de uma chave RSA-2048 tem 294 bytes", () => {
    expect(extrairChavePublicaDer(derDoPem(CERT)).length).toBe(294);
  });

  it("é importável pelo WebCrypto", async () => {
    const spki = extrairChavePublicaDer(derDoPem(CERT));
    await expect(crypto.subtle.importKey(
      "spki", spki, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
    )).resolves.toBeDefined();
  });
});

describe("assinaturaSnsValida", () => {
  it("aceita assinatura legítima na versão 1 (SHA-1)", async () => {
    expect(await assinaturaSnsValida(mensagemAssinada("1"), baixaFixture)).toBe(true);
  });

  it("aceita assinatura legítima na versão 2 (SHA-256)", async () => {
    expect(await assinaturaSnsValida(mensagemAssinada("2"), baixaFixture)).toBe(true);
  });

  it("RECUSA assinatura forjada", async () => {
    const msg = { ...mensagemAssinada("1"), Signature: Buffer.from("lixo").toString("base64") };
    expect(await assinaturaSnsValida(msg, baixaFixture)).toBe(false);
  });

  it("RECUSA corpo adulterado depois de assinado", async () => {
    const msg = { ...mensagemAssinada("1"), Message: "conteúdo trocado por um atacante" };
    expect(await assinaturaSnsValida(msg, baixaFixture)).toBe(false);
  });

  it("RECUSA mensagem fora da janela de tempo (replay)", async () => {
    const msg = mensagemAssinada("1");
    const duasHorasDepois = Date.parse(msg.Timestamp) + 2 * 60 * 60 * 1000;
    expect(await assinaturaSnsValida(msg, { ...baixaFixture, agoraMs: duasHorasDepois })).toBe(false);
  });

  it("RECUSA SignatureVersion desconhecida", async () => {
    const msg = { ...mensagemAssinada("1"), SignatureVersion: "3" };
    expect(await assinaturaSnsValida(msg, baixaFixture)).toBe(false);
  });
});

describe("certUrlConfiavel", () => {
  it.each([
    ["https://sns.sa-east-1.amazonaws.com/SimpleNotificationService-x.pem", true],
    ["https://sns.us-east-1.amazonaws.com/x.pem", true],
    ["https://sns.cn-north-1.amazonaws.com.cn/x.pem", true],
    ["http://sns.sa-east-1.amazonaws.com/x.pem", false],          // sem TLS
    ["https://sns.sa-east-1.amazonaws.com.evil.com/x.pem", false], // sufixo forjado
    ["https://evil.com/sns.sa-east-1.amazonaws.com/x.pem", false], // host do atacante
  ])("%s -> %s", (url, esperado) => {
    expect(certUrlConfiavel(url)).toBe(esperado);
  });
});
