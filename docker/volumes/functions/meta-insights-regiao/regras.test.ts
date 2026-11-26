import { describe, expect, it } from "vitest";
import { contaSemPrefixo, diaEmSaoPaulo, leadsDasAcoes, linhasDaResposta, MAX_DIAS, periodoDoCorpo } from "./regras";

// 26/11/2026 às 01:30 UTC = 25/11 às 22:30 em São Paulo.
const AGORA = new Date("2026-11-26T01:30:00Z");

describe("periodoDoCorpo", () => {
  it("sem datas = hoje e os 6 dias anteriores, no fuso de São Paulo", () => {
    expect(diaEmSaoPaulo(AGORA)).toBe("2026-11-25");
    expect(periodoDoCorpo({}, AGORA)).toEqual({ desde: "2026-11-19", ate: "2026-11-25" });
  });

  it("aceita um mês inteiro do histórico", () => {
    expect(periodoDoCorpo({ desde: "2026-01-01", ate: "2026-01-31" }, AGORA)).toEqual({
      desde: "2026-01-01",
      ate: "2026-01-31",
    });
  });

  it("corta o fim no dia de hoje", () => {
    expect(periodoDoCorpo({ desde: "2026-11-01", ate: "2026-12-31" }, AGORA).ate).toBe("2026-11-25");
  });

  it("recusa data malformada, só uma das pontas, fim antes do início e janela grande demais", () => {
    expect(() => periodoDoCorpo({ desde: "01/11/2026", ate: "2026-11-30" }, AGORA)).toThrow(/AAAA-MM-DD/);
    expect(() => periodoDoCorpo({ desde: "2026-11-01" }, AGORA)).toThrow(/AAAA-MM-DD/);
    expect(() => periodoDoCorpo({ desde: "2026-11-10", ate: "2026-11-01" }, AGORA)).toThrow(/anterior/);
    expect(() => periodoDoCorpo({ desde: "2026-01-01", ate: "2026-06-30" }, AGORA)).toThrow(String(MAX_DIAS));
  });
});

describe("leadsDasAcoes", () => {
  it("conta a primeira ação de lead e ignora o resto", () => {
    expect(leadsDasAcoes([{ action_type: "link_click", value: "40" }, { action_type: "lead", value: "3" }])).toBe(3);
    expect(leadsDasAcoes([{ action_type: "link_click", value: "40" }])).toBe(0);
    expect(leadsDasAcoes(undefined)).toBe(0);
  });
});

describe("linhasDaResposta", () => {
  const MARCA = "2026-11-26T09:40:00.000Z";

  it("vira uma linha por campanha, dia e estado, com o nome que a Meta usa", () => {
    const l = linhasDaResposta(
      [
        { campaign_id: "1", date_start: "2026-11-20", region: "São Paulo (state)", spend: "12.34", impressions: "900", clicks: "10" },
        { campaign_id: "1", date_start: "2026-11-20", region: "Paraná", spend: "7.1", impressions: "300", clicks: "4" },
      ],
      "1520818801666741",
      MARCA,
    );
    expect(l).toHaveLength(2);
    expect(l[0]).toMatchObject({ regiao: "São Paulo (state)", spend: 12.34, impressions: 900, fetched_at: MARCA });
    expect(l[1]).toMatchObject({ regiao: "Paraná", spend: 7.1, ad_account_id: "1520818801666741" });
  });

  it("descarta linha vazia ou sem campanha e chama de Unknown o estado que falta", () => {
    const l = linhasDaResposta(
      [
        { campaign_id: "1", date_start: "2026-11-20", region: "Bahia", spend: "0", impressions: "0", clicks: "0" },
        { date_start: "2026-11-20", region: "Bahia", spend: "5" },
        { campaign_id: "2", date_start: "2026-11-20", spend: "1.5" },
      ],
      "x",
      MARCA,
    );
    expect(l).toEqual([expect.objectContaining({ campaign_id: "2", regiao: "Unknown", spend: 1.5 })]);
  });

  it("soma a chave repetida numa linha só (o upsert recusa a mesma chave duas vezes)", () => {
    const l = linhasDaResposta(
      [
        { campaign_id: "1", date_start: "2026-11-20", region: "Goiás", spend: "1.005", impressions: "10" },
        { campaign_id: "1", date_start: "2026-11-20", region: "Goiás", spend: "2.005", impressions: "5" },
      ],
      "x",
      MARCA,
    );
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ spend: 3.01, impressions: 15 });
  });
});

describe("contaSemPrefixo", () => {
  it("tira o act_", () => {
    expect(contaSemPrefixo("act_1187337038878748")).toBe("1187337038878748");
    expect(contaSemPrefixo("1187337038878748")).toBe("1187337038878748");
  });
});
