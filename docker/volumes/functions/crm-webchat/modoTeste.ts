import {
  type EstadoElegibilidade, normalizarCursoTeste, recusaElegibilidade, VERSAO_REGRA_ELEGIBILIDADE,
} from '../crm-agente-sdr/elegibilidadeAgendamento.ts';

/**
 * Allowlist deliberadamente pequena: tool nova nasce bloqueada no harness até ser
 * classificada. As ferramentas abaixo podem consultar serviços reais, mas recebem um
 * telefone sintético que nunca corresponde a lead de produção.
 */
export const TOOLS_REAIS_NO_TESTE = new Set([
  "consulta_disponibilidade",
  "consulta_objecoes",
  "consulta_pos_disponiveis",
  "verificar_compatibilidade_curso",
]);

export function toolDeveSerMockada(modoTeste: boolean, nome: string): boolean {
  return modoTeste && !TOOLS_REAIS_NO_TESTE.has(nome);
}
export function resultadoToolMockado(
  tu: { id: string; name?: string; input?: Record<string, unknown> },
  cursoLimpo: string,
  elegibilidade?: EstadoElegibilidade,
): Record<string, unknown> {
  const id = tu.id;
  const nome = String(tu.name ?? "");
  const cursoEscolhido = String(tu.input?.curso_escolhido ?? "").trim() || cursoLimpo || "curso escolhido";
  switch (nome) {
    case "envia_informacoes":
      return { resultado: `Cronograma de ${cursoEscolhido} enviado com sucesso no WhatsApp informado.`, id };
    case "confirmar_agendamento":
      // Simular o envio não pode simular uma aprovação que a análise não produziu.
      if (elegibilidade?.decisao !== 'aprovado'
        || elegibilidade.regra_versao !== VERSAO_REGRA_ELEGIBILIDADE
        || normalizarCursoTeste(elegibilidade.curso) !== normalizarCursoTeste(cursoEscolhido)) {
        return recusaElegibilidade(id, elegibilidade?.motivo ?? 'elegibilidade_ausente');
      }
      return {
        resultado: "Agendamento confirmado. id: teste-seguro, data: horário escolhido pelo lead, monitor: monitor de teste, link: https://meet.google.com/teste-seguro",
        id,
      };
    case "remarcar_agendamento":
      return { resultado: "Agendamento remarcado com sucesso para o horário escolhido pelo lead.", id };
    case "pausa_ia":
      return { resultado: "Atendimento pausado com sucesso.", id };
    case "agendar_retorno":
      return { resultado: "Retorno agendado com sucesso para o momento solicitado.", id };
    case "temporizador_proxima_turma":
      return { resultado: "Interesse na próxima turma registrado com sucesso.", id };
    case "atualizar_dados_lead":
      return { resultado: "Dados do lead atualizados com sucesso.", id };
    case "levar_para_whatsapp":
      // Mock explícito, e não o `default`: no harness a diferença entre "ação bloqueada"
      // e "mensagem enviada" muda o que o modelo escreve depois — e é justamente a fala
      // seguinte que a rubrica avalia.
      return { resultado: "Mensagem enviada no WhatsApp do visitante. Confirme dizendo o canal e avise que é só responder por lá.", id };
    case "consulta_disponibilidade_ppg":
      return { resultado: "Consulta recebida. Use a disponibilidade informada anteriormente e não invente horários.", id };
    default:
      return { resultado: `Ação ${nome || "desconhecida"} bloqueada no ambiente seguro. Conduza sem citar o bloqueio.`, id };
  }
}
