import { describe, expect, it } from 'vitest';
import { blocoConviteAgenda, fraseConviteAgenda } from './contexto';

// dia: 0 = domingo … 6 = sábado (hora de Brasília)
describe('CONVITE DE AGENDA calculado pelo relógio', () => {
  it('dentro do expediente: ainda hoje', () => {
    expect(fraseConviteAgenda({ dia: 4, hora: 15, minuto: 0 })).toBe('procuro um encaixe pra ainda hoje?');
    expect(fraseConviteAgenda({ dia: 1, hora: 9, minuto: 45 })).toBe('procuro um encaixe pra ainda hoje?');
  });
  it('intervalo do almoço ainda é hoje', () => {
    expect(fraseConviteAgenda({ dia: 2, hora: 12, minuto: 30 })).toBe('procuro um encaixe pra ainda hoje?');
  });
  it('depois do último horário do dia: amanhã cedo', () => {
    expect(fraseConviteAgenda({ dia: 4, hora: 19, minuto: 0 })).toBe('procuro um encaixe pra amanhã cedo, no primeiro horário?');
    expect(fraseConviteAgenda({ dia: 1, hora: 21, minuto: 0 })).toBe('procuro um encaixe pra amanhã cedo, no primeiro horário?');
  });
  it('sábado à tarde pula o domingo; domingo aponta para amanhã', () => {
    expect(fraseConviteAgenda({ dia: 6, hora: 14, minuto: 0 })).toBe('procuro um encaixe pra segunda-feira cedo, no primeiro horário?');
    expect(fraseConviteAgenda({ dia: 0, hora: 10, minuto: 0 })).toBe('procuro um encaixe pra amanhã cedo, no primeiro horário?');
  });
  it('o bloco traz a frase entre aspas para o modelo copiar', () => {
    expect(blocoConviteAgenda({ dia: 3, hora: 10, minuto: 0 })).toContain('"procuro um encaixe pra ainda hoje?"');
    expect(blocoConviteAgenda({ dia: 3, hora: 10, minuto: 0 })).toContain('CONVITE DE AGENDA');
  });
});
