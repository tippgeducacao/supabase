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
let usuarioAtivo: boolean;
let usuarioValido: boolean;
let cargoUsuario: string;
// Reserva da conta Resend (14/10/2026): resposta de `email_resend_cota_liberar` e chamadas feitas.
let cota: { data: unknown; error: { message: string } | null };
let rpcs: Array<[string, unknown]>;

beforeAll(async () => {
  vi.stubGlobal("Deno", { env: { get: (k: string) => env?.[k] }, serve: (handler: typeof atender) => { atender = handler; } });
  await import("./index.ts");
});
afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  env = { SUPABASE_URL: "http://kong:8000", SUPABASE_PUBLIC_URL: "https://api.exemplo.com",
    SUPABASE_SERVICE_ROLE_KEY: "service-teste", RESEND_API_KEY: "resend-teste", RESEND_WEBHOOK_SECRET: "whsec_teste" };
  log = {}; existente = null; suprimido = null; provider = "resend"; tabelas = []; insercoes = 0;
  usuarioAtivo = true; usuarioValido = true; cargoUsuario = "admin";
  cota = { data: { liberado: true, uso: 64634, teto: 195000, limite_plano: 200000, reserva_externa: 5000 }, error: null };
  rpcs = [];
  fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: "resend-1" })));
  vi.stubGlobal("fetch", fetcher);
  ambiente.criarCliente.mockReturnValue({
    auth: { getUser: async () => ({ data: { user: usuarioValido ? { id: "usuario-1" } : null } }) },
    // `email_marketing_pode_gerir` (banco) = perfil ativo E admin/diretor/liberado nominalmente.
    rpc: async (nome: string, args: { role_name?: string; p_usuario?: string; p_uso?: number } = {}) => {
      rpcs.push([nome, args]);
      if (nome === "email_resend_cota_liberar") return cota;
      if (nome === "email_resend_cota_registrar") return { data: null, error: null };
      return nome === "email_marketing_pode_gerir"
        ? { data: usuarioAtivo && args.p_usuario === "usuario-1" && ["admin", "diretor"].includes(cargoUsuario), error: null }
        : { data: args.role_name === cargoUsuario, error: null };
    },
    from: (tabela: string) => {
      tabelas.push(tabela);
      let acao = "select";
      let valores: Record<string, unknown> = {};
      const filtros: Record<string, unknown> = {};
      const resolver = () => {
        if (tabela === "profiles") return { data: { ativo: usuarioAtivo }, error: null };
        if (tabela === "email_campanhas") return { data: { id: "campanha-1", template_id: "tpl-1", remetente_id: "rem-1", status: "enviando" }, error: null };
        if (tabela === "email_campanhas_envios") return { data: { campanha_id: "campanha-1", contato_email: "aluno@exemplo.com", template_id: "tpl-1", status: "pendente" }, error: null };
        if (tabela === "email_templates") return { data: { id: "tpl-1", uso: "marketing", ativo: true, assunto: "Curso", corpo_html: "<html><body>Olá</body></html>", corpo_texto: "Olá", remetente_id: "rem-1" }, error: null };
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

const requisicao = (extra = {}, authorization: string | null = "Bearer service-teste") => new Request("https://api.exemplo.com/functions/v1/email-send", {
  method: "POST", headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) },
  body: JSON.stringify({ remetente_id: "rem-1", destinatario_email: "aluno@exemplo.com", contexto_tipo: "campanha",
    contexto_id: "campanha-1", template_id: "tpl-1", idempotencia_key: "campanha:11111111-1111-4111-8111-111111111111",
    assunto: "Curso", corpo_html: "<html><body>Olá</body></html>", corpo_texto: "Olá", ...extra }),
});

describe("email-send integrado ao Resend", () => {
  it("recusa chamada anônima antes de ler modelos, criar log ou enviar ao provedor", async () => {
    expect((await atender(requisicao({}, null))).status).toBe(401);
    expect(tabelas).toEqual([]); expect(insercoes).toBe(0); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["invalido", "inativo", "vendedor"])("recusa acesso direto %s sem emitir mensagem", async tipo => {
    if (tipo === "invalido") usuarioValido = false;
    if (tipo === "inativo") usuarioAtivo = false;
    if (tipo === "vendedor") cargoUsuario = "vendedor";
    const resposta = await atender(requisicao({}, "Bearer sessao-usuario"));
    expect(resposta.status).toBe(tipo === "invalido" ? 401 : 403);
    expect(tabelas).not.toContain("email_remetentes"); expect(insercoes).toBe(0); expect(fetcher).not.toHaveBeenCalled();
  });
  it("permite teste da sessão administrativa ativa e conserva autoria", async () => {
    const resposta = await atender(requisicao({ contexto_tipo: "teste", idempotencia_key: undefined, usuario_esperado: "usuario-1" }, "Bearer sessao-usuario"));
    expect(resposta.status).toBe(200); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(log.enviado_por).toBe("usuario-1");
  });
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

  // Desde 17/09 o aluno recebia "<ul><li>Termo…" como texto (print de 24/09).
  const pedidoTcc = (extra = {}) => requisicao({ contexto_tipo: "gt_task", contexto_id: "task-1", template_id: undefined,
    idempotencia_key: undefined, corpo_texto: undefined, corpo_html: "<p>Olá, {{nome_aluno}}.</p><p> {{docs_faltantes}}</p>",
    variaveis: { nome_aluno: "<b>Ana</b>", docs_faltantes: "<ul><li>Termo de Aceite</li></ul>" }, ...extra });
  it("lista de documentos do TCC sai como lista; o resto das variáveis segue escapado", async () => {
    expect((await atender(pedidoTcc({ variaveis_html: ["docs_faltantes"] }))).status).toBe(200);
    const html = JSON.parse(fetcher.mock.calls[0][1]!.body as string).html as string;
    expect(html).toContain("<p> <ul><li>Termo de Aceite</li></ul></p>");
    expect(html).toContain("Olá, &lt;b&gt;Ana&lt;/b&gt;.");
  });
  it("sem a marca variaveis_html a variável continua escapada — o padrão não mudou", async () => {
    expect((await atender(pedidoTcc())).status).toBe(200);
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string).html).toContain("&lt;ul&gt;&lt;li&gt;Termo");
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
    existente = { id: "log-anterior", provider: "resend", status: "falhou", provider_message_id: null,
      contexto_tipo: "campanha", contexto_id: "campanha-1", template_id: "tpl-1", destinatario_email: "aluno@exemplo.com" };
    const resposta = await atender(requisicao());
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

describe("reserva da conta Resend para outros sistemas (14/10/2026)", () => {
  it("trava fechada: não chama o Resend, grava o motivo e devolve 429 para pausar a campanha", async () => {
    cota = { data: { liberado: false, uso: 195020, teto: 195000, limite_plano: 200000, reserva_externa: 5000 }, error: null };
    const resposta = await atender(requisicao());
    expect(resposta.status).toBe(429);
    expect(await resposta.json()).toMatchObject({ codigo: "ppgvet_reserva_resend", rate_limited: true, log_id: "log-1" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(log.status).toBe("falhou");
    expect(String(log.erro_msg)).toMatch(/^ppgvet_reserva_resend: O PPGVET parou de enviar pelo Resend/);
    expect(String(log.erro_msg)).toContain("195.020 de 200.000");
    expect(String(log.erro_msg)).toContain("5.000 ficam reservados");
    // não pode cair no aviso de cota do próprio Resend, que procura "quota"
    expect(String(log.erro_msg)).not.toMatch(/quota/i);
  });

  it("envio aceito registra o uso do ciclo lido no cabeçalho do Resend", async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify({ id: "resend-1" }), { headers: { "x-resend-monthly-quota": "64635" } }));
    expect((await atender(requisicao())).status).toBe(200);
    expect(rpcs).toContainEqual(["email_resend_cota_registrar", { p_uso: 64635 }]);
  });

  it("sem o cabeçalho, envia e não inventa uso", async () => {
    expect((await atender(requisicao())).status).toBe(200);
    expect(rpcs.map(([nome]) => nome)).toContain("email_resend_cota_liberar");
    expect(rpcs.map(([nome]) => nome)).not.toContain("email_resend_cota_registrar");
  });

  it("consulta da trava falhou: envia mesmo assim (não derruba todo e-mail do sistema)", async () => {
    cota = { data: null, error: { message: "timeout" } };
    expect((await atender(requisicao())).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("recusa de cota mensal do próprio Resend fecha a trava com o limite do plano", async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify({ name: "monthly_quota_exceeded" }), { status: 429 }));
    expect((await atender(requisicao())).status).toBe(429);
    expect(rpcs).toContainEqual(["email_resend_cota_registrar", { p_uso: 200000 }]);
  });
});
