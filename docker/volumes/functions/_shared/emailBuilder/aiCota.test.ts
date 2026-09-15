import { describe, expect, it } from "vitest";
import { calcularCotaEmailIA, validarCotaEmailIA } from "./aiCota.ts";

const agora = Date.parse("2026-09-14T12:00:00Z");
const registro = (usos: number[], dia = "2026-09-14", usosDia = usos.length) => ({ usos_ultimo_minuto: usos.map(ms => new Date(agora + ms).toISOString()), dia_utc: dia, usos_dia: usosDia });
describe("fotografia da cota real, sem reservar geração", () => {
  it("usuário sem linha dispõe das cotas integrais", () => {
    expect(calcularCotaEmailIA(null, agora)).toEqual({ limite_minuto: 5, restante_minuto: 5, limite_dia: 50, restante_dia: 50, retry_after: 0,
      consultada_em: "2026-09-14T12:00:00.000Z", reinicia_dia_em: "2026-09-15T00:00:00.000Z" });
  });
  it("janela móvel exclui exatamente60s e inclui59.999s sem resetar o dia", () => {
    expect(calcularCotaEmailIA(registro([-60000, -59999, -1000], undefined, 17), agora)).toMatchObject({ restante_minuto: 3, restante_dia: 33, retry_after: 0 });
  });
  it("cinco usos recentes informam o instante de liberação mais antigo", () => {
    expect(calcularCotaEmailIA(registro([-59200, -40000, -30000, -20000, -10000]), agora)).toMatchObject({ restante_minuto: 0, restante_dia: 45, retry_after: 1 });
  });
  it("limite diário prevalece sobre o minuto e vira à meia-noiteUTC", () => {
    expect(calcularCotaEmailIA(registro([-1000], undefined, 50), agora)).toMatchObject({ restante_dia: 0, retry_after: 43200 });
    expect(calcularCotaEmailIA(registro([], "2026-09-13", 50), agora)).toMatchObject({ restante_dia: 50, retry_after: 0 });
  });
  it("janela móvel atravessa a virada diária", () => {
    const estado = { usos_ultimo_minuto: ["2026-09-14T23:59:59Z"], dia_utc: "2026-09-14", usos_dia: 50 };
    expect(calcularCotaEmailIA(estado, Date.parse("2026-09-15T00:00:00Z"))).toMatchObject({ restante_minuto: 4, restante_dia: 50 });
  });
  it.each([undefined, {}, registro([], undefined, 51), { ...registro([]), usos_ultimo_minuto: ["ontem"] }, registro([0, 0, 0, 0, 0, 0])])("não inventa saldo para registro inválido", valor => {
    expect(() => calcularCotaEmailIA(valor, agora)).toThrow();
  });
  it("cliente recusa contagens e datas inválidas", () => {
    expect(() => validarCotaEmailIA({ ...calcularCotaEmailIA(null, agora), restante_dia: -1 })).toThrow();
    expect(() => validarCotaEmailIA({ ...calcularCotaEmailIA(null, agora), consultada_em: "nunca" })).toThrow();
  });
});
