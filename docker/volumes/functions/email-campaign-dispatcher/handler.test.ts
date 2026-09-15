import { describe, expect, it, vi } from "vitest";
import { montarPedidoCampanha, normalizarContatos, processarCampanha, resolverSegmento, type Campanha, type ClienteCampanhas } from "./handler.ts";

const campanha: Campanha = { id: "campanha-1", segmento_id: "segmento", template_id: "modelo-a", template_b_id: "modelo-b", remetente_id: "remetente" };
const envio = (id: string, variante: "A" | "B" = "A") => ({ id, campanha_id: campanha.id, contato_email: `${id}@example.invalid`, contato_nome: "Contato", contato_metadata: null, template_id: variante === "B" ? "modelo-b" : "modelo-a", variante, status: "pendente" });

function ambiente(opcoes: { suprimidos?: string[]; erroSupressao?: boolean; reserva?: boolean[]; preparacaoErro?: boolean } = {}) {
  const tabelas: Record<string, Array<Record<string, unknown>>> = {
    email_campanhas: [{ id: campanha.id, fila_preparada_em: "2026-09-14", status: "enviando", iniciada_em: "2026-09-14" }],
    email_campanhas_envios: [envio("um"), envio("dois", "B")],
    email_remetentes: [{ id: "remetente", provider: "resend", ativo: true }],
    email_supressoes: (opcoes.suprimidos ?? []).map(email => ({ email })),
    email_segmentos: [{ id: "segmento", tipo: "estatico", contatos_estaticos: [{ email: "um@example.invalid" }] }],
  };
  const chamadas: string[] = [];
  let indiceReserva = 0;
  const cliente: ClienteCampanhas = {
    rpc: async nome => {
      chamadas.push(nome);
      return { data: nome === "email_campanha_reservar" ? (opcoes.reserva?.[indiceReserva++] ?? true) : true,
        error: nome === "email_campanha_preparar" && opcoes.preparacaoErro ? { message: "Falhou a transação" } : null };
    },
    from: nome => {
      const filtros: Array<(row: Record<string, unknown>) => boolean> = [];
      let patch: Record<string, unknown> | undefined;
      let limite = 1000;
      const resultado = () => {
        const rows = (tabelas[nome] ?? []).filter(r => filtros.every(f => f(r))).slice(0, limite);
        if (patch) for (const row of rows) Object.assign(row, patch);
        return { data: rows, error: nome === "email_supressoes" && opcoes.erroSupressao ? { message: "offline" } : null };
      };
      const q = {
        select: () => q, order: () => q, update: (valor: Record<string, unknown>) => { patch = valor; return q; },
        eq: (coluna: string, valor: unknown) => { filtros.push(row => row[coluna] === valor); return q; },
        in: (coluna: string, valores: unknown[]) => { filtros.push(row => valores.includes(row[coluna])); return q; },
        limit: (n: number) => { limite = n; return q; },
        single: async () => { const res = resultado(); return { ...res, data: res.data[0] }; },
        then: (resolver: (valor: ReturnType<typeof resultado>) => unknown) => Promise.resolve(resultado()).then(resolver),
      };
      return q;
    },
  };
  const enviar = vi.fn<typeof fetch>(async () => Response.json({ ok: true, log_id: "log-confirmado" }));
  return { cliente, tabelas, chamadas, enviar, deps: { url: "https://example.invalid", chave: "teste", enviar, esperar: async () => {} } };
}

describe("público e pedido de campanha A/B", () => {
  it("normaliza e deduplica destinatários sem perder os dados do primeiro registro", () => {
    expect(normalizarContatos([{ email: " Pessoa@Example.invalid ", nome: "Primeiro", metadata: null }, { email: "pessoa@example.invalid", nome: "Duplicado", metadata: null }]))
      .toEqual([{ email: "pessoa@example.invalid", nome: "Primeiro", metadata: null }]);
  });
  it("remove endereços inválidos como a prévia compartilhada do segmento", () => {
    expect(normalizarContatos([{ email: "inválido", nome: null, metadata: null }])).toEqual([]);
  });
  it("pagina além de mil contatos e lê o nome real de profiles", async () => {
    const paginas: number[] = [];
    const colunas: string[] = [];
    const cliente = { rpc: vi.fn(), from: () => {
      const q = { select: (campos: string) => { colunas.push(campos); return q; }, order: () => q, not: () => q,
        range: async (de: number) => { paginas.push(de); return { data: Array.from({ length: de === 0 ? 1000 : 1 }, (_, i) => ({ email: `pessoa${de + i}@example.invalid`, name: `Pessoa ${de + i}` })), error: null }; } };
      return q;
    } };
    const contatos = await resolverSegmento(cliente, { tipo: "dinamico", query_dinamica: { tabela: "profiles", filtros: [] } });
    expect(contatos).toHaveLength(1001);
    expect(contatos[1000].nome).toBe("Pessoa 1000");
    expect(paginas).toEqual([0, 1000]);
    expect(colunas[0]).toBe("email,name");
  });
  it("falha de leitura não é interpretada como segmento vazio", async () => {
    const cliente = { rpc: vi.fn(), from: () => { const q = { select: () => q, order: () => q, not: () => q, range: async () => ({ data: null, error: {} }) }; return q; } };
    await expect(resolverSegmento(cliente, { tipo: "dinamico", query_dinamica: { tabela: "profiles", filtros: [] } })).rejects.toThrow("contatos do segmento");
  });
  it("usa a variante persistida e conserva exatamente a mesma chave em retries", () => {
    const pedido = montarPedidoCampanha(campanha, envio("dois", "B"));
    expect(pedido).toMatchObject({ template_id: "modelo-b", campanha_envio_id: "dois", idempotencia_key: "campanha:dois" });
    expect(montarPedidoCampanha(campanha, envio("dois", "B"))).toEqual(pedido);
    expect(() => montarPedidoCampanha(campanha, { ...envio("dois"), variante: null })).toThrow("sem variante");
  });
});

