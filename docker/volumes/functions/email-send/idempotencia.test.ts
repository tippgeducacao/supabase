import { describe, expect, it } from "vitest";
import { respostaEnvioExistente } from "./idempotencia.ts";

describe("resultado de requisição repetida", () => {
  it.each(["enfileirado", "falhou"])("não conta log %s sem confirmação como enviado", (status) => {
    expect(respostaEnvioExistente({ id: "log-1", status, provider: "resend" }))
      .toMatchObject({ status: 409, corpo: { ok: false, duplicado: true, log_id: "log-1" } });
  });

  it("reconhece o ID do provedor mesmo se o webhook ainda não avançou o status", () => {
    expect(respostaEnvioExistente({ id: "log-1", status: "enfileirado", provider: "resend", provider_message_id: "resend-1" }))
      .toMatchObject({ status: 200, corpo: { ok: true, log_id: "log-1", provider_message_id: "resend-1" } });
  });

  it("mantém a deduplicação de envios Gmail que não usam provider_message_id", () => {
    expect(respostaEnvioExistente({ id: "gmail-1", status: "enviado", provider: "gmail" }))
      .toMatchObject({ status: 200, corpo: { ok: true, duplicado: true } });
  });
});
