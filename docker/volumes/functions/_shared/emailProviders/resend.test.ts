import { afterEach, describe, expect, it, vi } from "vitest";
import { ResendProvider, listarDominiosResend } from "./resend.ts";
import { obterProvedor, provedorEfetivo } from "./index.ts";

const EMAIL = { from: "PPG <cursos@mail.exemplo.com>", to: "aluno@exemplo.com", subject: "Curso",
  html: "<p>Conteúdo</p>", idempotencyKey: "email-send/log-1" };
const resposta = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

afterEach(() => vi.unstubAllGlobals());

describe("ResendProvider", () => {
  it("preserva reply-to, texto, anexos, headers, tags e idempotência no contrato REST", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(resposta({ id: "mensagem-1" }));
    const r = await new ResendProvider({ apiKey: "chave-teste", fetcher }).send({ ...EMAIL,
      text: "Texto", replyTo: "secretaria@exemplo.com", bcc: "auditoria@exemplo.com",
      headers: { "List-Unsubscribe": "<https://exemplo.com/sair>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      attachments: [{ filename: "curso.pdf", content: "JVBERi0=", contentType: "application/pdf" }],
      tags: [{ name: "log_id", value: "log-1" }], configurationSet: "somente-ses",
    });
    expect(r).toEqual({ providerMessageId: "mensagem-1" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: {
      Authorization: "Bearer chave-teste", "Idempotency-Key": "email-send/log-1",
    } });
    expect(JSON.parse(init!.body as string)).toEqual({
      from: EMAIL.from, to: [EMAIL.to], subject: EMAIL.subject, html: EMAIL.html, text: "Texto",
      reply_to: "secretaria@exemplo.com", bcc: ["auditoria@exemplo.com"],
      headers: { "List-Unsubscribe": "<https://exemplo.com/sair>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      attachments: [{ filename: "curso.pdf", content: "JVBERi0=", content_type: "application/pdf" }],
      tags: [{ name: "log_id", value: "log-1" }],
    });
  });

  it("exige chave e idempotência antes de chamar a rede", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new ResendProvider({ apiKey: "", fetcher }).send(EMAIL)).rejects.toMatchObject({ codigo: "resend_sem_credencial" });
    await expect(new ResendProvider({ apiKey: "teste", fetcher }).send({ ...EMAIL, idempotencyKey: undefined }))
      .rejects.toMatchObject({ codigo: "invalid_idempotency_key" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("mantém a mesma chave entre tentativas explícitas e reaproveita o ID devolvido", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => resposta({ id: "mesmo-id" }));
    const provider = new ResendProvider({ apiKey: "teste", fetcher });
    expect(await provider.send(EMAIL)).toEqual(await provider.send(EMAIL));
    expect(fetcher.mock.calls.map(([, init]) => new Headers(init?.headers).get("Idempotency-Key")))
      .toEqual(["email-send/log-1", "email-send/log-1"]);
  });

  it.each([
    [429, "rate_limit_exceeded", true], [429, "daily_quota_exceeded", true],
    [409, "invalid_idempotent_request", false], [409, "concurrent_idempotent_requests", false],
    [403, "validation_error", false], [503, "service_unavailable", false],
  ])("traduz HTTP %s/%s sem repetir o POST nem expor o corpo", async (status, name, repetivel) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(resposta({ name, message: "segredo email@privado.com conteúdo" }, status));
    const erro = await new ResendProvider({ apiKey: "teste", fetcher }).send(EMAIL).catch((e) => e);
    expect(erro).toMatchObject({ codigo: name, status, repetivel, rateLimited: status === 429 });
    expect(erro.message).not.toMatch(/segredo|privado/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("não repete resposta ambígua, inválida ou erro de rede", async () => {
    for (const falha of [null, { id: "" }, { name: "falha", message: "segredo" }]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(resposta(falha));
      await expect(new ResendProvider({ apiKey: "teste", fetcher }).send(EMAIL))
        .rejects.toMatchObject({ codigo: "resend_resposta_invalida", repetivel: false });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("token secreto"));
    const erro = await new ResendProvider({ apiKey: "teste", fetcher }).send(EMAIL).catch((e) => e);
    expect(erro).toMatchObject({ codigo: "resend_resultado_incerto", repetivel: false });
    expect(erro.message).not.toContain("secreto");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("não reflete nome de erro arbitrário do provedor", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(resposta({ name: "token_secreto", message: "segredo" }, 403));
    await expect(new ResendProvider({ apiKey: "teste", fetcher }).send(EMAIL))
      .rejects.toMatchObject({ codigo: "resend_http_403" });
  });
});

describe("domínios Resend", () => {
  it("pagina até o domínio do remetente, respeitando has_more/after", async () => {
    const primeiro = { id: "d1", name: "outro.com", status: "verified" };
    const segundo = { id: "d2", name: "mail.exemplo.com", status: "verified" };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(resposta({ data: [primeiro], has_more: true }))
      .mockResolvedValueOnce(resposta({ data: [segundo], has_more: false }));
    expect(await listarDominiosResend({ apiKey: "teste", fetcher })).toEqual([primeiro, segundo]);
    expect(fetcher.mock.calls[1][0]).toBe("https://api.resend.com/domains?limit=100&after=d1");
  });

  it("não aprova uma consulta truncada ou um cursor que não avança", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => resposta({
      data: [{ id: "d1", name: "outro.com", status: "verified" }], has_more: true,
    }));
    await expect(listarDominiosResend({ apiKey: "teste", fetcher }))
      .rejects.toMatchObject({ codigo: "resend_paginacao_incompleta" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("seleção Resend sem alterar Gmail/SES", () => {
  it("respeita o remetente explícito quando EMAIL_PROVIDER está ausente ou aponta SES", () => {
    for (const padrao of [undefined, "ses"]) {
      vi.stubGlobal("Deno", { env: { get: (k: string) => k === "EMAIL_PROVIDER" ? padrao : undefined } });
      expect(provedorEfetivo("resend")).toBe("resend");
      expect(provedorEfetivo("ses")).toBe("ses");
      const fake = { nome: "resend" as const, send: async () => ({ providerMessageId: "x" }) };
      expect(obterProvedor({ doRemetente: "resend", instancias: { resend: fake } })).toBe(fake);
    }
  });

  it("mantém o override SMTP somente quando configurado explicitamente", () => {
    vi.stubGlobal("Deno", { env: { get: (k: string) => k === "EMAIL_PROVIDER" ? "smtp" : undefined } });
    expect(provedorEfetivo("resend")).toBe("smtp");
  });
});
