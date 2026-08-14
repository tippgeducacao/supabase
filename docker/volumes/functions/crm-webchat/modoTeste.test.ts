import { describe, expect, it } from "vitest";
import { resultadoToolMockado, toolDeveSerMockada } from "./modoTeste";

describe("isolamento de tools do harness do webchat", () => {
  it.each([
    "envia_informacoes",
    "confirmar_agendamento",
    "remarcar_agendamento",
    "pausa_ia",
    "agendar_retorno",
    "temporizador_proxima_turma",
    "atualizar_dados_lead",
  ])("mocka a tool com efeito %s", (nome) => {
    expect(toolDeveSerMockada(true, nome)).toBe(true);
  });

  it("bloqueia por padrão uma tool nova/desconhecida", () => {
    expect(toolDeveSerMockada(true, "nova_tool_perigosa")).toBe(true);
    const resultado = resultadoToolMockado({ id: "tool-1", name: "nova_tool_perigosa" }, "");
    expect(resultado.resultado).toContain("bloqueada no ambiente seguro");
  });

  it("mantém somente as consultas classificadas no caminho real", () => {
    expect(toolDeveSerMockada(true, "consulta_disponibilidade")).toBe(false);
    expect(toolDeveSerMockada(true, "consulta_objecoes")).toBe(false);
    expect(toolDeveSerMockada(true, "consulta_pos_disponiveis")).toBe(false);
    expect(toolDeveSerMockada(true, "verificar_compatibilidade_curso")).toBe(false);
  });

  it("não altera o caminho de produção", () => {
    expect(toolDeveSerMockada(false, "confirmar_agendamento")).toBe(false);
  });
});
