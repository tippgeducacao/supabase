import { describe, expect, it } from "vitest";
import { contarAulasFuturas, hojeEmAmpere, turmaDaOportunidade, type Admin } from "./dados.ts";

describe("aulas futuras (a conferência do D+1)", () => {
  it("hoje é o dia de Ampére, não o de UTC", () => {
    // 02h30 UTC do dia 12 ainda é 23h30 do dia 11 em Ampére
    expect(hojeEmAmpere(new Date("2026-09-12T02:30:00Z"))).toBe("2026-09-11");
    expect(hojeEmAmpere(new Date("2026-09-12T03:00:00Z"))).toBe("2026-09-12");
  });

  it("conta de hoje em diante e ignora pré-abertura sem data", () => {
    const aulas = [
      { data: null },
      { data: "2026-09-10" },
      { data: "2026-09-11" },
      { data: "2026-09-12" },
      { data: "2027-01-05" },
    ];
    expect(contarAulasFuturas(aulas, "2026-09-11")).toBe(3);
    expect(contarAulasFuturas(aulas, "2027-01-06")).toBe(0);
    expect(contarAulasFuturas([], "2026-09-11")).toBe(0);
  });
});

/** Admin falso: só o que turmaDaOportunidade usa (rpc + from().select().eq().maybeSingle()). */
function adminFalso(rpc: { data: unknown; error: unknown }, oportunidade: { id: string } | null): Admin {
  const consulta = {
    select: () => consulta,
    eq: () => consulta,
    maybeSingle: async () => ({ data: oportunidade, error: null }),
  };
  return { rpc: async () => rpc, from: () => consulta } as unknown as Admin;
}

describe("turma pela oportunidade", () => {
  const OP = "deeb46c5-eebb-431e-b402-92557c9bd518";

  it("resolve quando a RPC devolve a turma", async () => {
    const r = await turmaDaOportunidade(adminFalso({ data: [{ turma_id: "t1", origem: "venda" }], error: null }, { id: OP }), OP);
    expect(r).toEqual({ ok: true, turmaId: "t1", origem: "venda" });
  });

  it("oportunidade que existe sem turma é o caminho B (turma_nao_identificada)", async () => {
    const r = await turmaDaOportunidade(adminFalso({ data: [], error: null }, { id: OP }), OP);
    expect(r).toMatchObject({ ok: false, status: 404, code: "turma_nao_identificada" });
  });

  it("oportunidade que não existe é erro de quem chamou, com código próprio", async () => {
    const r = await turmaDaOportunidade(adminFalso({ data: [], error: null }, null), OP);
    expect(r).toMatchObject({ ok: false, status: 404, code: "oportunidade_nao_encontrada" });
  });

  it("função ausente no banco vira 424 (migration pendente)", async () => {
    const r = await turmaDaOportunidade(
      adminFalso({ data: null, error: { code: "PGRST202", message: "Could not find the function" } }, { id: OP }),
      OP,
    );
    expect(r).toMatchObject({ ok: false, status: 424, code: "rpc_sem_acesso" });
  });
});
