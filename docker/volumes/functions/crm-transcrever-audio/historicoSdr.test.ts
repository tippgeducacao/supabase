import { describe, expect, it, vi } from "vitest";
import {
  acessoWorkerAutorizado,
  FILA_ALUNO,
  processarFilaAudio,
  processarHistoricoSdr,
  type RpcHistorico,
  type TrabalhoAudio,
} from "./historicoSdr";

const trabalho = (id: string, cache: string | null = null): TrabalhoAudio => ({
  mensagem_id: id, tentativa: 2, audio_url: `https://storage.test/${id}.ogg`, mime_type: "audio/ogg", transcricao_cache: cache,
});

describe("worker de memória SDR", () => {
  it("exige POST e segredo dedicado, inclusive quando existe JWT de usuário", () => {
    expect(acessoWorkerAutorizado("POST", "segredo-worker", "segredo-worker")).toBe(true);
    expect(acessoWorkerAutorizado("GET", "segredo-worker", "segredo-worker")).toBe(false);
    expect(acessoWorkerAutorizado("POST", null, "segredo-worker")).toBe(false);
    expect(acessoWorkerAutorizado("POST", "JWT-do-usuario", "segredo-worker")).toBe(false);
    expect(acessoWorkerAutorizado("POST", "", "")).toBe(false);
    expect(acessoWorkerAutorizado("POST", "qualquer", null)).toBe(false);
  });

  it("reutiliza cache e executa somente claim/concluir, sem download ou envio", async () => {
    const rpc = vi.fn<RpcHistorico>()
      .mockResolvedValueOnce({ data: [trabalho("um", "  Combinamos sexta.  ")], error: null })
      .mockResolvedValue({ data: true, error: null });
    const transcrever = vi.fn();
    expect(await processarHistoricoSdr({ rpc, transcrever })).toEqual({ reivindicados: 1, concluidos: 1, falhas: 0, obsoletos: 0, erros_registro: 0 });
    expect(transcrever).not.toHaveBeenCalled();
    expect(rpc.mock.calls).toEqual([
      ["crm_sdr_historico_audio_reivindicar", { p_limite: 3 }],
      ["crm_sdr_historico_audio_concluir", { p_mensagem_id: "um", p_tentativa: 2, p_transcricao: "Combinamos sexta." }],
    ]);
  });

  it("processa três jobs em paralelo e aguarda todos antes de responder", async () => {
    const rpc = vi.fn<RpcHistorico>()
      .mockResolvedValueOnce({ data: [trabalho("um"), trabalho("dois"), trabalho("tres")], error: null })
      .mockResolvedValue({ data: true, error: null });
    const liberar: Array<(valor: string) => void> = [];
    const transcrever = vi.fn(() => new Promise<string>((resolve) => liberar.push(resolve)));
    let terminou = false;
    const processamento = processarHistoricoSdr({ rpc, transcrever }).then((resultado) => { terminou = true; return resultado; });
    await Promise.resolve();
    expect(transcrever).toHaveBeenCalledTimes(3);
    expect(terminou).toBe(false);
    liberar[1]("Segundo áudio.");
    liberar[0]("Primeiro áudio.");
    await Promise.resolve();
    expect(terminou).toBe(false);
    liberar[2]("Terceiro áudio.");
    expect(await processamento).toEqual({ reivindicados: 3, concluidos: 3, falhas: 0, obsoletos: 0, erros_registro: 0 });
    expect(rpc.mock.calls.every(([nome]) => ["crm_sdr_historico_audio_reivindicar", "crm_sdr_historico_audio_concluir"].includes(nome))).toBe(true);
  });

  it("falha de um áudio não impede outro, e o erro persistido não expõe conteúdo", async () => {
    const rpc = vi.fn<RpcHistorico>()
      .mockResolvedValueOnce({ data: [trabalho("ruim"), trabalho("bom", "Resposta salva.")], error: null })
      .mockResolvedValue({ data: true, error: null });
    const transcrever = vi.fn().mockRejectedValue(new Error("token=segredo https://privado.test fala do vendedor"));
    expect(await processarHistoricoSdr({ rpc, transcrever })).toEqual({ reivindicados: 2, concluidos: 1, falhas: 1, obsoletos: 0, erros_registro: 0 });
    expect(rpc).toHaveBeenCalledWith("crm_sdr_historico_audio_falhar", {
      p_mensagem_id: "ruim", p_tentativa: 2, p_erro: "TRANSCRICAO_FALHOU",
    });
  });

  it("não informa sucesso quando concluir falha no banco", async () => {
    const rpc = vi.fn<RpcHistorico>()
      .mockResolvedValueOnce({ data: [trabalho("um", "Resposta.")], error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "banco indisponível com dado sensível" } })
      .mockResolvedValueOnce({ data: true, error: null });
    expect(await processarHistoricoSdr({ rpc, transcrever: vi.fn() })).toEqual({ reivindicados: 1, concluidos: 0, falhas: 1, obsoletos: 0, erros_registro: 0 });
    expect(rpc).toHaveBeenLastCalledWith("crm_sdr_historico_audio_falhar", {
      p_mensagem_id: "um", p_tentativa: 2, p_erro: "FALHA_CONCLUIR",
    });
  });

  it("expõe falha de registro no resumo sem vazar erro do banco", async () => {
    const rpc = vi.fn<RpcHistorico>()
      .mockResolvedValueOnce({ data: [trabalho("um")], error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "credencial=privada" } });
    expect(await processarHistoricoSdr({ rpc, transcrever: vi.fn().mockRejectedValue(new Error("falhou")) }))
      .toEqual({ reivindicados: 1, concluidos: 0, falhas: 0, obsoletos: 0, erros_registro: 1 });
  });

  it("para antes de transcrever se a reivindicação falhar", async () => {
    const rpc = vi.fn<RpcHistorico>().mockResolvedValue({ data: null, error: { message: "erro privado" } });
    const transcrever = vi.fn();
    await expect(processarHistoricoSdr({ rpc, transcrever })).rejects.toMatchObject({ codigo: "FALHA_REIVINDICAR" });
    expect(transcrever).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("não reabre job concluído pelo botão manual durante a transcrição", async () => {
    const rpc = vi.fn<RpcHistorico>()
      .mockResolvedValueOnce({ data: [trabalho("um")], error: null })
      .mockResolvedValueOnce({ data: false, error: null });
    expect(await processarHistoricoSdr({ rpc, transcrever: vi.fn().mockResolvedValue("Transcrição.") }))
      .toEqual({ reivindicados: 1, concluidos: 0, falhas: 0, obsoletos: 1, erros_registro: 0 });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  /**
   * A fila do ALUNO (12/09/2026) é a mesma mecânica com outro nome de função. O guarda existe
   * para que ninguém "simplifique" o worker de volta para os nomes cravados do SDR: a fila do
   * SDR é de saída humana, e a trigger dela apaga qualquer linha que não seja isso.
   */
  it("a fila do aluno usa as funções dela, e nunca as do SDR", async () => {
    const rpc = vi.fn<RpcHistorico>()
      .mockResolvedValueOnce({ data: [trabalho("um")], error: null })
      .mockResolvedValue({ data: true, error: null });
    const resultado = await processarFilaAudio({
      rpc, fila: FILA_ALUNO, transcrever: vi.fn().mockResolvedValue("  Oi, é sobre o cronograma.  "),
    });
    expect(resultado).toEqual({ reivindicados: 1, concluidos: 1, falhas: 0, obsoletos: 0, erros_registro: 0 });
    expect(rpc.mock.calls).toEqual([
      ["onb_agente_audio_reivindicar", { p_limite: 3 }],
      ["onb_agente_audio_concluir", { p_mensagem_id: "um", p_tentativa: 2, p_transcricao: "Oi, é sobre o cronograma." }],
    ]);
    expect(rpc.mock.calls.some(([nome]) => String(nome).includes("sdr"))).toBe(false);
  });

  it("erro de lease antigo é descartado quando falhar devolve false", async () => {
    const rpc = vi.fn<RpcHistorico>()
      .mockResolvedValueOnce({ data: [trabalho("um")], error: null })
      .mockResolvedValueOnce({ data: false, error: null });
    expect(await processarHistoricoSdr({ rpc, transcrever: vi.fn().mockRejectedValue(new Error("timeout")) }))
      .toEqual({ reivindicados: 1, concluidos: 0, falhas: 0, obsoletos: 1, erros_registro: 0 });
  });
});
