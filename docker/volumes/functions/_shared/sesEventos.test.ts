/**
 * Interpretação dos eventos SES e verificação de assinatura SNS, com os payloads
 * reais salvos em tests/fixtures/sns/.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { interpretarEventoSes } from "./sesEventos.ts";
import {
  assinaturaSnsValida, certUrlConfiavel, montarStringParaAssinar, type MensagemSns,
} from "./snsVerify.ts";

const DIR = join(process.cwd(), "tests", "fixtures", "sns");
const fixture = (nome: string): MensagemSns =>
  JSON.parse(readFileSync(join(DIR, `${nome}.json`), "utf-8"));

/** Extrai o payload do SES de dentro do envelope SNS. */
const corpoSes = (m: MensagemSns) => JSON.parse(m.Message);

describe("interpretação dos eventos SES", () => {
  it("bounce PERMANENTE suprime o endereço", () => {
    const e = interpretarEventoSes(corpoSes(fixture("notification-bounce-permanent")));

    expect(e.tipo).toBe("Bounce");
    expect(e.status).toBe("bounce");
    expect(e.messageId).toBe("0100018f-abc-message-id");
    expect(e.suprimir).toHaveLength(1);
    expect(e.suprimir[0]).toMatchObject({ email: "inexistente@exemplo.com", motivo: "bounce" });
    expect(e.suprimir[0].detalhe).toContain("Permanent");
  });

  it("bounce TRANSIENTE não suprime — caixa cheia não é endereço inválido", () => {
    const e = interpretarEventoSes(corpoSes(fixture("notification-bounce-transient")));

    expect(e.tipo).toBe("Bounce");
    expect(e.suprimir).toHaveLength(0);
    // Nem marca como bounce: o próprio SES ainda pode reentregar.
    expect(e.status).toBe("enviado");
  });

  it("reclamação suprime com motivo spam", () => {
    const e = interpretarEventoSes(corpoSes(fixture("notification-complaint")));

    expect(e.tipo).toBe("Complaint");
    expect(e.status).toBe("spam");
    expect(e.suprimir).toEqual([
      expect.objectContaining({ email: "reclamou@exemplo.com", motivo: "spam" }),
    ]);
  });

  it("entrega marca entregue e não suprime ninguém", () => {
    const e = interpretarEventoSes(corpoSes(fixture("notification-delivery")));

    expect(e.status).toBe("entregue");
    expect(e.suprimir).toHaveLength(0);
    expect(e.destinatarios).toEqual(["ok@exemplo.com"]);
  });

  it("evento desconhecido não quebra a interpretação", () => {
    const e = interpretarEventoSes({ notificationType: "Coisa", mail: { messageId: "x" } });
    expect(e.messageId).toBe("x");
    expect(e.suprimir).toHaveLength(0);
  });
});

describe("string canônica da assinatura SNS", () => {
  it("usa a ordem exigida e pula campo ausente", () => {
    const m = fixture("notification-delivery");
    const s = montarStringParaAssinar(m);

    // A string é ALTERNADA nome/valor, uma por linha — por isso a conferência é por
    // índice de linha, e não por indexOf: "Type" também aparece dentro do JSON da
    // mensagem (em "notificationType"), e a busca textual casaria no lugar errado.
    const linhas = s.split("\n");
    const nomes = linhas.filter((_, i) => i % 2 === 0);

    expect(nomes.slice(0, 5)).toEqual(["Message", "MessageId", "Timestamp", "TopicArn", "Type"]);
    // Sem Subject na fixture: o campo é PULADO, não vira string vazia.
    expect(nomes).not.toContain("Subject");
    expect(s.endsWith("\n")).toBe(true);
  });

  it("inclui Subject quando ele existe, na posição certa", () => {
    const m = { ...fixture("notification-delivery"), Subject: "assunto" };
    const nomes = montarStringParaAssinar(m).split("\n").filter((_, i) => i % 2 === 0);
    expect(nomes.slice(0, 6)).toEqual(["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]);
  });

  it("SubscriptionConfirmation inclui SubscribeURL e Token", () => {
    const s = montarStringParaAssinar(fixture("subscription-confirmation"));
    expect(s).toContain("SubscribeURL");
    expect(s).toContain("Token");
  });
});

describe("origem do certificado", () => {
  it("aceita host da AWS", () => {
    expect(certUrlConfiavel("https://sns.us-east-1.amazonaws.com/Simple-abc.pem")).toBe(true);
    expect(certUrlConfiavel("https://sns.sa-east-1.amazonaws.com/x.pem")).toBe(true);
  });

  it("REJEITA host de terceiro — senão o atacante serve o próprio certificado", () => {
    for (const url of [
      "https://sns.us-east-1.amazonaws.com.atacante.com/x.pem",
      "https://atacante.com/sns.us-east-1.amazonaws.com/x.pem",
      "http://sns.us-east-1.amazonaws.com/x.pem",
      "https://evil.com/x.pem",
    ]) {
      expect(certUrlConfiavel(url), url).toBe(false);
    }
  });

  it("REJEITA url malformada", () => {
    expect(certUrlConfiavel("nao-e-url")).toBe(false);
    expect(certUrlConfiavel("")).toBe(false);
  });
});

describe("validação da assinatura", () => {
  const agora = Date.parse("2026-08-14T12:00:05.000Z");

  it("rejeita quando a url do certificado não é da AWS", async () => {
    const m = { ...fixture("notification-delivery"), SigningCertURL: "https://evil.com/x.pem" };
    expect(await assinaturaSnsValida(m, { agoraMs: agora })).toBe(false);
  });

  it("rejeita mensagem fora da janela de tempo (replay)", async () => {
    const m = fixture("notification-bounce-permanent");
    const doisDiasDepois = Date.parse("2026-08-16T12:00:00.000Z");
    expect(await assinaturaSnsValida(m, { agoraMs: doisDiasDepois })).toBe(false);
  });

  it("rejeita SignatureVersion desconhecida", async () => {
    const m = { ...fixture("notification-bounce-permanent"), SignatureVersion: "9" };
    expect(await assinaturaSnsValida(m, { agoraMs: agora })).toBe(false);
  });

  it("rejeita quando falta assinatura", async () => {
    const m = { ...fixture("notification-bounce-permanent"), Signature: "" };
    expect(await assinaturaSnsValida(m, { agoraMs: agora })).toBe(false);
  });

  it("rejeita quando o certificado não baixa", async () => {
    const m = fixture("notification-bounce-permanent");
    const baixar = vi.fn(async () => { throw new Error("404"); });
    expect(await assinaturaSnsValida(m, { agoraMs: agora, baixarCertificado: baixar })).toBe(false);
  });

  it("rejeita certificado malformado sem lançar exceção", async () => {
    const m = fixture("notification-bounce-permanent");
    const baixar = vi.fn(async () => "-----BEGIN CERTIFICATE-----\nnao-e-base64-valido\n-----END CERTIFICATE-----");
    expect(await assinaturaSnsValida(m, { agoraMs: agora, baixarCertificado: baixar })).toBe(false);
  });
});
