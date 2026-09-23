import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKOFF_RATE_LIMIT_MIN, chaveDaConta, criarRitmo, intercalarPorConta,
  MAX_REAGENDAMENTOS_RATE_LIMIT, proximaTentativaRateLimit,
} from "./ritmo.ts";

vi.mock("https://esm.sh/@supabase/supabase-js@2.49.4", () => ({ createClient: vi.fn() }));

let processarUma: typeof import("./index.ts").processarUma;
const rpc = vi.fn();
const eq = vi.fn();
const update = vi.fn();
const from = vi.fn();
const enviar = vi.fn();
const banco = { rpc, from };
const mensagem: Parameters<typeof processarUma>[1] = {
  id: "00000000-0000-4000-8000-000000000002",
  wa_account_id: "conta", wa_conexao_id: null, telefone: "5511900000000",
  lead_id: "lead", oportunidade_id: "card", automacao_id: "fluxo-1",
  tipo_mensagem: "template" as const, conteudo: null, template_name: "prova_01_",
  template_lang: "pt_BR", template_components: [], anexo_url: null, filename: null, mime_type: null,
  criado_por_nome: "Fluxo", tentativas_rate_limit: 0,
  contexto_campanha: { origem: "fluxo", fluxo_id: "fluxo-1", header_media_url: "https://m.invalid/v.mp4", header_media_format: "VIDEO" },
};
const agora = new Date("2030-01-01T12:00:00Z");

beforeAll(async () => {
  vi.stubGlobal("Deno", { env: { get: (k: string) => k === "SUPABASE_URL" ? "https://example.invalid" : "teste" }, serve: vi.fn() });
  ({ processarUma } = await import("./index.ts"));
});
afterAll(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(agora);
  vi.stubGlobal("fetch", enviar);
  rpc.mockResolvedValue({ data: { permitido: true }, error: null });
  eq.mockResolvedValue({ error: null });
  update.mockReturnValue({ eq });
  from.mockReturnValue({ update });
  enviar.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, wa_message_id: "wamid.ok" }) });
});

const processar = (alteracao: Partial<typeof mensagem> = {}) =>
  processarUma(banco as unknown as Parameters<typeof processarUma>[0], { ...mensagem, ...alteracao });
const corpo = () => JSON.parse(enviar.mock.calls[0][1].body);
const rateLimit = () => ({ ok: false, status: 422, json: async () => ({ error: "Rate limit hit", meta_code: 130429, reagendavel: true }) });

describe("template do Fluxo pela fila", () => {
  it("manda fluxo_id e cabeçalho como o envio direto, sem carimbar origem", async () => {
    expect(await processar()).toBe("enviado");
    expect(corpo()).toMatchObject({ fluxo_id: "fluxo-1", header_media_url: "https://m.invalid/v.mp4", header_media_format: "VIDEO", adiar_rate_limit: true });
    expect(corpo().origem).toBeUndefined();
  });
});

describe("130429 (limite de vazão da Meta)", () => {
  it("reagenda com backoff, sem gravar falha", async () => {
    enviar.mockResolvedValue(rateLimit());
    expect(await processar({ tentativas_rate_limit: 2 })).toBe("reagendado_rate_limit");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      status: "agendado", tentativas_rate_limit: 3,
      enviar_em: new Date(agora.getTime() + BACKOFF_RATE_LIMIT_MIN[2] * 60_000).toISOString(),
    }));
  });

  it("última tentativa não pede adiamento: a falha fica gravada", async () => {
    enviar.mockResolvedValue({ ok: false, status: 422, json: async () => ({ error: "Rate limit hit", meta_code: 130429 }) });
    expect(await processar({ tentativas_rate_limit: MAX_REAGENDAMENTOS_RATE_LIMIT })).toMatch(/^erro:/);
    expect(corpo().adiar_rate_limit).toBeUndefined();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "erro" }));
  });

  it("sem a coluna de contagem (migration não aplicada) mantém o comportamento antigo", async () => {
    enviar.mockResolvedValue(rateLimit());
    expect(await processar({ tentativas_rate_limit: undefined })).toMatch(/^erro:/);
    expect(corpo().adiar_rate_limit).toBeUndefined();
  });

  it("outro erro da Meta não é reagendado", async () => {
    enviar.mockResolvedValue({ ok: false, status: 422, json: async () => ({ error: "Template pausado", meta_code: 132015 }) });
    expect(await processar()).toMatch(/^erro:/);
    expect(update).not.toHaveBeenCalledWith(expect.objectContaining({ status: "agendado" }));
  });

  it("backoff esgota depois das tentativas previstas", () => {
    expect(proximaTentativaRateLimit(0, 0)).toBe(new Date(60_000).toISOString());
    expect(proximaTentativaRateLimit(MAX_REAGENDAMENTOS_RATE_LIMIT, 0)).toBeNull();
  });
});

describe("ritmo por conta", () => {
  it("espaça envios da mesma conta e deixa as outras livres", () => {
    let t = 1_000;
    const ritmo = criarRitmo(20, () => t);
    expect([ritmo.reservar("a"), ritmo.reservar("a"), ritmo.reservar("a")]).toEqual([0, 50, 100]);
    expect(ritmo.reservar("b")).toBe(0);
    t += 1_000;
    expect(ritmo.reservar("a")).toBe(0);
    ritmo.penalizar("a", 2_000);
    expect(ritmo.reservar("a")).toBe(2_000);
  });

  it("intercala contas preservando a ordem de cada uma", () => {
    const rows = [
      { id: "a1", wa_account_id: "A" }, { id: "a2", wa_account_id: "A" }, { id: "a3", wa_account_id: "A" },
      { id: "b1", wa_account_id: "B" }, { id: "w1", wa_account_id: null, wa_conexao_id: "W" },
    ];
    expect(intercalarPorConta(rows).map((r) => r.id)).toEqual(["a1", "b1", "w1", "a2", "a3"]);
    expect(chaveDaConta({ wa_account_id: null })).toBe("meta:padrao");
  });
});
