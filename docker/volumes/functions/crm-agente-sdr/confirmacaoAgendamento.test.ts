import { describe, expect, it } from 'vitest';
import {
  confirmacaoDoResultado, falaEntregaConfirmacao, INSTRUCAO_ENVIAR_CONFIRMACAO, resultadoConfirmacao, textoConfirmacaoAgendamento,
} from './confirmacaoAgendamento';
import { blocoConfirmacao } from '../crm-webchat/guardas';

const confirmacao = { data: 'sexta-feira, 25/09/2026 às 16:30', monitor: 'Ana', link: 'https://meet.google.com/abc-defg-hij' };

describe('confirmação de agendamento em código', () => {
  it('texto no formato do prompt, com os dados da tool', () => {
    expect(textoConfirmacaoAgendamento(confirmacao)).toBe([
      'Horário reservado pra você:',
      '📅 sexta-feira, 25/09/2026 às 16:30',
      '👨‍💼 Monitor Ana',
      '🔗 Link do meet: https://meet.google.com/abc-defg-hij',
      '',
      'Se você não conseguir comparecer me avisa com 2h de antecedência para eu remanejar esse horário e qualquer dúvida é só me chamar por aqui.',
    ].join('\n'));
  });

  it('sem link devolvido pela agenda, a linha do link sai (nunca inventar)', () => {
    const texto = textoConfirmacaoAgendamento({ ...confirmacao, link: '' });
    expect(texto).not.toContain('Link do meet');
    expect(texto).toContain('👨‍💼 Monitor Ana');
  });

  it('só agendamento criado de fato vira pendência', () => {
    expect(confirmacaoDoResultado({ agendamento_id: 'ag-1', confirmacao })).toEqual(confirmacao);
    expect(confirmacaoDoResultado({ agendamento_id: null, confirmacao })).toBeNull(); // modo teste / erro
    expect(confirmacaoDoResultado({ agendamento_id: 'ag-1' })).toBeNull();
    expect(confirmacaoDoResultado({ agendamento_id: 'ag-1', confirmacao: { ...confirmacao, monitor: ' ' } })).toBeNull();
    expect(confirmacaoDoResultado('Erro ao agendar: sem id_calendar')).toBeNull();
    expect(confirmacaoDoResultado({ agendamento_id: 'ag-1', confirmacao: { ...confirmacao, link: null } }))
      .toEqual({ ...confirmacao, link: '' });
  });

  it('fala entrega a reunião só com o link; sem link devolvido, basta o monitor', () => {
    expect(falaEntregaConfirmacao(textoConfirmacaoAgendamento(confirmacao), confirmacao)).toBe(true);
    expect(falaEntregaConfirmacao('show, fechado então: sexta às 16h30 com a Ana', confirmacao)).toBe(false);
    expect(falaEntregaConfirmacao('fechado com a ana na sexta', { ...confirmacao, link: '' })).toBe(true);
    expect(falaEntregaConfirmacao('show', { ...confirmacao, link: '' })).toBe(false);
  });

  it('resultado da tool traz a instrução e o webchat continua extraindo o link inteiro', () => {
    const resultado = resultadoConfirmacao('ag-1', confirmacao);
    expect(resultado).toContain(INSTRUCAO_ENVIAR_CONFIRMACAO);
    const bloco = blocoConfirmacao(resultado);
    expect(bloco).toContain('🔗 Link do meet: https://meet.google.com/abc-defg-hij\n');
    expect(bloco).toContain('📅 sexta-feira, 25/09/2026 às 16:30');
    expect(bloco).toContain('👨‍💼 Monitor Ana');
  });
});
