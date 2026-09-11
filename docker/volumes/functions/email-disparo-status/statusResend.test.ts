import { describe, expect, it, vi } from "vitest";
import { verificarStatusResend } from "./statusResend.ts";

const remetente = { provider: "resend", ativo: true, email_completo: "Cursos@MAIL.EXEMPLO.COM" };
const dominio = { id: "d1", name: "mail.exemplo.com", status: "verified", capabilities: { sending: "enabled" } };
const resposta = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const opcoes = (dominios = [dominio]) => ({
  apiKey: "chave-secreta", webhookSecret: "whsec_segredo", remetentes: [remetente],
  fetcher: vi.fn<typeof fetch>().mockResolvedValue(resposta({ data: dominios, has_more: false })),
});

describe("status real dos remetentes Resend", () => {
  it("exige o domínio exato do remetente e assinatura de eventos para marcar configuração pronta", async () => {
    const status = await verificarStatusResend(opcoes());
    expect(status).toMatchObject({ ok: true, provider: "resend", apiRespondeu: true,
      dominiosVerificados: 1, dominiosPendentes: 0, webhookConfigurado: true });
    expect(JSON.stringify(status)).not.toMatch(/chave-secreta|whsec_segredo/);
    expect(status.detalhe).toContain("envio de teste");
  });

  it.each(["exemplo.com", "outro.com", "mail.exemplo.com.atacante.com"])("domínio verificado %s não libera outro remetente", async (name) => {
    const status = await verificarStatusResend(opcoes([{ ...dominio, name }]));
    expect(status).toMatchObject({ ok: false, dominiosVerificados: 0, dominiosPendentes: 1 });
    expect(status.detalhe).toContain("mail.exemplo.com");
  });

  it("não fica pronto quando algum domínio ativo está pendente", async () => {
    const status = await verificarStatusResend({ ...opcoes(), remetentes: [remetente,
      { ...remetente, email_completo: "cursos@outra.com" }] });
    expect(status).toMatchObject({ ok: false, dominiosVerificados: 1, dominiosPendentes: 1 });
    expect(status.detalhe).toContain("outra.com");
  });

  it("domínio de recebimento com envio desabilitado não libera campanhas", async () => {
    const status = await verificarStatusResend(opcoes([{ ...dominio, capabilities: { sending: "disabled" } }]));
    expect(status).toMatchObject({ ok: false, dominiosVerificados: 0, dominiosPendentes: 1 });
  });

  it("sem assinatura de eventos continua pendente apesar do domínio verificado", async () => {
    const status = await verificarStatusResend({ ...opcoes(), webhookSecret: " " });
    expect(status).toMatchObject({ ok: false, apiRespondeu: true, webhookConfigurado: false, dominiosVerificados: 1 });
    expect(status.detalhe).toContain("segredo de assinatura");
  });

  it("sem chave não tenta a rede", async () => {
    const config = { ...opcoes(), apiKey: " " };
    expect(await verificarStatusResend(config)).toMatchObject({ ok: false, credencialConfigurada: false });
    expect(config.fetcher).not.toHaveBeenCalled();
  });

  it("explica chave restrita sem vazar erro externo", async () => {
    const status = await verificarStatusResend({ ...opcoes(), fetcher: vi.fn<typeof fetch>()
      .mockResolvedValue(resposta({ name: "restricted_api_key", message: "chave-secreta destinatario@privado.com" }, 401)) });
    expect(status).toMatchObject({ ok: false, credencialConfigurada: true, apiRespondeu: false });
    expect(status.comoResolver).toContain("Full access");
    expect(JSON.stringify(status)).not.toMatch(/chave-secreta|privado.com/);
  });

  it("sem remetente ativo não apresenta verde", async () => {
    for (const remetentes of [[], [{ ...remetente, ativo: false }]]) {
      expect(await verificarStatusResend({ ...opcoes(), remetentes })).toMatchObject({ ok: false, apiRespondeu: true });
    }
  });

  it("ignora remetentes de outros provedores e domínios de remetentes desativados", async () => {
    const status = await verificarStatusResend({ ...opcoes(), remetentes: [remetente,
      { provider: "ses", ativo: true, email_completo: "curso@ses.com" },
      { ...remetente, ativo: false, email_completo: "curso@legado.com" }] });
    expect(status).toMatchObject({ ok: true, dominiosVerificados: 1, dominiosPendentes: 0 });
  });

  it("endereço inválido e modo seco não podem confirmar configuração", async () => {
    expect(await verificarStatusResend({ ...opcoes(), remetentes: [{ ...remetente, email_completo: "inválido" }] }))
      .toMatchObject({ ok: false });
    expect(await verificarStatusResend({ ...opcoes(), modoSeco: true })).toMatchObject({ ok: false, modoSeco: true });
  });
});
