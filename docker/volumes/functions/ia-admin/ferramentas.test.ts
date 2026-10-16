import { describe, expect, it, vi } from "vitest";
import { compactarLinhas, executarFerramenta, FERRAMENTAS, redigirSegredos, type ContextoFerramentas } from "./ferramentas";

function contexto(resposta: { data: unknown; error: { message: string } | null }, modo: "chat" | "varredura" = "chat") {
  const rpc = vi.fn(async () => resposta);
  const auditar = vi.fn(async () => {});
  const ctx: ContextoFerramentas = { cliente: { rpc }, modo, checagemId: "c1", rodadaItemId: "i1", auditar };
  return { ctx, rpc, auditar };
}

describe("ferramentas da IA Administrativa", () => {
  it("nomes únicos e ordem estável (o cache depende disso)", () => {
    const nomes = FERRAMENTAS.map((f) => f.name);
    expect(new Set(nomes).size).toBe(nomes.length);
    expect(nomes[0]).toBe("consultar_banco");
  });

  it("consultar_banco passa o SQL para ia_admin_sql e audita", async () => {
    const { ctx, rpc, auditar } = contexto({ data: { linhas: [{ n: 14 }], total: 1, cortado: false, ms: 5 }, error: null });
    const r = await executarFerramenta(ctx, "consultar_banco", { sql: "select count(*) n from agendamentos", objetivo: "contar" });
    expect(rpc).toHaveBeenCalledWith("ia_admin_sql", { p_sql: "select count(*) n from agendamentos" });
    expect(r.erro).toBe(false);
    expect(r.conteudo).toContain('"n":14');
    expect(r.etapa).toMatchObject({ ferramenta: "consultar_banco", linhas: 1, detalhe: "select count(*) n from agendamentos" });
    expect(r.memoria).toContain("contar");
    expect(auditar).toHaveBeenCalledWith(expect.objectContaining({ ok: true, linhas: 1 }));
  });

  it("erro de SQL devolvido pelo banco volta como erro para o modelo", async () => {
    const { ctx, auditar } = contexto({ data: { erro: "permission denied for table leads", codigo: "42501" }, error: null });
    const r = await executarFerramenta(ctx, "consultar_banco", { sql: "select cpf from leads", objetivo: "x" });
    expect(r.erro).toBe(true);
    expect(r.conteudo).toContain("permission denied");
    expect(auditar).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });

  it("sem SQL é entrada inválida e não chama o banco", async () => {
    const { ctx, rpc } = contexto({ data: null, error: null });
    const r = await executarFerramenta(ctx, "consultar_banco", { objetivo: "x" });
    expect(r.erro).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("listar_achados é uma consulta fixa, só leitura, na fila", async () => {
    const { ctx, rpc } = contexto({ data: { linhas: [], total: 0, cortado: false }, error: null });
    await executarFerramenta(ctx, "listar_achados", { status: "abertos" });
    const sql = (rpc.mock.calls[0] as unknown as [string, { p_sql: string }])[1].p_sql;
    expect(sql).toMatch(/^select .* from ia_admin_achados where status in \('aberto','em_andamento'\)/);
  });

  it("registrar_achado normaliza a assinatura e marca a origem pelo modo", async () => {
    const { ctx, rpc } = contexto({ data: { id: "a1", novo: true }, error: null }, "varredura");
    const r = await executarFerramenta(ctx, "registrar_achado", {
      assinatura: "Lead de Venda no SAC Contratação!",
      titulo: "Lead de venda no RH",
      gravidade: "alta",
      area: "rh",
      resumo: "3 leads.",
      casos: 3,
    });
    expect(r.erro).toBe(false);
    expect(r.etapa.achado_id).toBe("a1");
    const p = (rpc.mock.calls[0] as unknown as [string, { p: Record<string, unknown> }])[1].p;
    expect(p.assinatura).toBe("lead-de-venda-no-sac-contratacao");
    expect(p).toMatchObject({ origem: "varredura", checagem_id: "c1", rodada_item_id: "i1", casos: 3 });
  });

  it("ferramenta desconhecida não lança", async () => {
    const { ctx } = contexto({ data: null, error: null });
    const r = await executarFerramenta(ctx, "apagar_tudo", {});
    expect(r.erro).toBe(true);
  });
});

describe("compactarLinhas", () => {
  it("encurta campo longo e corta linhas até caber", () => {
    const linhas = Array.from({ length: 200 }, (_, i) => ({ id: i, texto: "x".repeat(1000) }));
    const { texto, mostradas } = compactarLinhas(linhas, 20_000);
    expect(texto.length).toBeLessThanOrEqual(20_000);
    expect(mostradas).toBeLessThan(200);
    expect(texto).toContain("(+600 caracteres)");
  });
});

describe("redigirSegredos", () => {
  it("tira JWT e chaves", () => {
    const s = redigirSegredos("a eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZSJ9.abcdefghijklmnop b sk-ant-api03-abcdefghijklmnopqrstuv c");
    expect(s).not.toMatch(/eyJ|sk-ant/);
    expect(s.match(/\[segredo omitido\]/g)).toHaveLength(2);
  });
});
