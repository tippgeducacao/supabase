import { describe, expect, it } from 'vitest';
import { descreverToolsSdr } from './descricoesTools';
import { INSTRUCAO_AGENDA_EVENTOS, INSTRUCAO_EVENTOS } from './instrucaoEventos';
import { montarContextoTemporal } from './contexto';
import { AGENTE_VALIDACAO } from './prompts';

describe('contratos de aula e conversa individual', () => {
  it.each(['consulta_disponibilidade', 'confirmar_agendamento', 'remarcar_agendamento'])(
    'prioriza a finalidade em %s, preservando schema e descrição original', (name) => {
      const original = { name, description: 'Apresente APENAS os horários.', input_schema: { type: 'object', properties: { data: { type: 'string' } } } };
      const copia = structuredClone(original);
      const [descrita] = descreverToolsSdr([original]);
      expect(descrita.description).toContain(INSTRUCAO_AGENDA_EVENTOS);
      expect(descrita.description!.indexOf(INSTRUCAO_AGENDA_EVENTOS)).toBeLessThan(descrita.description!.indexOf(original.description));
      expect(descrita.description).toContain('prevalecem sobre qualquer instrução posterior de apresentar APENAS os horários');
      expect(descrita.input_schema).toEqual(copia.input_schema);
      expect(original).toEqual(copia);
      const [comRegraDoBanco] = descreverToolsSdr([descrita]);
      expect(comRegraDoBanco.description!.split(INSTRUCAO_AGENDA_EVENTOS)).toHaveLength(2);
    },
  );

  it('a instrução alcança ferramentas do banco sem descrição e não invade outra ferramenta', () => {
    const lista = descreverToolsSdr([
      { name: 'confirmar_agendamento', input_schema: { type: 'object' } },
      { name: 'ferramenta_de_outro_assunto', description: 'Outro contrato', input_schema: { type: 'object' } },
    ]);
    expect(lista[0].description).toContain(INSTRUCAO_AGENDA_EVENTOS);
    expect(lista[1].description).toBe('Outro contrato');
  });

  it('explica confirmação, dúvida de horário, fonte antiga e retomada explícita da reunião', () => {
    expect(INSTRUCAO_EVENTOS).toContain('"Confirmar Participação"');
    expect(INSTRUCAO_EVENTOS).toContain('Não consulte disponibilidade, não colete formação para agendar, não crie nem remarque reunião');
    expect(INSTRUCAO_EVENTOS).toContain('não anuncie inscrição, presença registrada ou vaga reservada');
    expect(INSTRUCAO_EVENTOS).toContain('Convite antigo com "hoje" não comprova que a aula é hoje');
    expect(INSTRUCAO_EVENTOS).toContain('19h é só exemplo: use o horário efetivamente informado na fonte');
    expect(INSTRUCAO_EVENTOS).toContain('Sem esse convite, não confirme 19h nem outro horário como fato');
    expect(INSTRUCAO_EVENTOS).toContain('Pedido posterior explícito de reunião retoma o fluxo normal');
    expect(INSTRUCAO_EVENTOS).toContain('confirmação ou escolha de horário de aula/evento NÃO promove para agente_qualificador');
  });

  it('remove o conflito na abertura e identifica finalidade das janelas temporais', () => {
    expect(AGENTE_VALIDACAO).not.toContain('Trate-a só como o que abriu a janela');
    expect(AGENTE_VALIDACAO).toContain('Confirmação de participação na aula não é aceite de conversa individual com o monitor');
    expect(AGENTE_VALIDACAO).toContain('Lead aceitou especificamente a conversa individual com o monitor');
    const temporal = montarContextoTemporal();
    expect(temporal).toContain('NÃO SÃO HORÁRIOS DE AULAS');
    expect(temporal).toContain('primeiro obtenha o aceite específico do lead e consulte a agenda');
    expect(temporal).not.toContain('PERÍODO QUE VOCÊ PODE OFERECER HOJE:');
  });
});
