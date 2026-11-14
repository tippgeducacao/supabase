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

describe("correspondência", () => {
  it("external_id é o mesmo hash do telefone com 55 (igual ao dos sites)", async () => {
    const e = await montarEvento({ ...base, telefone: "(46) 99999-0000", valor: null });
    expect(e.user_data.external_id).toEqual(e.user_data.ph);
    expect(e.user_data.ph).toHaveLength(1);
  });
  it("sem telefone válido: nem ph nem external_id", async () => {
    const e = await montarEvento({ ...base, telefone: "123", valor: null });
    expect(e.user_data).not.toHaveProperty("external_id");
    expect(e.user_data).not.toHaveProperty("ph");
  });
});
