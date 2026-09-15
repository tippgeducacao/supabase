import { describe, expect, it, vi } from "vitest";
import { CABECALHO_CAPACIDADE_CAMPANHAS, consultarCapacidadesCampanhas, PROTOCOLO_CAMPANHAS_AB, respostaOpcoesCampanhas } from "./emailCampanhasCapacidades";

describe("capacidade dos workers sem iniciar campanhas", () => {
  it("exige confirmação dos dois workers por OPTIONS em endereços fixos", async () => {
    const buscar = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => respostaOpcoesCampanhas({ "Access-Control-Allow-Origin": "*" }));
    expect(await consultarCapacidadesCampanhas({ url: "https://api.test/", authorization: "Bearer sessao", apikey: "publica", buscar })).toEqual({ versao: 1, campanhas_ab: true });
    expect(buscar.mock.calls).toHaveLength(2);
    expect(buscar.mock.calls.map(c => c[0])).toEqual(["https://api.test/functions/v1/email-campaign-dispatcher", "https://api.test/functions/v1/email-send"]);
    for (const chamada of buscar.mock.calls) expect(chamada[1]).toMatchObject({ method: "OPTIONS", redirect: "error", cache: "no-store" });
  });
  it.each(["antigo", "somente-dispatcher", "somente-envio", "protocolo-diferente", "erro-http", "rede"])("bloqueia %s mesmo com HTTP aparentemente disponível", async cenario => {
    const buscar = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      if (cenario === "rede") throw new Error("Falha privada da conexão");
      const novo = cenario === "somente-dispatcher" && String(url).endsWith("dispatcher") || cenario === "somente-envio" && String(url).endsWith("email-send");
      return new Response("ok", { status: cenario === "erro-http" ? 503 : 200, headers: {
        [CABECALHO_CAPACIDADE_CAMPANHAS]: novo || cenario === "erro-http" ? PROTOCOLO_CAMPANHAS_AB : "outro",
      } });
    });
    expect(await consultarCapacidadesCampanhas({ url: "https://api.test", authorization: "Bearer sessao", buscar })).toEqual({ versao: 1, campanhas_ab: false });
    for (const chamada of buscar.mock.calls) expect(chamada[1]?.method).toBe("OPTIONS");
  });
  it("limita cada sondagem a cinco segundos e converte expiração em indisponível", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => { expect(ms).toBe(5000); return AbortSignal.abort(); });
    try {
      const buscar = vi.fn(async (_url: unknown, init?: RequestInit) => { init?.signal?.throwIfAborted(); return respostaOpcoesCampanhas({}); });
      expect((await consultarCapacidadesCampanhas({ url: "https://api.test", authorization: "Bearer sessao", buscar })).campanhas_ab).toBe(false);
      expect(timeout).toHaveBeenCalledTimes(2);
    } finally { timeout.mockRestore(); }
  });
  it("retorna apenas o protocolo público, com cache desativado", async () => {
    const resposta = respostaOpcoesCampanhas({ "Access-Control-Allow-Origin": "*" });
    expect(resposta.headers.get(CABECALHO_CAPACIDADE_CAMPANHAS)).toBe(PROTOCOLO_CAMPANHAS_AB);
    expect(resposta.headers.get("Cache-Control")).toBe("no-store");
    expect(await resposta.text()).toBe("ok");
  });
});