describe("worker A/B sem disparos reais", () => {
  it("não processa uma campanha reservada por outro worker", async () => {
    const a = ambiente({ reserva: [false] });
    await processarCampanha(a.cliente, campanha, a.deps);
    expect(a.enviar).not.toHaveBeenCalled();
    expect(a.chamadas).toEqual(["email_campanha_reservar"]);
  });
  it("envia o modelo correto por variante e preserva o vínculo do log", async () => {
    const a = ambiente();
    await processarCampanha(a.cliente, campanha, a.deps);
    expect(a.enviar.mock.calls.map(c => JSON.parse(String(c[1]?.body)).template_id)).toEqual(["modelo-a", "modelo-b"]);
    expect(a.tabelas.email_campanhas_envios.every(e => e.status === "enviado" && e.email_enviado_id === "log-confirmado")).toBe(true);
    expect(a.chamadas).toContain("email_campanha_recontar");
    expect(a.chamadas.at(-1)).toBe("email_campanha_liberar");
  });
  it("supressão em lote impede a chamada e não marca enviado", async () => {
    const a = ambiente({ suprimidos: ["um@example.invalid"] });
    await processarCampanha(a.cliente, campanha, a.deps);
    expect(a.enviar).toHaveBeenCalledTimes(1);
    expect(a.tabelas.email_campanhas_envios[0].status).toBe("pulado");
  });
  it("falha de consulta da supressão impede todo o lote e libera a reserva", async () => {
    const a = ambiente({ erroSupressao: true });
    await expect(processarCampanha(a.cliente, campanha, a.deps)).rejects.toThrow("bloqueios");
    expect(a.enviar).not.toHaveBeenCalled();
    expect(a.chamadas.at(-1)).toBe("email_campanha_liberar");
  });
  it("supressão na conferência final também não conta como envio", async () => {
    const a = ambiente(); a.enviar.mockImplementation(async () => Response.json({ ok: true, suprimido: true }));
    await processarCampanha(a.cliente, campanha, a.deps);
    expect(a.tabelas.email_campanhas_envios.every(e => e.status === "pulado" && !e.enviado_em)).toBe(true);
  });
  it("duplicado confirmado usa o ID existente e duplicado incerto continua falho", async () => {
    const a = ambiente(); a.enviar.mockResolvedValueOnce(Response.json({ ok: true, duplicado: true, id: "existente" }))
      .mockResolvedValueOnce(Response.json({ ok: false, duplicado: true, log_id: "incerto", error: "Não confirmado" }, { status: 409 }));
    await processarCampanha(a.cliente, campanha, a.deps);
    expect(a.tabelas.email_campanhas_envios[0]).toMatchObject({ status: "enviado", email_enviado_id: "existente" });
    expect(a.tabelas.email_campanhas_envios[1]).toMatchObject({ status: "falhou", email_enviado_id: "incerto" });
    expect(a.enviar).toHaveBeenCalledTimes(2);
  });
  it("pausa entre destinatários interrompe o restante", async () => {
    const a = ambiente({ reserva: [true, true, false] });
    await processarCampanha(a.cliente, campanha, a.deps);
    expect(a.enviar).toHaveBeenCalledTimes(1);
    expect(a.tabelas.email_campanhas_envios[1].status).toBe("pendente");
  });
  it("falha de preparação não dispara uma fila parcial", async () => {
    const a = ambiente({ preparacaoErro: true }); a.tabelas.email_campanhas[0].fila_preparada_em = null;
    await expect(processarCampanha(a.cliente, campanha, a.deps)).rejects.toThrow("transação");
    expect(a.enviar).not.toHaveBeenCalled();
  });
  it("falha de rede não repete automaticamente nem muda provedor", async () => {
    const a = ambiente(); a.enviar.mockRejectedValue(new Error("timeout"));
    await processarCampanha(a.cliente, campanha, a.deps);
    expect(a.enviar).toHaveBeenCalledTimes(2);
    expect(a.tabelas.email_campanhas_envios.every(e => e.status === "falhou")).toBe(true);
  });
});
