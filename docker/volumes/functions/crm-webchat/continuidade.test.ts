import { describe, expect, it, vi } from "vitest";
import { semearHistoricoWhatsApp } from "./continuidade";

describe("continuidade confirmada no WhatsApp", () => {
  it.each(["cronograma", "transferencia"] as const)("encaminha efeito %s para a transação", async (tipo) => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    await semearHistoricoWhatsApp({ rpc }, "sessao", { tipo, curso: "Clínica bovina" });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("webchat_semear_historico_whatsapp", {
      p_sessao_id: "sessao", p_tipo: tipo, p_curso: "Clínica bovina",
    });
  });

  it("aceita transferência antes de conhecer o curso", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    await semearHistoricoWhatsApp({ rpc }, "sessao", { tipo: "transferencia", curso: null });
    expect(rpc.mock.calls[0][1].p_curso).toBeNull();
  });

  it("expõe o erro ao chamador sem reexecutar o envio", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: { message: "histórico indisponível" } });
    await expect(semearHistoricoWhatsApp({ rpc }, "sessao", { tipo: "cronograma", curso: "Clínica" }))
      .rejects.toThrow("semearHistoricoWhatsApp: histórico indisponível");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
