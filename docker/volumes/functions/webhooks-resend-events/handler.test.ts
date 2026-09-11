import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { tratarEventoResend } from "./handler";

const segredo = `whsec_${Buffer.from("segredo-ficticio-exclusivo-testes").toString("base64")}`;
const agoraMs = 1_790_000_000_000;
const evento = {
  type: "email.bounced", created_at: new Date(agoraMs).toISOString(),
  data: { email_id: "id-no-resend", to: ["teste@example.invalid"], bounce: { message: "caixa inexistente" } },
};

function requisicao(corpo = JSON.stringify(evento), assinar = true) {
  const id = "msg-teste";
  const timestamp = String(agoraMs / 1000);
  const assinatura = createHmac("sha256", Buffer.from(segredo.slice(6), "base64"))
    .update(`${id}.${timestamp}.${corpo}`).digest("base64");
  return new Request("https://api.example.invalid/functions/v1/webhooks-resend-events", {
    method: "POST", body: corpo,
    headers: {
      "svix-id": id, "svix-timestamp": timestamp,
      "svix-signature": assinar ? `v1,${assinatura}` : "v1,invalida",
    },
  });
}

function banco() {
  return { rpc: vi.fn().mockResolvedValue({ data: { ok: true, suprimidos: 1 }, error: null }) };
}

describe("webhook Resend", () => {
  it("verifica assinatura real antes de delegar os efeitos a uma única transação", async () => {
    const supabase = banco();
    const resposta = await tratarEventoResend(requisicao(), { supabase, segredo, agoraMs });
    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toEqual({ ok: true, suprimidos: 1 });
    expect(supabase.rpc).toHaveBeenCalledExactlyOnceWith("email_processar_evento_resend", {
      p_evento_id: "msg-teste", p_evento: evento,
    });
  });

  it("nega payload forjado sem tocar no banco", async () => {
    const supabase = banco();
    const resposta = await tratarEventoResend(requisicao(undefined, false), { supabase, segredo, agoraMs });
    expect(resposta.status).toBe(400);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("retorna erro recuperável sem segredo, nunca aceita o evento", async () => {
    const supabase = banco();
    const resposta = await tratarEventoResend(requisicao(), { supabase, agoraMs });
    expect(resposta.status).toBe(503);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("recusa assinatura antiga mesmo que criptograficamente válida", async () => {
    const supabase = banco();
    const resposta = await tratarEventoResend(requisicao(), { supabase, segredo, agoraMs: agoraMs + 301_000 });
    expect(resposta.status).toBe(400);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it.each(["{", "null", "[]", '{"type":"email.bounced","data":null}', '{"data":{}}'])("recusa envelope inválido: %s", async (corpo) => {
    const supabase = banco();
    const resposta = await tratarEventoResend(requisicao(corpo), { supabase, segredo, agoraMs });
    expect(resposta.status).toBe(400);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("não acusa recebimento se o banco falhar nem expõe dados do erro", async () => {
    const supabase = banco();
    supabase.rpc.mockResolvedValue({ data: null, error: { message: "dado-pessoal-ou-segredo", code: "XX001" } });
    const resposta = await tratarEventoResend(requisicao(), { supabase, segredo, agoraMs });
    expect(resposta.status).toBe(503);
    expect(await resposta.text()).not.toContain("dado-pessoal-ou-segredo");
  });

  it("permite retry se a conexão com o banco cair", async () => {
    const supabase = banco();
    supabase.rpc.mockRejectedValue(new Error("indisponível"));
    const resposta = await tratarEventoResend(requisicao(), { supabase, segredo, agoraMs });
    expect(resposta.status).toBe(503);
  });

  it("não confirma resposta vazia da transação", async () => {
    const supabase = banco();
    supabase.rpc.mockResolvedValue({ data: null, error: null });
    const resposta = await tratarEventoResend(requisicao(), { supabase, segredo, agoraMs });
    expect(resposta.status).toBe(503);
  });

  it("aceita confirmação de evento já processado sem repetir efeitos locais", async () => {
    const supabase = banco();
    supabase.rpc.mockResolvedValue({ data: { ok: true, repetido: true }, error: null });
    const resposta = await tratarEventoResend(requisicao(), { supabase, segredo, agoraMs });
    expect(await resposta.json()).toEqual({ ok: true, repetido: true });
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
  });

  it("limita o corpo antes de qualquer acesso ao banco", async () => {
    const supabase = banco();
    const resposta = await tratarEventoResend(requisicao("x".repeat(256 * 1024 + 1)), { supabase, segredo, agoraMs });
    expect(resposta.status).toBe(413);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("não processa outros métodos", async () => {
    const supabase = banco();
    const resposta = await tratarEventoResend(new Request("https://example.invalid"), { supabase, segredo, agoraMs });
    expect(resposta.status).toBe(405);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});
