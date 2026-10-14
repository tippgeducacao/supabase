import { describe, expect, it } from "vitest";
import { lerLiberacaoCotaResend, motivoReservaResend } from "./emailCotaResend.ts";

describe("reserva da conta Resend (14/10/2026)", () => {
  it("lê a resposta do banco", () => {
    expect(lerLiberacaoCotaResend({ liberado: false, uso: 195000, teto: 195000, limite_plano: 200000, reserva_externa: 5000 }))
      .toEqual({ liberado: false, sonda: false, uso: 195000, teto: 195000, limitePlano: 200000, reservaExterna: 5000 });
    expect(lerLiberacaoCotaResend({ liberado: true, sonda: true, uso: 195000 })).toMatchObject({ liberado: true, sonda: true });
  });

  it("resposta fora do formato libera (falha de leitura não para o e-mail do sistema)", () => {
    for (const dados of [null, undefined, "x", 1, {}, { liberado: "false" }]) {
      expect(lerLiberacaoCotaResend(dados).liberado).toBe(true);
    }
    expect(lerLiberacaoCotaResend({ liberado: false, uso: -5, teto: 1.5 })).toMatchObject({ liberado: false, uso: null, teto: null });
  });

  it("o motivo dá os números da conta e da reserva, sem a palavra do aviso de cota do Resend", () => {
    const motivo = motivoReservaResend(lerLiberacaoCotaResend({ liberado: false, uso: 195312, limite_plano: 200000, reserva_externa: 5000 }));
    expect(motivo).toContain("a conta já usou 195.312 de 200.000 e-mails neste ciclo");
    expect(motivo).toContain("os últimos 5.000 ficam reservados para outros sistemas");
    expect(motivo).not.toMatch(/quota/i);
    expect(motivoReservaResend(lerLiberacaoCotaResend({ liberado: false }))).toContain("chegou ao limite do PPGVET");
  });
});
