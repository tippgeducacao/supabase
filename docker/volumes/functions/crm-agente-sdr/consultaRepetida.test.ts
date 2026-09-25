import { describe, expect, it } from 'vitest';
import { MemoriaDeConsultas } from './consultaRepetida';

// Duelo cego Luna × Sonnet 5 (25/09/2026): a mesma consulta de agenda 3 vezes até esgotar as voltas.
describe('MemoriaDeConsultas', () => {
  const agenda = { data_desejada: '2026-09-26', curso_escolhido: 'MBA', periodo_desejado: 'manha' };

  it('a segunda consulta idêntica é repetida, mesmo com as chaves em outra ordem', () => {
    const m = new MemoriaDeConsultas();
    expect(m.repetida('consulta_disponibilidade', agenda)).toBe(false);
    expect(m.repetida('consulta_disponibilidade', { periodo_desejado: 'manha', curso_escolhido: 'MBA', data_desejada: '2026-09-26' })).toBe(true);
  });

  it('dados diferentes não são repetição', () => {
    const m = new MemoriaDeConsultas();
    m.repetida('consulta_disponibilidade', agenda);
    expect(m.repetida('consulta_disponibilidade', { ...agenda, data_desejada: '2026-09-28' })).toBe(false);
  });

  it('tool que grava ou agenda zera a memória: reconsultar depois é legítimo', () => {
    const m = new MemoriaDeConsultas();
    m.repetida('consulta_disponibilidade', agenda);
    expect(m.repetida('confirmar_agendamento', { horario: '10:00' })).toBe(false);
    expect(m.repetida('consulta_disponibilidade', agenda)).toBe(false);
  });

  it('tool que não é consulta nunca é tratada como repetida', () => {
    const m = new MemoriaDeConsultas();
    expect(m.repetida('envia_informacoes', { conteudo: 'valor' })).toBe(false);
    expect(m.repetida('envia_informacoes', { conteudo: 'valor' })).toBe(false);
  });
});
