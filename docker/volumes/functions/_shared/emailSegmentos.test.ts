import { describe, expect, it, vi } from "vitest";
import { enfileirarContatosSegmentoEmail, normalizarContatosSegmentoEmail, resolverSegmentoEmail, validarQuerySegmentoEmail } from "./emailSegmentos";

type Resultado = { data: Array<Record<string, unknown>> | null; error: unknown };
function clienteDePaginas(paginas: Resultado[]) {
  const consultas: Array<{ campos?: string; ordem?: string; inicio?: number; fim?: number }> = [];
  const cliente = {
    from: vi.fn(() => {
      const detalhes: typeof consultas[number] = {};
      consultas.push(detalhes);
      const consulta = {
        select(campos: string) { detalhes.campos = campos; return consulta; },
        not() { return consulta; },
        order(campo: string) { detalhes.ordem = campo; return consulta; },
        range(inicio: number, fim: number) { detalhes.inicio = inicio; detalhes.fim = fim; return consulta; },
        eq() { return consulta; }, neq() { return consulta; }, in() { return consulta; },
        ilike() { return consulta; }, gt() { return consulta; }, lt() { return consulta; }, is() { return consulta; },
        then(resolve: (resultado: Resultado) => unknown) {
          const pagina = paginas[(detalhes.inicio ?? 0) / 1000] ?? { data: [], error: null };
          return Promise.resolve(pagina).then(resolve);
        },
      };
      return consulta;
    }),
  };
  return { cliente, consultas };
}

describe("público compartilhado da prévia e campanha", () => {
  it("normaliza e deduplica e-mails, preservando os dados do primeiro contato", () => {
    expect(normalizarContatosSegmentoEmail([
      { email: "  ANA@EXAMPLE.COM  ", nome: "Ana", metadata: { curso: "Pós" } },
      { email: "ana@example.com", nome: "Duplicada" },
      { email: " " }, { email: null }, { email: "sem-endereco" }, { email: "duplo@@example.com" }, null,
    ])).toEqual([{ email: "ana@example.com", nome: "Ana", metadata: { curso: "Pós" } }]);
  });

  it("usa a mesma normalização para segmento estático", async () => {
    const { cliente } = clienteDePaginas([]);
    const contatos = await resolverSegmentoEmail(cliente, {
      tipo: "estatico", contatos_estaticos: [{ email: "A@EXAMPLE.COM" }, { email: "a@example.com" }, { email: "" }],
    });
    expect(contatos).toEqual([{ email: "a@example.com", nome: null, metadata: null }]);
    expect(cliente.from).not.toHaveBeenCalled();
  });

  it("consulta além do teto de mil linhas e remove duplicatas entre páginas", async () => {
    const primeira = Array.from({ length: 1000 }, (_, i) => ({ email: `pessoa${i}@example.com`, nome: `Pessoa ${i}` }));
    const { cliente, consultas } = clienteDePaginas([
      { data: primeira, error: null },
      { data: [{ email: " PESSOA0@EXAMPLE.COM " }, { email: "nova@example.com" }, { email: " " }], error: null },
    ]);
    const contatos = await resolverSegmentoEmail(cliente, { tipo: "dinamico", query_dinamica: { tabela: "leads", filtros: [] } });
    expect(contatos).toHaveLength(1001);
    expect(contatos.at(-1)?.email).toBe("nova@example.com");
    expect(consultas).toEqual([
      { campos: "email,nome", ordem: "id", inicio: 0, fim: 999 },
      { campos: "email,nome", ordem: "id", inicio: 1000, fim: 1999 },
    ]);
  });

  it("usa a coluna real name ao consultar colaboradores", async () => {
    const { cliente, consultas } = clienteDePaginas([{ data: [{ email: "ana@example.com", name: "Ana" }], error: null }]);
    const contatos = await resolverSegmentoEmail(cliente, { tipo: "dinamico", query_dinamica: { tabela: "profiles", filtros: [] } });
    expect(consultas[0].campos).toBe("email,name");
    expect(contatos[0].nome).toBe("Ana");
  });

  it("interrompe uma consulta com falha em página posterior em vez de devolver um público parcial", async () => {
    const { cliente } = clienteDePaginas([
      { data: Array.from({ length: 1000 }, (_, i) => ({ email: `p${i}@example.com` })), error: null },
      { data: null, error: { message: "offline" } },
    ]);
    await expect(resolverSegmentoEmail(cliente, { tipo: "dinamico", query_dinamica: { tabela: "leads", filtros: [] } })).rejects.toThrow("Não foi possível consultar");
  });

  it("rejeita campos antigos e operadores inválidos sem ampliar o público silenciosamente", () => {
    for (const [tabela, campo] of [["profiles", "setor"], ["alunos", "curso_id"], ["leads", "origem"], ["leads", "etapa"]]) {
      expect(() => validarQuerySegmentoEmail({ tabela, filtros: [{ campo, operador: "eq", valor: "x" }] })).toThrow("campo de filtro indisponível");
    }
    expect(() => validarQuerySegmentoEmail({ tabela: "leads", filtros: [{ campo: "status", operador: "invalido", valor: "x" }] })).toThrow("operador");
    expect(() => validarQuerySegmentoEmail({ tabela: "__proto__", filtros: [] })).toThrow("Origem");
  });

  it("distingue filtros booleanos válidos de critérios incompletos", () => {
    expect(validarQuerySegmentoEmail({ tabela: "profiles", filtros: [{ campo: "ativo", operador: "eq", valor: false }] }).filtros[0].valor).toBe(false);
    expect(() => validarQuerySegmentoEmail({ tabela: "leads", filtros: [{ campo: "status", operador: "eq", valor: " " }] })).toThrow("Preencha");
    expect(() => validarQuerySegmentoEmail({ tabela: "leads", filtros: [{ campo: "status", operador: "in", valor: [] }] })).toThrow("pelo menos");
  });

  it("retoma a preparação depois de uma falha preservando IDs e status dos lotes anteriores", async () => {
    const filas = new Map<string, { id: string; status: string }>();
    let falharProximoLote = true;
    const upsert = vi.fn(async (linhas: Array<{ contato_email: string; status: string }>, opcoes: { onConflict: string; ignoreDuplicates: boolean }) => {
      expect(opcoes).toEqual({ onConflict: "campanha_id,contato_email", ignoreDuplicates: true });
      if (linhas.length === 1 && falharProximoLote) {
        falharProximoLote = false;
        return { error: { message: "falha ao persistir o segundo lote" } };
      }
      for (const linha of linhas) {
        if (!filas.has(linha.contato_email)) filas.set(linha.contato_email, { id: `id-${filas.size}`, status: linha.status });
      }
      return { error: null };
    });
    const cliente = { from: vi.fn(() => ({ upsert })) };
    const contatos = Array.from({ length: 501 }, (_, i) => ({ email: `p${i}@example.com`, nome: null, metadata: null }));
    await expect(enfileirarContatosSegmentoEmail(cliente, "campanha", contatos)).rejects.toThrow("preparação será retomada");
    expect(filas.size).toBe(500);
    const primeiraLinha = filas.get("p0@example.com")!;
    primeiraLinha.status = "enviado";
    await enfileirarContatosSegmentoEmail(cliente, "campanha", contatos);
    expect(filas.size).toBe(501);
    expect(filas.get("p0@example.com")).toBe(primeiraLinha);
    expect(filas.get("p0@example.com")?.status).toBe("enviado");
  });
});
