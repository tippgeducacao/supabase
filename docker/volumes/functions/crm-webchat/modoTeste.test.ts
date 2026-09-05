import { describe, expect, it } from "vitest";
import { resultadoToolMockado, toolDeveSerMockada } from "./modoTeste";
import { type EstadoElegibilidade, VERSAO_REGRA_ELEGIBILIDADE } from '../crm-agente-sdr/elegibilidadeAgendamento';

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

describe('confirmação simulada exige elegibilidade produzida pela análise', () => {
  const confirmado: EstadoElegibilidade = {
    curso: 'Sanidade Avícola', decisao: 'aprovado', motivo: 'APROVADO',
    regra_versao: VERSAO_REGRA_ELEGIBILIDADE,
  };
  const tool = { id: 'confirmar-teste', name: 'confirmar_agendamento', input: { curso_escolhido: 'Sanidade Avícola' } };

  it.each([
    { caso: 'sem análise', estado: undefined },
    { caso: 'reprovado', estado: { ...confirmado, decisao: 'reprovado' as const } },
    { caso: 'pendente', estado: { ...confirmado, decisao: 'pendente' as const } },
    { caso: 'outro curso', estado: { ...confirmado, curso: 'Cannabis Medicinal' } },
    { caso: 'regra antiga', estado: { ...confirmado, regra_versao: 'regra-antiga' } },
  ])('recusa $caso', ({ estado }) => {
    const resposta = resultadoToolMockado(tool, 'Sanidade Avícola', estado);
    expect(resposta.output).toBe('ELEGIBILIDADE_NAO_APROVADA');
    expect(resposta.agendamento_id).toBeNull();
    expect(resposta.resultado).not.toContain('Agendamento confirmado');
  });

  it('aprovação válida produz somente o resultado de confirmação mockada', () => {
    const resposta = resultadoToolMockado(tool, 'Sanidade Avícola', confirmado);
    expect(resposta.id).toBe('confirmar-teste');
    expect(resposta.resultado).toContain('Agendamento confirmado. id: teste-seguro');
    expect(resposta.agendamento_id).toBeUndefined();
  });

  it('aceita variação de caixa, acento e prefixo do mesmo curso no harness', () => {
    const resposta = resultadoToolMockado(tool, '', { ...confirmado, curso: 'PÓS | SANIDADE AVICOLA' });
    expect(resposta.resultado).toContain('Agendamento confirmado');
  });
});
