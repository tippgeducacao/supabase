import { describe, expect, it } from "vitest";
import { gaClientIdDe, normalizarGaClientId } from "./gaClientId";

describe("client_id do GA4 no lead", () => {
  it("aceita o id pronto e o valor cru do cookie _ga", () => {
    expect(normalizarGaClientId("123456789.1700000000")).toBe("123456789.1700000000");
    expect(normalizarGaClientId("GA1.1.123456789.1700000000")).toBe("123456789.1700000000");
    expect(normalizarGaClientId("GA1.2.987.654")).toBe("987.654");
  });

  it("recusa vazio, placeholder e lixo", () => {
    for (const v of ["", "  ", "{ga_client_id}", "__ga__", "abc.def", "123", "1.2.3", null, undefined, {}]) {
      expect(normalizarGaClientId(v)).toBeUndefined();
    }
  });

  it("pega o primeiro válido na ordem das fontes", () => {
    expect(gaClientIdDe({ ga_client_id: "lixo" }, { ga_client_id: "GA1.1.1.2" })).toBe("1.2");
    expect(gaClientIdDe({ ga_client_id: "3.4" }, { ga_client_id: "1.2" })).toBe("3.4");
    expect(gaClientIdDe(undefined, null, {})).toBeUndefined();
  });
});
