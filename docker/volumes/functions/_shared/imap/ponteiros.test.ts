import { describe, expect, it } from "vitest";
import { pontoDePartida } from "./ponteiros.ts";

/**
 * O teste que faltava quando o furo aconteceu: a caixa foi adotada com
 * `teto == backfill`, e o UID mais alto do servidor — o e-mail que a pessoa tinha
 * acabado de receber — não coube em nenhum dos dois intervalos.
 */
describe("pontoDePartida", () => {
  it("não mexe em nada quando a caixa já tem histórico iniciado", () => {
    expect(pontoDePartida(1378, 1377, 1317)).toEqual({ teto: 1377, backfill: 1317, adotou: false });
    // backfill 0 = histórico completo, e continua sendo respeitado.
    expect(pontoDePartida(1378, 1377, 0)).toEqual({ teto: 1377, backfill: 0, adotou: false });
  });

  it("adota o topo do servidor e deixa o histórico COBRIR esse mesmo UID", () => {
    const p = pontoDePartida(1378, 0, null);
    expect(p.adotou).toBe(true);
    expect(p.teto).toBe(1377);
    // O intervalo do histórico é "abaixo de backfill" — precisa ser 1378 para que
    // 1377 entre. Com 1377 aqui, o UID 1377 não entraria em lugar nenhum.
    expect(p.backfill).toBe(1378);
    expect(p.backfill).toBeGreaterThan(p.teto);
  });

  it("nenhum UID do servidor fica sem dono na adoção", () => {
    const uidNext = 501;
    const { teto, backfill } = pontoDePartida(uidNext, 0, null);
    const doServidor = Array.from({ length: 500 }, (_, i) => i + 1); // 1..500
    const cobertos = doServidor.filter((uid) => uid > teto || uid < backfill);
    expect(cobertos).toEqual(doServidor);
  });

  it("respeita o ponteiro antigo quando ele passou do que o servidor informa", () => {
    // Servidor que devolve UIDNEXT menor que o já processado: nunca voltar atrás,
    // senão o sync rebaixaria o teto e reprocessaria a caixa inteira.
    expect(pontoDePartida(10, 900, null)).toEqual({ teto: 900, backfill: 901, adotou: true });
  });

  it("caixa vazia ou servidor sem UIDNEXT não gera ponteiro negativo", () => {
    expect(pontoDePartida(1, 0, null)).toEqual({ teto: 0, backfill: 1, adotou: true });
    expect(pontoDePartida(0, 0, null)).toEqual({ teto: 0, backfill: 1, adotou: true });
  });
});
