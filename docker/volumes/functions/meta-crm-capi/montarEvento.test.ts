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

describe("enriquecimento (16/11/2026)", () => {
  it("nome, cidade, estado, país em hash; fbc/fbp/IP/navegador do site sem hash", async () => {
    const e = await montarEvento({
      ...base, valor: null, nome: "Maria  da Silva", cidade: "São José", estado: "Paraná", pais: "Brazil",
      fbc: "fb.1.1731770000000.IwAR2abc", fbp: "fb.1.1731700000000.123456789", fbclid: "VELHO",
      ip: "200.1.2.3", user_agent: "Mozilla/5.0 (iPhone)",
    });
    const u = e.user_data;
    expect(u.fn).toEqual([await sha("maria")]);
    expect(u.ln).toEqual([await sha("silva")]);
    expect(u.ct).toEqual([await sha("sãojosé")]);
    expect(u.st).toEqual([await sha("pr")]);
    expect(u.country).toEqual([await sha("br")]);
    expect(u.fbc).toBe("fb.1.1731770000000.IwAR2abc");
    expect(u.fbp).toBe("fb.1.1731700000000.123456789");
    expect(u.client_ip_address).toBe("200.1.2.3");
    expect(u.client_user_agent).toBe("Mozilla/5.0 (iPhone)");
  });

  it("sem cookie, o fbc sai do fbclid; sem dados, nada a mais", async () => {
    const e = await montarEvento({ ...base, valor: null, fbclid: "ABC", lead_criado_em: "2026-11-01T00:00:00Z" });
    expect(e.user_data.fbc).toBe(`fb.1.${Date.parse("2026-11-01T00:00:00Z")}.ABC`);
    for (const k of ["fn", "ln", "ct", "st", "country", "fbp", "client_ip_address"]) expect(e.user_data).not.toHaveProperty(k);
  });
});

async function sha(t: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
}
