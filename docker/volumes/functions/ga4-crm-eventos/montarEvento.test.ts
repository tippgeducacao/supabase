import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("https://esm.sh/@supabase/supabase-js@2.49.1", () => ({ createClient: () => ({}) }));
let montarEvento: (p: Record<string, unknown>, agora?: number) => { events: Record<string, unknown>[] } & Record<string, unknown>;

beforeAll(async () => {
  vi.stubGlobal("Deno", { env: { get: () => undefined }, serve: () => {} });
  ({ montarEvento } = (await import("./index.ts")) as never);
});

const agora = Date.parse("2026-11-16T15:00:00Z");
const base = { event_id: "crm_matricula:lead-1", lead_id: "lead-1", etapa: "crm_matricula", ga_client_id: "123.456", valor: null };

describe("evento do Measurement Protocol", () => {
  it("leva o client_id, o nome da etapa e a data quando cabe nas 72 h", () => {
    const e = montarEvento({ ...base, event_time: "2026-11-15T15:00:00Z", valor: "4790.00", curso_id: "curso-1", curso_nome: "PÓS | SANIDADE AVÍCOLA" }, agora);
    expect(e).toEqual({
      client_id: "123.456",
      timestamp_micros: Date.parse("2026-11-15T15:00:00Z") * 1000,
      events: [{
        name: "purchase",
        params: {
          transaction_id: "crm_matricula:lead-1", value: 4790, currency: "BRL",
          items: [{ item_id: "curso-1", item_name: "PÓS | SANIDADE AVÍCOLA", price: 4790, quantity: 1 }],
        },
      }],
    });
  });

  it("matrícula sem valor nem pós ainda vai como purchase válido (items com item_name)", () => {
    const e = montarEvento({ ...base, event_time: "2026-11-15T15:00:00Z" }, agora);
    expect(e.events[0]).toEqual({
      name: "purchase",
      params: { transaction_id: "crm_matricula:lead-1", items: [{ item_name: "Matrícula", quantity: 1 }] },
    });
  });

  it("etapa registrada há mais de 71 h vai sem data (o GA4 grava na chegada)", () => {
    const e = montarEvento({ ...base, etapa: "crm_reuniao_realizada", event_time: "2026-11-13T15:00:00Z" }, agora);
    expect(e).not.toHaveProperty("timestamp_micros");
    expect(e.events[0]).toEqual({ name: "crm_reuniao_realizada", params: {} });
  });

  it("data no futuro ou inválida também vai sem data", () => {
    expect(montarEvento({ ...base, event_time: "2026-11-17T15:00:00Z" }, agora)).not.toHaveProperty("timestamp_micros");
    expect(montarEvento({ ...base, event_time: "lixo" }, agora)).not.toHaveProperty("timestamp_micros");
  });
});
