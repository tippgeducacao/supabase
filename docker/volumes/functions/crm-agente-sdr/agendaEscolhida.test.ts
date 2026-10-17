import { describe, expect, it } from 'vitest';
import { aprovadoNaConversa, escolheuHorarioOfertado, followupDosHorarios, ultimaFalaOfereceuHorario } from './agendaEscolhida';

// Caso Manu (17/10/2026): sábado 08:02 BRT, a IA ofereceu segunda 19/10 às 10h, 10h30 ou 11h.
const AGORA = Date.parse('2026-10-17T11:37:00Z');
const consulta = { role: 'user', content: [{ type: 'tool_result', content: JSON.stringify({ slots_raw: [
  { data: '2026-10-19', horario: '10:00', vendedor_id: 'v1' }, { data: '2026-10-19', horario: '10:30', vendedor_id: 'v1' },
  { data: '2026-10-19', horario: '11:00', vendedor_id: 'v1' }] }) }] };
const aprovado = { role: 'user', content: [{ type: 'tool_result', content: JSON.stringify({ output: 'APROVADO', compativel: true }) }] };
const oferta = { role: 'assistant', content: 'beleza. pra conversa com o monitor, tenho segunda às 10h, 10h30 ou 11h, no horário de brasília. qual fica melhor?' };
const HIST = [aprovado, consulta, oferta] as any;

describe('o lead escolheu um horário oferecido (caso Manu)', () => {
  it('"Pode ser às 10" escolhe o das 10h, com a formação aprovada', () => {
    expect(aprovadoNaConversa(HIST)).toBe(true);
    expect(escolheuHorarioOfertado(HIST, 'Pode ser às 10', AGORA)).toBe(true);
    expect(escolheuHorarioOfertado(HIST, '10h30', AGORA)).toBe(true);
    expect(escolheuHorarioOfertado(HIST, 'pode ser às 15', AGORA)).toBe(false);
    expect(escolheuHorarioOfertado(HIST, 'sim', AGORA)).toBe(false);
  });

  it('horário que já passou não vale', () => {
    expect(escolheuHorarioOfertado(HIST, 'às 10', Date.parse('2026-10-19T14:00:00Z'))).toBe(false);
  });

  it('o follow-up oferece os mesmos horários, em vez de "ainda faz sentido procurar"', () => {
    expect(ultimaFalaOfereceuHorario(HIST)).toBe(true);
    expect(followupDosHorarios(HIST, 'manu', AGORA))
      .toBe('manu, pra sua conversa com o monitor, segunda às 10h, 10h30 ou 11h ainda estão livres. qual fica melhor pra vc?');
    expect(followupDosHorarios(HIST, 'manu', Date.parse('2026-10-19T14:00:00Z'))).toBe('');
    expect(ultimaFalaOfereceuHorario([{ role: 'assistant', content: 'vc já se formou em agronomia?' }] as any)).toBe(false);
  });
});
