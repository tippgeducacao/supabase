import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ambiente = vi.hoisted(() => ({ criarCliente: vi.fn() }));
vi.mock("https://esm.sh/@supabase/supabase-js@2.45.0", () => ({ createClient: ambiente.criarCliente }));

let atender: (req: Request) => Promise<Response>;
let env: Record<string, string>;
let log: Record<string, unknown>;
let existente: Record<string, unknown> | null;
let suprimido: Record<string, unknown> | null;
let provider: string;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let tabelas: string[];
let insercoes: number;

beforeAll(async () => {
  vi.stubGlobal("Deno", { env: { get: (k: string) => env?.[k] }, serve: (handler: typeof atender) => { atender = handler; } });
  await import("./index.ts");
});
afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  env = { SUPABASE_URL: "http://kong:8000", SUPABASE_PUBLIC_URL: "https://api.exemplo.com",
    SUPABASE_SERVICE_ROLE_KEY: "service-teste", RESEND_API_KEY: "resend-teste", RESEND_WEBHOOK_SECRET: "whsec_teste" };
  log = {}; existente = null; suprimido = null; provider = "resend"; tabelas = []; insercoes = 0;
  fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: "resend-1" })));
  vi.stubGlobal("fetch", fetcher);
  ambiente.criarCliente.mockReturnValue({
    auth: { getUser: async () => ({ data: { user: { id: "usuario-1" } } }) },
    from: (tabela: string) => {
      tabelas.push(tabela);
      let acao = "select";
      let valores: Record<string, unknown> = {};
      const filtros: Record<string, unknown> = {};
      const resolver = () => {
        if (tabela === "email_remetentes") return { data: { id: "rem-1", provider, ativo: true,
          nome_remetente: "PPG", email_completo: "cursos@mail.exemplo.com", reply_to_email: "secretaria@exemplo.com" } };
        if (tabela === "email_supressoes") return { data: suprimido };
        if (tabela === "calendar_integrations") return { data: null };
        if (tabela === "emails_enviados" && acao === "insert") {
          insercoes++;
          log = { ...valores, id: "log-1" };
          return { data: { id: "log-1" }, error: null };
        }
        if (tabela === "emails_enviados" && acao === "update") {
          if (Object.entries(filtros).every(([k, v]) => log[k] === v)) Object.assign(log, valores);
          return { data: null, error: null };
        }
        return { data: existente, error: null };
      };
      const query = {
        select: () => query, order: () => query, limit: () => query, not: () => query,
        eq: (k: string, v: unknown) => { filtros[k] = v; return query; },
        gte: () => query,
        insert: (v: Record<string, unknown>) => { acao = "insert"; valores = v; return query; },
        update: (v: Record<string, unknown>) => { acao = "update"; valores = v; return query; },
        single: async () => resolver(), maybeSingle: async () => resolver(),
        then: (resolve: (v: ReturnType<typeof resolver>) => unknown) => Promise.resolve(resolver()).then(resolve),
      };
      return query;
    },
  });
});

const requisicao = (extra = {}) => new Request("https://api.exemplo.com/functions/v1/email-send", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ remetente_id: "rem-1", destinatario_email: "aluno@exemplo.com", contexto_tipo: "campanha",
    assunto: "Curso", corpo_html: "<html><body>Olá</body></html>", corpo_texto: "Olá", ...extra }),
});

describe("email-send integrado ao Resend", () => {
  it("usa Resend, grava ID comum e inclui descadastro público no HTML, texto e headers", async () => {
    const resposta = await atender(requisicao({ anexos: [{ filename: "curso.pdf", content_base64: "JVBERi0=" }] }));
    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toMatchObject({ ok: true, provider: "resend", provider_message_id: "resend-1" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    const enviado = JSON.parse(init!.body as string);
    expect(enviado.reply_to).toBe("secretaria@exemplo.com");
    expect(enviado.html).toContain("https://api.exemplo.com/functions/v1/email-descadastro");
    expect(enviado.text).toContain("Descadastrar: https://api.exemplo.com/");
    expect(enviado.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(enviado.tags).toContainEqual({ name: "log_id", value: "log-1" });
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("email-send/log-1");
    expect(log).toMatchObject({ provider: "resend", provider_message_id: "resend-1", status: "enviado" });
    expect(tabelas).not.toContain("calendar_integrations");
  });

  it("supressão impede envio e criação de log", async () => {
    suprimido = { email: "aluno@exemplo.com", motivo: "bounce" };
    expect(await (await atender(requisicao())).json()).toMatchObject({ ok: true, suprimido: true });
    expect(fetcher).not.toHaveBeenCalled();
    expect(insercoes).toBe(0);
  });

  it("usa o domínio de e-mail no pixel e descadastro da campanha sem trocar o cliente Supabase", async () => {
    env.EMAIL_PUBLIC_URL = "https://email.exemplo.com/";
    expect((await atender(requisicao())).status).toBe(200);
    const enviado = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(enviado.html).toContain('src="https://email.exemplo.com/functions/v1/email-track-open?id=log-1"');
    expect(enviado.html).toContain('href="https://email.exemplo.com/functions/v1/email-descadastro?');
    expect(enviado.text).toContain("Descadastrar: https://email.exemplo.com/functions/v1/email-descadastro?");
    expect(enviado.headers["List-Unsubscribe"]).toMatch(/^<https:\/\/email\.exemplo\.com\/functions\/v1\/email-descadastro\?/);
    expect(enviado.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(enviado.html).not.toContain("https://api.exemplo.com/");
    expect(ambiente.criarCliente).toHaveBeenLastCalledWith("http://kong:8000", "service-teste");
  });

  it("preserva entrega confirmada pelo webhook que chega antes da resposta do POST", async () => {
    fetcher.mockImplementation(async () => {
      log.status = "entregue";
      return new Response(JSON.stringify({ id: "resend-1" }));
    });
    await atender(requisicao());
    expect(log).toMatchObject({ status: "entregue", provider_message_id: "resend-1" });
  });

  it("requisição repetida após falha fica sem confirmação e não faz novo envio", async () => {
    existente = { id: "log-anterior", provider: "resend", status: "falhou", provider_message_id: null };
    const resposta = await atender(requisicao({ idempotencia_key: "campanha:1" }));
    expect(resposta.status).toBe(409);
    expect(await resposta.json()).toMatchObject({ ok: false, duplicado: true, id: "log-anterior" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(insercoes).toBe(0);
  });

  it("não tenta Resend para remetente Gmail sem caixa conectada", async () => {
    provider = "gmail";
    expect((await atender(requisicao())).status).toBe(412);
    expect(tabelas).toContain("calendar_integrations");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sem assinatura de eventos o envio aguarda a configuração", async () => {
    delete env.RESEND_WEBHOOK_SECRET;
    expect((await atender(requisicao())).status).toBe(412);
    expect(fetcher).not.toHaveBeenCalled();
    expect(insercoes).toBe(0);
  });

  it("propaga 429 para pausar campanha sem fallback", async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify({ name: "rate_limit_exceeded" }), { status: 429 }));
    const resposta = await atender(requisicao());
    expect(resposta.status).toBe(429);
    expect(await resposta.json()).toMatchObject({ rate_limited: true, codigo: "rate_limit_exceeded" });
    expect(log.status).toBe("falhou");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
