import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("https://esm.sh/@supabase/supabase-js@2.49.1", () => ({ createClient: () => ({}) }));
let montarEvento: (p: Record<string, unknown>) => Promise<Record<string, any>>;

beforeAll(async () => {
  vi.stubGlobal("Deno", { env: { get: () => undefined }, serve: () => {} });
  ({ montarEvento } = (await import("./index.ts")) as never);
});

const base = {
  event_id: "crm_matricula:lead-1", lead_id: "lead-1", etapa: "crm_matricula",
  event_time: "2026-11-12T15:00:00Z", lead_criado_em: "2026-07-01T10:00:00Z",
  email: null, telefone: null, fbclid: null, leadgen_id: null,
};

describe("valor da matrícula na Meta", () => {
  it("com valor: value e currency BRL no custom_data", async () => {
    const e = await montarEvento({ ...base, valor: "15836.36" });
    expect(e.custom_data).toEqual({ event_source: "crm", lead_event_source: "Sistema PPGVET", value: 15836.36, currency: "BRL" });
  });
  it("sem valor: nada de value nem currency", async () => {
    const e = await montarEvento({ ...base, valor: null });
    expect(e.custom_data).toEqual({ event_source: "crm", lead_event_source: "Sistema PPGVET" });
  });
});
