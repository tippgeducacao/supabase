import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// O handler HTTP real deve ligar o efeito confirmado à continuidade. Nenhuma rede,
// conta, modelo ou mensagem de produção participa destes testes de integração.
const mocks = vi.hoisted(() => ({
  rodada: vi.fn(), semear: vi.fn(), rpc: vi.fn(), push: vi.fn(), fetch: vi.fn(),
  sessao: {} as Record<string, unknown>,
}));
vi.mock("https://esm.sh/@supabase/supabase-js@2.49.4", () => ({
  createClient: () => ({
    rpc: mocks.rpc,
    auth: { getUser: async () => ({ data: { user: { id: "usuario-teste" } }, error: null }) },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: mocks.sessao, error: null }) }) }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  }),
}));
vi.mock("./agente.ts", () => ({
  responderWebchat: vi.fn(), aberturaWebchat: vi.fn(),
  WEBCHAT_TEMPLATE_CONTINUIDADE: "template_teste", WEBCHAT_WA_ACCOUNT_ID: "conta-teste",
  WHATSAPP_REENVIO_COOLDOWN_MIN: 10,
}));
vi.mock("./rodada.ts", () => ({ processarRodadaWebchat: mocks.rodada }));
vi.mock("./continuidade.ts", () => ({ semearHistoricoWhatsApp: mocks.semear }));
vi.mock("../_shared/webchatPush.ts", () => ({ pushParaSessao: mocks.push }));

let handler: (req: Request) => Promise<Response>;
const idSessao = "00000000-0000-4000-8000-000000000001";
beforeAll(async () => {
  vi.stubGlobal("Deno", {
    env: { get: (nome: string) => nome === "SUPABASE_URL" ? "https://supabase.invalid" : undefined },
    serve: (callback: typeof handler) => { handler = callback; },
  });
  vi.stubGlobal("fetch", mocks.fetch);
  await import("./index");
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.resetAllMocks();
  mocks.sessao = {
    id: idSessao, nome: "Visitante", telefone: "00000000000", curso: "Curso teste",
    estagio: "validacao", modo_teste: false, bloqueada: false, atendimento_humano: false,
    chat_visivel: true, presenca_em: new Date().toISOString(),
  };
  mocks.rodada.mockResolvedValue({ status: "publicado", tools: [], mensagens: [], ha_pendencia: false, erro: null });
  mocks.rpc.mockResolvedValue({ data: true, error: null });
  mocks.fetch.mockRejectedValue(new Error("Rede não simulada"));
});
function chamar(acao = "responder") {
  return handler(new Request("https://supabase.invalid/functions/v1/crm-webchat", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer teste" },
    body: JSON.stringify({ acao, sessao_id: idSessao }),
  }));
}

describe("handler Webchat: efeito e publicação são coisas diferentes", () => {
  it.each(["envia_informacoes", "levar_para_whatsapp"])("tentativa de %s sem efeito não semeia", async (nome) => {
    mocks.rodada.mockResolvedValue({ status: "publicado", tools: [{ nome, mockado: false, resultado: "RECUSADO" }] });
    expect((await chamar()).status).toBe(200);
    expect(mocks.semear).not.toHaveBeenCalled();
  });

  it.each(["publicado", "atendimento_humano", "falha_publicacao"])(
    "efeito confirmado é preservado quando a publicação fica %s", async (status) => {
      const efeito = { tipo: "transferencia", curso: null };
      mocks.rodada.mockResolvedValue({ status, tools: [{ nome: "levar_para_whatsapp", mockado: false, efeito_whatsapp: efeito }] });
      await chamar();
      expect(mocks.semear).toHaveBeenCalledWith(expect.anything(), idSessao, efeito);
      expect(mocks.rpc).not.toHaveBeenCalledWith("webchat_sac_sync", expect.anything());
    },
  );

  it("não semeia efeitos mockados nem espelha uma publicação recusada", async () => {
    mocks.rodada.mockResolvedValue({ status: "atendimento_humano", tools: [
      { nome: "envia_informacoes", mockado: true, efeito_whatsapp: { tipo: "cronograma", curso: "Curso" } },
    ] });
    await chamar();
    expect(mocks.semear).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("repassa ao widget a pendência retornada pelo banco", async () => {
    mocks.rodada.mockResolvedValue({ status: "publicado", tools: [], ha_pendencia: true });
    expect(await (await chamar()).json()).toEqual({ ok: true, pendente: true });
  });

  it("isola sessões de teste das ações públicas", async () => {
    mocks.sessao.modo_teste = true;
    expect((await chamar()).status).toBe(404);
    expect(mocks.rodada).not.toHaveBeenCalled();
  });
});

describe("ponte manual para WhatsApp", () => {
  it("copia contexto após envio confirmado pelo botão", async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ success: true, wa_message_id: null }), { status: 200 }));
    expect((await chamar("levar_para_whatsapp")).status).toBe(200);
    expect(mocks.semear).toHaveBeenCalledWith(expect.anything(), idSessao, { tipo: "transferencia", curso: "Curso teste" });
  });

  it.each([
    ['erro explícito', { error: 'envio recusado' }],
    ['success falso', { success: false }],
    ['corpo vazio', {}],
    ['ok falso', { success: true, ok: false }],
    ['erro interno', { success: true, data: { error: 'envio recusado' } }],
  ])("HTTP 200 com %s não confirma nem semeia", async (_nome, corpo) => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify(corpo), { status: 200 }));
    expect((await chamar("levar_para_whatsapp")).status).toBe(400);
    expect(mocks.semear).not.toHaveBeenCalled();
  });

  it("HTTP 200 com JSON inválido não confirma nem semeia", async () => {
    mocks.fetch.mockResolvedValue(new Response("", { status: 200 }));
    expect((await chamar("levar_para_whatsapp")).status).toBe(400);
    expect(mocks.semear).not.toHaveBeenCalled();
  });

  it("botão manual também protege sessões do harness", async () => {
    mocks.sessao.modo_teste = true;
    expect((await chamar("levar_para_whatsapp")).status).toBe(403);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
