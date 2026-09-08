import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { autorDaMensagemAgendada, confirmarAutoriaAposEco } from "./autoria.ts";

const transporte = vi.hoisted(() => ({
  from: vi.fn(), rpc: vi.fn(), sendText: vi.fn(), fetch: vi.fn(), insert: vi.fn(),
  agendada: {} as Record<string, unknown>,
}));
vi.mock("https://esm.sh/@supabase/supabase-js@2.49.4", () => ({
  createClient: () => ({ from: transporte.from, rpc: transporte.rpc }),
}));
vi.mock("../_shared/waProviders.ts", () => ({
  getWaProvider: () => ({ sendText: transporte.sendText }),
}));

const mensagemId = "00000000-0000-4000-8000-000000000001";
const manual = { criado_por: "vendedor", telefone: "(11) 99999-0001", status: "enviando", automacao_id: null, execucao_id: null };
const envio = { serviceRole: true, mensagemId, telefone: "5511999990001", origem: null };

function banco(data: unknown, error: unknown = null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data, error });
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  return { from: vi.fn().mockReturnValue({ select }), eq };
}

describe("autoria de mensagens agendadas", () => {
  it("recupera o criador do registro manual em envio para o mesmo contato", async () => {
    const db = banco(manual);
    expect(await autorDaMensagemAgendada(db, envio)).toBe("vendedor");
    expect(db.eq).toHaveBeenCalledWith("id", mensagemId);
  });

  it("reconhece o DDD 55 nacional quando o sender recebe o mesmo contato com DDI", async () => {
    const db = banco({ ...manual, telefone: "(55) 99999-0001" });
    expect(await autorDaMensagemAgendada(db, { ...envio, telefone: "5555999990001" })).toBe("vendedor");
  });

  it.each([
    { serviceRole: false }, { mensagemId: "inválido" }, { origem: "automacao" },
    { fluxoId: "fluxo" }, { automacaoId: "automacao-sac" },
  ])("não aceita autoria informada por canal indevido: %j", async (alteracao) => {
    const db = banco(manual);
    expect(await autorDaMensagemAgendada(db, { ...envio, ...alteracao })).toBeNull();
    expect(db.from).not.toHaveBeenCalled();
  });

  it.each([
    { criado_por: null }, { status: "cancelado" }, { status: "enviado" },
    { automacao_id: "auto" }, { execucao_id: "execucao" },
    { telefone: "5521999990001" },
  ])("não atribui ao vendedor registros incompatíveis: %j", async (alteracao) => {
    expect(await autorDaMensagemAgendada(banco({ ...manual, ...alteracao }), envio)).toBeNull();
  });

  it("interrompe antes do envio quando o banco não consegue confirmar autoria", async () => {
    await expect(autorDaMensagemAgendada(banco(null, { message: "falhou" }), envio))
      .rejects.toThrow("confirmar a autoria");
  });
});

describe("autoria quando o eco Uazapi chega primeiro", () => {
  const eco = { erro: { code: "23505" }, aceito: true, waMessageId: "wamid", conexaoId: "linha", metadata: { enviado_por_nome: "Vendedor" } };

  it("confirma o mesmo id e linha por merge atômico, sem inserir/reenviar", async () => {
    const db = { rpc: vi.fn().mockResolvedValue({ data: true, error: null }) };
    await confirmarAutoriaAposEco(db, { ...eco, metadata: { ...eco.metadata, origem: "humano" } });
    expect(db.rpc).toHaveBeenCalledWith("crm_sdr_confirmar_autoria_saida", {
      p_wa_message_id: "wamid", p_wa_conexao_id: "linha",
      p_metadata: { enviado_por_nome: "Vendedor", origem: "humano" },
    });
  });

  it("origem de serviço vazia não permanece como humano inferido pelo webhook", async () => {
    const db = { rpc: vi.fn().mockResolvedValue({ data: true }) };
    await confirmarAutoriaAposEco(db, { ...eco, metadata: { origem: null, enviado_por_id: null, enviado_por_nome: null } });
    expect(db.rpc.mock.calls[0][1].p_metadata.origem).toBe("sistema");
  });

  it.each([{ erro: null }, { erro: { code: "23514" } }, { aceito: false }, { waMessageId: null }])(
    "só corrige conflito de uma saída realmente aceita: %j", async (alteracao) => {
      const db = { rpc: vi.fn() };
      await confirmarAutoriaAposEco(db, { ...eco, ...alteracao });
      expect(db.rpc).not.toHaveBeenCalled();
    },
  );

  it("sinaliza erro de confirmação sem chamar envio", async () => {
    const db = { rpc: vi.fn().mockResolvedValue({ data: false, error: null }) };
    await expect(confirmarAutoriaAposEco(db, eco)).rejects.toThrow("autoria do eco");
  });
});

