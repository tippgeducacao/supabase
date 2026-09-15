import { describe, expect, it } from "vitest";
import { conferirConsultaIdempotente, permiteNovaChaveIdempotente, respostaEnvioExistente } from "./idempotencia.ts";

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

describe("falhas de consulta e reserva de campanha", () => {
  it("uma falha na releitura após colisão 23505 não autoriza outro envio", () => {
    expect(() => conferirConsultaIdempotente({ message: "offline" }, null, { destinatario_email: "a@example.invalid" })).toThrow("Nenhum novo envio");
  });
  it.each([undefined, 0, -1, Infinity, NaN])("sem janela válida %s nunca cria outra chave", janela => {
    expect(permiteNovaChaveIdempotente(janela, "webhook", "webhook:1")).toBe(false);
  });
  it("campanhas não podem desambiguar sua chave mesmo com janela", () => {
    expect(permiteNovaChaveIdempotente(60, "campanha", "campanha:1")).toBe(false);
    expect(permiteNovaChaveIdempotente(60, "manual", "campanha:1")).toBe(false);
    expect(permiteNovaChaveIdempotente(60, "webhook", "webhook:1")).toBe(true);
  });
  it("um log de outro destinatário não confirma a fila da campanha", () => {
    const log = { id: "log", status: "enviado", contexto_tipo: "campanha", contexto_id: "c", template_id: "b", destinatario_email: "outra@example.invalid" };
    const pedido = { contexto_tipo: "campanha", contexto_id: "c", template_id: "b", destinatario_email: "pessoa@example.invalid" };
    expect(() => conferirConsultaIdempotente(null, log, pedido)).toThrow("não corresponde");
    expect(() => conferirConsultaIdempotente(null, { ...log, destinatario_email: " Pessoa@Example.invalid " }, pedido)).not.toThrow();
  });
});
