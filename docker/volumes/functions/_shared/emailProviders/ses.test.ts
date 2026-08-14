/**
 * SesProvider com o SDK da AWS MOCKADO — nenhuma chamada real sai daqui.
 *
 * O que torna isto possível é o cliente ser injetável: como o teste passa um mock, o
 * `import("npm:@aws-sdk/client-sesv2")` nunca é executado, e o vitest não precisa
 * resolver o especificador `npm:` (que ele não resolveria).
 */
import { describe, expect, it, vi } from "vitest";
import { SesProvider, type ClienteSesLike } from "./ses.ts";
import { SmtpProvider, type TransporteSmtpLike } from "./smtp.ts";
import { ErroEnvio } from "./types.ts";
import { intervaloThrottleMs, obterProvedor, provedorEfetivo, provedorPadrao } from "./index.ts";

const EMAIL = {
  from: "PPG <no-reply@mail.exemplo.com>",
  to: "aluno@exemplo.com",
  subject: "Assunto com acento: matrícula",
  html: "<p>Olá</p>",
  text: "Olá",
};

/** Mock que registra o comando recebido, no lugar do SDK. */
function mockSes(resposta: { MessageId?: string } = { MessageId: "ses-msg-1" }) {
  const enviados: Record<string, unknown>[] = [];
  const cliente: ClienteSesLike = {
    send: vi.fn(async (comando: unknown) => {
      enviados.push(comando as Record<string, unknown>);
      return resposta;
    }),
  };
  // criarComando devolve a própria entrada, para o teste inspecionar o payload.
  return { cliente, criarComando: (entrada: Record<string, unknown>) => entrada, enviados };
}

