import { describe, expect, it, vi } from "vitest";
import { carregarHistoricoRecente, processarRodadaWebchat, type ClienteRodada } from "./rodada";
import type { WebchatToolChamada } from "./agente";

const sessao = {
  nome: "Visitante", telefone: "00000000000", curso: "Curso de teste",
  estagio: "validacao" as const, lead_id: null, produto: "pos", modo_teste: true,
};
const idSessao = "00000000-0000-4000-8000-000000000001";
const resposta = { chunks: ["resposta"], tools: [], estagio: "qualificador" as const };
const janela = { ultimo_inbound_id: 60, ultimo_mensagem_id: 60, cursor_anterior: 59 };

function bancoSimulado() {
  const mensagens = Array.from({ length: 60 }, (_, i) => ({
    id: i + 1, direcao: "inbound", conteudo: `mensagem-${i + 1}`,
  }));
  const faixas: [number, number][] = [];
  function consultar() {
    let teto = Infinity;
    let piso = -Infinity;
    let crescente = true;
    let limite = Infinity;
    let inicio = 0;
    let direcao: string | null = null;
    const consulta = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn((coluna: string, valor: string) => {
        if (coluna === "direcao") direcao = valor;
        return consulta;
      }),
      gt: vi.fn((_coluna: string, valor: number) => { piso = valor; return consulta; }),
      lte: vi.fn((_coluna: string, valor: number) => { teto = valor; return consulta; }),
      order: vi.fn((_coluna: string, opcoes: { ascending: boolean }) => { crescente = opcoes.ascending; return consulta; }),
      limit: vi.fn((valor: number) => { limite = valor; return consulta; }),
      range: vi.fn((de: number, ate: number) => {
        faixas.push([de, ate]); inicio = de; limite = ate - de + 1; return consulta;
      }),
      then(resolve: (valor: unknown) => unknown) {
        return Promise.resolve(resolve({
          data: mensagens.filter((m) => m.id > piso && m.id <= teto && (!direcao || m.direcao === direcao))
            .sort((a, b) => crescente ? a.id - b.id : b.id - a.id)
            .slice(inicio, inicio + Math.min(limite, 1000)),
          error: null,
        }));
      },
    };
    return consulta;
  }
  const rpc = vi.fn(async (nome: string, _args: Record<string, unknown>): Promise<{
    data: Record<string, unknown> | boolean | null;
    error: { message: string } | null;
  }> => {
    if (nome === "webchat_ia_reservar") return { data: { status: "reservado", ...janela }, error: null };
    if (nome === "webchat_ia_publicar") return {
      data: { status: "publicado", mensagens: [{ id: 61, conteudo: "resposta" }], ha_pendencia: false }, error: null,
    };
    return { data: true, error: null };
  });
  const cliente = { rpc, from: vi.fn(consultar) } as unknown as ClienteRodada;
  return { cliente, rpc, mensagens, faixas };
}

