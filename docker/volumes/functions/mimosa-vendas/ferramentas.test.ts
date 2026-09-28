import { describe, expect, it, vi } from "vitest";
import { executarFerramenta, FERRAMENTAS, fontesDoResultado, statusDaFerramenta, type ClienteRpc } from "./ferramentas";

function cliente(dados: unknown = { ok: true }, erro: string | null = null) {
  const rpc = vi.fn(async () => ({ data: dados, error: erro ? { message: erro } : null }));
  return { cliente: { rpc } as unknown as ClienteRpc, rpc };
}

describe("executarFerramenta", () => {
  it("detalhar_produto chama mimosa_produto com o JWT de quem pergunta e só seções válidas", async () => {
    const { cliente: c, rpc } = cliente({ resumo: { produto: "Sanidade Avícola", pos: { nome: "Sanidade Avícola" } } });
    const r = await executarFerramenta(c, "detalhar_produto", { produto: " sanidade ", secoes: ["praticos", "inventada", 3] });
    expect(rpc).toHaveBeenCalledWith("mimosa_produto", { p_ref: "sanidade", p_secoes: ["praticos"] });
    expect(r.erro).toBe(false);
    expect(r.fontes[0]).toMatchObject({ tipo: "pedagogico", rotulo: "Sanidade Avícola — cadastro do Pedagógico" });
  });

  it("recusa entrada inválida sem chamar o banco", async () => {
    const { cliente: c, rpc } = cliente();
    expect((await executarFerramenta(c, "detalhar_produto", {})).erro).toBe(true);
    expect((await executarFerramenta(c, "modulos_praticos", { de: "15/10/2026" })).conteudo).toContain("AAAA-MM-DD");
    expect((await executarFerramenta(c, "ler_documento", { documento_id: "abc" })).conteudo).toContain("inválido");
    expect((await executarFerramenta(c, "nao_existe", {})).erro).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("modulos_praticos e turmas passam os filtros no formato das RPCs", async () => {
    const { cliente: c, rpc } = cliente({ encontros: [] });
    await executarFerramenta(c, "modulos_praticos", { produto: "clínica", cidade: "Ampére", de: "2026-10-01" });
    expect(rpc).toHaveBeenLastCalledWith("mimosa_praticos", { p_produto: "clínica", p_cidade: "Ampére", p_de: "2026-10-01", p_ate: null });
    await executarFerramenta(c, "turmas", { incluir_em_andamento: true });
    expect(rpc).toHaveBeenLastCalledWith("mimosa_turmas", { p_produto: null, p_de: null, p_ate: null, p_incluir_em_andamento: true });
  });

  it("erro do banco volta como erro para o modelo, não derruba a conversa", async () => {
    const { cliente: c } = cliente(null, "permission denied");
    const r = await executarFerramenta(c, "buscar_na_base", { consulta: "nasem" });
    expect(r.erro).toBe(true);
    expect(r.conteudo).toContain("permission denied");
  });

  it("calcular_orcamento roda local (sem banco) e cita a régua usada", async () => {
    const { cliente: c, rpc } = cliente();
    const r = await executarFerramenta(c, "calcular_orcamento", { valor_integral: 12730, desconto_percentual: 20, parcelas: 24 });
    expect(rpc).not.toHaveBeenCalled();
    expect(JSON.parse(r.conteudo).valor_parcela).toBe("R$ 424,33");
    expect(r.fontes[0].tipo).toBe("calculo");
    const ruim = await executarFerramenta(c, "calcular_orcamento", { valor_integral: 1000, parcelas: 99 });
    expect(ruim.erro).toBe(true);
  });
});

describe("fontesDoResultado", () => {
  it("busca: um documento vira uma fonte só, sem a página no rótulo", () => {
    const f = fontesDoResultado("buscar_na_base", {
      resultados: [
        { fonte: "documento", titulo: "Ebook de Produto — p. 12 · Sanidade", ref: { documento_id: "d1", pagina: 12 }, atualizado_em: "2026-09-28" },
        { fonte: "documento", titulo: "Ebook de Produto — p. 40", ref: { documento_id: "d1", pagina: 40 } },
        { fonte: "grade", curso: "Sanidade Avícola", titulo: "Módulo 3" },
      ],
    }, {});
    expect(f).toEqual([
      { tipo: "documento", rotulo: "Ebook de Produto", atualizado_em: "2026-09-28", documento_id: "d1", pagina: 12 },
      { tipo: "busca", rotulo: "Grade · Sanidade Avícola", atualizado_em: null, documento_id: null, pagina: null },
    ]);
  });

  it("produto não encontrado não gera fonte", () => {
    expect(fontesDoResultado("detalhar_produto", { erro: "Produto não encontrado no sistema." }, {})).toEqual([]);
  });

  it("status legível para cada ferramenta declarada", () => {
    for (const t of FERRAMENTAS) {
      expect(statusDaFerramenta(t.name, {})).not.toBe("Consultando o sistema");
    }
    expect(statusDaFerramenta("buscar_na_base", { consulta: "SISBI" })).toBe("Buscando “SISBI” em toda a base");
  });
});
