import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("https://esm.sh/@supabase/supabase-js@2.49.4", () => ({ createClient: vi.fn() }));

let processarUma: typeof import("./index.ts").processarUma;
const rpc = vi.fn();
const eq = vi.fn();
const update = vi.fn();
const from = vi.fn();
const enviar = vi.fn();
const banco = { rpc, from };
const mensagem: Parameters<typeof processarUma>[1] = {
  id: "00000000-0000-4000-8000-000000000001",
  wa_account_id: "conta", wa_conexao_id: null, telefone: "5511900000000",
  lead_id: "lead", oportunidade_id: "card", automacao_id: "automacao",
  tipo_mensagem: "template" as const, conteudo: null, template_name: "teste",
  template_lang: "pt_BR", template_components: [], anexo_url: null, filename: null, mime_type: null,
};

beforeAll(async () => {
  vi.stubGlobal("Deno", { env: { get: (chave: string) => chave === "SUPABASE_URL" ? "https://example.invalid" : "teste" }, serve: vi.fn() });
  ({ processarUma } = await import("./index.ts"));
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", enviar);
  rpc.mockResolvedValue({ data: { permitido: true }, error: null });
  eq.mockResolvedValue({ error: null });
  update.mockReturnValue({ eq });
  from.mockReturnValue({ update });
  enviar.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, wa_message_id: "wamid.teste" }) });
});

afterAll(() => vi.unstubAllGlobals());

// Exercita o dispatcher real, com transporte simulado: nenhuma chamada externa.
const processar = (alteracao: Partial<typeof mensagem> & { criado_por_nome?: string } = {}) =>
  processarUma(banco as unknown as Parameters<typeof processarUma>[0], { ...mensagem, ...alteracao });

describe("proteções da automação no instante do envio", () => {
  it("consulta a proteção antes do transporte e envia quando ainda permitido", async () => {
    const ordem: string[] = [];
    rpc.mockImplementation(async () => { ordem.push("validar"); return { data: { permitido: true }, error: null }; });
    enviar.mockImplementation(async () => {
      ordem.push("enviar");
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    expect(await processar()).toBe("enviado");
    expect(rpc).toHaveBeenCalledWith("crm_agendada_validar_envio", { p_mensagem_id: mensagem.id });
    expect(ordem).toEqual(["validar", "enviar"]);
  });

  it.each(["temporizador de recontato ativo", "oportunidade arquivada", "lead já aluno matriculado", "número com disparo bloqueado"])(
    "não envia nem sobrescreve cancelamento registrado no banco: %s", async (motivo) => {
      rpc.mockResolvedValue({ data: { permitido: false, motivo }, error: null });
      expect(await processar()).toBe("cancelado");
      expect(enviar).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    },
  );

  it.each([
    { data: null, error: { message: "indisponível" } },
    { data: null, error: null },
    { data: { permitido: "true" }, error: null },
  ])("interrompe e registra erro quando não consegue confirmar a liberação: %j", async (resultado) => {
    rpc.mockResolvedValue(resultado);
    expect(await processar()).toContain("erro:");
    expect(enviar).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "erro" }));
  });

  it.each(["Vendedor", "Assistente pedagógico"])("preserva mensagem sem automação: %s", async (criado_por_nome) => {
    expect(await processar({ automacao_id: null, criado_por_nome })).toBe("enviado");
    expect(rpc).not.toHaveBeenCalled();
    expect(enviar).toHaveBeenCalledTimes(1);
  });
});