describe("rodada real do Webchat com fronteiras simuladas", () => {
  it("entrega as últimas 40 mensagens em ordem, incluindo a pergunta atual", async () => {
    const { cliente } = bancoSimulado();
    const historico = await carregarHistoricoRecente(cliente, idSessao, janela);
    expect(historico).toHaveLength(40);
    expect(historico[0].text).toBe("mensagem-21");
    expect(historico.at(-1)?.text).toBe("mensagem-60");
  });

  it("fixa a entrada no teto reservado e devolve a pendência que chegou durante o modelo", async () => {
    const { cliente, rpc, mensagens } = bancoSimulado();
    const responder = vi.fn(async (..._args: unknown[]) => {
      mensagens.push({ id: 61, direcao: "inbound", conteudo: "outra pergunta" });
      return resposta;
    });
    rpc.mockImplementation(async (nome) => {
      if (nome === "webchat_ia_reservar") return { data: { status: "reservado", ...janela }, error: null };
      if (nome === "webchat_ia_publicar") return { data: { status: "publicado", ha_pendencia: true }, error: null };
      return { data: true, error: null };
    });
    const resultado = await processarRodadaWebchat(cliente, idSessao, sessao, responder);
    expect(resultado.ha_pendencia).toBe(true);
    expect(responder.mock.calls[0][3]).toEqual(expect.arrayContaining([{ role: "user", text: "mensagem-60" }]));
    expect(responder.mock.calls[0][3]).not.toEqual(expect.arrayContaining([{ role: "user", text: "outra pergunta" }]));
    expect(rpc).toHaveBeenCalledWith("webchat_ia_publicar", expect.objectContaining({ p_ultimo_inbound_id: 60 }));
    const token = rpc.mock.calls[0][1].p_token;
    expect(rpc).toHaveBeenLastCalledWith("webchat_ia_liberar", { p_sessao_id: idSessao, p_token: token });
  });

  it("preserva a resposta de A e põe B como pergunta atual, mesmo que B tenha chegado antes da publicação de A", async () => {
    const { cliente, rpc, mensagens } = bancoSimulado();
    mensagens.splice(0, mensagens.length,
      { id: 1, direcao: "inbound", conteudo: "Pergunta A" },
      { id: 2, direcao: "inbound", conteudo: "Pergunta B" },
      { id: 3, direcao: "outbound", conteudo: "Resposta de A" },
      { id: 4, direcao: "inbound", conteudo: "Pergunta C depois da reserva" },
    );
    rpc.mockResolvedValueOnce({ data: {
      status: "reservado", ultimo_inbound_id: 2, ultimo_mensagem_id: 3, cursor_anterior: 1,
    }, error: null });
    const responder = vi.fn(async (..._args: unknown[]) => resposta);
    await processarRodadaWebchat(cliente, idSessao, sessao, responder);
    expect(responder.mock.calls[0][3]).toEqual([
      { role: "user", text: "Pergunta A" },
      { role: "assistant", text: "Resposta de A" },
      { role: "user", text: "Pergunta B" },
    ]);
    expect(rpc).toHaveBeenCalledWith("webchat_ia_publicar", expect.objectContaining({ p_ultimo_inbound_id: 2 }));
  });

  it.each([60, 1045])("entrega todos os %i inbounds pendentes sem duplicar os que também entraram no histórico recente", async (quantidade) => {
    const { cliente, rpc, mensagens, faixas } = bancoSimulado();
    mensagens.splice(0, mensagens.length, ...Array.from({ length: quantidade }, (_, i) => ({
      id: i + 1, direcao: "inbound", conteudo: `pendente-${i + 1}`,
    })));
    rpc.mockResolvedValueOnce({ data: {
      status: "reservado", ultimo_inbound_id: quantidade, ultimo_mensagem_id: quantidade, cursor_anterior: 0,
    }, error: null });
    const responder = vi.fn(async (..._args: unknown[]) => resposta);
    await processarRodadaWebchat(cliente, idSessao, sessao, responder);
    expect(responder.mock.calls[0][3]).toEqual(mensagens.map((m) => ({ role: "user", text: m.conteudo })));
    expect(rpc).toHaveBeenCalledWith("webchat_ia_publicar", expect.objectContaining({ p_ultimo_inbound_id: quantidade }));
    expect(faixas).toEqual(quantidade > 1000 ? [[0, 999], [1000, 1999]] : [[0, 999]]);
  });

  it.each(["ocupado", "sem_pendencia", "atendimento_humano", "bloqueada"])(
    "não chama o modelo nem publica quando a reserva retorna %s", async (status) => {
      const { cliente, rpc } = bancoSimulado();
      rpc.mockResolvedValueOnce({ data: { status }, error: null });
      const responder = vi.fn(async () => resposta);
      expect((await processarRodadaWebchat(cliente, idSessao, sessao, responder)).status).toBe(status);
      expect(responder).not.toHaveBeenCalled();
      expect(rpc).toHaveBeenCalledTimes(1);
    },
  );

  it("falha do modelo publica fallback e erro junto do cursor daquela entrada", async () => {
    const { cliente, rpc } = bancoSimulado();
    const responder = vi.fn(async () => { throw new Error("provedor indisponível"); });
    const resultado = await processarRodadaWebchat(cliente, idSessao, sessao, responder);
    expect(resultado.erro).toBe("provedor indisponível");
    expect(rpc).toHaveBeenCalledWith("webchat_ia_publicar", expect.objectContaining({
      p_ultimo_inbound_id: 60, p_erro: "provedor indisponível", p_estagio: "validacao",
      p_chunks: [expect.stringContaining("Pode mandar de novo?")],
    }));
  });

  it("rejeição após humano assumir não é convertida em sucesso", async () => {
    const { cliente, rpc } = bancoSimulado();
    rpc.mockImplementation(async (nome) => ({
      data: nome === "webchat_ia_reservar"
        ? { status: "reservado", ...janela }
        : { status: "atendimento_humano" }, error: null,
    }));
    const resultado = await processarRodadaWebchat(cliente, idSessao, sessao, async () => resposta);
    expect(resultado.status).toBe("atendimento_humano");
    expect(resultado.mensagens).toBeUndefined();
  });

  it.each(["excecao", "erro_rpc"])("falha de publicação (%s) preserva envio confirmado e libera só a própria reserva", async (falha) => {
    const { cliente, rpc } = bancoSimulado();
    const tools: WebchatToolChamada[] = [{
      nome: "levar_para_whatsapp", input: {}, mockado: false,
      efeito_whatsapp: { tipo: "transferencia", curso: "Curso de teste" },
    }];
    rpc.mockImplementation(async (nome) => {
      if (nome === "webchat_ia_publicar") {
        if (falha === "excecao") throw new Error("banco indisponível");
        return { data: null, error: { message: "banco indisponível" } };
      }
      return { data: { status: "reservado", ...janela }, error: null };
    });
    const resultado = await processarRodadaWebchat(cliente, idSessao, sessao, async () => ({ ...resposta, tools }));
    expect(resultado).toMatchObject({
      status: "falha_publicacao", ha_pendencia: true, tools,
      estagio: "qualificador", erro: expect.stringContaining("banco indisponível"),
    });
    expect(resultado.mensagens).toBeUndefined();
    expect(rpc.mock.calls.at(-1)?.[0]).toBe("webchat_ia_liberar");
    expect(rpc.mock.calls.at(-1)?.[1].p_token).toBe(rpc.mock.calls[0][1].p_token);
  });
});
