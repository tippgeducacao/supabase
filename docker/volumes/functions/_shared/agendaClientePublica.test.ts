import { describe, expect, it } from "vitest";
import {
  LIMITE_POR_DIA,
  LIMITE_POR_MINUTO,
  filtrarLinks,
  interpretarPedido,
  limparNome,
  limparTexto,
  tratarPedido,
  type Banco,
  type ComentarioPublico,
  type DadosDaAgenda,
} from "./agendaClientePublica.ts";

const TOKEN = "a".repeat(64);
const AGENDA = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";

const dados: DadosDaAgenda = {
  cliente: "Elanco (Academia Suína)",
  agenda: { projeto: "Academia Suína", inicio: "2026-01-01", termino: "2027-01-01", ultima_reuniao: null, proxima_reuniao: null, logo: null },
  secoes: [
    {
      id: "s2",
      titulo: "Segunda",
      ordem: 2,
      itens: [],
    },
    {
      id: "s1",
      titulo: "Primeira",
      ordem: 1,
      itens: [
        {
          id: "i2",
          titulo: "Segundo",
          detalhe: "",
          status: "Publicado",
          prazo: "",
          entregue_em: "10/04",
          ordem: 2,
          links: [{ label: "Instagram", url: "https://www.instagram.com/p/abc/" }],
        },
        {
          id: "i1",
          titulo: "Primeiro",
          detalhe: "d",
          status: "Em aprovação",
          prazo: "",
          entregue_em: "",
          ordem: 1,
          links: [
            { label: "Tarefa", url: "https://sistemappgvet.ppgeducacao.site/gestao-de-tarefas?gtTask=c1b9ca8d-11a7-4ad1-b66b-fdc7b2d373df" },
            { label: "x", url: "javascript:alert(1)" },
          ],
        },
      ],
    },
  ],
};

function bancoFalso(sobrescrever: Partial<Banco> = {}) {
  const gravados: { itemId: string | null; nome: string; texto: string }[] = [];
  const banco: Banco = {
    agendaDoToken: async (t) => (t === TOKEN ? AGENDA : null),
    carregarAgenda: async () => dados,
    listarComentarios: async () => [],
    contarComentariosDeClientes: async () => 0,
    inserirComentario: async (c) => {
      gravados.push({ itemId: c.itemId, nome: c.nome, texto: c.texto });
      const r: ComentarioPublico = { id: "c1", item_id: c.itemId, autor_tipo: "cliente", autor_nome: c.nome, texto: c.texto, created_at: "2026-11-03T12:00:00Z" };
      return r;
    },
    ...sobrescrever,
  };
  return { banco, gravados };
}

describe("filtrarLinks", () => {
  it("deixa só http(s) e esconde o endereço do sistema interno", () => {
    const r = filtrarLinks([
      { label: "Instagram", url: "https://www.instagram.com/p/abc/" },
      { label: "Tarefa", url: "https://sistemappgvet.ppgeducacao.site/gestao-de-tarefas?gtTask=abc" },
      { label: "Outra", url: "https://exemplo.com/gestao-de-tarefas/1" },
      { label: "Ruim", url: "javascript:alert(1)" },
      { label: "Ruim 2", url: "data:text/html,x" },
      null,
      "texto",
    ]);
    expect(r).toEqual([{ label: "Instagram", url: "https://www.instagram.com/p/abc/" }]);
  });
  it("sem lista vira lista vazia; sem rótulo vira Acesso e corta em 60", () => {
    expect(filtrarLinks(null)).toEqual([]);
    expect(filtrarLinks([{ url: "https://a.com/x" }])[0].label).toBe("Acesso");
    expect(filtrarLinks([{ label: "x".repeat(90), url: "https://a.com/x" }])[0].label).toHaveLength(60);
  });
});

