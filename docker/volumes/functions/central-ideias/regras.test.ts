import { describe, expect, it } from "vitest";
import { resumirNossasContas, validarDia, validarMiniaturas, type PostNosso } from "./regras";

const post = (o: Partial<PostNosso>): PostNosso => ({
  conta: "ppgvet_oficial", caption: "x", media_type: "VIDEO", permalink: "https://instagram.com/p/1",
  timestamp: "2026-11-20T13:00:00Z", reach: 100, likes: 1, comments: 0, saves: 0, shares: 0,
  engagement_rate: 1, ...o,
});

describe("resumirNossasContas", () => {
  it("separa melhores e piores por alcance e calcula médias com 2 casas", () => {
    const r = resumirNossasContas([
      post({ reach: 10, permalink: "a" }), post({ reach: 50, permalink: "b" }),
      post({ reach: 30, permalink: "c" }), post({ reach: 20, permalink: "d" }),
      post({ conta: "suinocast", reach: 7, media_type: "IMAGE" }),
    ]);
    const vet = r.por_conta.find((c) => c.conta === "ppgvet_oficial")!;
    expect(vet.melhores.map((p) => p.link)).toEqual(["b", "c", "d"]);
    expect(vet.piores.map((p) => p.link)).toEqual(["d", "a"]);
    expect(vet.alcance_medio).toBe(27.5);
    expect(r.por_formato.find((f) => f.grupo === "IMAGE")?.posts).toBe(1);
  });

  it("usa o horário de Brasília (13h UTC = manhã de sexta)", () => {
    const r = resumirNossasContas([post({ timestamp: "2026-11-20T13:00:00Z" })]);
    expect(r.por_faixa_de_hora[0].grupo).toBe("manhã");
    expect(r.por_dia_da_semana[0].grupo).toBe("sex");
  });

  it("conta com poucos posts não repete o mesmo post em melhores e piores", () => {
    const r = resumirNossasContas([post({}), post({ reach: 5 })]);
    expect(r.por_conta[0].piores).toEqual([]);
  });
});

describe("validarDia", () => {
  const ok = { dia: "2026-11-23", resumo: " Resumo ", conteudo: { ideias: [] } };
  it("aceita o mínimo e limpa o resumo", () => {
    expect(validarDia(ok)).toMatchObject({ dia: "2026-11-23", resumo: "Resumo", erros: [], custo_usd: null });
  });
  it.each([
    [{ ...ok, dia: "23/11/2026" }, "dia"],
    [{ ...ok, resumo: "  " }, "resumo"],
    [{ ...ok, conteudo: [] }, "conteudo"],
    [{ ...ok, erros: "x" }, "erros"],
    [{ ...ok, custo_usd: "1" }, "custo_usd"],
  ])("recusa %j", (corpo, campo) => {
    expect(validarDia(corpo as Record<string, unknown>)).toEqual(expect.stringContaining(campo));
  });
});

describe("validarMiniaturas", () => {
  it("aceita vazio e lista boa", () => {
    expect(validarMiniaturas(undefined)).toEqual([]);
    expect(validarMiniaturas([{ link: "https://x/1", jpeg_base64: "AAAA" }])).toHaveLength(1);
  });
  it.each([
    ["não lista", "x"],
    ["sem link", [{ link: "ftp://x", jpeg_base64: "AA" }]],
    ["grande demais", [{ link: "https://x", jpeg_base64: "A".repeat(350_001) }]],
    ["demais", Array.from({ length: 81 }, () => ({ link: "https://x", jpeg_base64: "A" }))],
  ])("recusa %s", (_n, m) => {
    expect(typeof validarMiniaturas(m)).toBe("string");
  });
});