describe("handler real: confirmação de autoria não reenvia mensagem aceita", () => {
  let handler: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    vi.stubGlobal("Deno", {
      env: { get: (nome: string) => ({ SUPABASE_URL: "https://supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "servico-teste" })[nome] },
      serve: (callback: typeof handler) => { handler = callback; },
    });
    vi.stubGlobal("fetch", transporte.fetch);
    await import("./index");
  });
  afterAll(() => vi.unstubAllGlobals());
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    transporte.agendada = { ...manual };
    transporte.fetch.mockRejectedValue(new Error("Rede não permitida neste teste"));
    transporte.sendText.mockResolvedValue({ ok: true, externalId: "wamid-eco", raw: {} });
    transporte.insert.mockResolvedValue({ error: { code: "23505", message: "eco já gravado" } });
    transporte.rpc.mockResolvedValue({ data: true, error: null });
    transporte.from.mockImplementation((tabela: string) => {
      if (tabela === "crm_whatsapp_messages") return { insert: transporte.insert };
      const registros: Record<string, unknown> = {
        crm_mensagens_agendadas: transporte.agendada,
        profiles: { name: "Vendedor Teste" },
        wa_conexoes: { id: "linha-teste", provider: "uazapi", server_url: "https://provider.invalid", status_conexao: "conectado" },
        wa_conexoes_secrets: { token: "token-teste" },
      };
      if (!(tabela in registros)) throw new Error(`Tabela inesperada: ${tabela}`);
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: registros[tabela], error: null }) }) }) };
    });
  });
  afterEach(() => vi.restoreAllMocks());

  function chamar() {
    return handler(new Request("https://supabase.invalid/functions/v1/crm-whatsapp-send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer servico-teste" },
      body: JSON.stringify({ mensagem_agendada_id: mensagemId, wa_conexao_id: "linha-teste", telefone: manual.telefone, tipo: "text", conteudo: "Segue o que combinamos." }),
    }));
  }

  it("carimba a agendada manual no envio e no eco com o criador confirmado no banco", async () => {
    const resposta = await chamar();
    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toMatchObject({ success: true, wa_message_id: "wamid-eco" });
    const metadata = { origem: "humano", enviado_por_id: "vendedor", enviado_por_nome: "Vendedor Teste" };
    expect(transporte.insert).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining(metadata) }));
    expect(transporte.rpc).toHaveBeenCalledWith("crm_sdr_confirmar_autoria_saida", {
      p_wa_message_id: "wamid-eco", p_wa_conexao_id: "linha-teste",
      p_metadata: expect.objectContaining(metadata),
    });
    expect(transporte.sendText).toHaveBeenCalledTimes(1);
    expect(transporte.insert).toHaveBeenCalledTimes(1);
    expect(transporte.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { data: false, error: null },
    { data: null, error: { message: "RPC indisponível" } },
  ])("mantém sucesso após envio aceito mesmo quando o merge retorna %j", async (retorno) => {
    transporte.rpc.mockResolvedValue(retorno);
    const resposta = await chamar();
    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toMatchObject({ success: true, wa_message_id: "wamid-eco" });
    expect(transporte.sendText).toHaveBeenCalledTimes(1);
    expect(transporte.insert).toHaveBeenCalledTimes(1);
    expect(transporte.rpc).toHaveBeenCalledTimes(1);
    expect(transporte.fetch).not.toHaveBeenCalled();
  });

  it("corrige eco de agendada automática para sistema sem herdar o criador como vendedor", async () => {
    transporte.agendada = { ...manual, execucao_id: "execucao-automatica" };
    expect((await chamar()).status).toBe(200);
    expect(transporte.rpc).toHaveBeenCalledWith("crm_sdr_confirmar_autoria_saida", {
      p_wa_message_id: "wamid-eco", p_wa_conexao_id: "linha-teste",
      p_metadata: expect.objectContaining({ origem: "sistema", enviado_por_id: null, enviado_por_nome: null }),
    });
    expect(transporte.sendText).toHaveBeenCalledTimes(1);
  });
});
