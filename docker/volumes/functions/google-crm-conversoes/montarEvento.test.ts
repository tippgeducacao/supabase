import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("https://esm.sh/@supabase/supabase-js@2.49.1", () => ({ createClient: () => ({}) }));
let montarEvento: (p: Record<string, unknown>) => Promise<Record<string, any>>;

beforeAll(async () => {
  vi.stubGlobal("Deno", { env: { get: () => undefined }, serve: () => {} });
  ({ montarEvento } = (await import("./index.ts")) as never);
});

const base = {
  event_id: "crm_matricula:lead-1", lead_id: "lead-1", etapa: "crm_matricula",
  event_time: "2026-11-12T15:00:00Z", gclid: "GCLID_1", gbraid: null, wbraid: null, email: null, telefone: null,
};

describe("valor da matrícula no Google Ads", () => {
  it("com valor: conversionValue e currency BRL", async () => {
    const e = await montarEvento({ ...base, valor: 15836.36 });
    expect(e).toMatchObject({ conversionValue: 15836.36, currency: "BRL", transactionId: base.event_id });
  });
  it("sem valor: sem conversionValue nem currency", async () => {
    const e = await montarEvento({ ...base, valor: null });
    expect(e).not.toHaveProperty("conversionValue");
    expect(e).not.toHaveProperty("currency");
  });
});

describe("click IDs do Google Ads (gclid, gbraid, wbraid)", () => {
  it("só gclid: manda só gclid", async () => {
    expect((await montarEvento(base)).adIdentifiers).toEqual({ gclid: "GCLID_1" });
  });
  it("clique no iPhone sem gclid: manda gbraid e/ou wbraid", async () => {
    expect((await montarEvento({ ...base, gclid: null, wbraid: "WB_1" })).adIdentifiers).toEqual({ wbraid: "WB_1" });
    expect((await montarEvento({ ...base, gclid: null, gbraid: "GB_1", wbraid: "WB_1" })).adIdentifiers).toEqual({ gbraid: "GB_1", wbraid: "WB_1" });
  });
  it("os três juntos vão juntos (o Google escolhe gclid > wbraid > gbraid)", async () => {
    expect((await montarEvento({ ...base, gbraid: "GB_1", wbraid: "WB_1" })).adIdentifiers).toEqual({ gclid: "GCLID_1", gbraid: "GB_1", wbraid: "WB_1" });
  });
});
