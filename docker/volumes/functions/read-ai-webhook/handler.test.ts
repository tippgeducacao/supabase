// @vitest-environment node
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { LIMITE_CORPO_BYTES, tratarWebhookReadAi, type DepsReadAi } from "./handler.ts";

const CHAVE = Buffer.from("chave-de-teste-do-read-ai").toString("base64");
const CORPO = JSON.stringify({ session_id: "S1", trigger: "meeting_end", title: "Reunião B2B — ZZ Teste Read" });

const hmac = (chave: string | Buffer, corpo = CORPO, saida: "hex" | "base64" = "hex") =>
  createHmac("sha256", chave).update(corpo).digest(saida);

const pedido = (assinatura: string | null, corpo = CORPO) =>
  new Request("http://local/read-ai-webhook", {
    method: "POST",
    headers: assinatura ? { "X-Read-Signature": assinatura } : {},
    body: corpo,
  });

function deps(chaves: string | null = CHAVE) {
  const gravar = vi.fn<DepsReadAi["gravar"]>(async () => ({ error: null }));
  return { lerChaves: async () => chaves, gravar };
}

describe("webhook do Read AI", () => {
  it.each([
    ["chave como texto, hex", hmac(CHAVE), "chave-texto/hex"],
    ["chave decodificada de base64, hex", hmac(Buffer.from(CHAVE, "base64")), "chave-base64/hex"],
    ["assinatura em base64", hmac(CHAVE, CORPO, "base64"), "chave-texto/base64"],
    ["prefixo sha256= e maiúsculas", `sha256=${hmac(CHAVE).toUpperCase()}`, "chave-texto/hex"],
  ])("aceita e grava: %s", async (_nome, assinatura, formato) => {
    const d = deps();
    const r = await tratarWebhookReadAi(pedido(assinatura), d);
    expect(r.status).toBe(200);
    expect(d.gravar).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: "S1", evento: "meeting_end", assinatura_formato: formato }),
    );
  });

  it("aceita qualquer uma de várias chaves cadastradas", async () => {
    const d = deps(`outra-chave,\n${CHAVE}`);
    expect((await tratarWebhookReadAi(pedido(hmac(CHAVE)), d)).status).toBe(200);
  });

  it("não grava com assinatura errada, ausente ou de outro corpo", async () => {
    for (const assinatura of [null, "abc", hmac("chave-errada"), hmac(CHAVE, "{}")]) {
      const d = deps();
      expect((await tratarWebhookReadAi(pedido(assinatura), d)).status).toBe(401);
      expect(d.gravar).not.toHaveBeenCalled();
    }
  });

  it("sem chave configurada responde 503 e não grava", async () => {
    for (const chaves of [null, "  "]) {
      const d = deps(chaves);
      expect((await tratarWebhookReadAi(pedido(hmac(CHAVE)), d)).status).toBe(503);
      expect(d.gravar).not.toHaveBeenCalled();
    }
  });

  it("recusa outro método, corpo grande e JSON que não é objeto", async () => {
    const d = deps();
    expect((await tratarWebhookReadAi(new Request("http://local/x"), d)).status).toBe(405);
    const grande = "x".repeat(LIMITE_CORPO_BYTES + 1);
    expect((await tratarWebhookReadAi(pedido(hmac(CHAVE, grande), grande), d)).status).toBe(413);
    for (const corpo of ["nao-e-json", "[1]"]) {
      expect((await tratarWebhookReadAi(pedido(hmac(CHAVE, corpo), corpo), d)).status).toBe(400);
    }
    expect(d.gravar).not.toHaveBeenCalled();
  });

  it("modo teste: reunião sem a marca no título é aceita e descartada sem gravar", async () => {
    for (const corpo of [JSON.stringify({ session_id: "S2", title: "Entrevista" }), JSON.stringify({ session_id: "S3" })]) {
      const d = deps();
      const r = await tratarWebhookReadAi(pedido(hmac(CHAVE, corpo), corpo), d);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true, ignorada: true });
      expect(d.gravar).not.toHaveBeenCalled();
    }
  });

  it("falha ao gravar devolve 500 para o Read tentar de novo", async () => {
    const d = deps();
    d.gravar.mockResolvedValue({ error: { message: "banco fora" } });
    expect((await tratarWebhookReadAi(pedido(hmac(CHAVE)), d)).status).toBe(500);
  });
});
