import { describe, expect, it } from "vitest";
import {
  MAX_BYTES_DO_PEDIDO,
  TOKEN_RE,
  criarFreio,
  excedeContentLength,
  interpretarPedido,
  lerTextoComTeto,
  linkDeSala,
  montarEvento,
  motivoConhecido,
  respostaCarregar,
  reuniaoPublica,
} from "./cobAgendaPublica.ts";

const TOKEN = "0123456789abcdef0123456789abcdef";
const HORARIO = "11111111-1111-4111-8111-111111111111";
const INTEGRACAO = "25d6a6fa-5833-4d6b-8df0-fc9239a8c179";

describe("interpretarPedido", () => {
  it("carregar é o padrão", () => {
    expect(interpretarPedido({ token: TOKEN })).toEqual({ acao: "carregar", token: TOKEN });
  });

  it("marcar exige o id do horário", () => {
    expect(interpretarPedido({ acao: "marcar", token: TOKEN, horario_id: HORARIO }))
      .toEqual({ acao: "marcar", token: TOKEN, horarioId: HORARIO });
    expect(interpretarPedido({ acao: "marcar", token: TOKEN })).toEqual({ erro: "pedido_invalido" });
    expect(interpretarPedido({ acao: "marcar", token: TOKEN, horario_id: "1; drop table" })).toEqual({ erro: "pedido_invalido" });
  });

  it("token fora do formato é link inválido (nem chega ao banco)", () => {
    expect(interpretarPedido({ token: "abc" })).toEqual({ erro: "link_invalido" });
    expect(interpretarPedido({ token: TOKEN.toUpperCase() })).toEqual({ erro: "link_invalido" });
    expect(interpretarPedido({ token: `${TOKEN}0` })).toEqual({ erro: "link_invalido" });
    expect(interpretarPedido({ token: 123 })).toEqual({ erro: "link_invalido" });
  });

  it("ação desconhecida e corpo que não é objeto", () => {
    expect(interpretarPedido({ acao: "apagar", token: TOKEN })).toEqual({ erro: "pedido_invalido" });
    expect(interpretarPedido(null)).toEqual({ erro: "pedido_invalido" });
    expect(interpretarPedido([TOKEN])).toEqual({ erro: "pedido_invalido" });
  });

  it("o token do banco (uuid sem hífens) passa no formato", () => {
    expect(TOKEN_RE.test("4e781303b284ed81f4ab2f4905d1c99e")).toBe(true);
  });
});

describe("respostaCarregar", () => {
  it("só repassa o que a página precisa", () => {
    const r = respostaCarregar({
      ok: true,
      primeiro_nome: "Maria",
      telefone: "5546999999999",
      reuniao: null,
      horarios: [
        { id: HORARIO, inicio: "2026-11-13T12:00:00+00:00", fim: "2026-11-13T12:30:00+00:00", extra: "x" },
        { id: "invalido", inicio: "2026-11-13T12:30:00+00:00", fim: "2026-11-13T13:00:00+00:00" },
      ],
    });
    expect(r).toEqual({
      ok: true,
      primeiro_nome: "Maria",
      reuniao: null,
      horarios: [{ id: HORARIO, inicio: "2026-11-13T12:00:00+00:00", fim: "2026-11-13T12:30:00+00:00" }],
    });
    expect(JSON.stringify(r)).not.toContain("5546");
  });

  it("erro do banco vira motivo conhecido", () => {
    expect(respostaCarregar({ ok: false, motivo: "link_invalido" })).toEqual({ ok: false, motivo: "link_invalido" });
    expect(respostaCarregar({ ok: false, motivo: "erro interno com detalhe" })).toEqual({ ok: false, motivo: "falhou" });
    expect(respostaCarregar(null)).toEqual({ ok: false, motivo: "falhou" });
  });

  it("a reunião marcada vem com o link só se for https", () => {
    const r = respostaCarregar({
      ok: true,
      primeiro_nome: "Ana",
      reuniao: { id: "x", inicio: "2026-11-13T12:00:00+00:00", fim: "2026-11-13T12:30:00+00:00", status: "marcada", link: "javascript:alert(1)", passou: false },
      horarios: [],
    });
    expect(r.ok && r.reuniao).toEqual({
      inicio: "2026-11-13T12:00:00+00:00", fim: "2026-11-13T12:30:00+00:00", status: "marcada", link: null, passou: false,
    });
  });
});

