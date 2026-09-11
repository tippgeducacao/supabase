import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assinaturaResendValida } from "./resendSignature";

// Vetor independente publicado pela Svix, para não testar apenas uma assinatura
// fabricada pela mesma implementação que estamos verificando.
// https://docs.svix.com/receiving/verifying-payloads/how-manual#example-signatures
const segredo = "whsec_plJ3nmyCDGBKInavdOK15jsl";
const corpo = '{"event_type":"ping","data":{"success":true}}';
const agoraMs = 1731705121000;
const headers = () => new Headers({
  "svix-id": "msg_loFOjxBNrRLzqYUf",
  "svix-timestamp": "1731705121",
  "svix-signature": "v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=",
});

describe("assinatura Resend/Svix", () => {
  it("valida o vetor oficial usando WebCrypto", async () => {
    expect(await assinaturaResendValida(corpo, headers(), segredo, agoraMs)).toBe(true);
  });

  it.each([corpo + " ", corpo.replace("true", "false"), "{}"])("recusa alterações nos bytes do corpo: %s", async (alterado) => {
    expect(await assinaturaResendValida(alterado, headers(), segredo, agoraMs)).toBe(false);
  });

  it("aceita a chave válida durante rotação", async () => {
    const h = headers();
    h.set("svix-signature", `v2,outra v1,%%% ${h.get("svix-signature")}`);
    expect(await assinaturaResendValida(corpo, h, segredo, agoraMs)).toBe(true);
  });

  it.each([-301, 301])("recusa tentativa fora da janela de tempo (%s s)", async (desvio) => {
    expect(await assinaturaResendValida(corpo, headers(), segredo, agoraMs + desvio * 1000)).toBe(false);
  });

  it("assina e verifica acentos pelo caminho Node crypto → WebCrypto", async () => {
    const h = headers();
    const texto = '{"type":"email.sent","data":{"subject":"Pós-graduação 🐾"}}';
    const assinatura = createHmac("sha256", Buffer.from(segredo.slice(6), "base64"))
      .update(`${h.get("svix-id")}.${h.get("svix-timestamp")}.${texto}`).digest("base64");
    h.set("svix-signature", `v1,${assinatura}`);
    expect(await assinaturaResendValida(texto, h, segredo, agoraMs)).toBe(true);
  });

  it.each(["svix-id", "svix-timestamp", "svix-signature"])("recusa cabeçalho ausente: %s", async (nome) => {
    const h = headers();
    h.delete(nome);
    expect(await assinaturaResendValida(corpo, h, segredo, agoraMs)).toBe(false);
  });

  it("recusa segredo inválido e timestamp não numérico", async () => {
    expect(await assinaturaResendValida(corpo, headers(), "re_nao_e_segredo_webhook", agoraMs)).toBe(false);
    const h = headers();
    h.set("svix-timestamp", "NaN");
    expect(await assinaturaResendValida(corpo, h, segredo, agoraMs)).toBe(false);
  });
});