describe("limparNome / limparTexto", () => {
  it("nome: junta espaços, exige 2 a 80 letras", () => {
    expect(limparNome("  Ana   Paula \n Souza ")).toBe("Ana Paula Souza");
    expect(limparNome("A")).toBeNull();
    expect(limparNome("x".repeat(81))).toBeNull();
    expect(limparNome(42)).toBeNull();
  });
  it("texto: tira caractere de controle, mantém quebra de linha, vazio e longo demais viram null", () => {
    expect(limparTexto("oi\u0000 tudo\r\nbem?\n\n\n\nfim")).toBe("oi tudo\nbem?\n\nfim");
    expect(limparTexto("   ")).toBeNull();
    expect(limparTexto("x".repeat(2001))).toBeNull();
    expect(limparTexto("x".repeat(2000))).toHaveLength(2000);
  });
  it("HTML passa como texto puro (a tela escapa; nada é interpretado aqui)", () => {
    expect(limparTexto("<img src=x onerror=alert(1)>")).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("interpretarPedido", () => {
  it("token fora do formato é pedido inválido", () => {
    expect(interpretarPedido({ acao: "ler", token: "curto" })).toEqual({ erro: "pedido_invalido" });
    expect(interpretarPedido({ acao: "ler", token: "G".repeat(64) })).toEqual({ erro: "pedido_invalido" });
    expect(interpretarPedido(null)).toEqual({ erro: "pedido_invalido" });
    expect(interpretarPedido({ acao: "apagar", token: TOKEN })).toEqual({ erro: "pedido_invalido" });
  });
  it("token em maiúsculas é aceito (copiou de e-mail)", () => {
    expect(interpretarPedido({ acao: "ler", token: TOKEN.toUpperCase() })).toEqual({ acao: "ler", token: TOKEN });
  });
  it("comentar exige nome e texto válidos e item com cara de uuid", () => {
    expect(interpretarPedido({ acao: "comentar", token: TOKEN, nome: "", texto: "oi" })).toEqual({ erro: "nome_invalido" });
    expect(interpretarPedido({ acao: "comentar", token: TOKEN, nome: "Ana", texto: " " })).toEqual({ erro: "texto_invalido" });
    expect(interpretarPedido({ acao: "comentar", token: TOKEN, nome: "Ana", texto: "oi", item_id: "nao-e-uuid" })).toEqual({ erro: "pedido_invalido" });
    expect(interpretarPedido({ acao: "comentar", token: TOKEN, nome: "Ana", texto: "oi", item_id: ITEM })).toEqual({
      acao: "comentar",
      token: TOKEN,
      nome: "Ana",
      texto: "oi",
      itemId: ITEM,
    });
  });
});

describe("tratarPedido", () => {
  it("token que não existe (ou foi revogado) = 404 sem dizer qual dos dois", async () => {
    const { banco } = bancoFalso();
    const r = await tratarPedido({ acao: "ler", token: "b".repeat(64) }, banco);
    expect(r).toEqual({ status: 404, corpo: { ok: false, motivo: "link_invalido" } });
  });

  it("ler devolve a agenda ordenada, sem links internos e sem campo de pessoa", async () => {
    const { banco } = bancoFalso();
    const r = await tratarPedido({ acao: "ler", token: TOKEN }, banco);
    expect(r.status).toBe(200);
    const c = r.corpo as { cliente: string; secoes: { id: string; itens: { id: string; links: unknown[] }[] }[] };
    expect(c.cliente).toBe("Elanco (Academia Suína)");
    expect(c.secoes.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(c.secoes[0].itens.map((i) => i.id)).toEqual(["i1", "i2"]);
    expect(c.secoes[0].itens[0].links).toEqual([]); // só tinha a tarefa do Gestor e um javascript:
    expect(c.secoes[0].itens[1].links).toHaveLength(1);
    const texto = JSON.stringify(r.corpo);
    expect(texto).not.toMatch(/created_by|updated_by|autor_id|task_id|gtTask|gestao-de-tarefas/);
  });

  it("comentar grava como cliente e devolve o comentário", async () => {
    const { banco, gravados } = bancoFalso();
    const r = await tratarPedido({ acao: "comentar", token: TOKEN, nome: "Ana", texto: "Pode aprovar o Reels 9." }, banco);
    expect(r.status).toBe(200);
    expect(gravados).toEqual([{ itemId: null, nome: "Ana", texto: "Pode aprovar o Reels 9." }]);
    expect((r.corpo.comentario as ComentarioPublico).autor_tipo).toBe("cliente");
  });

  it("freia a enxurrada: por minuto e por dia", async () => {
    const agora = new Date("2026-11-03T12:00:00Z");
    const pedido = { acao: "comentar", token: TOKEN, nome: "Ana", texto: "oi" };

    const minuto = bancoFalso({ contarComentariosDeClientes: async (_a, desde) => (new Date(desde).getTime() > agora.getTime() - 120_000 ? LIMITE_POR_MINUTO : 0) });
    expect((await tratarPedido(pedido, minuto.banco, agora)).status).toBe(429);
    expect(minuto.gravados).toHaveLength(0);

    const dia = bancoFalso({ contarComentariosDeClientes: async (_a, desde) => (new Date(desde).getTime() < agora.getTime() - 3_600_000 ? LIMITE_POR_DIA : 0) });
    expect((await tratarPedido(pedido, dia.banco, agora)).status).toBe(429);
    expect(dia.gravados).toHaveLength(0);
  });

  it("item de outra agenda (o gatilho recusa) vira pedido inválido, não erro de servidor", async () => {
    const { banco } = bancoFalso({ inserirComentario: async () => "item_invalido" });
    const r = await tratarPedido({ acao: "comentar", token: TOKEN, nome: "Ana", texto: "oi", item_id: ITEM }, banco);
    expect(r).toEqual({ status: 400, corpo: { ok: false, motivo: "pedido_invalido" } });
  });

  it("não consulta o banco de comentários quando o token não vale", async () => {
    let chamadas = 0;
    const { banco } = bancoFalso({
      contarComentariosDeClientes: async () => {
        chamadas++;
        return 0;
      },
      inserirComentario: async () => {
        chamadas++;
        return "item_invalido";
      },
    });
    await tratarPedido({ acao: "comentar", token: "c".repeat(64), nome: "Ana", texto: "oi" }, banco);
    expect(chamadas).toBe(0);
  });
});
