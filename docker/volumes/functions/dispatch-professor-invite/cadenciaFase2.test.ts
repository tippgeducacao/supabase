import { describe, it, expect } from "vitest";
import {
  daysUntilAula,
  pickNextFase2Marco,
  marcoLinkDoDia,
  buildAulaStartIso,
  buildAulaEndIso,
} from "./cadenciaFase2";

const AULA = { data: "2026-08-17", horario: "19:00 - 22:00" };

/** Data civil N dias antes da aula, para usar como "hoje". */
function hojeAntesDaAula(dias: number): string {
  const d = new Date(Date.UTC(2026, 7, 17));
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

describe("daysUntilAula", () => {
  it("conta por data civil, sem arredondar pra cima", () => {
    // O bug de 17/08/2026: no PRÓPRIO dia do marco de 30d a conta dava 31.
    expect(daysUntilAula("2026-08-17", "2026-07-18")).toBe(30);
    expect(daysUntilAula("2026-08-17", "2026-08-10")).toBe(7);
    expect(daysUntilAula("2026-08-17", "2026-08-16")).toBe(1);
    expect(daysUntilAula("2026-08-17", "2026-08-17")).toBe(0);
    expect(daysUntilAula("2026-08-17", "2026-08-18")).toBe(-1);
  });

  it("atravessa a virada do mês", () => {
    expect(daysUntilAula("2026-09-01", "2026-08-31")).toBe(1);
    expect(daysUntilAula("2026-03-01", "2026-02-27")).toBe(2); // 2026 não é bissexto
  });
});

describe("pickNextFase2Marco — a cadência não pode queimar", () => {
  it("depois do lembrete de 30d, o próximo é o de 7d (não o dia da aula)", () => {
    const next = pickNextFase2Marco(AULA, "fase2_reconfirmacao_30d", hojeAntesDaAula(30));
    expect(next.status).toBe("fase2_reconfirmacao_7d");
    expect(next.marco).toBe("lembrete_7d");
    expect(next.proxima_acao_em.slice(0, 10)).toBe("2026-08-10");
  });

  it("depois do lembrete de 7d, o próximo é o de 1d", () => {
    const next = pickNextFase2Marco(AULA, "fase2_reconfirmacao_7d", hojeAntesDaAula(7));
    expect(next.status).toBe("fase2_lembrete_1d");
    expect(next.proxima_acao_em.slice(0, 10)).toBe("2026-08-16");
  });

  it("depois do lembrete de 1d, sobra o link do dia — 1h antes de começar", () => {
    const next = pickNextFase2Marco(AULA, "fase2_lembrete_1d", hojeAntesDaAula(1));
    expect(next.status).toBe("dia_aula_link_enviado");
    expect(next.proxima_acao_em).toBe(marcoLinkDoDia(AULA));
    // aula 19:00 em SP ⇒ marco às 18:00 (21:00Z)
    expect(next.proxima_acao_em).toBe("2026-08-17T21:00:00.000Z");
  });

  it("NUNCA devolve o mesmo degrau em que o convite já está", () => {
    for (const status of [
      "fase2_reconfirmacao_30d",
      "fase2_reconfirmacao_7d",
      "fase2_lembrete_1d",
    ]) {
      for (let dias = 0; dias <= 60; dias++) {
        const next = pickNextFase2Marco(AULA, status, hojeAntesDaAula(dias));
        expect(next.status).not.toBe(status);
      }
    }
  });

  it("o 14d aposentado cai no degrau de 7d, não volta pro de 30d", () => {
    const next = pickNextFase2Marco(AULA, "fase2_reconfirmacao_14d", hojeAntesDaAula(14));
    expect(next.status).toBe("fase2_reconfirmacao_7d");
  });

  it("atraso no motor pula degrau em vez de mandar dois toques no mesmo dia", () => {
    // Convite ainda em 30d mas a aula é daqui a 7 dias: o marco de 7d seria HOJE.
    const next = pickNextFase2Marco(AULA, "fase2_reconfirmacao_30d", hojeAntesDaAula(7));
    expect(next.status).toBe("fase2_lembrete_1d");
  });

  it("sem status atual, começa do topo da régua", () => {
    const next = pickNextFase2Marco(AULA, null, hojeAntesDaAula(45));
    expect(next.status).toBe("fase2_reconfirmacao_30d");
    expect(next.proxima_acao_em.slice(0, 10)).toBe("2026-07-18");
  });

  it("aula já passada não vira lembrete — cai no link (que o guard do dia barra)", () => {
    const next = pickNextFase2Marco(AULA, "fase2_lembrete_1d", "2026-08-20");
    expect(next.status).toBe("dia_aula_link_enviado");
    expect(next.dias).toBe(-3);
  });
});

describe("marco do link do dia × janela do cron", () => {
  // ⚠️ 1h antes NÃO é escolha de implementação: três templates aprovados na Meta prometem
  // esse prazo por escrito ("sua aula começa em 1h", "o link será enviado 1h antes"). Se
  // alguém mudar o marco sem trocar os textos, a mensagem passa a mentir — foi por isso que
  // a antecipação para o meio-dia foi revertida em 18/08/2026.
  it("aula da noite recebe o link às 18h — a 1h prometida no template", () => {
    expect(marcoLinkDoDia({ data: "2026-08-17", horario: "19:00 - 22:00" })).toBe(
      "2026-08-17T21:00:00.000Z", // 18:00 SP
    );
  });

  it("aula matinal sai 1h antes de começar", () => {
    const pratico = { data: "2026-08-20", horario: "08:00 - 18:00" };
    expect(buildAulaStartIso(pratico.data, pratico.horario)).toBe("2026-08-20T08:00:00-03:00");
    // 07:00 SP = 10:00Z — e o cron começa exatamente às 10:00Z, então alcança.
    expect(marcoLinkDoDia(pratico)).toBe("2026-08-20T10:00:00.000Z");
  });

  it("aula sem horário cadastrado assume 19:00 e não quebra a conta", () => {
    expect(marcoLinkDoDia({ data: "2026-08-17", horario: null })).toBe(
      "2026-08-17T21:00:00.000Z",
    );
  });

  it("todo marco de link cai DENTRO da janela do cron (10:00–23:30 UTC)", () => {
    // A janela é */30 10-23 UTC. Um marco fora dela é uma mensagem que não sai no dia —
    // foi exatamente o que aconteceu em 17/08 com o marco das 18h SP... que ERA alcançável
    // em UTC (21:00Z), mas não pelo cron de 1x/dia. Aqui o teste guarda a nova regra.
    for (const horario of ["08:00 - 18:00", "09:00 - 12:00", "13:00 - 17:00", "19:00 - 22:00", null]) {
      const iso = marcoLinkDoDia({ data: "2026-08-20", horario });
      const horaUtc = new Date(iso).getUTCHours();
      expect(horaUtc).toBeGreaterThanOrEqual(10);
      expect(horaUtc).toBeLessThanOrEqual(23);
    }
  });
});

describe("horário escrito à mão — a base tem de tudo", () => {
  const inicio = (h: string | null) => buildAulaStartIso("2026-08-20", h).slice(11, 16);
  const fim = (h: string | null) => buildAulaEndIso("2026-08-20", h).slice(11, 16);

  it("entende as variações reais do cadastro", () => {
    expect(inicio("08:00 - 18:00")).toBe("08:00");
    expect(inicio("8h")).toBe("08:00"); // caía em 19:00 e mandava o link 10h atrasado
    expect(inicio("8:00")).toBe("08:00");
    expect(inicio("13h")).toBe("13:00");
    expect(inicio("19h00")).toBe("19:00"); // gerava Invalid Date e derrubava o convite
    expect(inicio("19:00 às 22:00")).toBe("19:00");
    expect(fim("19:00 às 22:00")).toBe("22:00");
    expect(fim("08:00 - 18:00")).toBe("18:00");
  });

  it("cai nos padrões quando não dá pra ler", () => {
    expect(inicio(null)).toBe("19:00");
    expect(inicio("")).toBe("19:00");
    expect(inicio("a combinar")).toBe("19:00");
    expect(inicio("99:99")).toBe("19:00");
    expect(fim("19:00")).toBe("22:00"); // só o início cadastrado
  });

  it("nunca produz data inválida", () => {
    for (const h of [null, "", "8h", "19h00", "13h", "a combinar", "19:00 às 22:00", "99:99"]) {
      expect(Number.isNaN(new Date(buildAulaStartIso("2026-08-20", h)).getTime())).toBe(false);
      expect(Number.isNaN(new Date(buildAulaEndIso("2026-08-20", h)).getTime())).toBe(false);
    }
  });
});
