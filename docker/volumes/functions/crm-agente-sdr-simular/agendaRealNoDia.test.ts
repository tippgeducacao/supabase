import { describe, expect, it } from 'vitest';
import { agendaRealNoDia, disponibilidadeSimulada } from './simulacao';

// Replay de 25/09/2026: a agenda real era da segunda 21/09; o modelo pedia dias depois.
const REAL = JSON.stringify({
  resultado: 'Horários disponíveis para a conversa com o monitor (Brasília):\n'
    + '- 10h de segunda-feira, dia 2026-09-21 (vendedor_id: a, nome: Amanda)\n'
    + '- 19h de segunda-feira, dia 2026-09-21 (vendedor_id: a, nome: Amanda)\n'
    + '- 19h30 de segunda-feira, dia 2026-09-21 (vendedor_id: a, nome: Amanda)\n'
    + '- 20h de segunda-feira, dia 2026-09-21 (vendedor_id: a, nome: Amanda)',
});
const agora = new Date('2026-09-25T13:00:00Z'); // sexta, 10h em Brasília

describe('agendaRealNoDia', () => {
  it('leva os horários reais ao dia pedido, com o dia da semana certo e o recorte da noite', () => {
    const t = agendaRealNoDia(REAL, { data_desejada: '2026-09-28', periodo_desejado: 'noite' }, agora)!;
    expect(t).toContain('- 19h de segunda-feira, dia 2026-09-28 (vendedor_id: a, nome: Amanda)');
    expect(t).toContain('- 20h de segunda-feira, dia 2026-09-28');
    expect(t).not.toContain('10h');
    expect(t).not.toContain('2026-09-21');
  });

  it('sábado só tem manhã; domingo e data passada não têm agenda real', () => {
    expect(agendaRealNoDia(REAL, { data_desejada: '2026-09-26' }, agora)).toContain('- 10h de sábado, dia 2026-09-26');
    expect(agendaRealNoDia(REAL, { data_desejada: '2026-09-26' }, agora)).not.toContain('19h');
    expect(agendaRealNoDia(REAL, { data_desejada: '2026-09-27' }, agora)).toBeNull();
    expect(agendaRealNoDia(REAL, { data_desejada: '2026-09-24' }, agora)).toBeNull();
  });

  it('hoje só o que ainda não passou; recorte vazio ⇒ null', () => {
    expect(agendaRealNoDia(REAL, { data_desejada: '2026-09-25' }, agora)).not.toContain('- 10h ');
    expect(agendaRealNoDia(REAL, { data_desejada: '2026-09-28', horario_inicio_desejado: '21:00' }, agora)).toBeNull();
  });
});

describe("disponibilidadeSimulada com mocks.disponibilidade = 'realista'", () => {
  const agoraSexta = new Date('2026-09-25T13:00:00Z'); // sexta, 10h em Brasília
  it('hoje à tarde e à noite têm horário; o que já passou não aparece', () => {
    const tarde = disponibilidadeSimulada({ data_desejada: '2026-09-25', periodo_desejado: 'tarde' }, { disponibilidade: 'realista' }, agoraSexta);
    expect(tarde).toContain('- 14h de sexta, dia 2026-09-25');
    const manha = disponibilidadeSimulada({ data_desejada: '2026-09-25', periodo_desejado: 'manha' }, { disponibilidade: 'realista' }, agoraSexta);
    expect(manha).not.toContain('- 9h ');
    expect(manha).toContain('- 11h30 de sexta');
    expect(disponibilidadeSimulada({ data_desejada: '2026-09-28', periodo_desejado: 'noite' }, { disponibilidade: 'realista' }, agoraSexta))
      .toContain('- 19h30 de segunda, dia 2026-09-28');
  });
  it('sábado só manhã, domingo nada, sem data só os 4 primeiros', () => {
    expect(disponibilidadeSimulada({ data_desejada: '2026-09-26', periodo_desejado: 'tarde' }, { disponibilidade: 'realista' }, agoraSexta)).toContain('Nenhum horário');
    expect(disponibilidadeSimulada({ data_desejada: '2026-09-27' }, { disponibilidade: 'realista' }, agoraSexta)).toContain('Nenhum horário');
    const semData = disponibilidadeSimulada({}, { disponibilidade: 'realista' }, agoraSexta);
    expect(semData.split('\n').filter((l) => l.startsWith('- ')).length).toBe(4);
  });
});