describe("SesProvider — envio simples", () => {
  it("devolve o MessageId do SES", async () => {
    const m = mockSes({ MessageId: "0100018f-abc" });
    const p = new SesProvider({ cliente: m.cliente, criarComando: m.criarComando });

    const r = await p.send(EMAIL);

    expect(r.providerMessageId).toBe("0100018f-abc");
    expect(m.cliente.send).toHaveBeenCalledTimes(1);
  });

  it("usa o formato Simple quando não há anexo", async () => {
    const m = mockSes();
    await new SesProvider({ cliente: m.cliente, criarComando: m.criarComando }).send(EMAIL);

    const entrada = m.enviados[0] as { Content: { Simple?: unknown; Raw?: unknown } };
    expect(entrada.Content.Simple).toBeDefined();
    expect(entrada.Content.Raw).toBeUndefined();
  });

  it("monta o destinatário e o BCC como listas", async () => {
    const m = mockSes();
    await new SesProvider({ cliente: m.cliente, criarComando: m.criarComando })
      .send({ ...EMAIL, to: ["a@x.com", "b@x.com"], bcc: "copia@x.com" });

    const d = (m.enviados[0] as { Destination: { ToAddresses: string[]; BccAddresses: string[] } }).Destination;
    expect(d.ToAddresses).toEqual(["a@x.com", "b@x.com"]);
    expect(d.BccAddresses).toEqual(["copia@x.com"]);
  });

  it("leva o List-Unsubscribe como header — exigência de quem manda volume", async () => {
    const m = mockSes();
    await new SesProvider({ cliente: m.cliente, criarComando: m.criarComando }).send({
      ...EMAIL,
      headers: {
        "List-Unsubscribe": "<https://x.com/sair>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });

    const headers = (m.enviados[0] as { Content: { Simple: { Headers: Array<{ Name: string; Value: string }> } } })
      .Content.Simple.Headers;
    expect(headers).toEqual(expect.arrayContaining([
      { Name: "List-Unsubscribe", Value: "<https://x.com/sair>" },
      { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
    ]));
  });

  it("passa o configuration set — sem ele os eventos de bounce não chegam", async () => {
    const m = mockSes();
    await new SesProvider({
      cliente: m.cliente, criarComando: m.criarComando, configurationSet: "crm-mkt",
    }).send(EMAIL);

    expect((m.enviados[0] as { ConfigurationSetName: string }).ConfigurationSetName).toBe("crm-mkt");
  });

  it("o configuration set do envio tem precedência sobre o do provedor", async () => {
    const m = mockSes();
    await new SesProvider({
      cliente: m.cliente, criarComando: m.criarComando, configurationSet: "padrao",
    }).send({ ...EMAIL, configurationSet: "especifico" });

    expect((m.enviados[0] as { ConfigurationSetName: string }).ConfigurationSetName).toBe("especifico");
  });

  it("converte tags para EmailTags", async () => {
    const m = mockSes();
    await new SesProvider({ cliente: m.cliente, criarComando: m.criarComando })
      .send({ ...EMAIL, tags: [{ name: "campanha", value: "abc" }] });

    expect((m.enviados[0] as { EmailTags: unknown }).EmailTags)
      .toEqual([{ Name: "campanha", Value: "abc" }]);
  });
});

describe("SesProvider — anexo", () => {
  it("troca para o formato Raw e codifica o assunto acentuado", async () => {
    const m = mockSes();
    await new SesProvider({ cliente: m.cliente, criarComando: m.criarComando }).send({
      ...EMAIL,
      attachments: [{ filename: "ata.pdf", content: "JVBERi0=", contentType: "application/pdf" }],
    });

    const conteudo = (m.enviados[0] as { Content: { Raw?: { Data: string }; Simple?: unknown } }).Content;
    expect(conteudo.Simple).toBeUndefined();
    expect(conteudo.Raw?.Data).toContain('filename="ata.pdf"');
    // Assunto com acento precisa ir codificado; cru quebra em vários clientes.
    expect(conteudo.Raw?.Data).toMatch(/Subject: =\?UTF-8\?B\?/);
    expect(conteudo.Raw?.Data).not.toContain("Subject: Assunto com acento");
  });
});

describe("SesProvider — erros", () => {
  it("sem destinatário não chega a chamar a AWS", async () => {
    const m = mockSes();
    const p = new SesProvider({ cliente: m.cliente, criarComando: m.criarComando });

    await expect(p.send({ ...EMAIL, to: [] })).rejects.toBeInstanceOf(ErroEnvio);
    expect(m.cliente.send).not.toHaveBeenCalled();
  });

  it("throttling do SES é marcado como repetível", async () => {
    const cliente: ClienteSesLike = {
      send: vi.fn(async () => {
        throw Object.assign(new Error("Maximum sending rate exceeded"), {
          name: "Throttling", $metadata: { httpStatusCode: 429 },
        });
      }),
    };
    const p = new SesProvider({ cliente, criarComando: (e) => e });

    await expect(p.send(EMAIL)).rejects.toMatchObject({
      name: "ErroEnvio", rateLimited: true, repetivel: true, codigo: "Throttling",
    });
  });

  it("5xx é repetível", async () => {
    const cliente: ClienteSesLike = {
      send: vi.fn(async () => {
        throw Object.assign(new Error("indisponível"), {
          name: "ServiceUnavailable", $metadata: { httpStatusCode: 503 },
        });
      }),
    };
    await expect(new SesProvider({ cliente, criarComando: (e) => e }).send(EMAIL))
      .rejects.toMatchObject({ repetivel: true });
  });

  it("endereço rejeitado NÃO é repetível — repetir só repetiria o erro", async () => {
    const cliente: ClienteSesLike = {
      send: vi.fn(async () => {
        throw Object.assign(new Error("Email address is not verified"), {
          name: "MessageRejected", $metadata: { httpStatusCode: 400 },
        });
      }),
    };
    await expect(new SesProvider({ cliente, criarComando: (e) => e }).send(EMAIL))
      .rejects.toMatchObject({ repetivel: false, rateLimited: false });
  });

  it("resposta sem MessageId é erro, não sucesso silencioso", async () => {
    const m = mockSes({});
    await expect(new SesProvider({ cliente: m.cliente, criarComando: m.criarComando }).send(EMAIL))
      .rejects.toThrow(/MessageId/);
  });
});

describe("SmtpProvider", () => {
  it("envia pelo transporte injetado e devolve um id local", async () => {
    const enviados: Record<string, unknown>[] = [];
    const transporte: TransporteSmtpLike = { send: vi.fn(async (m) => { enviados.push(m); }) };

    const r = await new SmtpProvider({ transporte }).send(EMAIL);

    expect(r.providerMessageId).toMatch(/^smtp-/);
    expect(enviados[0]).toMatchObject({ from: EMAIL.from, to: ["aluno@exemplo.com"], html: EMAIL.html });
  });

  it("falha de conexão é repetível", async () => {
    const transporte: TransporteSmtpLike = {
      send: vi.fn(async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:2500"); }),
    };
    await expect(new SmtpProvider({ transporte }).send(EMAIL))
      .rejects.toMatchObject({ repetivel: true });
  });
});

describe("fábrica de provedor", () => {
  it("o padrão é smtp — nada de produção sai sem configuração explícita", () => {
    expect(provedorPadrao()).toBe("smtp");
  });

  it("com EMAIL_PROVIDER=smtp, TODO remetente cai no SMTP (override de desenvolvimento)", () => {
    // Sem este override o modo dev seria inalcançável: `provider` é NOT NULL com
    // default 'gmail', então nenhum remetente jamais fica "sem provedor declarado".
    const fake = { nome: "smtp" as const, send: async () => ({ providerMessageId: "x" }) };
    expect(obterProvedor({ doRemetente: "ses", instancias: { smtp: fake } })).toBe(fake);
    expect(provedorEfetivo("ses")).toBe("smtp");
  });

  it("com EMAIL_PROVIDER=ses, o remetente manda", () => {
    const g = globalThis as { Deno?: { env: { get(k: string): string | undefined } } };
    const anterior = g.Deno;
    g.Deno = { env: { get: (k) => (k === "EMAIL_PROVIDER" ? "ses" : undefined) } };
    try {
      expect(provedorEfetivo("ses")).toBe("ses");
      expect(provedorEfetivo("resend")).toBe("resend");
      // Remetente Gmail não é da alçada desta fábrica: cai no padrão do ambiente.
      expect(provedorEfetivo("gmail")).toBe("ses");
    } finally {
      g.Deno = anterior;
    }
  });

  it("resend não é instanciável aqui — tem caminho próprio já testado", () => {
    const g = globalThis as { Deno?: { env: { get(k: string): string | undefined } } };
    const anterior = g.Deno;
    g.Deno = { env: { get: (k) => (k === "EMAIL_PROVIDER" ? "resend" : undefined) } };
    try {
      expect(() => obterProvedor({ doRemetente: "resend" })).toThrow(/resend/);
    } finally {
      g.Deno = anterior;
    }
  });

  it("o throttle deriva do rate limit (14/s = ~72ms)", () => {
    expect(intervaloThrottleMs()).toBe(72);
  });
});