describe("reuniaoPublica e linkDeSala", () => {
  it("aceita o Meet e recusa o resto", () => {
    expect(linkDeSala(" https://meet.google.com/abc-defg-hij ")).toBe("https://meet.google.com/abc-defg-hij");
    expect(linkDeSala("http://meet.google.com/abc")).toBeNull();
    expect(linkDeSala("https://meet.google.com/a b")).toBeNull();
    expect(linkDeSala(null)).toBeNull();
  });

  it("sem datas válidas não há reunião", () => {
    expect(reuniaoPublica({ inicio: "ontem", fim: "hoje" })).toBeNull();
    expect(reuniaoPublica("x")).toBeNull();
  });
});

describe("motivoConhecido", () => {
  it("mantém os motivos que a página explica", () => {
    expect(motivoConhecido("horario_indisponivel")).toBe("horario_indisponivel");
    expect(motivoConhecido("muitas_tentativas")).toBe("muitas_tentativas");
    expect(motivoConhecido("sem_permissao")).toBe("falhou");
  });
});

describe("montarEvento", () => {
  const reuniao = { inicio: "2026-11-13T17:30:00+00:00", fim: "2026-11-13T18:00:00+00:00" };

  it("agenda GLOBAL: só o primeiro nome, sem telefone, sem nome completo, sem a fase", () => {
    const e = montarEvento({
      integration_id: INTEGRACAO,
      convidados: ["rafaeldacostacenio@gmail.com", "nao-e-email", 3],
      primeiro_nome: "Maria",
      // Campos que não devem vazar mesmo se o banco mandar por engano.
      nome: "Maria da Silva", telefone: "5546999999999",
    } as never, reuniao);
    expect(e).toMatchObject({
      integration_id: INTEGRACAO,
      title: "Renegociação com Maria",
      starts_at: reuniao.inicio,
      ends_at: reuniao.fim,
      attendees: ["rafaeldacostacenio@gmail.com"],
      create_meet: true,
    });
    expect(e!.description).toBe(
      "Quem conduz: entre na sala logado no programappgvet@gmail.com para conseguir admitir o aluno.\nDetalhes no SAC - Cobrança.",
    );
    const tudo = JSON.stringify(e);
    expect(tudo).not.toContain("5546");
    expect(tudo).not.toContain("Silva");
    expect(tudo).not.toMatch(/fase/i);
  });

  it("nome inteiro no lugar do primeiro vira só a primeira palavra", () => {
    expect(montarEvento({ integration_id: INTEGRACAO, primeiro_nome: "  Ana   Paula Souza " }, reuniao)!.title)
      .toBe("Renegociação com Ana");
  });

  it("sem agenda configurada não cria evento", () => {
    expect(montarEvento({ integration_id: null }, reuniao)).toBeNull();
    expect(montarEvento(null, reuniao)).toBeNull();
    expect(montarEvento({ integration_id: INTEGRACAO }, { inicio: "x", fim: "y" })).toBeNull();
  });

  it("sem nome o título é só Renegociação", () => {
    expect(montarEvento({ integration_id: INTEGRACAO }, reuniao)!.title).toBe("Renegociação");
  });
});

describe("corpo com teto", () => {
  it("Content-Length acima de 2 kB é recusado antes de ler", () => {
    expect(MAX_BYTES_DO_PEDIDO).toBe(2048);
    expect(excedeContentLength("2049")).toBe(true);
    expect(excedeContentLength("2048")).toBe(false);
    expect(excedeContentLength(null)).toBe(false);
    expect(excedeContentLength("abc")).toBe(false);
  });

  it("lê até o teto e devolve null quando passa (mesmo sem Content-Length)", async () => {
    const pequeno = JSON.stringify({ acao: "carregar", token: TOKEN });
    expect(await lerTextoComTeto(new Response(pequeno).body)).toBe(pequeno);
    expect(await lerTextoComTeto(new Response("x".repeat(2049)).body)).toBeNull();
    expect(await lerTextoComTeto(new Response("ç".repeat(1100)).body)).toBeNull(); // 2.200 bytes em UTF-8
    expect(await lerTextoComTeto(null)).toBe("");
  });
});

describe("criarFreio", () => {
  it("deixa 8 marcações por IP na janela e libera depois", () => {
    let t = 0;
    const pode = criarFreio(8, 1_000, () => t);
    for (let i = 0; i < 8; i++) expect(pode("1.1.1.1")).toBe(true);
    expect(pode("1.1.1.1")).toBe(false);
    expect(pode("2.2.2.2")).toBe(true);
    t = 1_001;
    expect(pode("1.1.1.1")).toBe(true);
  });
});
